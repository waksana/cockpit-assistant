import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { McpInvocationMeta, ModuleHostApi, ModuleHostIntent, ModuleHostIntentBody,
  ModuleHostIntentResult, NativeChatEvent, PublicSessionMeta } from '@waksana/cockpit-module-sdk/backend';
import { Assistant, configInput } from '../src/core.ts';
import type { Caller, Gateway, Input } from '../src/gateway.ts';
import { mcp } from '../src/mcp.ts';
import { Store, type Delivery, type Topic } from '../src/store.ts';

const identity = (toolCallId: string): McpInvocationMeta =>
  ({ sessionId: 'assistant', runtimeSessionId: 'assistant', subagent: false, toolCallId });
type HistoryPage = ModuleHostIntentResult<'session/chat'>;
const historyPage = (events: NativeChatEvent[], extra: Partial<HistoryPage> = {}): HistoryPage =>
  ({ sessionId: 'a', source: 'persisted', direction: 'backward', events, cursor: 'native-cursor',
    cursorStatus: 'ok', hasMore: false, read: { rpc: 1, events: events.length }, ...extra });
const message = (id: string, type = 'assistant.message', content = id): NativeChatEvent =>
  ({ id, type, data: { messageId: `message-${id}`, content } });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const store = new Store(':memory:'), calls: { name: string; body: unknown }[] = [], errors: unknown[] = [];
  const meta = (id: string): PublicSessionMeta => ({
    sessionId: id, title: id, cwd: '/synthetic', loaded: true, status: 'idle', ask: null, lastActivity: 0,
    roles: id === 'assistant' ? [{ moduleId: 'assistant', roleId: 'coordinator', name: 'Assistant', moduleName: 'Assistant' }] : [],
    appliedRoles: id === 'assistant' ? [{ moduleId: 'assistant', roleId: 'coordinator', name: 'Assistant', moduleName: 'Assistant' }] : [],
    rolesNeedReload: false,
    activity: { processing: false, hasActiveWork: false, abortable: false, sampledAt: Date.now(),
      tasks: { activeAgents: 0, activeShells: 0, unknown: 0 },
      queue: { pendingCount: 0, steeringCount: 0, inFlightSteeringCount: 0 },
      mcp: { pendingConnectionCount: 0 } },
  });
  const sessions = new Map(['assistant', 'a', 'b', 'observer'].map(id => [id, meta(id)]));
  let source: Input = { sessionId: 'assistant', messageId: 'human-message', interactionId: 'human-turn',
    text: 'Do exactly this work', attachments: [], human: true, createdAt: Date.now() + 1000 };
  let onCall: ((name: string, sessionId: string) => Promise<void>) | null = null;
  let onMeta: ((id: string) => Promise<void>) | null = null;
  let history: HistoryPage[] | null = null, callerRole: Caller['role'] = 'coordinator';
  let failure: string | null = null, missingReceipt = false, created = 0;
  const host: ModuleHostApi = {
    toolScopeVersion: 1, chatReadVersion: 1, promptReceiptVersion: 1, askResponseVersion: 1,
    async call<Name extends ModuleHostIntent>(name: Name, body: ModuleHostIntentBody<Name>): Promise<ModuleHostIntentResult<Name>> {
      calls.push({ name, body });
      const target = 'sessionId' in body ? body.sessionId : '';
      if (onCall) await onCall(name, target);
      if (failure === name) throw Object.assign(new Error('Synthetic lost receipt'), { sessionId: 'partially-created' });
      let result: unknown;
      switch (name) {
        case 'session/new': {
          const id = `worker-${++created}`; sessions.set(id, meta(id)); result = { sessionId: id }; break;
        }
        case 'session/load': sessions.get(target)!.loaded = true; result = { ok: true, sessionId: target }; break;
        case 'prompt': result = { ok: true, ...(missingReceipt ? {} : { messageId: `receipt-${calls.length}` }) }; break;
        case 'respondAsk': sessions.get(target)!.ask = null; result = { ok: true }; break;
        case 'session/chat':
          result = history ? history.shift() : historyPage([message('history', 'assistant.message', 'Native history')], { sessionId: target });
          assert.ok(result, 'Unexpected extra native history read'); break;
        default: throw new Error(`Unexpected native call ${name}`);
      }
      return result as ModuleHostIntentResult<Name>;
    },
  };
  const native: Gateway = {
    host, async caller(call) {
      assert.equal(call.subagent, false);
      return { sessionId: 'assistant', toolCallId: call.toolCallId!, role: callerRole, input: structuredClone(source) };
    },
    async session(id) { if (onMeta) await onMeta(id); return sessions.get(id) ?? null; },
    async foreground() { return sessions.get('assistant')!; },
    observe() {},
  };
  const assistant = new Assistant(store, native, configInput.parse({ defaultCwd: '/synthetic' }), error => errors.push(error));
  const topic = (id: string, sessionId: string | null): Topic => store.saveTopic({ id, title: id, content: '',
    version: 1, archived: false, session_id: sessionId, mapping_state: sessionId ? 'bound' : 'unbound', mapping_error: null, creation_receipt: null });
  return { store, assistant, sessions, calls, errors, topic,
    input(value: Partial<Input>) { source = { ...source, ...value }; },
    history(pages: HistoryPage[]) { history = pages; },
    organizer(ids: string[]) { callerRole = 'organizer'; source.text = `historySessionIds: ${JSON.stringify(ids)}`; },
    onCall(value: typeof onCall) { onCall = value; }, onMeta(value: typeof onMeta) { onMeta = value; },
    fail(value: string | null) { failure = value; }, missingReceipt() { missingReceipt = true; },
    invoke(name: string, input: unknown = {}, id = `${name}-${calls.length}`) { return assistant.invoke(name, input, identity(id)); },
    close() { assistant.stop(); store.close(); },
  };
}

