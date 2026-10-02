import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { ModuleBackend, ModuleBackendContext, ModuleHostApi, ModuleHostIntent,
  ModuleHostIntentBody, ModuleHostIntentResult, NativeChatEvent, PublicSessionMeta } from '@waksana/cockpit-module-sdk/backend';
import { activate } from '../src/index.ts';
import { coordinatorTools } from '../src/mcp.ts';
import { Store } from '../src/store.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t: TestContext, seed = true) {
  const root = join(process.cwd(), 'test', `.index-${randomUUID()}`);
  const dataRoot = join(root, 'data'), database = join(dataRoot, 'assistant.sqlite');
  mkdirSync(root, { recursive: true });
  if (seed) {
    mkdirSync(dataRoot);
    const store = new Store(database);
    try {
      store.remember('foreground', 'front');
      store.saveTopic({ id: 'topic', title: 'Synthetic topic', content: '', version: 1, archived: false,
        session_id: 'source', mapping_state: 'bound', mapping_error: null, creation_receipt: null });
      store.enqueue({ session_id: 'source', native_id: 'reply', kind: 'reply',
        text: 'Synthetic completed reply', attachments: [], question: null });
    } finally { store.close(); }
  }
  const role = { moduleId: 'assistant', roleId: 'coordinator', name: 'Assistant', moduleName: 'Assistant' };
  const meta = (sessionId: string): PublicSessionMeta => ({
    sessionId, cwd: '/synthetic', title: sessionId, status: 'idle', loaded: true, lastActivity: 1, ask: null,
    roles: sessionId === 'front' ? [role] : [], appliedRoles: sessionId === 'front' ? [role] : [],
    rolesNeedReload: false,
    activity: { processing: false, hasActiveWork: false, abortable: false, sampledAt: Date.now(),
      tasks: { activeAgents: 0, activeShells: 0, unknown: 0 },
      queue: { pendingCount: 0, steeringCount: 0, inFlightSteeringCount: 0 },
      mcp: { pendingConnectionCount: 0 } },
  });
  const sessions = new Map(['front', 'source'].map(id => [id, meta(id)]));
  const events = new Map<string, NativeChatEvent[]>();
  const calls: { name: ModuleHostIntent; body: unknown }[] = [], errors: unknown[] = [];
  const backends: ModuleBackend[] = [], releases: (() => void)[] = [];
  let onCall: ((name: ModuleHostIntent) => Promise<void>) | null = null;
  let onResult: ((name: ModuleHostIntent, result: unknown) => unknown) | null = null;
  let failure: ModuleHostIntent | null = null, missingReceipt = false;
  const host: ModuleHostApi = {
    chatReadVersion: 1, askResponseVersion: 1, roleAssignmentVersion: 1, roleAvailabilityVersion: 1, sessionLoadVersion: 1,
    promptReceiptVersion: 1, toolScopeVersion: 1, promptOriginVersion: 1, roleResourcePolicyVersion: 1,
    async call<Name extends ModuleHostIntent>(name: Name, body: ModuleHostIntentBody<Name>): Promise<ModuleHostIntentResult<Name>> {
      assert.equal(context.signal.aborted, false, 'Host capability remains live while draining');
      if (name === 'session/load' || name === 'prompt')
        assert.equal(context.stopping.aborted, false, 'No new native side effects after stopping');
      if (name === 'roles/readiness')
        assert.equal(context.stopping.aborted, false, 'Host does not admit new readiness calls during drain');
      calls.push({ name, body });
      if (onCall) await onCall(name);
      assert.equal(context.signal.aborted, false, 'Started calls settle before final capability revocation');
      if (failure === name) throw new Error(`Synthetic lost ${name} receipt`);
      const sessionId = 'sessionId' in body ? body.sessionId : undefined;
      let result: unknown;
      switch (name) {
        case 'session/get': result = { meta: structuredClone(sessions.get(sessionId!) ?? null) }; break;
        case 'roles/availability': result = { sessionId, roles: sessions.get(sessionId!)!.roles, status: 'available', reasons: [] }; break;
        case 'session/load':
          assert.equal(sessionId, 'front');
          sessions.get('front')!.loaded = true;
          sessions.get('front')!.appliedRoles = structuredClone(sessions.get('front')!.roles);
          result = { ok: true, sessionId }; break;
        case 'session/tool-scope': result = { sessionId, loaded: true, configured: null,
          applied: { builtins: [], mcpServers: [{ name: 'assistant', tools: coordinatorTools }] },
          tools: coordinatorTools.map(name => ({ name: `assistant-${name}`, mcpServerName: 'assistant', mcpToolName: name })) }; break;
        case 'roles/readiness': result = { sessionId, ready: true, loaded: true, rolesNeedReload: false,
          roles: sessions.get(sessionId!)!.roles, appliedRoles: sessions.get(sessionId!)!.appliedRoles }; break;
        case 'prompt':
          assert.ok(sessionId === 'front' || sessionId === 'source');
          result = { ok: true, ...(missingReceipt ? {} : { messageId: 'native-notice-receipt' }) }; break;
        case 'session/chat': result = { sessionId, source: 'source' in body ? body.source : 'live',
          direction: 'backward', events: events.get(sessionId!) ?? [], cursorStatus: 'ok',
          cursor: 'synthetic-cursor', hasMore: false, read: { rpc: 1, events: events.get(sessionId!)?.length ?? 0 } }; break;
        default: throw new Error(`Unexpected synthetic Host operation: ${name}`);
      }
      return (onResult ? onResult(name, structuredClone(result)) : result) as ModuleHostIntentResult<Name>;
    },
  };
  let stopping = new AbortController(), signal = new AbortController();
  let context: ModuleBackendContext = {
    host, apiVersion: 1, serviceReadyVersion: 1, shutdownVersion: 1, moduleId: 'assistant',
    dataRoot, apiBase: '/modules/assistant', config: { defaultCwd: '/synthetic' },
    stopping: stopping.signal, signal: signal.signal,
    report(error) { errors.push(error); }, invalidate() {}, publish() {},
  };
  t.after(async () => {
    for (const release of releases) release();
    for (const backend of backends) await backend.dispose!();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    dataRoot, database, calls, errors, sessions, events,
    respond(value: typeof onResult) { onResult = value; },
    get context() { return context; },
    stop() { stopping.abort(); },
    revoke() { signal.abort(); },
    fail(name: ModuleHostIntent) { failure = name; },
    missingReceipt() { missingReceipt = true; },
    gate(name: ModuleHostIntent) {
      const entered = deferred(), release = deferred();
      releases.push(release.resolve);
      onCall = async called => { if (called === name) { entered.resolve(); await release.promise; } };
      return { entered: entered.promise, release: release.resolve };
    },
    async activate() {
      const backend = await activate(context);
      backends.push(backend);
      return backend;
    },
    restart() {
      stopping = new AbortController(); signal = new AbortController();
      context = { ...context, stopping: stopping.signal, signal: signal.signal };
      onCall = null; failure = null; missingReceipt = false;
    },
    state() {
      const sql = new DatabaseSync(database, { readOnly: true });
      try {
        const wake = sql.prepare("SELECT fingerprint FROM seen WHERE id='foreground-wake'").get();
        return {
          inbox: sql.prepare(`SELECT notice_state,notification_receipt,text FROM mailbox
            WHERE NOT EXISTS(SELECT 1 FROM seen WHERE seen.id='inbox-archived:'||mailbox.id) ORDER BY sequence`).all(),
          wake: wake ? JSON.parse(String(wake.fingerprint)) as { sessionId: string; state: string } : null,
        };
      } finally { sql.close(); }
    },
  };
}

