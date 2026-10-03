import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ModuleHostApi, ModuleHostIntent, ModuleHostIntentBody, ModuleHostIntentResult,
  NativeChatEvent, PublicSessionMeta } from '@waksana/cockpit-module-sdk/backend';
import { RECENT_LIMITS, RECENT_SCHEMA_VERSION, RecentStore } from '../src/recent-store.ts';
import { boundedRecentText, RecentIndex, RecentSessions } from '../src/recent.ts';
import type { RecentError } from '../src/recent.ts';

type ChatBody = ModuleHostIntentBody<'session/chat'>;
type ChatPage = ModuleHostIntentResult<'session/chat'>;
type DirectoryBody = ModuleHostIntentBody<'session/directory'>;
type DirectoryPage = ModuleHostIntentResult<'session/directory'>;
const meta = (sessionId: string, lastActivity = 1): PublicSessionMeta => ({
  sessionId, title: `Title ${sessionId}`, cwd: '/synthetic', loaded: false, status: 'unloaded',
  lastActivity, lastActivitySource: 'native-persisted', ask: null,
});
const event = (id: string, content = `消息 ${id}`, type = 'assistant.message'): NativeChatEvent =>
  ({ id, type, timestamp: `2026-10-03T00:00:${id}Z`, data: { messageId: `native-${id}`, content } });
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
function fixture(path = ':memory:') {
  const store = new RecentStore(path);
  const sessions = new Map<string, PublicSessionMeta>();
  const histories = new Map<string, NativeChatEvent[]>();
  const calls: Array<{ name: ModuleHostIntent; body: unknown }> = [];
  const errors: RecentError[] = [];
  let chatOverride: ((body: ChatBody) => Promise<ChatPage>) | null = null;
  let directoryOverride: ((body: DirectoryBody) => Promise<DirectoryPage>) | null = null;
  let getOverride: ((sessionId: string) => Promise<PublicSessionMeta | null>) | null = null;
  const page = (body: ChatBody): ChatPage => {
    const history = histories.get(body.sessionId) ?? [];
    const start = Number(body.cursor ?? '0'), end = start + body.max;
    return { sessionId: body.sessionId, source: 'persisted', direction: 'backward', cursorStatus: 'ok',
      events: structuredClone(history.slice(start, end)), cursor: String(end), hasMore: end < history.length,
      read: { events: Math.min(body.max, history.length - start), rpc: 1 } };
  };
  const directory = (body: DirectoryBody): DirectoryPage => {
    const values = [...sessions.values()], start = Number(body.cursor ?? '0'), end = start + body.limit;
    return { sessions: structuredClone(values.slice(start, end)), ...(end < values.length ? { cursor: String(end) } : {}) };
  };
  const host: ModuleHostApi = {
    async call<Name extends ModuleHostIntent>(name: Name, body: ModuleHostIntentBody<Name>): Promise<ModuleHostIntentResult<Name>> {
      calls.push({ name, body: structuredClone(body) });
      if (name === 'session/get') {
        const { sessionId } = body as ModuleHostIntentBody<'session/get'>;
        return { meta: getOverride ? await getOverride(sessionId) : structuredClone(sessions.get(sessionId) ?? null) } as ModuleHostIntentResult<Name>;
      }
      if (name === 'session/directory') return (directoryOverride
        ? await directoryOverride(body as DirectoryBody) : directory(body as DirectoryBody)) as ModuleHostIntentResult<Name>;
      assert.equal(name, 'session/chat', 'Only passive metadata and persisted history reads are permitted');
      const read = body as ChatBody;
      assert.equal(read.source, 'persisted'); assert.equal(read.direction, 'backward');
      assert.equal(read.bootstrap, false); assert.equal(read.waitMs, 0);
      assert.ok(read.max <= RECENT_LIMITS.pageEvents);
      assert.equal(read.agentScope, undefined); assert.equal(read.types, undefined);
      return (chatOverride ? await chatOverride(read) : page(read)) as ModuleHostIntentResult<Name>;
    },
  };
  const recent = new RecentSessions(host, store, { onError: error => errors.push(error) });
  return { store, recent, sessions, histories, calls, errors, page, directory,
    add(id = 'session', events = [event('one')], activity = 1) { sessions.set(id, meta(id, activity)); histories.set(id, events); },
    chatWith(value: typeof chatOverride) { chatOverride = value; },
    directoryWith(value: typeof directoryOverride) { directoryOverride = value; },
    getWith(value: typeof getOverride) { getOverride = value; },
    async start() { recent.start(); await recent.waitIdle(); },
    async close() { await recent.stop(); store.close(); },
  };
}

