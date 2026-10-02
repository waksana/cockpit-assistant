import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { McpInvocationMeta, ModuleHostApi, ModuleHostIntent, ModuleHostIntentBody,
  ModuleHostIntentResult, NativeChatEvent, PublicSessionMeta } from '@waksana/cockpit-module-sdk/backend';
import { Assistant, configInput, type Config } from '../src/core.ts';
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
function fixture(config: Partial<Config> = {}) {
  const store = new Store(':memory:'), calls: { name: string; body: unknown }[] = [], errors: unknown[] = [];
  const observed = new Map<string, NativeChatEvent[]>();
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
  let onReady: (() => Promise<void>) | null = null;
  let history: HistoryPage[] | null = null, callerRole: Caller['role'] = 'coordinator';
  let failure: string | null = null, missingReceipt = false, created = 0;
  let loadResult: unknown = null, loadChangesState = true;
  const host: ModuleHostApi = {
    toolScopeVersion: 1, chatReadVersion: 1, promptReceiptVersion: 1, askResponseVersion: 1,
    async call<Name extends ModuleHostIntent>(name: Name, body: ModuleHostIntentBody<Name>): Promise<ModuleHostIntentResult<Name>> {
      calls.push({ name, body });
      const target = 'sessionId' in body ? body.sessionId ?? '' : '';
      if (onCall) await onCall(name, target);
      if (failure === name) throw Object.assign(new Error('Synthetic lost receipt'), { sessionId: 'partially-created' });
      let result: unknown;
      switch (name) {
        case 'session/new': {
          const id = `worker-${++created}`; sessions.set(id, meta(id)); result = { sessionId: id }; break;
        }
        case 'session/load':
          if (loadChangesState) sessions.get(target)!.loaded = true;
          result = loadResult ?? { ok: true, sessionId: target }; break;
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
    async validateForeground(_meta, state) { if (state !== 'saved' && onReady) await onReady(); },
    observe(sessionId, event) {
      const events = observed.get(sessionId) ?? [];
      if (!events.some(old => old.id === event.id)) events.push(event);
      observed.set(sessionId, events);
    },
  };
  const assistant = new Assistant(store, native, configInput.parse({ defaultCwd: '/synthetic', ...config }), error => errors.push(error));
  const topic = (id: string, sessionId: string | null): Topic => store.saveTopic({ id, title: id, content: '',
    version: 1, archived: false, session_id: sessionId, mapping_state: sessionId ? 'bound' : 'unbound', mapping_error: null, creation_receipt: null });
  return { store, assistant, native, sessions, calls, errors, topic, observed,
    input(value: Partial<Input>) { source = { ...source, ...value }; },
    history(pages: HistoryPage[]) { history = pages; },
    organizer(ids: string[]) { callerRole = 'organizer'; source.text = `historySessionIds: ${JSON.stringify(ids)}`; },
    onCall(value: typeof onCall) { onCall = value; }, onMeta(value: typeof onMeta) { onMeta = value; },
    onReady(value: typeof onReady) { onReady = value; },
    load(value: typeof loadResult, changesState = true) { loadResult = value; loadChangesState = changesState; },
    fail(value: string | null) { failure = value; }, missingReceipt() { missingReceipt = true; },
    invoke(name: string, input: unknown = {}, id = `${name}-${calls.length}`) { return assistant.invoke(name, input, identity(id)); },
    close() { assistant.stop(); store.close(); },
  };
}
async function resolveInbox(f: ReturnType<typeof fixture>) {
  const inbox = await f.invoke('assistant_inbox') as {
    items: { id: string; sessionId: string; readToken?: string; receipt?: { id: string } }[];
  };
  const tokens = new Set<string>();
  for (const item of inbox.items) {
    if (item.receipt) {
      await f.invoke('assistant_resolve', { receiptId: item.receipt.id, disposition: 'notify' }, `decide-${item.id}`);
    } else if (item.readToken && !tokens.has(item.readToken)) {
      tokens.add(item.readToken);
      const nativeEvents = f.observed.get(item.sessionId) ?? f.store.inbox().filter(row => row.session_id === item.sessionId)
        .map(row => ({ id: row.native_id, type: 'assistant.message', data: { messageId: row.native_id, content: row.text } }));
      f.history([historyPage(nativeEvents, { sessionId: item.sessionId })]);
      const result = await f.invoke('assistant_read', { token: item.readToken }, `read-${item.id}`) as { receipt: { id: string } };
      await f.invoke('assistant_resolve', { receiptId: result.receipt.id, disposition: 'silent' }, `decide-${item.id}`);
    }
  }
}
function pending(f: ReturnType<typeof fixture>, id = 'pending') {
  f.topic('topic', 'a');
  f.store.enqueue({ session_id: 'a', native_id: id, kind: 'reply', text: id, attachments: [], question: null });
}

test('eligible recovered replies load only the original foreground, coalesce notifications, and retain inbox bodies', async () => {
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
    await f.assistant.notify();
    assert.equal(f.calls.length, 2);
    f.sessions.get('assistant')!.loaded = false; pending(f, 'third');
    await f.assistant.notify();
    assert.deepEqual(f.calls.map(call => call.name), ['session/load', 'prompt', 'session/load', 'prompt']);
  } finally { release.resolve(); f.close(); }
});
test('empty, unrelated, duplicate, uncertain and active-source mail never loads the foreground', async () => {
  for (const state of ['empty', 'unrelated', 'duplicate', 'unknown', 'running', 'unloaded', 'activity-unknown', 'stale-ask']) {
    const f = fixture();
    try {
      f.sessions.get('assistant')!.loaded = false;
      if (state !== 'empty') pending(f);
      if (state === 'unrelated') f.store.saveTopic({ ...f.store.topic('topic')!, session_id: null, mapping_state: 'unbound' });
      if (state === 'duplicate' || state === 'unknown') {
        const notice = f.store.reserveNotice(new Set(f.store.inbox().map(item => item.id)))!;
        f.store.settleNotice(notice.id, state === 'duplicate' ? 'receipt' : null, state === 'duplicate');
      }
      if (state === 'running') f.sessions.get('a')!.activity!.processing = true;
      if (state === 'unloaded') f.sessions.get('a')!.loaded = false;
      if (state === 'activity-unknown') f.sessions.get('a')!.activity = null;
      if (state === 'stale-ask') {
        f.store.take('synthetic-read', 100);
        f.store.enqueue({ session_id: 'a', native_id: 'old', kind: 'ask', text: 'Old?', attachments: [],
          question: { requestId: 'old', question: 'Old?' } });
      }
      let foregroundReads = 0;
      f.native.foreground = async () => { foregroundReads++; return f.sessions.get('assistant')!; };
      await f.assistant.notify();
      assert.equal(f.calls.length, 0, state);
      assert.equal(foregroundReads, 0, state);
    } finally { f.close(); }
  }
});
test('a live source ask can wake the foreground without requiring idle or carrying unfinished progress', async () => {
  const f = fixture();
  try {
    f.topic('topic', 'a'); f.sessions.get('assistant')!.loaded = false;
    const source = f.sessions.get('a')!;
    source.status = 'running'; source.activity!.processing = true;
    source.ask = { requestId: 'ask', question: 'Choose', choices: ['A'] };
    await f.assistant.observe('a', message('progress'));
    assert.deepEqual(f.calls.map(call => call.name), ['session/load', 'prompt']);
    assert.deepEqual(f.store.inbox().map(item => item.notice_state), ['pending', 'notified']);
  } finally { f.close(); }
});
test('loaded busy, queued or asking foregrounds are neither reloaded nor interrupted', async () => {
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
      assert.equal(f.calls.length, 0, state);
      assert.equal(f.store.inbox()[0]!.notice_state, 'pending');
    } finally { f.close(); }
  }
});
test('load rejection, lost response, wrong identity and unconfirmed loading retain pending and never replay', async () => {
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
      f.store.recover();
      await f.assistant.notify();
      assert.equal(f.store.foregroundWake()!.state, state === 'rejected' ? 'failed' : 'unknown', state);
      const count = f.calls.length;
      await f.assistant.notify(); f.store.recover(); await f.assistant.notify();
      assert.equal(f.calls.length, count, state);
      assert.equal(f.store.inbox()[0]!.notice_state, 'pending');
      assert.equal(f.calls.some(call => call.name === 'prompt'), false);
      f.fail(null); f.sessions.get('assistant')!.loaded = true;
      await f.assistant.notify();
      assert.equal(f.calls.at(-1)!.name, 'prompt', 'A normal public Host load permits readback recovery, not another load');
      assert.equal(f.store.foregroundWake()!.state, state === 'rejected' ? 'failed' : 'unknown',
        'Current readiness recovery must not erase the historical failed/unknown load');
    } finally { f.close(); }
  }
});
test('missing and unreadable foregrounds report errors without replacing the identity or changing notice receipts', async () => {
  for (const code of ['FOREGROUND_MISSING', 'NATIVE_READ_FAILED']) {
    const f = fixture();
    try {
      pending(f);
      f.native.foreground = async () => { throw Object.assign(new Error(code), { code }); };
      await f.assistant.notify();
      assert.equal(f.calls.length, 0);
      assert.equal((f.errors[0] as { code: string }).code, code);
      assert.equal(f.store.inbox()[0]!.notice_state, 'pending');
      assert.equal(f.store.foregroundWake(), null);
    } finally { f.close(); }
  }
});
test('frontend discovery, load and readiness awaits cannot reserve mail after eligibility, identity or roles change', async () => {
  for (const phase of ['discovery', 'load', 'readiness', 'identity', 'roles', 'not-ready', 'stop']) {
    const f = fixture();
    try {
      pending(f); f.sessions.get('assistant')!.loaded = false;
      const invalidate = () => { f.sessions.get('a')!.activity!.processing = true; };
      if (phase === 'discovery') f.native.foreground = async () => { invalidate(); return f.sessions.get('assistant')!; };
      if (phase === 'load') f.onCall(async name => { if (name === 'session/load') invalidate(); });
      f.onReady(async () => {
        if (phase === 'readiness') invalidate();
        if (phase === 'identity') f.native.foreground = async () => f.sessions.get('b')!;
        if (phase === 'roles') f.sessions.get('assistant')!.rolesNeedReload = true;
        if (phase === 'not-ready') throw new Error('Synthetic resources not ready');
        if (phase === 'stop') f.assistant.stop();
      });
      await f.assistant.notify();
      assert.deepEqual(f.calls.map(call => call.name), phase === 'discovery' ? [] : ['session/load'], phase);
      assert.equal(f.store.inbox()[0]!.notice_state, 'pending', phase);
      if (phase === 'identity' || phase === 'roles' || phase === 'not-ready') assert.equal(f.errors.length, 1, phase);
    } finally { f.close(); }
  }
});
test('an ask invalidated during loading is never reminded or consumed as current', async () => {
  const f = fixture();
  try {
    f.topic('topic', 'a'); f.sessions.get('assistant')!.loaded = false;
    f.sessions.get('a')!.ask = { requestId: 'ask', question: 'Choose' };
    f.onCall(async name => { if (name === 'session/load') f.sessions.get('a')!.ask = null; });
    await f.assistant.observe('a');
    assert.deepEqual(f.calls.map(call => call.name), ['session/load']);
    assert.equal(f.store.inbox().length, 0);
  } finally { f.close(); }
});
test('consumption during foreground loading neither sends an empty reminder nor restores the body', async () => {
  const f = fixture();
  try {
    pending(f); f.sessions.get('assistant')!.loaded = false;
    f.onCall(async name => { if (name === 'session/load') f.store.take('read-during-load', 100); });
    await f.assistant.notify();
    assert.deepEqual(f.calls.map(call => call.name), ['session/load']);
    assert.equal(f.store.inbox().length, 0);
    pending(f);
    await f.assistant.notify();
    assert.deepEqual(f.calls.map(call => call.name), ['session/load']);
    assert.equal(f.store.inbox().length, 0);
  } finally { f.close(); }
});
test('failed post-load resources do not form an unload and reload loop', async () => {
  const f = fixture();
  try {
    pending(f); f.sessions.get('assistant')!.loaded = false;
    f.onReady(async () => { throw new Error('Synthetic disconnected role resources'); });
    await f.assistant.notify();
    assert.equal(f.store.foregroundWake()!.state, 'failed');
    assert.match(f.store.foregroundWake()!.error!, /disconnected/);
    f.sessions.get('assistant')!.loaded = false;
    await f.assistant.notify();
    assert.deepEqual(f.calls.map(call => call.name), ['session/load']);
    f.onReady(null); f.sessions.get('assistant')!.loaded = true;
    await f.assistant.notify();
    assert.deepEqual(f.calls.map(call => call.name), ['session/load', 'prompt']);
    assert.equal(f.store.foregroundWake()!.state, 'failed', 'Current readiness is separate from the failed load attempt');
  } finally { f.close(); }
});
test('foreground resource invalidation across source awaits cancels stale readiness without reserving a notice', async () => {
  const f = fixture();
  try {
    pending(f); f.sessions.get('assistant')!.loaded = false;
    let ready = true, samples = 0;
    f.onReady(async () => { if (!ready) throw new Error('Synthetic toolkit disconnected'); });
    f.onMeta(async id => {
      if (id === 'a' && ++samples === 2) {
        ready = false;
        await f.assistant.observe('assistant');
      }
    });
    await f.assistant.notify();
    assert.deepEqual(f.calls.map(call => call.name), ['session/load']);
    assert.equal(f.store.inbox()[0]!.notice_state, 'pending');
    await f.assistant.notify();
    assert.deepEqual(f.calls.map(call => call.name), ['session/load']);
    assert.match(String(f.errors[0]), /disconnected/);
    ready = true;
    await f.assistant.notify();
    assert.deepEqual(f.calls.map(call => call.name), ['session/load', 'prompt']);
  } finally { f.close(); }
});

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
test('internal notices can read and resolve results but cannot dispatch or mutate the registry', async () => {
  const f = fixture();
  try {
    f.topic('topic', 'a'); f.input({ human: false });
    await assert.rejects(f.invoke('assistant_dispatch', { items: [{ topicId: 'topic', prompt: 'Do more' }] }), { code: 'HUMAN_REQUIRED' });
    await assert.rejects(f.invoke('assistant_topic', { title: 'Extra' }), { code: 'HUMAN_REQUIRED' });
    f.store.enqueue({ session_id: 'a', native_id: 'result', kind: 'reply', text: 'Worker report', attachments: [], question: null });
    assert.deepEqual(await f.invoke('assistant_inbox', { peek: true }), { count: 1 });
    await resolveInbox(f);
    assert.equal(f.store.inbox().length, 0);
    assert.deepEqual(f.calls.map(call => call.name), ['session/chat']);
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
test('existing sessions keep their IDs and new topics create ordinary sessions without injected roles or scope', async () => {
  const f = fixture();
  try {
    f.topic('old', 'a'); f.topic('new', null); f.sessions.get('a')!.loaded = false;
    await f.invoke('assistant_dispatch', { items: [{ topicId: 'old', prompt: 'Old target' }, { topicId: 'new', prompt: 'New target' }] });
    assert.equal(f.store.topic('old').session_id, 'a');
    assert.deepEqual(f.calls.filter(call => call.name === 'session/load').map(call => call.body), [{ sessionId: 'a' }]);
    const create = f.calls.find(call => call.name === 'session/new')!;
    assert.deepEqual(create.body, { cwd: '/synthetic' });
    assert.equal(f.store.topic('new').session_id, 'worker-1');
    assert.deepEqual(f.calls.filter(call => call.name === 'prompt').map(call => call.body), [
      { sessionId: 'a', mode: 'immediate', text: 'Old target' },
      { sessionId: 'worker-1', mode: 'immediate', text: 'New target' },
    ]);
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
        { stage: 'creation', promptAttempted: false, error: 'Synthetic lost receipt', sessionId: 'partially-created' });
    } finally { f.close(); }
  }
});
test('only the exact old built-in worker preset retires its private scope; custom selections survive', async () => {
  const retired = { moduleId: 'assistant', roleId: 'worker' };
  const selected = { moduleId: 'example', roleId: 'reader' };
  const oldScope = { builtins: ['view', 'grep', 'glob', 'bash', 'apply_patch', 'ask_user', 'skill'], mcpServers: [] };
  const customScope = { builtins: ['view'], mcpServers: [{ name: 'catalog', tools: ['lookup'] }] };
  const cases = [
    { worker: { cwd: '/original', roles: [retired], toolScope: oldScope }, body: { cwd: '/original' } },
    { worker: { roles: [retired] }, body: { cwd: '/synthetic' } },
    { worker: { roles: [selected] }, body: { cwd: '/synthetic', roles: [selected] } },
    { worker: { roles: [retired, selected], toolScope: oldScope },
      body: { cwd: '/synthetic', roles: [selected], toolScope: oldScope } },
    { worker: { roles: [retired], toolScope: customScope }, body: { cwd: '/synthetic', toolScope: customScope } },
    { worker: { toolScope: oldScope }, body: { cwd: '/synthetic', toolScope: oldScope } },
    { worker: { toolScope: { builtins: [], mcpServers: [] } },
      body: { cwd: '/synthetic', toolScope: { builtins: [], mcpServers: [] } } },
  ];
  for (const { worker, body } of cases) {
    const original = structuredClone(worker), f = fixture({ worker });
    try {
      f.topic('new', null);
      await f.invoke('assistant_dispatch', { items: [{ topicId: 'new', prompt: 'One request' }] });
      assert.deepEqual(f.calls[0], { name: 'session/new', body });
      assert.equal(f.store.deliveries('assistant', 'human-message')[0]!.state, 'accepted');
      assert.deepEqual(f.assistant.config.worker, original, 'Compatibility does not rewrite saved configuration');
    } finally { f.close(); }
  }
  assert.throws(() => configInput.parse({ worker: { model: 'unsupported' } }));
  assert.throws(() => configInput.parse({ worker: { roles: [{ ...retired, unknown: true }] } }));
});
test('custom scope failures retain the created ID and readiness phase without sending or widening history', async () => {
  const f = fixture({ worker: { toolScope: { builtins: ['view'], mcpServers: [] } } });
  try {
    f.topic('new', null);
    f.onCall(async name => {
      if (name === 'session/new') throw Object.assign(new Error('Tool scope violation: undeclared native tool bash'),
        { code: 'SESSION_CREATION_INCOMPLETE', sessionId: 'created-before-readback' });
    });
    const query = { items: [{ topicId: 'new', prompt: 'One request' }] };
    await f.invoke('assistant_dispatch', query);
    const row = f.store.deliveries('assistant', 'human-message')[0]!;
    assert.equal(row.state, 'unknown');
    assert.equal(row.mode, null);
    assert.equal(row.native_message_id, null);
    const status = await f.invoke('assistant_status', { topicId: 'new' }) as {
      topic: { sessionId: string | null; creationReceipt: unknown }; session: unknown;
    };
    assert.equal(status.topic.sessionId, null);
    assert.equal(status.session, null);
    assert.deepEqual(status.topic.creationReceipt, {
      stage: 'readiness', promptAttempted: false, error: 'Tool scope violation: undeclared native tool bash',
      code: 'SESSION_CREATION_INCOMPLETE', sessionId: 'created-before-readback',
    });
    await f.invoke('assistant_dispatch', query);
    f.input({ messageId: 'another-user-input' });
    await f.invoke('assistant_dispatch', query);
    await assert.rejects(f.invoke('assistant_history', { sessionId: 'created-before-readback' }), { code: 'HISTORY_SCOPE' });
    assert.deepEqual(f.calls.map(call => call.name), ['session/new']);
  } finally { f.close(); }
});
test('removed saved worker roles are not silently rewritten, loaded or replaced', async () => {
  const f = fixture();
  try {
    f.topic('old', 'a'); f.sessions.get('a')!.loaded = false;
    f.sessions.get('a')!.roles = [{ moduleId: 'assistant', roleId: 'worker', name: 'Legacy', moduleName: 'Assistant' }];
    await f.invoke('assistant_dispatch', { items: [{ topicId: 'old', prompt: 'One request' }] });
    assert.equal(f.calls.length, 0);
    assert.equal(f.store.topic('old').session_id, 'a');
    const row = f.store.deliveries('assistant', 'human-message')[0]!;
    assert.equal(row.state, 'rejected');
    assert.match(row.error!, /removed assistant\/worker role/);
    f.sessions.get('a')!.loaded = true; f.input({ messageId: 'loaded-request' });
    await f.invoke('assistant_dispatch', { items: [{ topicId: 'old', prompt: 'Existing loaded target' }] });
    assert.deepEqual(f.calls.map(call => call.name), ['prompt']);
  } finally { f.close(); }
});
test('binding failure retains the successfully created identity without sending a prompt', async t => {
  const f = fixture();
  try {
    f.topic('new', null);
    const save = f.store.saveTopic.bind(f.store);
    t.mock.method(f.store, 'saveTopic', (topic: Topic) => {
      if (topic.mapping_state === 'bound') throw new Error('Synthetic binding write failure');
      return save(topic);
    });
    await f.invoke('assistant_dispatch', { items: [{ topicId: 'new', prompt: 'One request' }] });
    assert.deepEqual(f.store.topic('new').creation_receipt, {
      stage: 'binding', promptAttempted: false, error: 'Synthetic binding write failure', sessionId: 'worker-1',
    });
    assert.equal(f.store.topic('new').mapping_state, 'unknown');
    assert.deepEqual(f.calls.map(call => call.name), ['session/new']);
  } finally { f.close(); }
});
test('new session configuration cannot select foreground roles or their communication tools', async () => {
  for (const worker of [
    { roles: [{ moduleId: 'assistant', roleId: 'coordinator' }] },
    { roles: [{ moduleId: 'assistant', roleId: 'organizer' }] },
    { roles: [{ moduleId: 'assistant', roleId: 'unknown' }] },
    { toolScope: { builtins: [], mcpServers: [{ name: 'assistant', tools: ['assistant_dispatch'] }] } },
    { toolScope: { builtins: [], mcpServers: [{ name: 'cockpit', tools: ['cockpit_send_prompt'] }] } },
  ]) {
    const f = fixture({ worker });
    try {
      f.topic('new', null);
      await f.invoke('assistant_dispatch', { items: [{ topicId: 'new', prompt: 'One request' }] });
      assert.equal(f.calls.length, 0);
      assert.equal(f.store.deliveries('assistant', 'human-message')[0]!.state, 'rejected');
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
    await resolveInbox(f);
    f.history([historyPage([message('original')])]);
    await f.invoke('assistant_history', { sessionId: 'a', cursor: 'page' });
    assert.equal(f.store.inbox().length, 0);
    assert.deepEqual(f.calls.at(-1), { name: 'session/chat', body: {
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
    await f.assistant.observe('a', { id: 'idle', type: 'session.idle', data: {} });
    f.sessions.get('assistant')!.status = 'idle'; await f.assistant.notify();
    assert.equal(f.calls.length, 1);
    assert.equal((f.calls[0]!.body as { text: string }).text.includes('Progress report'), false);
  } finally { f.close(); }
});
test('a notice in flight cannot restore resolved items or lose another result arrival', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  try {
    f.topic('topic', 'a');
    f.onCall(async (name, target) => { if (name === 'prompt' && target === 'assistant') { entered.resolve(); await release.promise; } });
    const first = f.assistant.observe('a', { id: 'first', type: 'assistant.message', data: { content: 'First' } });
    const idle = f.assistant.observe('a', { id: 'idle', type: 'session.idle', data: {} });
    await entered.promise;
    await resolveInbox(f);
    f.store.enqueue({ session_id: 'a', native_id: 'later', kind: 'reply', text: 'Later', attachments: [], question: null });
    f.sessions.get('assistant')!.status = 'running';
    const again = f.assistant.notify();
    release.resolve(); await first; await idle; await again;
    assert.deepEqual(f.store.inbox().map(item => item.text), ['Later']);
    assert.equal(f.store.inbox()[0]!.notice_state, 'pending');
  } finally { release.resolve(); f.close(); }
});

test('the original notification promise drains follow-up sends and records their receipts before shutdown', async () => {
  const f = fixture(), firstEntered = deferred(), firstRelease = deferred(), nextEntered = deferred(), nextRelease = deferred();
  try {
    f.topic('topic', 'a');
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
    f.topic('topic', 'a');
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
    const idle = f.assistant.observe('a', { id: 'idle', type: 'session.idle', data: {} });
    await Promise.all([empty, arrived, idle]);
    assert.equal(f.calls.filter(call => call.name === 'prompt').length, 1);
    assert.equal(f.store.inbox()[0]!.notice_state, 'notified');
  } finally { f.close(); }
});
test('source progress and queued replies wait for known idle; frontend remains enqueue and idle is not success', async () => {
  const f = fixture();
  try {
    f.topic('topic', 'a');
    const source = f.sessions.get('a')!;
    source.status = 'running'; source.activity!.processing = true; source.activity!.hasActiveWork = true;
    const progress = { ...message('progress'), data: { content: 'Checking', toolRequests: [{ toolCallId: 'tool' }] } };
    for (const event of [progress, message('final-a'), { id: 'turn', type: 'assistant.turn_end', data: { turnId: '0' } },
      message('queued-b'), message('final-b')]) await f.assistant.observe('a', event);
    assert.equal(f.store.inbox().length, 4);
    assert.equal(f.calls.length, 0);
    source.status = 'idle'; source.activity!.processing = false; source.activity!.hasActiveWork = false;
    source.activity!.queue.pendingCount = 1;
    await f.assistant.notify(); assert.equal(f.calls.length, 0);
    source.activity!.queue.pendingCount = 0;
    const activity = source.activity; source.activity = null;
    await f.assistant.notify(); assert.equal(f.calls.length, 0);
    source.activity = activity;
    f.sessions.get('assistant')!.status = 'running';
    await f.assistant.observe('a', { id: 'idle', type: 'session.idle', data: {} });
    assert.equal(f.calls.length, 0);
    f.sessions.get('assistant')!.status = 'idle';
    await f.assistant.notify();
    assert.equal(f.calls.length, 1);
    const notice = f.calls[0]!.body as { mode: string; text: string };
    assert.equal(notice.mode, 'enqueue');
    assert.match(notice.text, /not evidence of business success/);
    await resolveInbox(f);
    await f.assistant.observe('a', progress);
    assert.equal(f.calls.filter(call => call.name === 'prompt').length, 1);
    assert.equal(f.store.inbox().length, 0);
  } finally { f.close(); }
});
test('active source asks bypass idle, but ordinary progress does not ride along in the reminder', async () => {
  const f = fixture();
  try {
    f.topic('topic', 'a');
    const source = f.sessions.get('a')!;
    source.status = 'running'; source.activity!.processing = true;
    source.ask = { requestId: 'current', question: 'Choose', choices: ['A', 'B'], allowFreeform: false };
    await f.assistant.observe('a', message('progress'));
    assert.equal(f.calls.length, 1);
    const notice = f.calls[0]!.body as { text: string };
    assert.match(notice.text, /"kind":"ask"/);
    assert.doesNotMatch(notice.text, /"kind":"reply"/);
    assert.deepEqual(f.store.inbox().map(item => item.notice_state), ['pending', 'notified']);
    source.ask = null;
    const result = await f.invoke('assistant_inbox') as { items: { type: string }[] };
    assert.deepEqual(result.items.map(item => item.type), ['reply']);
    await f.assistant.notify();
    assert.equal(f.calls.length, 1);
  } finally { f.close(); }
});
test('asks are revalidated before reminders, and unloaded questions wait without losing their identities', async () => {
  const f = fixture();
  try {
    f.topic('topic', 'a');
    const source = f.sessions.get('a')!;
    f.sessions.get('assistant')!.status = 'running';
    source.ask = { requestId: 'old', question: 'Obsolete?' };
    await f.assistant.observe('a', { id: 'idle', type: 'session.idle', data: {} });
    source.ask = { requestId: 'new', question: 'Current?', choices: ['Yes'] };
    await f.assistant.observe('a');
    source.loaded = false;
    assert.deepEqual(await f.invoke('assistant_inbox', { peek: true }), { count: 0 });
    assert.equal(f.store.inbox().length, 1, 'Eligibility refresh removes stale asks even while foreground is busy');
    const unavailable = await f.invoke('assistant_inbox', {}, 'unavailable') as { items: unknown[]; consumed: boolean };
    assert.deepEqual(unavailable.items, []); assert.equal(unavailable.consumed, false);
    source.loaded = true;
    f.sessions.get('assistant')!.status = 'idle';
    await f.assistant.notify();
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.store.inbox().map(item => item.native_id), ['new']);
    const result = await f.invoke('assistant_inbox', {}, 'available') as { items: { question: unknown }[] };
    assert.deepEqual(result.items.map(item => item.question), [source.ask]);
    assert.equal(f.store.inbox().length, 1, 'Reading a valid ask does not claim presentation');
    await resolveInbox(f);
    await f.assistant.observe('a');
    assert.equal(f.calls.filter(call => call.name === 'prompt').length, 1);
    assert.equal(f.store.inbox().length, 0);
  } finally { f.close(); }
});
test('manual progress consumption before source idle does not leave a new reminder', async () => {
  const f = fixture();
  try {
    f.topic('topic', 'a');
    const source = f.sessions.get('a')!;
    source.status = 'running'; source.activity!.processing = true;
    await f.assistant.observe('a', message('manual-progress'));
    assert.equal(f.calls.length, 0);
    await resolveInbox(f);
    source.status = 'idle'; source.activity!.processing = false;
    await f.assistant.observe('a', { id: 'idle', type: 'session.idle', data: {} });
    assert.equal(f.calls.filter(call => call.name === 'prompt').length, 0);
  } finally { f.close(); }
});
test('native cancellation and errors retain explicit incomplete facts, not successful completion', async () => {
  for (const type of ['abort', 'session.error']) {
    const f = fixture();
    try {
      f.topic('topic', 'a');
      const source = f.sessions.get('a')!;
      source.status = 'running'; source.activity!.processing = true;
      const event = { id: type, type, data: { message: 'Synthetic failure' } };
      await f.assistant.observe('a', message('partial'));
      await f.assistant.observe('a', event);
      assert.equal(f.calls.length, 0);
      source.status = type === 'abort' ? 'idle' : 'error'; source.activity!.processing = false;
      await f.assistant.observe('a', { id: 'idle', type: 'session.idle', data: {} });
      assert.equal(f.calls.length, 1);
      assert.equal(f.store.inbox()[1]!.text, '');
      assert.equal(f.store.source(f.store.inbox()[1]!.id)?.eventId, type);
      await resolveInbox(f);
      await f.assistant.observe('a', event);
      assert.equal(f.calls.filter(call => call.name === 'prompt').length, 1);
    } finally { f.close(); }
  }
});
test('busy dispatch uses immediate with distinct human receipts and never aborts, clears, or loses repeated text', async () => {
  const f = fixture();
  try {
    f.topic('topic', 'a');
    f.sessions.get('a')!.status = 'running'; f.sessions.get('a')!.activity!.processing = true;
    const query = { items: [{ topicId: 'topic', prompt: 'Same request' }] };
    await f.invoke('assistant_dispatch', query, 'first');
    f.input({ messageId: 'next-human-message', interactionId: 'next-human-interaction' });
    await f.invoke('assistant_dispatch', query, 'second');
    assert.deepEqual(f.calls, [1, 2].map(() => ({ name: 'prompt',
      body: { sessionId: 'a', mode: 'immediate', text: 'Same request' } })));
    assert.equal(f.store.deliveries('assistant', 'human-message')[0]!.state, 'accepted');
    assert.equal(f.store.deliveries('assistant', 'next-human-message')[0]!.state, 'accepted');
  } finally { f.close(); }
});
test('overlapping native callbacks drain in order even when metadata already reports idle', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  try {
    f.topic('topic', 'a');
    let first = true;
    f.onMeta(async id => {
      if (id === 'a' && first) { first = false; entered.resolve(); await release.promise; }
    });
    const progress = f.assistant.observe('a', message('slow-progress'));
    await entered.promise;
    const final = f.assistant.observe('a', message('final'));
    release.resolve();
    await Promise.all([progress, final]);
    assert.equal(f.calls.length, 0, 'Idle metadata alone must not flush a partial live callback batch');
    await f.assistant.observe('a', { id: 'idle', type: 'session.idle', ephemeral: true, data: {} });
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.store.inbox().map(item => [f.store.source(item.id)?.eventId, item.notice_state]),
      [['slow-progress', 'notified'], ['final', 'notified']]);
    await resolveInbox(f);
    await f.assistant.observe('a', message('final'));
    assert.equal(f.calls.filter(call => call.name === 'prompt').length, 1);
  } finally { release.resolve(); f.close(); }
});
test('a question invalidated while another source is sampled stays unread and is not returned as live', async () => {
  for (const unloaded of [true, false]) {
    const f = fixture(), entered = deferred(), release = deferred();
    try {
      f.topic('one', 'a'); f.topic('two', 'b'); f.sessions.get('assistant')!.status = 'running';
      for (const id of ['a', 'b']) {
        f.sessions.get(id)!.ask = { requestId: id, question: id };
        await f.assistant.observe(id);
      }
      let paused = false;
      f.onMeta(async id => { if (id === 'b' && !paused) { paused = true; entered.resolve(); await release.promise; } });
      const read = f.invoke('assistant_inbox');
      await entered.promise;
      if (unloaded) f.sessions.get('a')!.loaded = false;
      else f.sessions.get('a')!.ask = null;
      const invalidation = f.assistant.observe('a');
      release.resolve();
      const result = await read as { items: { sessionId: string }[] };
      await invalidation;
      assert.deepEqual(result.items.map(item => item.sessionId), ['b']);
      assert.deepEqual(f.store.inbox().map(item => item.session_id), unloaded ? ['a', 'b'] : ['b']);
      assert.deepEqual(await f.invoke('assistant_inbox', { peek: true }), { count: 1 });
      assert.equal(f.store.inbox().length, unloaded ? 2 : 1);
    } finally { release.resolve(); f.close(); }
  }
});
test('source resumption during another source lookup invalidates notice eligibility before reservation', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  try {
    f.topic('one', 'a'); f.topic('two', 'b');
    for (const id of ['a', 'b']) f.store.enqueue({
      session_id: id, native_id: id, kind: 'reply', text: id, attachments: [], question: null,
    });

    test('status uses native freshness and current readiness without erasing historical wake failure or sending', async () => {
      const f = fixture();
      try {
        f.store.saveTopic({ ...f.topic('topic', 'a'), content: 'Legacy: release is pending' });
        f.store.saveForegroundWake({ sessionId: 'assistant', state: 'failed', error: 'Old disconnected resources' });
        f.history([historyPage([message('actual-new-tail')])]);
        const result = await f.invoke('assistant_status', { topicId: 'topic' }) as {
          topic: { contentUse: string; warning: string };
          freshness: { headEventId: string; evidenceInThisResponse: boolean };
          health: { current: { readiness: string; checkedAt: number }; lastWakeAttempt: { state: string; error: string; at: number } };
        };
        assert.equal(result.topic.contentUse, 'identity-responsibility-scope-only');
        assert.match(result.topic.warning, /never current progress/);
        assert.equal(result.freshness.headEventId, 'actual-new-tail');
        assert.equal(result.freshness.evidenceInThisResponse, false);
        assert.equal(result.health.current.readiness, 'ready');
        assert.equal(result.health.lastWakeAttempt.state, 'failed');
        assert.equal(result.health.lastWakeAttempt.error, 'Old disconnected resources');
        assert.ok(result.health.current.checkedAt >= result.health.lastWakeAttempt.at);
        assert.deepEqual(f.calls.map(call => call.name), ['session/chat']);
        assert.equal(f.store.foregroundWake()!.state, 'failed');
        f.sessions.get('assistant')!.loaded = false;
        assert.equal((await f.assistant.health()).current.readiness, 'unknown');
        assert.deepEqual(f.calls.map(call => call.name), ['session/chat']);
      } finally { f.close(); }
    });

    test('valid ask reads remain distinct from presentation, and expired asks do not leave unresolvable read decisions', async () => {
      const f = fixture();
      try {
        f.topic('topic', 'a'); f.sessions.get('assistant')!.status = 'running';
        f.sessions.get('a')!.ask = { requestId: 'ask', question: 'Choose', choices: ['Yes', 'No'] };
        await f.assistant.observe('a');
        const response = await f.invoke('assistant_inbox', {}, 'ask-reader') as {
          items: { receipt: { id: string; disposition: string } }[];
        };
        const receiptId = response.items[0]!.receipt.id;
        assert.equal(response.items[0]!.receipt.disposition, 'unresolved');
        await assert.rejects(f.invoke('assistant_resolve', { receiptId, disposition: 'silent' }), { code: 'ASK_PRESENTATION' });
        f.sessions.get('a')!.ask = null;
        await f.invoke('assistant_inbox');
        assert.deepEqual(f.assistant.evidence.pendingSummary('assistant').items, []);
        await assert.rejects(f.invoke('assistant_resolve', { receiptId, disposition: 'notify' }), { code: 'DECISION_CONFLICT' });
        assert.equal(f.calls.length, 0);
      } finally { f.close(); }
    });
    let paused = false;
    f.onMeta(async id => { if (id === 'b' && !paused) { paused = true; entered.resolve(); await release.promise; } });
    const notice = f.assistant.notify();
    await entered.promise;
    f.sessions.get('a')!.status = 'running'; f.sessions.get('a')!.activity!.processing = true;
    const resumed = f.assistant.observe('a', message('resumed-progress'));
    release.resolve();
    await Promise.all([notice, resumed]);
    assert.equal(f.calls.length, 1);
    assert.doesNotMatch((f.calls[0]!.body as { text: string }).text, /"sessionId":"a"/);
    assert.deepEqual(f.store.inbox().filter(item => item.session_id === 'a').map(item => item.notice_state), ['pending', 'pending']);
    f.sessions.get('a')!.status = 'idle'; f.sessions.get('a')!.activity!.processing = false;
    await f.assistant.observe('a', { id: 'idle', type: 'session.idle', ephemeral: true, data: {} });
    assert.equal(f.calls.length, 2);
  } finally { release.resolve(); f.close(); }
});