test('registry creates service-owned IDs and native call replay cannot create a duplicate topic', async () => {
  const f = fixture();
  try {
    const query = { title: 'Travel', content: 'Discussion only' };
    const first = await f.invoke('assistant_topic', query, 'create-once');
    assert.deepEqual(await f.invoke('assistant_topic', query, 'create-once'), first);
    assert.equal(f.store.topics().length, 1);
    assert.equal(f.calls.length, 0);
    await assert.rejects(f.invoke('assistant_topic', { ...query, title: 'Changed' }, 'create-once'), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(f.invoke('assistant_topic', { topicId: 'invented', title: 'New' }), { code: 'TOPIC_NOT_FOUND' });
  } finally { f.close(); }
});
test('internal notices can read and consume results but cannot dispatch or mutate the ledger', async () => {
  const f = fixture();
  try {
    f.topic('topic', 'a'); f.input({ human: false });
    await assert.rejects(f.invoke('assistant_dispatch', { items: [{ topicId: 'topic', prompt: 'Do more' }] }), { code: 'HUMAN_REQUIRED' });
    await assert.rejects(f.invoke('assistant_topic', { title: 'Extra' }), { code: 'HUMAN_REQUIRED' });
    f.store.enqueue({ session_id: 'a', native_id: 'result', kind: 'reply', text: 'Worker report', attachments: [], question: null });
    assert.deepEqual(await f.invoke('assistant_inbox', { peek: true }), { count: 1 });
    await f.invoke('assistant_inbox');
    assert.equal(f.store.inbox().length, 0);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});
test('one compound native user input delivers its complete split and attachments without a local chat copy', async () => {
  const f = fixture();
  try {
    f.topic('one', 'a'); f.topic('two', 'b');
    const attachments = [{ type: 'file' as const, path: '/synthetic/image' }];
    f.input({ attachments });
    const query = { items: [{ topicId: 'one', prompt: 'Discuss one' }, { topicId: 'two', prompt: 'Discuss two' }] };
    const result = await f.invoke('assistant_dispatch', query);
    assert.deepEqual((result as Delivery[]).map(row => row.state), ['accepted', 'accepted']);
    assert.deepEqual(f.calls.map(call => call.name), ['prompt', 'prompt']);
    for (const call of f.calls) assert.deepEqual((call.body as { attachments: unknown }).attachments, attachments);
    await f.invoke('assistant_dispatch', query, 'repeat');
    assert.equal(f.calls.length, 2);
    await assert.rejects(f.invoke('assistant_dispatch', { items: [{ topicId: 'one', prompt: 'Follow up' }] }),
      { code: 'FROZEN_DISPATCH' });
  } finally { f.close(); }
});
test('the existing unloaded worker keeps its ID and a new topic uses the actual persistent template', async () => {
  const f = fixture();
  try {
    f.topic('old', 'a'); f.topic('new', null); f.sessions.get('a')!.loaded = false;
    await f.invoke('assistant_dispatch', { items: [{ topicId: 'old', prompt: 'Old target' }, { topicId: 'new', prompt: 'New target' }] });
    assert.equal(f.store.topic('old').session_id, 'a');
    assert.deepEqual(f.calls.filter(call => call.name === 'session/load').map(call => call.body), [{ sessionId: 'a' }]);
    const create = f.calls.find(call => call.name === 'session/new')!;
    assert.deepEqual(create.body, { cwd: '/synthetic', roles: [{ moduleId: 'assistant', roleId: 'worker' }],
      toolScope: { builtins: ['view', 'grep', 'glob', 'bash', 'apply_patch', 'ask_user', 'skill'], mcpServers: [] } });
    assert.equal(f.store.topic('new').session_id, 'worker-1');
  } finally { f.close(); }
});
test('lost creation or prompt receipts are unknown and never automatically repeated', async () => {
  for (const create of [true, false]) {
    const f = fixture();
    try {
      f.topic('topic', create ? null : 'a');
      if (create) f.fail('session/new'); else f.missingReceipt();
      const query = { items: [{ topicId: 'topic', prompt: 'One request' }] };
      await f.invoke('assistant_dispatch', query);
      const count = f.calls.length;
      await f.invoke('assistant_dispatch', query, 'repeat');
      assert.equal(f.calls.length, count);
      assert.equal(f.store.deliveries('assistant', 'human-message')[0]!.state, 'unknown');
      if (create) assert.deepEqual(f.store.topic('topic').creation_receipt,
        { error: 'Synthetic lost receipt', sessionId: 'partially-created' });
    } finally { f.close(); }
  }
});
test('native ask answers are complete genuine user words, not a model substring or a mixed dispatch', async () => {
  const f = fixture();
  try {
    f.topic('ask', 'a'); f.topic('business', 'b');
    f.sessions.get('a')!.ask = { requestId: 'color', question: 'Choose', choices: ['Blue'], allowFreeform: false };
    await f.assistant.observe('a');
    f.calls.length = 0;
    f.input({ text: 'Do not choose Blue' });
    await assert.rejects(f.invoke('assistant_dispatch', { items: [{ topicId: 'ask', prompt: 'Blue' }] }), { code: 'ASK_ORIGINAL' });
    await assert.rejects(f.invoke('assistant_dispatch', { items: [
      { topicId: 'business', prompt: 'Do work' }, { topicId: 'ask', prompt: 'Do not choose Blue' },
    ] }), { code: 'ASK_ORIGINAL' });
    assert.equal(f.calls.length, 0);
    f.input({ text: ' Blue ' });
    await f.invoke('assistant_dispatch', { items: [{ topicId: 'ask', prompt: 'Blue' }] });
    assert.deepEqual(f.calls.map(call => call.body), [{ sessionId: 'a', requestId: 'color', answer: 'Blue', wasFreeform: false }]);
  } finally { f.close(); }
});
test('a human input predating an ask is never repurposed as its answer', async () => {
  const f = fixture();
  try {
    f.topic('topic', 'a'); f.sessions.get('a')!.ask = { requestId: 'ask', question: 'Choose account' };
    await f.assistant.observe('a'); f.calls.length = 0;
    f.input({ createdAt: 1 });
    await assert.rejects(f.invoke('assistant_dispatch', { items: [{ topicId: 'topic', prompt: 'Do exactly this work' }] }),
      { code: 'ASK_SOURCE_ORDER' });
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});
test('read-only history remains available after inbox consumption and never reenqueues history', async () => {
  const f = fixture();
  try {
    f.topic('topic', 'a');
    f.store.enqueue({ session_id: 'a', native_id: 'reply', kind: 'reply', text: 'Native report', attachments: [], question: null });
    await f.invoke('assistant_inbox');
    await f.invoke('assistant_history', { sessionId: 'a', cursor: 'page' });
    assert.equal(f.store.inbox().length, 0);
    assert.deepEqual(f.calls[0], { name: 'session/chat', body: {
      sessionId: 'a', source: 'persisted', direction: 'backward', max: 16, bootstrap: false, waitMs: 0, cursor: 'page',
    } });
    await assert.rejects(f.invoke('assistant_history', { sessionId: 'observer' }), { code: 'HISTORY_SCOPE' });
  } finally { f.close(); }
});
test('organizer reads the latest three dialogue bodies across tool-heavy pages in native append order', async () => {
  const f = fixture();
  try {
    f.organizer(['a']); f.sessions.get('a')!.loaded = false;
    const noise: NativeChatEvent[] = [
      { id: 'tool', type: 'tool.execution_complete', data: { result: 'Large tool result'.repeat(10000) } },
      message('empty', 'assistant.message', ' \n'),
      { ...message('ephemeral'), ephemeral: true },
      { ...message('subagent'), agentId: 'child' },
      { ...message('nested'), data: { content: 'Nested reply', parentToolCallId: 'parent' } },
    ];
    f.history([
      historyPage([...noise, { ...message('latest'), timestamp: 1,
        data: { messageId: 'message-latest', content: 'latest', reasoningOpaque: 'Opaque'.repeat(10000),
          toolRequests: [{ toolCallId: 'tool-action' }], attachments: [{ type: 'file', path: '/synthetic' }] } }],
      { cursor: 'older-page', hasMore: true }),
      historyPage([message('too-old'), { ...message('question', 'user.message'), timestamp: 999 },
        message('answer'), ...noise], { cursor: 'earliest-page' }),
    ]);
    const result = await f.invoke('assistant_history', { sessionId: 'a' });
    assert.deepEqual(result, { sessionId: 'a', source: 'persisted', view: 'recent', limit: 3, order: 'oldest-first',
      messages: [message('question', 'user.message'), message('answer'), message('latest')].map(event => ({
        eventId: event.id, messageId: event.data.messageId, type: event.type,
        content: event.data.content, truncated: false, originalLength: event.id.length,
      })), complete: true, scanLimited: false, read: { pages: 2, events: 14 } });
    assert.deepEqual(f.calls, [
      { name: 'session/chat', body: { sessionId: 'a', source: 'persisted', direction: 'backward', max: 32, bootstrap: false, waitMs: 0 } },
      { name: 'session/chat', body: { sessionId: 'a', source: 'persisted', direction: 'backward', max: 32, bootstrap: false, waitMs: 0, cursor: 'older-page' } },
    ]);
    assert.equal(f.sessions.get('a')!.loaded, false);
    assert.equal(f.store.inbox().length, 0);
    assert.equal(f.store.topics().length, 0);
  } finally { f.close(); }
});
test('recent text stays readable within the actual MCP envelope for huge, escaped and Unicode bodies', async () => {
  const f = fixture();
  try {
    f.organizer(['a']);
    const texts = ['long'.repeat(100000), '\0\n\\"'.repeat(100000), '\u{1F642}'.repeat(100000)];
    const events = texts.map((content, index) => ({ ...message(`large-${index}`, 'assistant.message', content),
      data: { messageId: `message-large-${index}`, content, reasoningText: 'Internal'.repeat(100000) } }));
    f.history([historyPage(events)]);
    const response = await mcp(f.assistant).handler({ headers: {}, params: {}, query: {}, signal: new AbortController().signal,
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'assistant_history',
        arguments: { sessionId: 'a' }, _meta: { 'cockpit/invocation': identity('recent-mcp') } } } });
    assert.ok(Buffer.byteLength(JSON.stringify(response.body)) < 20000);
    const envelope = response.body as { result: { content: { text: string }[]; isError: boolean } };
    assert.equal(envelope.result.isError, false);
    assert.ok(Buffer.byteLength(envelope.result.content[0]!.text) <= 12000);
    const result = JSON.parse(envelope.result.content[0]!.text) as {
      complete: boolean; messages: { content: string; truncated: boolean; originalLength: number }[];
    };
    assert.equal(result.complete, true);
    assert.equal(result.messages.length, 3);
    for (const [index, item] of result.messages.entries()) {
      assert.equal(item.truncated, true);
      assert.equal(item.originalLength, texts[index]!.length);
      assert.ok(texts[index]!.startsWith(item.content));
      assert.ok(Buffer.byteLength(JSON.stringify(item.content)) <= 3000);
      assert.doesNotMatch(item.content, /[\uD800-\uDBFF]$/u);
    }
    assert.equal(JSON.stringify(response.body).includes('reasoningText'), false);
    assert.equal(events[0]!.data.content, texts[0], 'Source history is not shortened');
  } finally { f.close(); }
});
test('recent sampling returns fewer messages only when history ends and never caches native bodies', async () => {
  for (const events of [[], [message('one', 'user.message'), message('two')]]) {
    const f = fixture();
    try {
      f.topic('topic', 'a'); f.history([historyPage(events)]);
      const result = await f.invoke('assistant_history', { sessionId: 'a', recent: true }) as {
        messages: unknown[]; complete: boolean; scanLimited: boolean;
      };
      assert.equal(result.messages.length, events.length);
      assert.equal(result.complete, true);
      assert.equal(result.scanLimited, false);
      assert.equal(f.store.sql.prepare('SELECT count(*) AS count FROM seen').get()!.count, 0);
      assert.equal(f.store.inbox().length, 0);
    } finally { f.close(); }
  }
});
test('recent sampling explicitly reports a bounded tool-only tail rather than an empty complete conversation', async () => {
  const f = fixture();
  try {
    f.organizer(['a']);
    f.history(Array.from({ length: 16 }, (_, page) => historyPage(Array.from({ length: 32 }, (_, index) => ({
      id: `tool-${page}-${index}`, type: 'tool.execution_complete', data: { result: 'Tool only' },
    })), { cursor: `page-${page}`, hasMore: true })));
    assert.deepEqual(await f.invoke('assistant_history', { sessionId: 'a' }),
      { sessionId: 'a', source: 'persisted', view: 'recent', limit: 3, order: 'oldest-first',
        messages: [], complete: false, scanLimited: true, read: { pages: 16, events: 512 } });
    assert.equal(f.calls.length, 16);
  } finally { f.close(); }
});
test('recent sampling propagates expired, invalid, oversized and nonadvancing native history instead of pretending success', async () => {
  const invalidPages = [
    [historyPage([message('one')], { cursorStatus: 'expired' })],
    [historyPage([message('one')], { sessionId: 'b' })],
    [historyPage([], { hasMore: true, cursor: '' })],
    [historyPage(Array.from({ length: 33 }, (_, index) => message(`over-${index}`)))],
    [historyPage([], { hasMore: true }), historyPage([], { hasMore: true })],
  ];
  for (const pages of invalidPages) {
    const f = fixture();
    try {
      f.organizer(['a']); f.history(pages);
      await assert.rejects(f.invoke('assistant_history', { sessionId: 'a' }), { code: 'NATIVE_HISTORY' });
    } finally { f.close(); }
  }
  const f = fixture();
  try {
    f.organizer(['a']); f.fail('session/chat');
    await assert.rejects(f.invoke('assistant_history', { sessionId: 'a' }), /Synthetic lost receipt/);
    assert.equal(f.calls.length, 1);
    f.fail(null);
    f.history([historyPage([message('identity'.repeat(3000))])]);
    await assert.rejects(f.invoke('assistant_history', { sessionId: 'a' }), { code: 'HISTORY_OUTPUT_LIMIT' });
  } finally { f.close(); }
});
test('organizer history keeps native input scope and protected source restrictions in both views', async () => {
  const f = fixture();
  try {
    f.organizer(['a', 'assistant']);
    for (const recent of [true, false]) {
      await assert.rejects(f.invoke('assistant_history', { sessionId: 'observer', recent }), { code: 'HISTORY_SCOPE' });
      await assert.rejects(f.invoke('assistant_history', { sessionId: 'assistant', recent }), { code: 'INTERNAL_HISTORY' });
      f.input({ human: false });
      await assert.rejects(f.invoke('assistant_history', { sessionId: 'a', recent }), { code: 'ORGANIZER_SCOPE' });
      f.input({ human: true });
    }
    await assert.rejects(f.invoke('assistant_history', { sessionId: 'a', cursor: 'raw-page' }), { code: 'RECENT_HISTORY_CURSOR' });
    assert.equal(f.calls.length, 0);
    const raw = historyPage([message('raw')]);
    f.history([raw]);
    assert.deepEqual(await f.invoke('assistant_history', { sessionId: 'a', recent: false, cursor: 'raw-page' }), raw);
    assert.deepEqual(f.calls[0], { name: 'session/chat', body: {
      sessionId: 'a', source: 'persisted', direction: 'backward', max: 16, bootstrap: false, waitMs: 0, cursor: 'raw-page',
    } });
  } finally { f.close(); }
});
test('recent sampling does not start another native read after shutdown', async () => {
  const f = fixture();
  try {
    f.organizer(['a']); f.history([historyPage([], { hasMore: true })]);
    f.onCall(async name => { if (name === 'session/chat') f.assistant.stop(); });
    await assert.rejects(f.invoke('assistant_history', { sessionId: 'a' }), { code: 'STOPPING' });
    assert.equal(f.calls.length, 1);
  } finally { f.close(); }
});
test('only owned main-agent messages enter inbox; complete text accompanying tools is retained', async () => {
  const f = fixture();
  try {
    f.topic('topic', 'a');
    f.sessions.get('assistant')!.status = 'running';
    const event = { id: 'reply', type: 'assistant.message', data: { messageId: 'native-reply', content: 'Progress report',
      toolRequests: [{ toolCallId: 'internal-action' }] } };
    await f.assistant.observe('observer', event);
    await f.assistant.observe('a', { ...event, ephemeral: true });
    await f.assistant.observe('a', { ...event, agentId: 'child' });
    assert.equal(f.store.inbox().length, 0);
    await f.assistant.observe('a', event);
    assert.equal(f.store.inbox().length, 1);
    assert.equal(f.calls.length, 0);
    f.sessions.get('assistant')!.status = 'idle'; await f.assistant.notify();
    assert.equal(f.calls.length, 1);
    assert.equal((f.calls[0]!.body as { text: string }).text.includes('Progress report'), false);
  } finally { f.close(); }
});
test('a notice in flight cannot restore consumed items or lose another result arrival', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  try {
    f.topic('topic', 'a');
    f.onCall(async (name, target) => { if (name === 'prompt' && target === 'assistant') { entered.resolve(); await release.promise; } });
    const first = f.assistant.observe('a', { id: 'first', type: 'assistant.message', data: { content: 'First' } });
    await entered.promise;
    await f.invoke('assistant_inbox');
    f.store.enqueue({ session_id: 'a', native_id: 'later', kind: 'reply', text: 'Later', attachments: [], question: null });
    f.sessions.get('assistant')!.status = 'running';
    const again = f.assistant.notify();
    release.resolve(); await first; await again;
    assert.deepEqual(f.store.inbox().map(item => item.text), ['Later']);
    assert.equal(f.store.inbox()[0]!.notice_state, 'pending');
  } finally { release.resolve(); f.close(); }
});