async function assertIngressStopped(backend: ModuleBackend, f: ReturnType<typeof fixture>) {
  const before = f.calls.length;
  await backend.onReady!();
  assert.equal(backend.promptAccepted, undefined);
  await backend.events!.handle({ sessionId: 'source', cwd: '/synthetic',
    event: { id: 'late-idle', type: 'session.idle', data: {} } });
  await backend.controlEvents!.handle({ type: 'session/invalidated', sessionId: 'source' });
  const route = backend.routes.find(route => route.path === '/state')!;
  await assert.rejects(async () => route.handler({
    params: {}, query: {}, headers: {}, body: null, signal: f.context.signal,
  }), { code: 'NOT_READY' });
  assert.equal(f.calls.length, before, 'Stopped callbacks do not start even passive Host reads');
}

test('activation rejects a missing shutdown.v1 before opening the database or acquiring its lease', async t => {
  const f = fixture(t, false);
  const { shutdownVersion: _version, ...legacy } = f.context;
  await assert.rejects(activate(legacy as ModuleBackendContext), { code: 'HOST_CAPABILITY' });
  assert.equal(existsSync(f.dataRoot), false);
  assert.deepEqual(f.calls, []);
  const backend = await f.activate();
  assert.equal(existsSync(f.database), true);
  assert.equal(typeof backend.onStop, 'function');
});

