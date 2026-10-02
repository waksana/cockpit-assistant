import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { McpInvocationMeta, ModuleHostApi, ModuleHostIntent, ModuleHostIntentBody,
  ModuleHostIntentResult, NativeChatEvent, PublicSessionMeta } from '@waksana/cockpit-module-sdk/backend';
import { Assistant, configInput, type Config } from '../src/core.ts';
import type { Gateway } from '../src/gateway.ts';
import { Store, type Topic } from '../src/store.ts';

const identity = (toolCallId: string): McpInvocationMeta =>
  ({ sessionId: 'assistant', runtimeSessionId: 'assistant', subagent: false, toolCallId });
const message = (id: string, content = id): NativeChatEvent =>
  ({ id, type: 'assistant.message', data: { messageId: `message-${id}`, content } });
const idle = (): NativeChatEvent => ({ id: 'idle', type: 'session.idle', ephemeral: true, data: {} });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(config: Partial<Config> = {}) {
  const store = new Store(':memory:'), calls: { name: string; body: unknown }[] = [], errors: unknown[] = [];
  const meta = (id: string): PublicSessionMeta => ({
    sessionId: id, title: id, cwd: '/synthetic', loaded: true, status: 'idle', ask: null, lastActivity: 0,
    roles: [], appliedRoles: [], rolesNeedReload: false,
    activity: { processing: false, hasActiveWork: false, abortable: false, sampledAt: Date.now(),
      tasks: { activeAgents: 0, activeShells: 0, unknown: 0 },
      queue: { pendingCount: 0, steeringCount: 0, inFlightSteeringCount: 0 },
      mcp: { pendingConnectionCount: 0 } },
  });
  const sessions = new Map(['assistant', 'a', 'b', 'observer'].map(id => [id, meta(id)]));
  let onCall: ((name: string, sessionId: string) => Promise<void>) | null = null;
  let onMeta: ((id: string) => Promise<void>) | null = null;
  let failure: string | null = null, missingReceipt = false, rejectedPrompt = false;
  let loadResult: unknown = null, loadChangesState = true, sequence = 0;
  let foregroundId: string | null = 'assistant';
  const host: ModuleHostApi = {
    toolScopeVersion: 1, chatReadVersion: 1, promptReceiptVersion: 1, askResponseVersion: 1,
    async call<Name extends ModuleHostIntent>(name: Name, body: ModuleHostIntentBody<Name>): Promise<ModuleHostIntentResult<Name>> {
      calls.push({ name, body });
      const target = 'sessionId' in body ? body.sessionId ?? '' : '';
      if (onCall) await onCall(name, target);
      if (failure === name) throw new Error('Synthetic lost receipt');
      let result: unknown;
      switch (name) {
        case 'session/load':
          if (loadChangesState) sessions.get(target)!.loaded = true;
          result = loadResult ?? { ok: true, sessionId: target }; break;
        case 'prompt':
          result = { ok: !rejectedPrompt, ...(missingReceipt ? {} : { messageId: `receipt-${calls.length}` }) }; break;
        default: throw new Error(`Unexpected native call ${name}`);
      }
      return result as ModuleHostIntentResult<Name>;
    },
  };
  const native: Gateway = {
    host, async caller(call) { return { sessionId: call.sessionId!, toolCallId: call.toolCallId! }; },
    async session(id) { if (onMeta) await onMeta(id); return sessions.get(id) ?? null; },
    foregroundId: () => foregroundId,
    async foreground() { return foregroundId ? sessions.get(foregroundId) ?? null : null; },
    async setForeground(id) { foregroundId = id; },
  };
  const assistant = new Assistant(store, native, configInput.parse(config), error => errors.push(error));
  const topic = (id: string, sessionId: string | null): Topic => store.saveTopic({ id, title: id, content: '',
    version: 1, archived: false, session_id: sessionId, mapping_state: sessionId ? 'bound' : 'unbound',
    mapping_error: null, creation_receipt: null });
  const pointer = (id = 'pending', sessionId = 'a') =>
    store.enqueuePointer(sessionId, id, 'reply', { eventId: `event-${id}`, timestamp: null });
  return { store, assistant, native, sessions, calls, errors, topic, pointer,
    onCall(value: typeof onCall) { onCall = value; }, onMeta(value: typeof onMeta) { onMeta = value; },
    load(value: typeof loadResult, changesState = true) { loadResult = value; loadChangesState = changesState; },
    fail(value: string | null) { failure = value; },
    missingReceipt() { missingReceipt = true; }, rejectPrompt() { rejectedPrompt = true; },
    invoke(name: string, input: unknown = {}, id = `call-${++sequence}`) { return assistant.invoke(name, input, identity(id)); },
    close() { assistant.stop(); store.close(); },
  };
}
async function resolveInbox(f: ReturnType<typeof fixture>) {
  const result = await f.invoke('assistant_inbox') as {
    items: { id: string }[];
    receipt: { id: string } | null;
  };
  if (!result.receipt) return;
  await recordRead(f, result.receipt.id, result.items.map(item => item.id));
  await f.invoke('assistant_resolve', { receiptId: result.receipt.id, disposition: 'silent' });
}
async function recordRead(f: ReturnType<typeof fixture>, receiptId: string, ids: string[], caller = identity('checkpoint')) {
  const items = f.store.inbox().filter(item => ids.includes(item.id));
  for (const sessionId of new Set(items.map(item => item.session_id))) {
    const source = items.filter(item => item.session_id === sessionId);
    await f.assistant.invoke('assistant_checkpoint', { receiptId, sessionId,
      readIds: source.map(item => item.id), complete: true,
      position: source.every(item => item.kind === 'ask') ? null : {
        query: { source: 'persisted', direction: 'backward' }, nextQuery: null,
        boundaryEventId: f.store.source(source[0]!.id)?.eventId ?? 'synthetic-boundary',
      } }, caller);
  }
}
function pending(f: ReturnType<typeof fixture>, id = 'pending') {
  if (!f.store.topics().length) f.topic('topic', 'a');
  f.pointer(id);
}

test('recovered updates load the exact foreground, coalesce wakes, and keep unread pointers', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  try {
    pending(f); f.sessions.get('assistant')!.loaded = false;
    f.onCall(async name => { if (name === 'session/load') { entered.resolve(); await release.promise; } });
    const first = f.assistant.notify();
    await entered.promise;
    assert.equal(f.store.foregroundWake()!.state, 'loading');
    pending(f, 'second');
    const second = f.assistant.notify();
    assert.equal(first, second);
    release.resolve(); await Promise.all([first, second]);
    assert.deepEqual(f.calls.map(call => call.name), ['session/load', 'prompt']);
    assert.deepEqual(f.calls[0]!.body, { sessionId: 'assistant' });
    assert.equal((f.calls[1]!.body as { mode: string }).mode, 'enqueue');
    assert.deepEqual(f.store.inbox().map(item => item.notice_state), ['notified', 'notified']);
    assert.equal(f.store.foregroundWake()!.state, 'loaded');
    await f.assistant.notify(); assert.equal(f.calls.length, 2);
    f.sessions.get('assistant')!.loaded = false; pending(f, 'third');
    await f.assistant.notify();
    assert.deepEqual(f.calls.map(call => call.name), ['session/load', 'prompt', 'session/load', 'prompt']);
  } finally { release.resolve(); f.close(); }
});