test('durable schema1 cache reopens and unchanged source skips full history but probes current head', async t => {
  const dir = join(process.cwd(), '.recent-test-' + randomUUID());
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'recent.sqlite');
  const first = fixture(path);
  first.add('unregistered-unloaded', [event('a', '持久化 原文')]);
  await first.start();
  assert.equal(first.recent.health().state, 'ready');
  assert.equal(first.store.sql.prepare('PRAGMA user_version').get()?.user_version, RECENT_SCHEMA_VERSION);
  await first.close();
  const second = fixture(path); t.after(() => second.close());
  second.add('unregistered-unloaded', [event('a', '持久化 原文')]);
  assert.equal(second.store.messages('unregistered-unloaded')[0]!.text, '持久化 原文');
  await second.start();
  assert.equal(second.recent.health().skipped, 1);
  assert.deepEqual(second.calls.filter(c => c.name === 'session/chat').map(c => (c.body as ChatBody).max), [1]);
  assert.equal((await second.recent.search({ query: '持久化' })).results[0]!.sessionId, 'unregistered-unloaded');
  assert.equal(second.sessions.get('unregistered-unloaded')!.loaded, false);
});

test('startup refreshes changed timestamp/source and detects unchanged-timestamp current head reset', async t => {
  const f = fixture();
  f.add('s', [event('a', 'old')]);
  await f.start();
  await f.recent.stop();
  f.histories.set('s', [event('b', 'new')]);
  const restart = new RecentSessions(f.recent.host, f.store);
  t.after(async () => { await restart.stop(); await f.close(); });
  restart.start(); await restart.waitIdle();
  assert.equal(restart.health().refreshed, 1, 'Same timestamp but changed head must refresh');
  assert.equal((await restart.search({ query: 'old' })).results.length, 0);
  assert.equal((await restart.search({ query: 'new' })).results.length, 1);
  f.sessions.get('s')!.lastActivity = 2;
  restart.invalidate('s'); await restart.waitIdle();
  assert.equal(f.store.get('s')!.syncedActivity, 2);
  f.sessions.get('s')!.lastActivitySource = 'host-event-receipt';
  restart.invalidate('s'); await restart.waitIdle();
  assert.equal(f.store.get('s')!.syncedActivitySource, 'host-event-receipt');
});

test('complete paginated inventory covers all sessions and prunes only after complete enumeration', async t => {
  const f = fixture();
  for (let i = 0; i < 105; i++) f.add(`s-${i}`);
  await f.start();
  assert.equal(f.recent.health().sessions, 105);
  assert.equal(f.recent.health().current, 105);
  assert.equal(f.calls.filter(c => c.name === 'session/directory').length, 2);
  await f.recent.stop();
  f.sessions.delete('s-104');
  const second = new RecentSessions(f.recent.host, f.store);
  t.after(async () => { await second.stop(); await f.close(); });
  second.start(); await second.waitIdle();
  assert.equal(f.store.get('s-104'), null);
  assert.equal(second.health().inventoryComplete, true);
});

test('failed later directory page preserves unobserved data as stale and reports partial coverage', async t => {
  const f = fixture();
  f.add('retained', [event('a', '保留')]); await f.start(); await f.recent.stop();
  f.add('observed');
  f.directoryWith(async body => {
    if (body.cursor) throw new Error('directory unavailable');
    return { sessions: [f.sessions.get('observed')!], cursor: 'second-page' };
  });
  const second = new RecentSessions(f.recent.host, f.store, { onError: error => f.errors.push(error) });
  t.after(async () => { await second.stop(); await f.close(); });
  second.start(); await second.waitIdle();
  assert.equal(second.health().state, 'partial');
  assert.equal(second.health().inventoryComplete, false);
  assert.match(second.health().inventoryError!, /directory unavailable/);
  assert.equal(f.store.messages('retained')[0]!.text, '保留');
  assert.equal(f.store.get('retained')!.state, 'stale');
  const result = await second.search({ query: '保留' });
  assert.equal(result.results.length, 0);
  assert.equal(result.coverage.stale, 1);
  assert.equal(f.errors[0]!.operation, 'inventory');
});