test('an already stopping activation is rejected before opening data', async t => {
  const f = fixture(t, false);
  f.stop();
  await assert.rejects(f.activate(), { code: 'STOPPING' });
  assert.equal(existsSync(f.dataRoot), false);
  assert.deepEqual(f.calls, []);
});

test('activation does not require unrelated role availability or prompt origin capabilities', async t => {
  const f = fixture(t, false);
  const { roleAvailabilityVersion: _version, ...host } = f.context.host;
  const backend = await activate({ ...f.context, host });
  assert.equal(existsSync(f.dataRoot), true);
  await backend.dispose!();
});

const connection = { moduleId: 'connection', roleId: 'binding', moduleName: 'Synthetic', name: 'Binding' };
function addConnections(meta: PublicSessionMeta, order: string) {
  const role = meta.roles![0]!;
  meta.roles = order === 'first' ? [connection, role]
    : order === 'last' ? [role, connection] : [connection, role, { ...connection, moduleId: 'second' }];
  meta.appliedRoles = [...meta.roles].reverse();
}
async function callTool(backend: ModuleBackend, name: string, toolCallId: string, args: unknown) {
  const result = await backend.routes.find(route => route.path === '/mcp')!.handler({
    params: {}, query: {}, headers: {}, signal: new AbortController().signal,
    body: { jsonrpc: '2.0', id: toolCallId, method: 'tools/call', params: { name, arguments: args,
      _meta: { 'cockpit/invocation': { sessionId: 'front', runtimeSessionId: 'front', subagent: false, toolCallId } } } },
  });
  return result.body as { result: { isError: boolean; content: { text: string }[] } };
}
function inputEvents(messageId: string, toolCallId: string): NativeChatEvent[] {
  return [
    { id: `event-${messageId}`, type: 'user.message', timestamp: Date.now(),
      data: { messageId, interactionId: messageId, content: 'Synthetic human instruction' } },
    { id: `event-${toolCallId}`, type: 'assistant.message',
      data: { interactionId: messageId, toolRequests: [{ toolCallId }] } },
  ];
}
for (const order of ['first', 'last', 'multiple']) {
  for (const cold of [false, true]) {
    test(`unrelated ${order} roles retain ${cold ? 'cold' : 'loaded'} notification and ordinary MCP access without qualification`, async t => {
      const f = fixture(t), front = f.sessions.get('front')!;
      addConnections(front, order);
      front.loaded = !cold;
      if (cold) front.appliedRoles = [];
      const backend = await f.activate();
      await backend.onReady!();
      assert.deepEqual(f.errors, []);
      assert.equal(f.state().inbox[0]!.notice_state, 'notified');
      assert.equal(f.calls.filter(call => call.name === 'session/load').length, cold ? 1 : 0);
      const notice = f.calls.find(call => call.name === 'prompt')!;
      assert.equal((notice.body as { mode: string }).mode, 'enqueue');
      f.events.set('front', inputEvents('notice', 'read-inbox'));
      assert.equal(backend.promptAccepted, undefined);
      const inbox = await callTool(backend, 'assistant_inbox', 'read-inbox', {});
      assert.equal(inbox.result.isError, false);
      assert.doesNotMatch(inbox.result.content[0]!.text, /Synthetic completed reply/);
      assert.equal(f.state().inbox.length, 1);
      const { receipt } = JSON.parse(inbox.result.content[0]!.text) as { receipt: { id: string; inboxIds: string[] } };
      const checkpoint = await callTool(backend, 'assistant_checkpoint', 'read-checkpoint', {
        receiptId: receipt.id, sessionId: 'source', readIds: receipt.inboxIds, complete: true,
        position: { query: { source: 'persisted', direction: 'backward' }, nextQuery: null, boundaryEventId: 'source-event' },
      });
      assert.equal(checkpoint.result.isError, false);
      f.events.set('front', inputEvents('notice', 'resolve-evidence'));
      const decision = await callTool(backend, 'assistant_resolve', 'resolve-evidence', { receiptId: receipt.id, disposition: 'silent' });
      assert.equal(decision.result.isError, false);
      assert.deepEqual(f.state().inbox, []);
      const duplicate = await callTool(backend, 'assistant_inbox', 'read-inbox', {});
      assert.equal(duplicate.result.isError, false);
      assert.doesNotMatch(duplicate.result.content[0]!.text, /Synthetic completed reply/);
      const blocked = await callTool(backend, 'assistant_dispatch', 'read-inbox',
        { items: [{ topicId: 'topic', prompt: 'Do not send module input' }] });
      assert.equal(blocked.result.isError, true);
      assert.match(blocked.result.content[0]!.text, /TOOL_RETIRED/);
      assert.equal(f.calls.filter(call => call.name === 'prompt').length, 1);
      f.events.set('front', inputEvents('human', 'dispatch'));
      const sent = await callTool(backend, 'assistant_dispatch', 'dispatch',
        { items: [{ topicId: 'topic', prompt: 'Synthetic human instruction' }] });
      assert.equal(sent.result.isError, true);
      assert.match(sent.result.content[0]!.text, /TOOL_RETIRED/);
      assert.equal(f.calls.filter(call => call.name === 'prompt').length, 1);
      assert.equal(f.calls.some(call => ['roles/availability', 'roles/readiness', 'session/tool-scope', 'session/chat'].includes(call.name)), false);
    });
  }
}
test('role preflight denials and missing role labels do not block existing Host-granted Assistant tools', async t => {
  for (const state of ['denied', 'unknown', 'changed', 'two-assistants', 'missing-saved']) {
    await t.test(state, async t => {
      const f = fixture(t), front = f.sessions.get('front')!;
      addConnections(front, 'multiple'); front.loaded = false; front.appliedRoles = [];
      if (state === 'two-assistants') front.roles!.push({ ...front.roles![1]!, roleId: 'organizer' });
      if (state === 'missing-saved') delete front.roles;
      f.respond((name, result) => {
        if (name !== 'roles/availability') return result;
        if (state === 'changed') { front.roles!.push({ ...connection, moduleId: 'raced' }); return result; }
        return { ...(result as ModuleHostIntentResult<'roles/availability'>),
          status: state === 'denied' ? 'unavailable' : 'unknown' };
      });
      const backend = await f.activate();
      await backend.onReady!();
      assert.equal(f.calls.some(call => call.name === 'roles/availability'), false);
      assert.equal(f.calls.filter(call => call.name === 'session/load').length, 1);
      assert.equal(f.calls.filter(call => call.name === 'prompt').length, 1);
      assert.equal(f.state().inbox[0]!.notice_state, 'notified');
      assert.equal(f.errors.length, 0);
    });
  }
});
test('native load rejection or uncertainty retains mail and forbids blind reload', async t => {
  for (const phase of ['failed', 'unknown'] as const) {
    await t.test(phase, async t => {
      const f = fixture(t), front = f.sessions.get('front')!;
      addConnections(front, 'first'); front.loaded = false; front.appliedRoles = [];
      f.respond((name, result) => {
        if (name === 'session/load') return phase === 'failed'
          ? { ok: false, sessionId: 'front' } : { ok: true };
        return result;
      });
      const backend = await f.activate();
      await backend.onReady!();
      assert.equal(f.state().wake!.state, phase);
      assert.equal(f.state().inbox[0]!.notice_state, 'pending');
      assert.equal(f.calls.some(call => call.name === 'prompt'), false);
      front.loaded = false;
      await backend.controlEvents!.handle({ type: 'session/invalidated', sessionId: 'front' });
      assert.equal(f.calls.filter(call => call.name === 'session/load').length, 1);
    });
  }
});