test('empty, unrelated, duplicate, uncertain and active-source pointers never discover or load foreground', async () => {
  for (const state of ['empty', 'unrelated', 'duplicate', 'unknown', 'running', 'unloaded', 'unknown-activity', 'stale-ask']) {
    const f = fixture();
    try {
      f.sessions.get('assistant')!.loaded = false;
      if (state !== 'empty') pending(f);
      if (state === 'unrelated') f.store.saveTopic({ ...f.store.topic('topic')!, session_id: null, mapping_state: 'unbound' });
      if (state === 'duplicate' || state === 'unknown') {
        const notice = f.store.reserveNotice()!;
        f.store.settleNotice(notice.id, state === 'duplicate' ? 'receipt' : null, state === 'duplicate');
      }
      if (state === 'running') f.sessions.get('a')!.activity!.processing = true;
      if (state === 'unloaded') f.sessions.get('a')!.loaded = false;
      if (state === 'unknown-activity') f.sessions.get('a')!.activity = null;
      if (state === 'stale-ask') {
        f.store.removeResolved(f.store.inbox().map(item => item.id));
        f.store.enqueuePointer('a', 'old', 'ask');
      }
      let reads = 0;
      f.native.foreground = async () => { reads++; return f.sessions.get('assistant')!; };
      await f.assistant.notify();
      assert.equal(f.calls.length, 0, state); assert.equal(reads, 0, state);
    } finally { f.close(); }
  }
});

test('busy, queued, asking or unknown foregrounds are never interrupted', async () => {
  for (const state of ['running', 'queued', 'steering', 'asking', 'unknown']) {
    const f = fixture();
    try {
      pending(f);
      const front = f.sessions.get('assistant')!;
      if (state === 'running') front.status = 'running';
      if (state === 'queued') front.activity!.queue.pendingCount = 1;
      if (state === 'steering') front.activity!.queue.inFlightSteeringCount = 1;
      if (state === 'asking') front.ask = { requestId: 'front-ask', question: 'Busy?' };
      if (state === 'unknown') front.activity = null;
      await f.assistant.notify();
      assert.deepEqual(f.calls, [], state);
      assert.equal(f.store.inbox()[0]!.notice_state, 'pending');
    } finally { f.close(); }
  }
});

test('failed, lost, incomplete and interrupted loads never replay; manual same-ID load permits waking', async () => {
  for (const state of ['rejected', 'lost', 'wrong-id', 'not-loaded', 'incomplete', 'interrupted']) {
    const f = fixture();
    try {
      pending(f); f.sessions.get('assistant')!.loaded = false;
      if (state === 'rejected') f.load({ ok: false, sessionId: 'assistant' }, false);
      if (state === 'lost') f.fail('session/load');
      if (state === 'wrong-id') f.load({ ok: true, sessionId: 'another' }, false);
      if (state === 'incomplete') f.load({ sessionId: 'assistant' }, false);
      if (state === 'not-loaded') f.load(null, false);
      if (state === 'interrupted') f.store.saveForegroundWake({ sessionId: 'assistant', state: 'loading', error: null });
      f.store.recover(); await f.assistant.notify();
      const expected = state === 'rejected' ? 'failed' : 'unknown', count = f.calls.length;
      assert.equal(f.store.foregroundWake()!.state, expected, state);
      await f.assistant.notify(); f.store.recover(); await f.assistant.notify();
      assert.equal(f.calls.length, count, state);
      assert.equal(f.store.inbox()[0]!.notice_state, 'pending');
      assert.ok(f.calls.every(call => call.name === 'session/load'));
      f.fail(null); f.sessions.get('assistant')!.loaded = true;
      await f.assistant.notify();
      assert.equal(f.calls.at(-1)!.name, 'prompt');
      assert.equal(f.store.foregroundWake()!.state, expected, 'Recovery must retain the historical failed/unknown attempt');
    } finally { f.close(); }
  }
});

test('lost, rejected or receiptless wake acceptance is unknown, never an automatic retry or handling', async () => {
  for (const state of ['lost', 'missing', 'rejected', 'interrupted']) {
    const f = fixture();
    try {
      pending(f);
      if (state === 'lost') f.fail('prompt');
      if (state === 'missing') f.missingReceipt();
      if (state === 'rejected') f.rejectPrompt();
      if (state === 'interrupted') { f.store.reserveNotice(); f.store.recover(); }
      await f.assistant.notify();
      assert.equal(f.store.inbox()[0]!.notice_state, 'unknown');
      const count = f.calls.length;
      f.store.recover(); await f.assistant.notify();
      assert.equal(f.calls.length, count);
      const result = await f.invoke('assistant_inbox') as { receipt: { disposition: string } };
      assert.equal(result.receipt.disposition, 'unresolved');
      await resolveInbox(f);
      assert.equal(f.store.inbox().length, 0);
    } finally { f.close(); }
  }
});

test('foreground read failures and absent selection do not replace an identity or consume pointers', async () => {
  for (const state of ['missing', 'unreadable', 'unconfigured']) {
    const f = fixture();
    try {
      pending(f);
      if (state === 'unconfigured') await f.native.setForeground(null);
      else f.native.foreground = async () => { throw new Error(state); };
      await f.assistant.notify();
      assert.deepEqual(f.calls, []);
      assert.equal(f.store.inbox()[0]!.notice_state, 'pending');
      assert.equal(f.store.foregroundWake(), null);
      assert.equal(f.errors.length, state === 'unconfigured' ? 0 : 1);
    } finally { f.close(); }
  }
});