test('the original notification promise drains follow-up sends and records their receipts before shutdown', async () => {
  const f = fixture(), firstEntered = deferred(), firstRelease = deferred(), nextEntered = deferred(), nextRelease = deferred();
  try {
    const enqueue = (native_id: string) => f.store.enqueue({
      session_id: 'a', native_id, kind: 'reply', text: native_id, attachments: [], question: null,
    });
    let calls = 0, finished = false;
    f.onCall(async name => {
      if (name !== 'prompt') return;
      if (++calls === 1) { firstEntered.resolve(); await firstRelease.promise; }
      else { nextEntered.resolve(); await nextRelease.promise; }
    });
    enqueue('first');
    const notification = f.assistant.notify().then(() => { finished = true; });
    await firstEntered.promise;
    enqueue('second');
    const continuation = f.assistant.notify();
    firstRelease.resolve(); await nextEntered.promise;
    assert.equal(finished, false);
    assert.equal(f.store.inbox()[1]!.notice_state, 'calling');
    f.assistant.stop();
    nextRelease.resolve();
    await notification; await continuation;
    assert.equal(finished, true);
    assert.deepEqual(f.store.inbox().map(item => item.notice_state), ['notified', 'notified']);
    assert.deepEqual(f.errors, []);
  } finally { firstRelease.resolve(); nextRelease.resolve(); f.close(); }
});
test('stopping during original worker load prevents a subsequent new business prompt', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  try {
    f.topic('topic', 'a'); f.sessions.get('a')!.loaded = false;
    f.onCall(async name => { if (name === 'session/load') { entered.resolve(); await release.promise; } });
    const dispatch = f.invoke('assistant_dispatch', { items: [{ topicId: 'topic', prompt: 'Business' }] });
    await entered.promise; f.assistant.stop(); release.resolve(); await dispatch;
    assert.deepEqual(f.calls.map(call => call.name), ['session/load']);
    assert.equal(f.store.deliveries('assistant', 'human-message')[0]!.state, 'rejected');
  } finally { release.resolve(); f.close(); }
});
test('stopping during foreground discovery does not reserve or send a fresh notification', async t => {
  const f = fixture(), entered = deferred(), release = deferred();
  try {
    f.store.enqueue({ session_id: 'a', native_id: 'new', kind: 'reply', text: 'New', attachments: [], question: null });
    t.mock.method(f.assistant.native, 'foreground', async () => {
      entered.resolve(); await release.promise; return f.sessions.get('assistant')!;
    });
    const sending = f.assistant.notify();
    await entered.promise; f.assistant.stop(); release.resolve(); await sending;
    assert.deepEqual(f.calls, []);
    assert.equal(f.store.inbox()[0]!.notice_state, 'pending');
  } finally { release.resolve(); f.close(); }
});
test('a result arriving while the empty notification loop exits receives its reminder without another wake', async () => {
  const f = fixture();
  try {
    f.topic('topic', 'a');
    const empty = f.assistant.notify();
    const arrived = f.assistant.observe('a', { id: 'at-loop-exit', type: 'assistant.message',
      data: { messageId: 'at-loop-exit', content: 'Do not lose this wake' } });
    await Promise.all([empty, arrived]);
    assert.equal(f.calls.filter(call => call.name === 'prompt').length, 1);
    assert.equal(f.store.inbox()[0]!.notice_state, 'notified');
  } finally { f.close(); }
});