test('stopping before readiness prevents all foreground loading and prompts', async t => {
  const f = fixture(t);
  f.sessions.get('front')!.loaded = false;
  const backend = await f.activate();
  f.stop();
  await assertIngressStopped(backend, f);
  await backend.onStop!();
  assert.equal(f.context.signal.aborted, false);
  assert.deepEqual(f.calls, []);
  assert.equal(f.state().inbox[0]!.notice_state, 'pending');
});

test('a foreground switch during final native readback cannot send to the old address', async t => {
  const f = fixture(t);
  const backend = await f.activate();
  let foregroundReads = 0, switched = false;
  f.respond((name, result) => {
    if (name !== 'session/get' || (result as ModuleHostIntentResult<'session/get'>).meta?.sessionId !== 'front')
      return result;
    if (++foregroundReads !== 2 || switched) return result;
    switched = true;
    return (async () => {
      const selected = await callTool(backend, 'assistant_foreground', 'switch-address', { sessionId: 'source' });
      assert.equal(selected.result.isError, false);
      return result;
    })();
  });

  await backend.onReady!();
  assert.equal(switched, true);
  assert.equal(f.calls.some(call => call.name === 'prompt'), false);
  assert.equal(f.state().inbox[0]!.notice_state, 'pending');
  assert.equal((f.errors[0] as { code: string }).code, 'FOREGROUND_CHANGED');
});