test('source, foreground and stop invalidations across discovery and load prevent stale sends', async () => {
  for (const phase of ['discovery', 'load', 'identity', 'stop', 'consumption', 'ask']) {
    const f = fixture();
    try {
      pending(f); f.sessions.get('assistant')!.loaded = false;
      if (phase === 'ask') {
        f.store.removeResolved(f.store.inbox().map(item => item.id));
        f.sessions.get('a')!.ask = { requestId: 'ask', question: 'Choose' };
        f.store.enqueuePointer('a', 'ask', 'ask');
      }
      if (phase === 'discovery') f.native.foreground = async () => {
        f.sessions.get('a')!.activity!.processing = true; return f.sessions.get('assistant')!;
      };
      f.onCall(async name => {
        if (name !== 'session/load') return;
        if (phase === 'load') f.sessions.get('a')!.activity!.processing = true;
        if (phase === 'identity') await f.native.setForeground('b');
        if (phase === 'stop') f.assistant.stop();
        if (phase === 'consumption') await resolveInbox(f);
        if (phase === 'ask') f.sessions.get('a')!.ask = null;
      });
      await f.assistant.notify();
      assert.deepEqual(f.calls.map(call => call.name), phase === 'discovery' ? [] : ['session/load'], phase);
      assert.equal(f.store.inbox().length, ['consumption', 'ask'].includes(phase) ? 0 : 1, phase);
    } finally { f.close(); }
  }
});

test('stopping during foreground discovery prevents notice reservation', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  try {
    pending(f);
    f.native.foreground = async () => { entered.resolve(); await release.promise; return f.sessions.get('assistant')!; };
    const sending = f.assistant.notify();
    await entered.promise; f.assistant.stop(); release.resolve(); await sending;
    assert.deepEqual(f.calls, []); assert.equal(f.store.inbox()[0]!.notice_state, 'pending');
    await assert.rejects(f.invoke('assistant_topics'), { code: 'STOPPING' });
  } finally { release.resolve(); f.close(); }
});