test('same-session events coalesce and obsolete in-flight reads cannot publish over reset', async t => {
  const f = fixture(); t.after(() => f.close());
  f.add('s', [event('a', 'old secret')]);
  const entered = deferred(), release = deferred();
  let block = true;
  f.chatWith(async body => {
    const result = f.page(body);
    if (body.max > 1 && block) { block = false; entered.resolve(); await release.promise; }
    return result;
  });
  f.recent.start(); await entered.promise;
  for (let i = 0; i < 30; i++) f.recent.invalidate('s');
  f.recent.invalidate('s', 'reset');
  f.histories.set('s', [event('b', '最新')]);
  assert.equal((await f.recent.search({ query: 'secret' })).results.length, 0);
  release.resolve(); await f.recent.waitIdle();
  assert.deepEqual(f.store.messages('s').map(m => m.text), ['最新']);
  assert.equal(f.recent.health().refreshed, 1);
  assert.equal(f.calls.filter(c => c.name === 'session/chat' && (c.body as ChatBody).max > 1).length, 2);
});

test('a repeatedly invalidated hot session cannot starve another queued session', async t => {
  const f = fixture(); t.after(() => f.close());
  f.add('hot'); f.add('other');
  let invalidations = 0;
  f.chatWith(async body => {
    if (body.sessionId === 'hot' && invalidations++ < 4) f.recent.invalidate('hot');
    return f.page(body);
  });
  await f.start();
  assert.equal(f.store.get('other')!.state, 'current');
  const reads = f.calls.filter(c => c.name === 'session/get').map(c => (c.body as { sessionId: string }).sessionId);
  assert.deepEqual(reads.slice(0, 2), ['hot', 'other']);
  assert.equal(f.store.get('hot')!.state, 'current');
});

test('unchanged ordinary dirty hints skip full scans while explicit reset still forces a rebuild', async t => {
  const f = fixture(); t.after(() => f.close());
  f.add('s'); await f.start();
  f.calls.length = 0;
  f.recent.invalidate('s'); await f.recent.waitIdle();
  assert.deepEqual(f.calls.filter(c => c.name === 'session/chat').map(c => (c.body as ChatBody).max), [1]);
  f.calls.length = 0;
  f.recent.invalidate('s', 'reset'); await f.recent.waitIdle();
  assert.deepEqual(f.calls.filter(c => c.name === 'session/chat').map(c => (c.body as ChatBody).max), [1, 16, 1]);
  assert.equal(f.recent.health().state, 'ready');
});

test('deletion immediately invalidates and deletion/recreation cannot admit a superseded generation', async t => {
  const f = fixture(); t.after(() => f.close());
  f.add('exact:id/not-a-token', [event('old', 'gone')]); await f.start();
  const entered = deferred(), release = deferred();
  let blocked = false;
  f.chatWith(async body => {
    const result = f.page(body);
    if (!blocked) { blocked = true; entered.resolve(); await release.promise; }
    return result;
  });
  f.recent.invalidate('exact:id/not-a-token'); await entered.promise;
  f.recent.invalidate('exact:id/not-a-token', 'delete');
  assert.equal(f.store.get('exact:id/not-a-token'), null);
  f.histories.set('exact:id/not-a-token', [event('new', 'replacement')]);
  f.recent.invalidate('exact:id/not-a-token');
  release.resolve(); await f.recent.waitIdle();
  assert.deepEqual(f.store.messages('exact:id/not-a-token').map(m => m.eventId), ['new']);
  f.sessions.delete('exact:id/not-a-token');
  const result = await f.recent.search({ query: 'replacement' });
  assert.equal(result.results.length, 0, 'Existence check blocks deletion even without an event');
  assert.equal(f.store.get('exact:id/not-a-token'), null);
});

