import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { ModuleBackend, ModuleBackendContext, ModuleHostApi, ModuleHostIntent,
  ModuleHostIntentBody, ModuleHostIntentResult, PublicSessionMeta } from '@waksana/cockpit-module-sdk/backend';
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
  const calls: { name: ModuleHostIntent; body: unknown }[] = [], errors: unknown[] = [];
  const backends: ModuleBackend[] = [], releases: (() => void)[] = [];
  let onCall: ((name: ModuleHostIntent) => Promise<void>) | null = null;
  let failure: ModuleHostIntent | null = null, missingReceipt = false;
  const host: ModuleHostApi = {
    chatReadVersion: 1, askResponseVersion: 1, roleAssignmentVersion: 1, sessionLoadVersion: 1,
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
        case 'session/load':
          assert.equal(sessionId, 'front');
          sessions.get('front')!.loaded = true;
          result = { ok: true, sessionId }; break;
        case 'session/tool-scope': result = { sessionId, loaded: true, configured: null,
          applied: { builtins: [], mcpServers: [{ name: 'assistant', tools: coordinatorTools }] },
          tools: coordinatorTools.map(name => ({ name: `assistant-${name}`, mcpServerName: 'assistant', mcpToolName: name })) }; break;
        case 'roles/readiness': result = { sessionId, ready: true, rolesNeedReload: false }; break;
        case 'prompt':
          assert.equal(sessionId, 'front');
          result = { ok: true, ...(missingReceipt ? {} : { messageId: 'native-notice-receipt' }) }; break;
        default: throw new Error(`Unexpected synthetic Host operation: ${name}`);
      }
      return result as ModuleHostIntentResult<Name>;
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
    dataRoot, database, calls, errors, sessions,
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
          inbox: sql.prepare('SELECT notice_state,notification_receipt,text FROM mailbox ORDER BY sequence').all(),
          wake: wake ? JSON.parse(String(wake.fingerprint)) as { sessionId: string; state: string } : null,
        };
      } finally { sql.close(); }
    },
  };
}

async function assertIngressStopped(backend: ModuleBackend, f: ReturnType<typeof fixture>) {
  const before = f.calls.length;
  await backend.onReady!();
  await backend.promptAccepted!({ sessionId: 'front', messageId: 'late', origin: 'module', acceptedAt: Date.now() });
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
    assert.ok(f.calls.some(call => call.name === 'session/tool-scope'));
    assert.ok(f.calls.some(call => call.name === 'roles/readiness'));
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

for (const phase of ['session/tool-scope', 'roles/readiness'] as const) {
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
    if (phase === 'session/tool-scope') {
      assert.equal((f.errors[0] as { code: string }).code, 'STOPPING');
      assert.equal(f.calls.some(call => call.name === 'roles/readiness'), false);
    } else assert.deepEqual(f.errors, []);
  });
}