test('registry edits are idempotent for minimal Host callers without role or input provenance', async () => {
  const f = fixture();
  try {
    const query = { title: 'Travel', content: 'Discussion only', sessionId: 'a' };
    const first = await f.invoke('assistant_topic', query, 'create-once') as { topicId: string };
    assert.deepEqual(await f.invoke('assistant_topic', query, 'create-once'), first);
    assert.equal(f.store.topics().length, 1);
    await assert.rejects(f.invoke('assistant_topic', { ...query, title: 'Changed' }, 'create-once'), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(f.invoke('assistant_topic', { topicId: 'invented', title: 'New' }), { code: 'TOPIC_NOT_FOUND' });
    await assert.rejects(f.invoke('assistant_topic', { title: 'Missing', sessionId: 'not-there' }), { code: 'MAPPING_TARGET' });
    await f.invoke('assistant_topic', { topicId: first.topicId, archived: true, sessionId: null });
    const result = await f.invoke('assistant_topics') as { items: { sessionId: string | null; archived: boolean; warning: string }[] };
    assert.equal(result.items[0]!.sessionId, null); assert.equal(result.items[0]!.archived, true);
    assert.match(result.items[0]!.warning, /never current progress/);
    assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});

test('business and evidence tools are explicitly retired without any Host calls or delivery replay', async () => {
  const f = fixture({ defaultCwd: '/legacy', worker: { roles: [{ moduleId: 'assistant', roleId: 'worker' }] } });
  try {
    f.topic('topic', 'a');
    for (const tool of ['assistant_dispatch', 'assistant_history', 'assistant_status', 'assistant_read']) {
      await assert.rejects(f.invoke(tool, { items: [{ topicId: 'topic', prompt: 'Do more' }] }), { code: 'TOOL_RETIRED' });
      await assert.rejects(f.invoke(tool, {}), { code: 'TOOL_RETIRED' });
    }
    assert.deepEqual(f.calls, []);
    assert.deepEqual(configInput.parse({}), { foregroundSessionId: null });
    assert.equal(f.assistant.config.defaultCwd, '/legacy');
    assert.equal(f.store.topic('topic').session_id, 'a');
  } finally { f.close(); }
});

test('legacy unknown and interrupted deliveries stay inert across recovery and never enroll their sessions', async () => {
  const f = fixture();
  try {
    f.store.saveTopic({ ...f.topic('legacy', null), mapping_state: 'calling',
      creation_receipt: { sessionId: 'a', stage: 'creation', promptAttempted: false } });
    for (const state of ['unknown', 'calling']) f.store.sql.prepare(`INSERT INTO deliveries
      (id,source_session,source_message,topic_id,fingerprint,session_id,state,mode,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(state, 'assistant', state, 'legacy', 'archived-fingerprint', 'a', state, 'prompt', 1);
    const before = f.store.sql.prepare('SELECT * FROM deliveries ORDER BY id').all(), topic = f.store.topic('legacy');
    for (let index = 0; index < 2; index++) {
      f.store.recover();
      await f.assistant.observe('a', message('legacy-update')); await f.assistant.observe('a', idle());
      await f.assistant.notify();
      await assert.rejects(f.invoke('assistant_dispatch', { items: [{ topicId: 'legacy', prompt: 'Old request' }] }),
        { code: 'TOOL_RETIRED' });
    }
    assert.deepEqual(f.store.sql.prepare('SELECT * FROM deliveries ORDER BY id').all(), before);
    assert.deepEqual(f.store.topic('legacy'), topic);
    assert.equal(f.store.managed('a'), false);
    assert.deepEqual(f.store.inbox(), []); assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});

test('concurrent registry edits detect a changed mapping after native lookup instead of overwriting it', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  try {
    f.topic('topic', 'a');
    f.onMeta(async id => { if (id === 'b') { entered.resolve(); await release.promise; } });
    const first = f.invoke('assistant_topic', { topicId: 'topic', sessionId: 'b', title: 'Stale title' });
    await entered.promise;
    await f.invoke('assistant_topic', { topicId: 'topic', title: 'Current title' });
    release.resolve();
    await assert.rejects(first, { code: 'TOPIC_CHANGED' });
    assert.equal(f.store.topic('topic').title, 'Current title');
    assert.equal(f.store.topic('topic').session_id, 'a');
    assert.deepEqual(f.calls, []);
  } finally { release.resolve(); f.close(); }
});

test('foreground supports passive query, explicit selection and null without human or role selection', async () => {
  const f = fixture();
  try {
    await f.native.setForeground(null);
    assert.equal((await f.invoke('assistant_foreground') as { foregroundSessionId: unknown }).foregroundSessionId, null);
    f.sessions.get('b')!.rolesNeedReload = true;
    assert.equal((await f.invoke('assistant_foreground', { sessionId: 'b' }) as { foregroundSessionId: string }).foregroundSessionId, 'b');
    assert.equal((await f.invoke('assistant_foreground', { sessionId: null }) as { foregroundSessionId: unknown }).foregroundSessionId, null);
    assert.deepEqual(f.calls, []);
    await assert.rejects(f.invoke('assistant_foreground', { human: true }));
  } finally { f.close(); }
});

test('foreground health is passive and preserves historical unknown wake facts', async () => {
  const f = fixture();
  try {
    pending(f); f.sessions.get('assistant')!.loaded = false;
    f.store.saveForegroundWake({ sessionId: 'assistant', state: 'unknown', error: 'Lost load acknowledgement' });
    const result = await f.invoke('assistant_foreground') as {
      current: { loaded: boolean }; lastWakeAttempt: { state: string; error: string };
    };
    assert.equal(result.current.loaded, false);
    assert.equal(result.lastWakeAttempt.state, 'unknown');
    assert.equal(result.lastWakeAttempt.error, 'Lost load acknowledgement');
    assert.deepEqual(f.calls, []);
    f.sessions.get('assistant')!.loaded = true;
    assert.equal((await f.assistant.health()).current.loaded, true);
    assert.equal(f.store.foregroundWake()!.state, 'unknown');
    assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});

test('foreground health retains the configured identity when metadata is missing or unreadable', async () => {
  for (const state of ['missing', 'read-error']) {
    const f = fixture();
    try {
      await f.native.setForeground('configured-original');
      if (state === 'read-error') f.native.foreground = async () => { throw new Error('Host metadata unavailable'); };
      const result = await f.invoke('assistant_foreground') as {
        foregroundSessionId: string; current: { sessionId?: string | null; status: string; error?: string };
      };
      assert.equal(result.foregroundSessionId, 'configured-original');
      if (state === 'read-error') {
        assert.equal(result.current.status, 'unknown');
        assert.match(result.current.error!, /Host metadata unavailable/);
      } else assert.equal(result.current.sessionId, null);
      assert.equal(f.native.foregroundId(), 'configured-original');
      assert.deepEqual(f.calls, []);
      assert.equal(f.store.foregroundWake(), null);
    } finally { f.close(); }
  }
});

test('explicit rebind repairs unknown mappings while retaining archived creation and error facts', async () => {
  const f = fixture();
  try {
    const legacy = { stage: 'creation', sessionId: 'possibly-created', promptAttempted: false };
    f.store.saveTopic({ ...f.topic('legacy', null), mapping_state: 'unknown',
      mapping_error: 'Creation acknowledgement lost', creation_receipt: legacy });
    await f.invoke('assistant_topic', { topicId: 'legacy', sessionId: 'b' });
    const repaired = f.store.topic('legacy');
    assert.equal(repaired.session_id, 'b');
    assert.equal(repaired.mapping_state, 'bound');
    assert.equal(repaired.mapping_error, 'Creation acknowledgement lost');
    assert.deepEqual(repaired.creation_receipt, legacy);
    assert.equal(repaired.version, 2);
    await assert.rejects(f.invoke('assistant_topic', { topicId: 'legacy', sessionId: 'missing' }), { code: 'MAPPING_TARGET' });
    assert.deepEqual(f.store.topic('legacy'), repaired);
    assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});

test('foreground activity observed during source sampling prevents a stale idle wake', async () => {
  const f = fixture();
  try {
    pending(f);
    let samples = 0;
    f.onMeta(async id => {
      if (id === 'a' && ++samples === 2) await f.assistant.observe('assistant');
    });
    await f.assistant.notify();
    assert.equal(f.calls.length, 0);
    assert.equal(f.store.inbox()[0]!.notice_state, 'pending');
    f.onMeta(null); await f.assistant.notify();
    assert.equal(f.calls.length, 1);
  } finally { f.close(); }
});

test('separate read and handling reports certify neither native Chat reading nor physical delivery', async () => {
  const f = fixture();
  try {
    pending(f);
    const result = await f.invoke('assistant_inbox', { limit: 1 }) as {
      receipt: { id: string }; items: { id: string }[]; consumed: boolean; warning: string;
    };
    assert.equal(result.consumed, false); assert.match(result.warning, /not progress evidence/);
    await assert.rejects(f.invoke('assistant_resolve', { receiptId: result.receipt.id, disposition: 'notified' }),
      { code: 'READ_INCOMPLETE' });
    await recordRead(f, result.receipt.id, result.items.map(item => item.id));
    assert.equal(f.store.inbox().length, 1, 'Read reports are not handling');
    f.pointer('later');
    const report = await f.invoke('assistant_resolve', { receiptId: result.receipt.id, disposition: 'notified' }) as {
      disposition: string; basis: string; userDeliveryVerified: boolean; chatReadVerified: boolean;
    };
    assert.equal(report.disposition, 'reported-notified');
    assert.equal(report.basis, 'agent-reported-handling');
    assert.equal(report.userDeliveryVerified, false);
    assert.equal(report.chatReadVerified, false);
    assert.deepEqual(f.store.inbox().map(item => item.native_id), ['later']);
    assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});

test('ordinary nonforeground callers can list and handle only their exact returned inbox range', async () => {
  const f = fixture();
  try {
    pending(f); f.pointer('second');
    const caller = { ...identity('nonfront-read'), sessionId: 'observer', runtimeSessionId: 'observer' };
    const read = await f.assistant.invoke('assistant_inbox', { limit: 1 }, caller) as {
      items: { id: string; sequence: number }[]; receipt: { id: string; owner: string; inboxIds: string[] };
      hasMore: boolean; nextAfter: number;
    };
    assert.equal(read.receipt.owner, 'observer');
    assert.deepEqual(read.receipt.inboxIds, read.items.map(item => item.id));
    assert.equal(read.hasMore, true); assert.equal(read.nextAfter, read.items[0]!.sequence);
    assert.equal(f.store.inbox().length, 2);
    await assert.rejects(f.invoke('assistant_resolve', { receiptId: read.receipt.id, disposition: 'silent' }), { code: 'READ_RECEIPT' });
    await recordRead(f, read.receipt.id, read.items.map(item => item.id), caller);
    f.pointer('concurrent');
    const report = await f.assistant.invoke('assistant_resolve', { receiptId: read.receipt.id, disposition: 'silent' },
      { ...caller, toolCallId: 'nonfront-resolve' }) as { disposition: string; userDeliveryVerified: boolean };
    assert.equal(report.disposition, 'silent'); assert.equal(report.userDeliveryVerified, false);
    assert.deepEqual(f.store.inbox().map(item => item.native_id), ['second', 'concurrent']);
    assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});

test('empty and filtered inbox pages do not create receipts or consume unrelated IDs', async () => {
  const f = fixture();
  try {
    const empty = await f.invoke('assistant_inbox') as { items: unknown[]; receipt: unknown };
    assert.deepEqual(empty.items, []); assert.equal(empty.receipt, null);
    pending(f); f.pointer('second');
    const selected = f.store.inbox()[1]!;
    const result = await f.invoke('assistant_inbox', { ids: [selected.id] }) as {
      items: { id: string }[]; receipt: { id: string; inboxIds: string[] };
    };
    assert.deepEqual(result.items.map(item => item.id), [selected.id]);
    assert.deepEqual(result.receipt.inboxIds, [selected.id]);
    await recordRead(f, result.receipt.id, [selected.id]);
    await f.invoke('assistant_resolve', { receiptId: result.receipt.id, disposition: 'silent' });
    assert.deepEqual(f.store.inbox().map(item => item.native_id), ['pending']);
    assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});

test('interrupted handling receipts remain paginated and repeated handling never restores items', async () => {
  const f = fixture();
  try {
    f.topic('topic', 'a');
    const ids: string[] = [];
    for (let index = 0; index < 52; index++) {
      f.pointer(`result-${index}`);
      const item = f.store.inbox().at(-1)!;
      const result = await f.invoke('assistant_inbox', { ids: [item.id] }) as { receipt: { id: string } };
      ids.push(result.receipt.id);
    }
    f.store.recover();
    const first = await f.invoke('assistant_inbox', { ids: ['not-found'] }) as {
      receipt: null; pendingDecisions: { items: { id: string }[]; hasMore: boolean; nextAfter: number };
    };
    assert.equal(first.receipt, null);
    assert.equal(first.pendingDecisions.items.length, 50); assert.equal(first.pendingDecisions.hasMore, true);
    const second = await f.invoke('assistant_inbox', { ids: ['not-found'], decisionsAfter: first.pendingDecisions.nextAfter }) as {
      pendingDecisions: { items: { id: string }[]; hasMore: boolean };
    };
    assert.equal(second.pendingDecisions.items.length, 2); assert.equal(second.pendingDecisions.hasMore, false);
    assert.deepEqual([...first.pendingDecisions.items, ...second.pendingDecisions.items].map(item => item.id), ids);
    await recordRead(f, ids[0]!, [f.store.inbox()[0]!.id]);
    const report = await f.invoke('assistant_resolve', { receiptId: ids[0], disposition: 'notified' });
    assert.deepEqual(await f.invoke('assistant_resolve', { receiptId: ids[0], disposition: 'notified' }), report);
    await assert.rejects(f.invoke('assistant_resolve', { receiptId: ids[0], disposition: 'silent' }), { code: 'DECISION_CONFLICT' });
    assert.equal(f.store.inbox().length, 51);
    assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});

test('an expired ask receipt can be handled harmlessly without answering a native question', async () => {
  const f = fixture();
  try {
    f.topic('topic', 'a'); f.sessions.get('assistant')!.status = 'running';
    f.sessions.get('a')!.ask = { requestId: 'ask', question: 'Original question' };
    await f.assistant.observe('a');
    const first = await f.invoke('assistant_inbox') as { receipt: { id: string } };
    f.sessions.get('a')!.ask = null;
    await f.invoke('assistant_inbox');
    assert.equal(f.store.inbox().length, 0);
    const report = await f.invoke('assistant_resolve', { receiptId: first.receipt.id, disposition: 'silent' }) as {
      disposition: string; userDeliveryVerified: boolean;
    };
    assert.equal(report.disposition, 'silent'); assert.equal(report.userDeliveryVerified, false);
    assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});

test('interrupted multi-page reads recover their continuation without advancing or handling unread IDs', async () => {
  const f = fixture();
  try {
    pending(f);
    const page = await f.invoke('assistant_inbox') as { items: { id: string }[]; receipt: { id: string } };
    const partial = { receiptId: page.receipt.id, sessionId: 'a', readIds: [], complete: false,
      position: { query: { source: 'persisted', direction: 'backward' },
        nextQuery: { source: 'persisted', direction: 'backward', cursor: 'host-opaque-older' }, boundaryEventId: null } };
    await assert.rejects(f.invoke('assistant_checkpoint', { ...partial, readIds: page.items.map(item => item.id) }),
      { code: 'READ_INCOMPLETE' });
    const result = await f.invoke('assistant_checkpoint', partial) as {
      checkpointState: string; basis: string; chatReadVerified: boolean;
    };
    assert.equal(result.checkpointState, 'not-advanced');
    assert.equal(result.basis, 'agent-reported-reading'); assert.equal(result.chatReadVerified, false);
    await assert.rejects(f.invoke('assistant_resolve', { receiptId: page.receipt.id, disposition: 'silent' }), { code: 'READ_INCOMPLETE' });
    f.pointer('concurrent');
    const restarted = new Assistant(f.store, f.native, f.assistant.config, error => f.errors.push(error));
    const recovered = await restarted.invoke('assistant_inbox', { ids: [page.items[0]!.id] }, identity('recovered')) as {
      receipt: { id: string; sources: { checkpoint: unknown }[];
        progress: { complete: boolean; readIds: string[]; position: { nextQuery: { cursor: string } } }[] };
    };
    assert.equal(recovered.receipt.id, page.receipt.id);
    assert.equal(recovered.receipt.sources[0]!.checkpoint, null);
    assert.equal(recovered.receipt.progress[0]!.complete, false);
    assert.deepEqual(recovered.receipt.progress[0]!.readIds, []);
    assert.equal(recovered.receipt.progress[0]!.position.nextQuery.cursor, 'host-opaque-older');
    await recordRead(f, page.receipt.id, page.items.map(item => item.id));
    assert.equal(f.store.inbox().length, 2);
    await restarted.invoke('assistant_resolve', { receiptId: page.receipt.id, disposition: 'silent' }, identity('recovered-resolve'));
    assert.deepEqual(f.store.inbox().map(item => item.native_id), ['concurrent']);
    restarted.stop(); assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});

test('older concurrent read receipts cannot replace a newer checkpoint but can handle their own exact IDs', async () => {
  const f = fixture();
  try {
    pending(f);
    const old = await f.invoke('assistant_inbox') as { receipt: { id: string }; items: { id: string }[] };
    f.pointer('newer');
    const newer = await f.invoke('assistant_inbox') as { receipt: { id: string }; items: { id: string }[] };
    const report = (receiptId: string, readIds: string[], boundaryEventId: string) => f.invoke('assistant_checkpoint', {
      receiptId, sessionId: 'a', readIds, complete: true,
      position: { query: { source: 'persisted', direction: 'backward' }, nextQuery: null, boundaryEventId },
    }) as Promise<{ checkpointState: string }>;
    assert.equal((await report(newer.receipt.id, newer.items.map(item => item.id), 'event-newer')).checkpointState, 'advanced');
    assert.equal((await report(old.receipt.id, old.items.map(item => item.id), 'event-pending')).checkpointState, 'stale-base');
    f.pointer('latest');
    const current = await f.invoke('assistant_inbox') as {
      receipt: { sources: { checkpoint: { receiptId: string; position: { boundaryEventId: string } } }[] };
    };
    assert.equal(current.receipt.sources[0]!.checkpoint.receiptId, newer.receipt.id);
    assert.equal(current.receipt.sources[0]!.checkpoint.position.boundaryEventId, 'event-newer');
    await f.invoke('assistant_resolve', { receiptId: old.receipt.id, disposition: 'silent' });
    assert.deepEqual(f.store.inbox().map(item => item.native_id), ['newer', 'latest']);
    assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});

test('read checkpoint continuations cannot mix Host source or direction except live bootstrap forward', async () => {
  const f = fixture();
  try {
    pending(f);
    const page = await f.invoke('assistant_inbox') as { receipt: { id: string }; items: { id: string }[] };
    const report = (query: unknown, nextQuery: unknown, extra = {}) => f.invoke('assistant_checkpoint', {
      receiptId: page.receipt.id, sessionId: 'a', readIds: [], complete: false,
      position: { query, nextQuery, boundaryEventId: null }, ...extra,
    });
    await assert.rejects(report({ source: 'persisted', direction: 'backward' },
      { source: 'live', direction: 'backward', cursor: 'foreign' }), { code: 'CHECKPOINT_QUERY' });
    await assert.rejects(report({ source: 'persisted', direction: 'backward' },
      { source: 'persisted', direction: 'forward', cursor: 'wrong-direction' }), { code: 'CHECKPOINT_QUERY' });
    await assert.rejects(report({ source: 'persisted', direction: 'backward', bootstrap: true }, null),
      { code: 'CHECKPOINT_QUERY' });
    await report({ source: 'live', direction: 'backward', bootstrap: true },
      { source: 'live', direction: 'forward', cursor: 'host-live-cursor' });
    await assert.rejects(report({ source: 'persisted', direction: 'backward' }, null), { code: 'CHECKPOINT_QUERY' });
    const completed = await f.invoke('assistant_checkpoint', {
      receiptId: page.receipt.id, sessionId: 'a', readIds: page.items.map(item => item.id), complete: true,
      position: { query: { source: 'live', direction: 'forward', cursor: 'host-live-cursor' },
        nextQuery: null, boundaryEventId: 'event-pending' },
    }) as { checkpointState: string };
    assert.equal(completed.checkpointState, 'advanced');
    await f.invoke('assistant_resolve', { receiptId: page.receipt.id, disposition: 'silent' });
    assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});

test('gapped reads require explicit reset and complete Chat reports require actual boundary positions', async () => {
  const f = fixture();
  try {
    pending(f);
    const page = await f.invoke('assistant_inbox') as { receipt: { id: string }; items: { id: string }[] };
    const base = { receiptId: page.receipt.id, sessionId: 'a', readIds: page.items.map(item => item.id), complete: true,
      position: { query: { source: 'persisted', direction: 'backward' }, nextQuery: null, boundaryEventId: 'event-pending' } };
    await assert.rejects(f.invoke('assistant_checkpoint', { ...base, position: null }), { code: 'READ_POSITION' });
    await assert.rejects(f.invoke('assistant_checkpoint', { ...base, position: { ...base.position, boundaryEventId: null } }),
      { code: 'READ_POSITION' });
    await assert.rejects(f.invoke('assistant_checkpoint', { ...base, position: { ...base.position, coverage: 'since-checkpoint' } }),
      { code: 'CHECKPOINT_BOUNDARY' });
    await f.invoke('assistant_checkpoint', { ...base, complete: false, readIds: [], gap: 'Host cursor expired after rewind' });
    await assert.rejects(f.invoke('assistant_checkpoint', base), { code: 'READ_GAP' });
    await assert.rejects(f.invoke('assistant_resolve', { receiptId: page.receipt.id, disposition: 'notified' }),
      { code: 'READ_INCOMPLETE' });
    const reset = await f.invoke('assistant_checkpoint', { ...base, reset: true }) as { checkpointState: string };
    assert.equal(reset.checkpointState, 'advanced');
    await assert.rejects(f.invoke('assistant_checkpoint', { ...base, readIds: [], complete: false }), { code: 'READ_COMPLETE' });
    await f.invoke('assistant_resolve', { receiptId: page.receipt.id, disposition: 'notified' });
    assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});

test('read reports cannot cover another caller, source or IDs outside their receipt', async () => {
  const f = fixture();
  try {
    pending(f); f.topic('second-topic', 'b'); f.pointer('second', 'b');
    const page = await f.invoke('assistant_inbox') as { receipt: { id: string }; items: { id: string }[] };
    const base = { receiptId: page.receipt.id, sessionId: 'a', readIds: [page.items[0]!.id], complete: true,
      position: { query: { source: 'persisted', direction: 'backward' }, nextQuery: null, boundaryEventId: 'event-pending' } };
    await assert.rejects(f.assistant.invoke('assistant_checkpoint', base, { ...identity('foreign'), sessionId: 'observer' }),
      { code: 'READ_RECEIPT' });
    await assert.rejects(f.invoke('assistant_checkpoint', { ...base, sessionId: 'missing' }), { code: 'CHECKPOINT_SOURCE' });
    for (const readIds of [[page.items[1]!.id], ['not-returned'], [page.items[0]!.id, page.items[0]!.id]])
      await assert.rejects(f.invoke('assistant_checkpoint', { ...base, readIds }), { code: 'READ_IDS' });
    await f.invoke('assistant_checkpoint', base);
    await assert.rejects(f.invoke('assistant_resolve', { receiptId: page.receipt.id, disposition: 'silent' }), { code: 'READ_INCOMPLETE' });
    await recordRead(f, page.receipt.id, [page.items[1]!.id]);
    await f.invoke('assistant_resolve', { receiptId: page.receipt.id, disposition: 'silent' });
    assert.equal(f.store.inbox().length, 0); assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});

test('only managed primary messages become body-free pointers and idle is not proof of success', async () => {
  const f = fixture();
  try {
    f.topic('topic', 'a'); f.sessions.get('assistant')!.status = 'running';
    const event = { ...message('reply', 'Private result body'), data: {
      messageId: 'native-reply', content: 'Private result body', reasoningOpaque: 'encrypted reasoning',
      toolRequests: [{ toolCallId: 'internal-action' }],
      attachments: [{ type: 'blob', data: 'inline-secret', mimeType: 'image/png' }],
    } };
    await f.assistant.observe('observer', event);
    for (const excluded of [{ ...event, ephemeral: true }, { ...event, agentId: 'child' },
      { ...event, parentToolCallId: 'parent' }, message('empty', ' \n')]) await f.assistant.observe('a', excluded);
    assert.equal(f.store.inbox().length, 0);
    await f.assistant.observe('a', event);
    assert.equal(f.store.inbox().length, 1);
    await f.assistant.observe('a', idle());
    f.sessions.get('assistant')!.status = 'idle'; await f.assistant.notify();
    assert.equal(f.calls.length, 1);
    const result = await f.invoke('assistant_inbox') as { consumed: boolean };
    assert.equal(result.consumed, false);
    assert.doesNotMatch(JSON.stringify([result, f.calls, f.store.inbox(), f.store.sql.prepare('SELECT * FROM seen').all()]),
      /Private result body|encrypted reasoning|inline-secret|internal-action/);
    await resolveInbox(f);
    await f.assistant.observe('a', event);
    assert.equal(f.store.inbox().length, 0); assert.equal(f.calls.length, 1);
  } finally { f.close(); }
});

test('legacy body rows remain archived unchanged while new listing, observation and handling use pointers only', async () => {
  const f = fixture();
  try {
    f.topic('topic', 'a'); f.sessions.get('assistant')!.status = 'running';
    f.store.enqueue({ session_id: 'a', native_id: 'message-legacy', kind: 'reply',
      text: 'Preserved legacy private body', attachments: [], question: null }, 'pending',
    { eventId: 'legacy', timestamp: null });
    f.store.sql.prepare('UPDATE mailbox SET text=? WHERE native_id=?').run('Preserved legacy private body', 'message-legacy');
    const archived = f.store.sql.prepare('SELECT * FROM mailbox').all();
    await f.assistant.observe('a', message('legacy', 'Preserved legacy private body'));
    await f.assistant.observe('a', message('fresh', 'Fresh private body'));
    const result = await f.invoke('assistant_inbox') as { items: { id: string; source: { eventId: string } }[] };
    assert.deepEqual(result.items.map(item => item.source.eventId), ['legacy', 'fresh']);
    assert.doesNotMatch(JSON.stringify(result), /Preserved legacy private body|Fresh private body/);
    assert.equal(f.store.inbox()[1]!.text, '');
    await resolveInbox(f);
    assert.equal(f.store.inbox().length, 0);
    assert.deepEqual(f.store.sql.prepare('SELECT * FROM mailbox').all(), archived);
    await f.assistant.observe('a', message('legacy', 'Preserved legacy private body'));
    await f.assistant.observe('a', message('fresh', 'Fresh private body'));
    assert.equal(f.store.inbox().length, 0); assert.deepEqual(f.calls, []);
    assert.doesNotMatch(JSON.stringify(f.store.sql.prepare('SELECT * FROM seen').all()), /Fresh private body/);
  } finally { f.close(); }
});

test('progress, queued and unknown source activity wait for known idle and an idle foreground', async () => {
  const f = fixture();
  try {
    f.topic('topic', 'a');
    const source = f.sessions.get('a')!;
    source.status = 'running'; source.activity!.processing = true; source.activity!.hasActiveWork = true;
    for (const event of [message('progress'), message('final-a'), message('queued-b'), message('final-b')])
      await f.assistant.observe('a', event);
    assert.equal(f.store.inbox().length, 4); assert.equal(f.calls.length, 0);
    source.status = 'idle'; source.activity!.processing = false; source.activity!.hasActiveWork = false;
    source.activity!.queue.pendingCount = 1;
    await f.assistant.notify(); assert.equal(f.calls.length, 0);
    source.activity!.queue.pendingCount = 0;
    const activity = source.activity; source.activity = null;
    await f.assistant.notify(); assert.equal(f.calls.length, 0);
    source.activity = activity; f.sessions.get('assistant')!.status = 'running';
    await f.assistant.observe('a', idle()); assert.equal(f.calls.length, 0);
    f.sessions.get('assistant')!.status = 'idle'; await f.assistant.notify();
    assert.equal(f.calls.length, 1);
    assert.match((f.calls[0]!.body as { text: string }).text, /Idle is not proof of business completion/);
    await resolveInbox(f);
    await f.assistant.observe('a', message('final-b'));
    assert.equal(f.calls.length, 1);
  } finally { f.close(); }
});

test('current asks can wake a running source without bundling unfinished progress or exposing question bodies', async () => {
  const f = fixture();
  try {
    f.topic('topic', 'a'); f.sessions.get('assistant')!.loaded = false;
    const source = f.sessions.get('a')!;
    source.status = 'running'; source.activity!.processing = true;
    source.ask = { requestId: 'current', question: 'Private question', choices: ['A', 'B'] };
    await f.assistant.observe('a', message('progress'));
    assert.deepEqual(f.calls.map(call => call.name), ['session/load', 'prompt']);
    const notice = (f.calls[1]!.body as { text: string }).text;
    assert.match(notice, /"kind":"ask"/); assert.doesNotMatch(notice, /"kind":"reply"|Private question/);
    assert.deepEqual(f.store.inbox().map(item => item.notice_state), ['pending', 'notified']);
    const ask = f.store.inbox().find(item => item.kind === 'ask')!;
    assert.equal(ask.text, ''); assert.equal(ask.question, null); assert.deepEqual(ask.attachments, []);
    const listed = await f.invoke('assistant_inbox') as { items: { questionRequestId?: string }[] };
    assert.equal(listed.items.find(item => item.questionRequestId)?.questionRequestId, 'current');
    assert.doesNotMatch(JSON.stringify([listed, f.store.sql.prepare('SELECT * FROM seen').all()]),
      /Private question|"choices"|"allowFreeform"/);
    source.ask = null;
    const inbox = await f.invoke('assistant_inbox') as { items: { type: string }[] };
    assert.deepEqual(inbox.items.map(item => item.type), ['reply']);
    await f.assistant.notify(); assert.equal(f.calls.length, 2);
  } finally { f.close(); }
});

test('stale asks expire while unloaded asks retain identity without claiming read or presentation', async () => {
  const f = fixture();
  try {
    f.topic('topic', 'a'); f.sessions.get('assistant')!.status = 'running';
    const source = f.sessions.get('a')!;
    source.ask = { requestId: 'old', question: 'Old' }; await f.assistant.observe('a');
    source.ask = { requestId: 'new', question: 'Current' }; await f.assistant.observe('a');
    source.loaded = false;
    assert.deepEqual(await f.invoke('assistant_inbox', { peek: true }), { count: 0 });
    assert.deepEqual(f.store.inbox().map(item => item.native_id), ['new']);
    const unavailable = await f.invoke('assistant_inbox') as { items: unknown[]; receipt: unknown };
    assert.deepEqual(unavailable.items, []); assert.equal(unavailable.receipt, null);
    source.loaded = true;
    const available = await f.invoke('assistant_inbox') as { items: { questionRequestId: string }[]; receipt: { disposition: string } };
    assert.equal(available.items[0]!.questionRequestId, 'new');
    assert.equal(available.receipt.disposition, 'unresolved'); assert.equal(f.store.inbox().length, 1);
    await resolveInbox(f);
    await f.assistant.observe('a');
    assert.deepEqual(f.calls, []); assert.equal(f.store.inbox().length, 0);
  } finally { f.close(); }
});

test('manual handling before source idle does not leave a fresh reminder', async () => {
  const f = fixture();
  try {
    f.topic('topic', 'a');
    const source = f.sessions.get('a')!;
    source.status = 'running'; source.activity!.processing = true;
    await f.assistant.observe('a', message('manual-progress'));
    await resolveInbox(f);
    source.status = 'idle'; source.activity!.processing = false;
    await f.assistant.observe('a', idle());
    assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});

test('abort and error pointers retain incomplete native identities, not successful completion', async () => {
  for (const type of ['abort', 'session.error']) {
    const f = fixture();
    try {
      f.topic('topic', 'a');
      const source = f.sessions.get('a')!;
      source.status = 'running'; source.activity!.processing = true;
      const event = { id: type, type, data: { message: 'Failure detail' } };
      await f.assistant.observe('a', message('partial')); await f.assistant.observe('a', event);
      assert.deepEqual(f.calls, []);
      source.status = type === 'abort' ? 'idle' : 'error'; source.activity!.processing = false;
      await f.assistant.observe('a', idle());
      assert.equal(f.calls.length, 1);
      assert.equal(f.store.source(f.store.inbox()[1]!.id)?.eventId, type);
      assert.equal(f.store.inbox()[1]!.text, '');
      await resolveInbox(f); await f.assistant.observe('a', event);
      assert.equal(f.calls.length, 1);
    } finally { f.close(); }
  }
});

test('in-flight notice completion cannot restore handled rows or lose later arrivals', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  try {
    pending(f);
    f.onCall(async name => { if (name === 'prompt') { entered.resolve(); await release.promise; } });
    const first = f.assistant.notify();
    await entered.promise; await resolveInbox(f);
    f.pointer('later'); f.sessions.get('assistant')!.status = 'running';
    const again = f.assistant.notify();
    release.resolve(); await Promise.all([first, again]);
    assert.deepEqual(f.store.inbox().map(item => [item.native_id, item.notice_state]), [['later', 'pending']]);
  } finally { release.resolve(); f.close(); }
});

test('the original notification promise drains follow-up sends and records an in-flight receipt after stop', async () => {
  const f = fixture(), firstEntered = deferred(), firstRelease = deferred(), nextEntered = deferred(), nextRelease = deferred();
  try {
    pending(f);
    let count = 0, finished = false;
    f.onCall(async name => {
      if (name !== 'prompt') return;
      if (++count === 1) { firstEntered.resolve(); await firstRelease.promise; }
      else { nextEntered.resolve(); await nextRelease.promise; }
    });
    const notification = f.assistant.notify().then(() => { finished = true; });
    await firstEntered.promise; f.pointer('second');
    const continuation = f.assistant.notify();
    firstRelease.resolve(); await nextEntered.promise;
    assert.equal(finished, false); assert.equal(f.store.inbox()[1]!.notice_state, 'calling');
    f.assistant.stop(); nextRelease.resolve();
    await Promise.all([notification, continuation]);
    assert.equal(finished, true);
    assert.deepEqual(f.store.inbox().map(item => item.notice_state), ['notified', 'notified']);
    assert.deepEqual(f.errors, []);
  } finally { firstRelease.resolve(); nextRelease.resolve(); f.close(); }
});

test('an arrival during empty notification-loop exit receives a reminder without another wake', async () => {
  const f = fixture();
  try {
    f.topic('topic', 'a');
    const empty = f.assistant.notify(), arrived = f.assistant.observe('a', message('at-loop-exit'));
    const settled = f.assistant.observe('a', idle());
    await Promise.all([empty, arrived, settled]);
    assert.equal(f.calls.length, 1); assert.equal(f.store.inbox()[0]!.notice_state, 'notified');
  } finally { f.close(); }
});

test('overlapping callbacks drain in order and do not flush a partial batch on idle metadata alone', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  try {
    f.topic('topic', 'a');
    let first = true;
    f.onMeta(async id => { if (id === 'a' && first) { first = false; entered.resolve(); await release.promise; } });
    const progress = f.assistant.observe('a', message('slow-progress'));
    await entered.promise;
    const final = f.assistant.observe('a', message('final'));
    release.resolve(); await Promise.all([progress, final]);
    assert.deepEqual(f.calls, []);
    await f.assistant.observe('a', idle());
    assert.deepEqual(f.store.inbox().map(item => [f.store.source(item.id)?.eventId, item.notice_state]),
      [['slow-progress', 'notified'], ['final', 'notified']]);
    await resolveInbox(f); await f.assistant.observe('a', message('final'));
    assert.equal(f.calls.length, 1);
  } finally { release.resolve(); f.close(); }
});

test('source resumption while another source is sampled invalidates notice eligibility before reservation', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  try {
    f.topic('one', 'a'); f.topic('two', 'b'); f.pointer('a'); f.pointer('b', 'b');
    let paused = false;
    f.onMeta(async id => { if (id === 'b' && !paused) { paused = true; entered.resolve(); await release.promise; } });
    const notice = f.assistant.notify();
    await entered.promise;
    f.sessions.get('a')!.status = 'running'; f.sessions.get('a')!.activity!.processing = true;
    const resumed = f.assistant.observe('a', message('resumed'));
    release.resolve(); await Promise.all([notice, resumed]);
    assert.equal(f.calls.length, 1);
    assert.doesNotMatch((f.calls[0]!.body as { text: string }).text, /"sessionId":"a"/);
    assert.deepEqual(f.store.inbox().filter(item => item.session_id === 'a').map(item => item.notice_state), ['pending', 'pending']);
    f.sessions.get('a')!.status = 'idle'; f.sessions.get('a')!.activity!.processing = false;
    await f.assistant.observe('a', idle()); assert.equal(f.calls.length, 2);
  } finally { release.resolve(); f.close(); }
});

test('ask invalidation during another source lookup never returns stale questions as live', async () => {
  for (const unloaded of [true, false]) {
    const f = fixture(), entered = deferred(), release = deferred();
    try {
      f.topic('one', 'a'); f.topic('two', 'b'); f.sessions.get('assistant')!.status = 'running';
      for (const id of ['a', 'b']) {
        f.sessions.get(id)!.ask = { requestId: id, question: id }; await f.assistant.observe(id);
      }
      let paused = false;
      f.onMeta(async id => { if (id === 'b' && !paused) { paused = true; entered.resolve(); await release.promise; } });
      const read = f.invoke('assistant_inbox');
      await entered.promise;
      if (unloaded) f.sessions.get('a')!.loaded = false; else f.sessions.get('a')!.ask = null;
      const invalidation = f.assistant.observe('a');
      release.resolve();
      const result = await read as { items: { sessionId: string }[] };
      await invalidation;
      assert.deepEqual(result.items.map(item => item.sessionId), ['b']);
      assert.deepEqual(f.store.inbox().map(item => item.session_id), unloaded ? ['a', 'b'] : ['b']);
    } finally { release.resolve(); f.close(); }
  }
});