test('rewind removes stored bodies before a failing refresh and never advances successful source metadata', async t => {
  const f = fixture(); t.after(() => f.close());
  f.add('s', [event('a', 'sensitive old')]); await f.start();
  const saved = f.store.get('s')!;
  f.sessions.get('s')!.lastActivity = 2;
  f.chatWith(async () => { throw new Error('read failed'); });
  f.recent.invalidate('s', 'reset');
  assert.deepEqual(f.store.messages('s'), []);
  await f.recent.waitIdle();
  assert.equal(f.store.get('s')!.syncedActivity, saved.syncedActivity);
  assert.equal(f.store.get('s')!.syncedAt, saved.syncedAt);
  assert.equal(f.store.get('s')!.state, 'failed');
  assert.equal(f.recent.health().state, 'partial');
  assert.equal(f.errors[0]!.operation, 'refresh');
  assert.equal((await f.recent.search({ query: 'old' })).results.length, 0);
  f.chatWith(null); f.histories.set('s', [event('b', 'recovered')]);
  f.recent.invalidate('s'); await f.recent.waitIdle();
  assert.equal(f.store.get('s')!.syncedActivity, 2);
});

test('UTF8/message/count budgets bound giant Unicode and multi-event histories without broken scalars', async t => {
  const f = fixture(); t.after(() => f.close());
  f.add('giant', Array.from({ length: 40 }, (_, i) => event(`u${i}`, '中文😀'.repeat(20_000))));
  f.add('many', Array.from({ length: 40 }, (_, i) => event(`m${i}`, `消息${i}`)));
  await f.start();
  const giant = f.store.messages('giant');
  assert.ok(giant.length <= RECENT_LIMITS.messages);
  assert.ok(giant.reduce((n, m) => n + Buffer.byteLength(m.text), 0) <= RECENT_LIMITS.sessionBytes);
  for (const message of giant) {
    assert.ok(Buffer.byteLength(message.text) <= RECENT_LIMITS.messageBytes);
    assert.equal(Buffer.from(message.text).toString(), message.text);
    assert.equal(message.truncated, true);
  }
  assert.equal(f.store.messages('many').length, 20);
  assert.equal(f.store.get('many')!.scanLimited, true);
  assert.equal(f.store.get('giant')!.truncated, true);
  const search = await f.recent.search({ query: '中文' });
  assert.ok(search.results.length <= 10);
  assert.ok(search.results.every(result => [...result.snippet].length <= 512 && Buffer.from(result.snippet).toString() === result.snippet));
  assert.deepEqual(boundedRecentText('中😀a', 6), { text: '中', truncated: true });
});

test('only primary non-ephemeral user/assistant content is retained; literal Chinese and metacharacters search', async t => {
  const f = fixture(); t.after(() => f.close());
  f.add('s', [
    event('user', '用户 要找 .* [abc] %_ 中文', 'user.message'),
    { ...event('assistant', '回答 中文'), data: { ...event('assistant').data, content: '回答 中文',
      reasoningText: 'PRIVATE reasoning', attachments: [{ data: 'PRIVATE bytes' }], toolRequests: ['PRIVATE tool'] } },
    { ...event('subagent', 'PRIVATE agent'), agentId: 'child' },
    { ...event('nested', 'PRIVATE nested'), parentToolCallId: 'task' },
    { ...event('data-agent', 'PRIVATE data'), data: { content: 'PRIVATE data', agentId: 'child' } },
    { ...event('data-parent', 'PRIVATE parent'), data: { content: 'PRIVATE parent', parentToolCallId: 'call' } },
    { ...event('ephemeral', 'PRIVATE transient'), ephemeral: true },
    event('tool', 'PRIVATE tool', 'tool.execution_complete'),
    event('system', 'PRIVATE system', 'system.message'),
    event('reasoning', 'PRIVATE reasoning', 'assistant.reasoning'),
  ]);
  await f.start();
  assert.deepEqual(f.store.messages('s').map(m => m.eventId), ['user', 'assistant']);
  assert.equal(JSON.stringify(f.store.messages('s')).includes('PRIVATE'), false);
  assert.equal((await f.recent.search({ query: 'PRIVATE' })).results.length, 0);
  for (const query of ['中文', '.*', '[abc]', '%_']) assert.ok((await f.recent.search({ query })).results.length > 0);
  assert.equal((await f.recent.search({ query: '不存在|中文' })).results.length, 0);
  assert.throws(() => f.recent.search({ query: '' }));
  assert.throws(() => f.recent.search({ query: 'x'.repeat(201) }));
  assert.throws(() => f.recent.search({ query: '中文', limit: 11 }));
  const result = await f.recent.search({ query: '中文', limit: 1 });
  assert.equal(result.results.length, 1);
  assert.equal(result.discoveryOnly, true); assert.equal(result.nativeChatReadRequired, true);
  assert.equal((await f.recent.search('  中文  ', 1)).results.length, 1);
  assert.throws(() => f.recent.search('   '));
  assert.equal(RecentIndex, RecentSessions);
});

