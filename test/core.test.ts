import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { McpInvocationMeta, ModuleHostApi, ModuleHostIntent, ModuleHostIntentBody,
  ModuleHostIntentResult, PublicSessionMeta } from '@waksana/cockpit-module-sdk/backend';
import { Assistant, configInput } from '../src/core.ts';
import type { Gateway, Input } from '../src/gateway.ts';
import { Store, type Delivery, type Topic } from '../src/store.ts';

const identity = (toolCallId: string): McpInvocationMeta =>
  ({ sessionId: 'assistant', runtimeSessionId: 'assistant', subagent: false, toolCallId });
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
        case 'session/chat': result = { sessionId: target, events: [{ id: 'history', type: 'assistant.message', data: { content: 'Native history' } }],
          cursor: 'native-cursor', hasMore: false }; break;
        default: throw new Error(`Unexpected native call ${name}`);
      }
      return result as ModuleHostIntentResult<Name>;
    },
  };
  const native: Gateway = {
    host, async caller(call) {
      assert.equal(call.subagent, false);
      return { sessionId: 'assistant', toolCallId: call.toolCallId!, role: 'coordinator', input: structuredClone(source) };
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