test('disabling reminders during discovery cannot load a deselected foreground', async t => {
  const f = fixture(t);
  f.sessions.get('front')!.loaded = false;
  const backend = await f.activate();
  let disabled = false;
  f.respond((name, result) => {
    if (disabled || name !== 'session/get' || (result as ModuleHostIntentResult<'session/get'>).meta?.sessionId !== 'front')
      return result;
    disabled = true;
    return (async () => {
      const selected = await callTool(backend, 'assistant_foreground', 'disable-address', { sessionId: null });
      assert.equal(selected.result.isError, false);
      return result;
    })();
  });
  await backend.onReady!();
  assert.equal(disabled, true);
  assert.equal(f.calls.some(call => call.name === 'session/load' || call.name === 'prompt'), false);
  assert.equal(f.state().wake, null);
  assert.equal(f.state().inbox[0]!.notice_state, 'pending');
  assert.equal((f.errors[0] as { code: string }).code, 'FOREGROUND_CHANGED');
});

for (const lost of [false, true]) {
  test(`onStop drains an in-flight foreground load and persists ${lost ? 'unknown' : 'loaded'} without prompting`, { timeout: 5000 }, async t => {
    const f = fixture(t), gate = f.gate('session/load');
    const close = t.mock.method(Store.prototype, 'close');
    f.sessions.get('front')!.loaded = false;
    if (lost) f.fail('session/load');
    const backend = await f.activate(), ready = backend.onReady!();
    await gate.entered;
    assert.equal(f.state().wake!.state, 'loading');
    f.stop();
    let drained = false;
    const drain = Promise.resolve(backend.onStop!()).then(() => { drained = true; });
    await setImmediate();
    assert.equal(drained, false);
    assert.equal(f.context.signal.aborted, false);
    await assertIngressStopped(backend, f);
    gate.release();
    await Promise.all([ready, drain]);
    assert.deepEqual(f.state().wake, lost
      ? { sessionId: 'front', state: 'unknown', error: 'Synthetic lost session/load receipt' }
      : { sessionId: 'front', state: 'loaded', error: null });
    assert.equal(f.state().inbox[0]!.notice_state, 'pending');
    assert.deepEqual(f.calls.filter(call => call.name === 'session/load' || call.name === 'prompt'),
      [{ name: 'session/load', body: { sessionId: 'front' } }]);
    assert.equal(f.errors.length, lost ? 1 : 0);
    assert.equal(close.mock.callCount(), 0, 'onStop drains without releasing persistent resources');
    f.restart();
    await assert.rejects(f.activate(), { code: 'EADDRINUSE' });
    assert.equal(close.mock.callCount(), 0, 'The lease still fences a second writer after onStop');
    await backend.dispose!();
    assert.equal(close.mock.callCount(), 1);
    await f.activate();
  });
}