test('bounded raw scan explicitly reports incomplete coverage; expired cursor is not empty success', async t => {
  const f = fixture(); t.after(() => f.close());
  f.add('no-text', Array.from({ length: 200 }, (_, i) => event(`tool${i}`, 'not text', 'tool.execution_complete')));
  f.add('expired', [event('a', 'formerly cached')]);
  await f.start();
  assert.equal(f.store.get('no-text')!.scanLimited, true);
  assert.deepEqual(f.store.messages('no-text'), []);
  assert.equal(f.calls.filter(c => c.name === 'session/chat' && (c.body as ChatBody).sessionId === 'no-text').length, 10);
  const previous = f.store.get('expired')!;
  f.chatWith(async body => ({ ...f.page(body), cursorStatus: 'expired', events: [] }));
  f.recent.invalidate('expired'); await f.recent.waitIdle();
  assert.equal(f.store.get('expired')!.syncedAt, previous.syncedAt);
  assert.equal(f.store.get('expired')!.state, 'failed');
  assert.match(f.store.get('expired')!.error!, /expired/);
  assert.equal((await f.recent.search({ query: 'formerly' })).results.length, 0);
});

test('backward raw pages in native append order are normalized using the one-event head probe', async t => {
  const f = fixture(); t.after(() => f.close());
  f.add('s', Array.from({ length: 35 }, (_, i) => event(`m${i}`, `消息${i}`)));
  f.chatWith(async body => {
    const page = f.page(body);
    return { ...page, events: [...page.events].reverse() };
  });
  await f.start();
  assert.equal(f.recent.health().state, 'ready');
  assert.deepEqual(f.store.messages('s').map(m => m.eventId),
    Array.from({ length: 20 }, (_, i) => `m${i}`));
});

test('directory cursor cycles terminate with explicit partial coverage and no prune', async t => {
  const f = fixture(); t.after(() => f.close());
  f.add('s');
  f.directoryWith(async body => ({ sessions: [], cursor: body.cursor === 'a' ? 'b' : 'a' }));
  await f.start();
  assert.equal(f.recent.health().state, 'partial');
  assert.match(f.recent.health().inventoryError!, /cycle/);
  assert.ok(f.calls.length <= 4);
});

test('event-discovered session during directory enumeration is retained even if the inventory snapshot omits it', async t => {
  const f = fixture(); t.after(() => f.close());
  const entered = deferred(), release = deferred();
  f.directoryWith(async () => { entered.resolve(); await release.promise; return { sessions: [] }; });
  f.recent.start(); await entered.promise;
  f.add('new', [event('new', 'new arrival')]); f.recent.invalidate('new');
  release.resolve(); await f.recent.waitIdle();
  assert.equal(f.store.get('new')!.state, 'current');
  assert.equal((await f.recent.search({ query: 'arrival' })).results.length, 1);
});

test('search access failure is bounded and surfaced; source metadata changes hide stale candidates', async t => {
  const f = fixture(); t.after(() => f.close());
  f.add('a', [event('a', 'find')]); f.add('b', [event('b', 'find')]); await f.start();
  f.getWith(async sessionId => {
    if (sessionId === 'a') throw new Error('access no longer available');
    return f.sessions.get(sessionId) ?? null;
  });
  const result = await f.recent.search({ query: 'find' });
  assert.deepEqual(result.results.map(r => r.sessionId), ['b']);
  assert.equal(result.errors.length, 1);
  assert.equal(result.coverage.failed, 1);
  assert.equal(result.coverage.state, 'partial');
  f.sessions.get('b')!.lastActivity = 2;
  assert.equal((await f.recent.search({ query: 'find' })).results.length, 0);
  await f.recent.waitIdle();
  assert.equal(f.store.get('b')!.syncedActivity, 2);
});

test('event while search awaits later candidate retracts earlier result', async t => {
  const f = fixture(); t.after(() => f.close());
  f.add('a', [event('a', 'find')], 2); f.add('b', [event('b', 'find')]); await f.start();
  const entered = deferred(), release = deferred();
  f.getWith(async id => {
    if (id === 'b') { entered.resolve(); await release.promise; }
    return f.sessions.get(id) ?? null;
  });
  const pending = f.recent.search({ query: 'find' });
  await entered.promise;
  f.recent.invalidate('a', 'delete'); f.sessions.delete('a');
  release.resolve();
  assert.deepEqual((await pending).results.map(r => r.sessionId), ['b']);
});

test('normal source drift retries once and only publishes a stable recent window', async t => {
  const f = fixture(); t.after(() => f.close());
  f.add('s', [event('a', 'before')]);
  f.chatWith(async body => {
    const result = f.page(body);
    if (body.max > 1) f.histories.set('s', [event('b', 'after')]);
    return result;
  });
  await f.start();
  assert.equal(f.store.get('s')!.state, 'current');
  assert.deepEqual(f.store.messages('s').map(message => message.text), ['after']);
  assert.equal(f.recent.health().drifted, 1);
  assert.equal(f.errors.length, 0);
  assert.equal(f.store.counts().pending, 0);
});

test('continuously drifting source remains explicitly stale after a bounded retry, without a hot loop', async t => {
  const f = fixture(); t.after(() => f.close());
  f.add('s');
  let changes = 0;
  f.chatWith(async body => {
    const result = f.page(body);
    if (body.max > 1) f.histories.set('s', [event(`changed-${++changes}`)]);
    return result;
  });
  await f.start();
  assert.equal(changes, 2);
  assert.equal(f.store.get('s')!.state, 'stale');
  assert.match(f.store.get('s')!.error!, /changed during refresh/);
  assert.equal(f.store.get('s')!.syncedAt, null);
  assert.equal(f.recent.health().state, 'partial');
  assert.equal(f.recent.health().drifted, 2);
  assert.equal(f.errors.length, 0);
  assert.equal(f.store.counts().pending, 0);
  f.chatWith(null); f.recent.invalidate('s');
  await f.recent.waitIdle();
  assert.equal(f.store.get('s')!.state, 'current');
});

test('stop drains in-flight raw reads and searches before database close with no producers afterward', async () => {
  const f = fixture();
  f.add('s');
  const entered = deferred(), release = deferred();
  f.chatWith(async body => { const result = f.page(body); entered.resolve(); await release.promise; return result; });
  f.recent.start(); await entered.promise;
  let settled = false;
  const stopping = f.recent.stop().then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  f.recent.invalidate('after-stop');
  release.resolve(); await stopping;
  assert.equal(f.store.get('s')!.syncedAt, null);
  const calls = f.calls.length;
  f.store.close();
  await f.recent.waitIdle(); await f.recent.stop();
  f.recent.invalidate('late', 'reset');
  assert.equal(f.recent.health().state, 'stopped');
  assert.equal(f.calls.length, calls);
  assert.throws(() => f.recent.search({ query: 'x' }), { code: 'RECENT_STOPPED' });
  assert.throws(() => f.recent.start(), { code: 'RECENT_STOPPED' });
});

test('shutdown also awaits native existence checks already running for search', async () => {
  const f = fixture(); f.add('s', [event('a', 'find')]); await f.start();
  const entered = deferred(), release = deferred();
  f.getWith(async id => { entered.resolve(); await release.promise; return f.sessions.get(id) ?? null; });
  const search = f.recent.search({ query: 'find' }); await entered.promise;
  let stopped = false;
  const stopping = f.recent.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  release.resolve();
  assert.equal((await search).results.length, 0);
  await stopping; f.store.close();
  assert.equal(f.recent.health().state, 'stopped');
});