for (const outcome of ['accepted', 'lost', 'missing'] as const) {
  test(`onStop drains the ${outcome} prompt receipt before disposal; restart never replays it`, { timeout: 5000 }, async t => {
    const f = fixture(t), gate = f.gate('prompt');
    const close = t.mock.method(Store.prototype, 'close');
    if (outcome === 'lost') f.fail('prompt');
    if (outcome === 'missing') f.missingReceipt();
    const backend = await f.activate(), ready = backend.onReady!();
    await gate.entered;
    assert.equal(f.state().inbox[0]!.notice_state, 'calling');
    assert.equal(f.calls.some(call => call.name === 'session/tool-scope' || call.name === 'roles/readiness'), false);
    assert.equal((f.calls.find(call => call.name === 'prompt')!.body as { mode: string }).mode, 'enqueue');
    f.stop();
    let drained = false, disposed = false;
    const drain = Promise.resolve(backend.onStop!()).then(() => { drained = true; });
    const disposal = Promise.resolve(backend.dispose!()).then(() => { disposed = true; });
    await setImmediate();
    assert.equal(drained, false);
    assert.equal(disposed, false);
    assert.equal(close.mock.callCount(), 0, 'Store stays open for the native receipt');
    await assertIngressStopped(backend, f);
    gate.release();
    await Promise.all([ready, drain, disposal]);
    assert.equal(f.context.signal.aborted, false);
    assert.equal(close.mock.callCount(), 1);
    await backend.dispose!();
    assert.equal(close.mock.callCount(), 1, 'Dispose is idempotent');
    assert.deepEqual(f.state().inbox, [{
      __proto__: null,
      notice_state: outcome === 'accepted' ? 'notified' : 'unknown',
      notification_receipt: outcome === 'accepted' ? 'native-notice-receipt' : null,
      text: 'Synthetic completed reply',
    }]);
    assert.equal(f.errors.length, outcome === 'accepted' ? 0 : 1);
    f.revoke();
    f.restart();
    f.sessions.get('front')!.loaded = false;
    const before = f.calls.length;
    const restarted = await f.activate();
    await restarted.onReady!();
    assert.equal(f.calls.length, before, 'Durable notice state prevents both load and prompt replay');
    await restarted.dispose!();
    assert.equal(close.mock.callCount(), 2, 'The same data path can reacquire its released writer lease');
  });
}

for (const phase of ['session/get'] as const) {
  test(`shutdown during ${phase} drains validation without reserving or prompting`, { timeout: 5000 }, async t => {
    const f = fixture(t), gate = f.gate(phase);
    const backend = await f.activate(), ready = backend.onReady!();
    await gate.entered;
    f.stop();
    let drained = false;
    const drain = Promise.resolve(backend.onStop!()).then(() => { drained = true; });
    await setImmediate();
    assert.equal(drained, false);
    gate.release();
    await Promise.all([ready, drain]);
    assert.equal(f.context.signal.aborted, false);
    assert.equal(f.state().inbox[0]!.notice_state, 'pending');
    assert.equal(f.calls.some(call => call.name === 'session/load' || call.name === 'prompt'), false);
    assert.equal(f.calls.some(call => call.name === 'roles/readiness'), false);
  });
}