test('concurrent search admission is bounded without dropping already admitted readers', async t => {
  const f = fixture(); t.after(() => f.close());
  f.add('s', [event('a', 'find')]); await f.start();
  const release = deferred();
  f.getWith(async id => { await release.promise; return f.sessions.get(id) ?? null; });
  const searches = Array.from({ length: RECENT_LIMITS.concurrentSearches }, () => f.recent.search({ query: 'find' }));
  assert.throws(() => f.recent.search({ query: 'find' }), { code: 'RECENT_BUSY' });
  release.resolve();
  assert.ok((await Promise.all(searches)).every(result => result.results.length === 1));
  assert.equal((await f.recent.search({ query: 'find' })).results.length, 1);
});

test('corrupt stored text/count budgets fail closed with explicit errors instead of publishing oversized results', async t => {
  const f = fixture(); t.after(() => f.close());
  f.add('s', [event('a', 'find')]); await f.start();
  f.store.sql.prepare('UPDATE recent_messages SET text=?').run('find' + '界'.repeat(10_000));
  await assert.rejects(f.recent.search({ query: 'find' }), { code: 'RECENT_CORRUPT' });
  assert.equal(f.recent.health().state, 'partial');
  assert.equal(f.errors.at(-1)!.operation, 'search');
  f.store.sql.prepare('UPDATE recent_messages SET text=?').run('find');
  const pointer = f.store.sql.prepare('SELECT message FROM recent_messages LIMIT 1').get()!.message as string;
  for (let i = 1; i <= 20; i++) {
    f.store.sql.prepare('INSERT INTO recent_messages(session_id,ordinal,message,text) VALUES (?,?,?,?)').run('s', i, pointer, 'find');
  }
  await assert.rejects(f.recent.search({ query: 'find' }), { code: 'RECENT_CORRUPT' });
  f.store.sql.prepare('DELETE FROM recent_messages WHERE ordinal>=9').run();
  f.store.sql.prepare('UPDATE recent_messages SET text=?').run('find' + 'x'.repeat(8188));
  await assert.rejects(f.recent.search({ query: 'find' }), { code: 'RECENT_CORRUPT' });
});

test('corrupt pointer shape never emits non-primary payloads and fails unchanged-head startup verification', async t => {
  const f = fixture(); f.add('s', [event('a', 'find')]); await f.start(); await f.recent.stop();
  f.store.sql.prepare('UPDATE recent_messages SET message=?').run(JSON.stringify({
    eventId: 'tool', messageId: null, role: 'tool', timestamp: 1, truncated: false, attachments: ['private bytes'],
  }));
  const restarted = new RecentSessions(f.recent.host, f.store, { onError: error => f.errors.push(error) });
  t.after(async () => { await restarted.stop(); await f.close(); });
  restarted.start(); await restarted.waitIdle();
  assert.equal(f.store.get('s')!.state, 'failed');
  assert.equal(restarted.health().skipped, 0);
  assert.equal(restarted.health().state, 'partial');
  assert.equal((await restarted.search({ query: 'find' })).results.length, 0);
  assert.equal(f.errors.at(-1)!.operation, 'refresh');
});

test('corrupt metadata is rejected without echoing oversized values or unrelated stored fields', async t => {
  const f = fixture(); t.after(() => f.close());
  f.add('s', [event('a', 'find')]); await f.start();
  f.store.sql.prepare('UPDATE recent_sessions SET metadata=?').run(JSON.stringify({
    sessionId: 's', title: 'x'.repeat(30_000), cwd: '/synthetic', lastActivity: 1,
  }));
  await assert.rejects(f.recent.search({ query: 'find' }), { code: 'RECENT_CORRUPT' });
  assert.ok(f.errors.every(error => error.error.length <= 512));
  assert.equal(f.recent.health().state, 'partial');
});

test('incompatible disposable cache schema is rejected without changing the main database', t => {
  const dir = join(process.cwd(), '.recent-test-' + randomUUID());
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const main = join(dir, 'assistant.sqlite'), cache = join(dir, 'recent.sqlite');
  writeFileSync(main, 'main store must remain untouched');
  const store = new RecentStore(cache);
  store.sql.exec('PRAGMA user_version=999');
  store.close();
  assert.throws(() => new RecentStore(cache), { code: 'RECENT_SCHEMA' });
  assert.equal(readFileSync(main, 'utf8'), 'main store must remain untouched');
});
