import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
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
import { RecentSessions } from '../src/recent.ts';
import { NativeChat } from '../src/native-chat.ts';

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
      store.saveWatch({ session_id: 'source', enabled: true, version: 1, updated_at: 0 });
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
    sessionDirectoryVersion: 1,
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
        case 'session/directory': result = { sessions: [...sessions.values()].map(meta => structuredClone(meta)) }; break;
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
          watches: sql.prepare('SELECT session_id,enabled,version FROM watches ORDER BY rowid').all(),
          topics: sql.prepare('SELECT id,session_id,archived FROM topics ORDER BY rowid').all(),
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

test('activation defers source transitions without activity feedback and recovers on natural control events', async t => {
  const f = fixture(t);
  f.sessions.get('source')!.status = 'running';
  const backend = await f.activate();
  await backend.onReady!();
  const unavailable = new Set(['source']);
  const call = f.context.host.call;
  const feedback: Promise<unknown>[] = [];
  f.context.host.call = (name, body) => {
    if (name === 'session/get') {
      const sessionId = (body as { sessionId: string }).sessionId;
      feedback.push(Promise.resolve(backend.controlEvents!.handle({
        type: 'session/patch', sessionId, activeOperations: 1,
      })));
      if (unavailable.has(sessionId)) throw Object.assign(new Error('metadata transition'), { code: 'SESSION_TRANSITION' });
    }
    return call(name, body);
  };
  const observation = (event: NativeChatEvent) => backend.events!.handle({ sessionId: 'source', cwd: '/synthetic', event });
  await observation({ id: 'new-message', type: 'assistant.message', data: { messageId: 'new-reply', content: 'Not mirrored' } });
  await observation({ id: 'idle', type: 'session.idle', ephemeral: true, data: {} });
  await Promise.all(feedback);
  assert.equal(f.state().inbox.length, 2);
  assert.ok(f.state().inbox.every(item => item.notice_state === 'pending'));
  assert.equal(f.state().inbox[1]!.text, '');
  const state = await backend.routes.find(route => route.path === '/state')!.handler({
    params: {}, query: {}, headers: {}, body: null, signal: f.context.signal,
  });
  assert.equal((state.body as { health: { observations: { deferredSourceCount: number } } }).health.observations.deferredSourceCount, 1);
  assert.equal(f.calls.some(call => call.name === 'prompt' || call.name === 'session/load'), false);
  assert.deepEqual(f.errors, []);
  unavailable.clear(); f.sessions.get('source')!.status = 'idle';
  await backend.controlEvents!.handle({ type: 'session/invalidated', sessionId: 'source', resources: ['control', 'queue'] });
  await Promise.all(feedback);
  assert.equal(f.calls.filter(call => call.name === 'prompt').length, 1);
  await backend.controlEvents!.handle({ type: 'session/patch', sessionId: 'source', loaded: true });
  assert.equal(f.calls.filter(call => call.name === 'prompt').length, 1);
  assert.deepEqual(f.errors, []);
  await backend.onStop!();
  await assertIngressStopped(backend, f);
});

test('activation lifecycle notifications wake only explicitly deferred recent entries, never activity-read feedback', async t => {
  const f = fixture(t, false);
  const refresh = t.mock.method(RecentSessions.prototype, 'resumeDeferred');
  const start = t.mock.method(RecentSessions.prototype, 'start');
  let transitioning = true;
  f.respond((name, result) => {
    if (transitioning && name === 'session/get') throw Object.assign(new Error('metadata transition'), { code: 'SESSION_TRANSITION' });
    return result;
  });
  const backend = await f.activate();
  await backend.onReady!();
  const instance = start.mock.calls[0]!.this as RecentSessions;
  await instance.waitIdle();
  assert.equal(instance.health().deferred, 2);
  const calls = f.calls.length, resumes = refresh.mock.callCount();
  await backend.controlEvents!.handle({ type: 'session/patch', sessionId: 'source', activeOperations: 1 });
  await backend.controlEvents!.handle({ type: 'session/patch', sessionId: 'source', controls: null });
  await backend.controlEvents!.handle({ type: 'session/invalidated', sessionId: 'source', resources: ['usage'] });
  await instance.waitIdle();
  assert.equal(f.calls.length, calls);
  assert.equal(refresh.mock.callCount(), resumes);
  transitioning = false;
  await backend.controlEvents!.handle({ type: 'session/patch', sessionId: 'source', closing: false, loaded: true });
  await instance.waitIdle();
  assert.equal(instance.health().deferred, 1);
  assert.equal(instance.health().current, 1);
  assert.deepEqual(f.errors, []);
});

test('failed metadata controls patches invalidate evidence without recursively scheduling reads', async t => {
  const f = fixture(t);
  t.mock.method(RecentSessions.prototype, 'start', () => {});
  const backend = await f.activate();
  const call = f.context.host.call, failure = new Error('Native metadata RPC unavailable');
  let reads = 0;
  f.context.host.call = (name, body) => {
    if (name === 'session/get' && 'sessionId' in body && body.sessionId === 'source') {
      reads++;
      if (reads === 5) f.stop();
      void backend.controlEvents!.handle({ type: 'session/patch', sessionId: 'source', activity: null });
      void backend.controlEvents!.handle({ type: 'session/patch', sessionId: 'source', controls: null });
      throw failure;
    }
    return call(name, body);
  };
  await backend.onReady!();
  await setImmediate();
  assert.equal(reads, 1, 'Read failure feedback cannot start another read');
  assert.deepEqual(f.errors, [failure], 'The genuine original failure is still reported');
  assert.equal(f.state().inbox[0]!.notice_state, 'pending');
  assert.equal(f.calls.some(call => call.name === 'prompt' || call.name === 'session/load'), false);
});

test('activation defers unreadable coordinator identity then loads only its fresh original owner on a natural event', async t => {
  const f = fixture(t);
  f.sessions.get('front')!.loaded = false;
  let transitioning = true;
  f.respond((name, result) => {
    if (transitioning && name === 'session/get'
      && (result as ModuleHostIntentResult<'session/get'>).meta?.sessionId === 'front')
      throw Object.assign(new Error('metadata transition'), { code: 'SESSION_TRANSITION' });
    return result;
  });
  const backend = await f.activate();
  await backend.onReady!();
  assert.equal(f.calls.some(call => call.name === 'session/load' || call.name === 'prompt'), false);
  const response = await backend.routes.find(route => route.path === '/state')!.handler({
    params: {}, query: {}, headers: {}, body: null, signal: f.context.signal,
  });
  const health = (response.body as { health: { foregroundSessionId: string | null; current: { status: string } } }).health;
  assert.equal(health.current.status, 'deferred');
  assert.equal(health.foregroundSessionId, null, 'No synthetic selected role when discovery could not read metadata');
  assert.equal(f.state().wake, null);
  transitioning = false;
  await backend.controlEvents!.handle({ type: 'session/invalidated', sessionId: 'front', resources: ['identity'] });
  assert.deepEqual(f.calls.filter(call => call.name === 'session/load' || call.name === 'prompt').map(call => call.name),
    ['session/load', 'prompt']);
  assert.equal(f.state().wake!.state, 'loaded');
  await backend.events!.handle({ sessionId: 'front', cwd: '/synthetic',
    event: { id: 'front-idle', type: 'session.idle', data: {} } });
  assert.equal(f.calls.filter(call => call.name === 'prompt').length, 1);
  assert.deepEqual(f.errors, []);
});

test('an inherited Host prompt guard failure preserves the inbox without replay from later events', async t => {
  const f = fixture(t), activePrompt = new AsyncLocalStorage<boolean>();
  const call = f.context.host.call;
  f.context.host.call = (name, body) => {
    if (name === 'prompt' && activePrompt.getStore()) {
      throw Object.assign(new Error('Recursive host.call(prompt) is forbidden; use next'),
        { code: 'MODULE_MIDDLEWARE_INVALID' });
    }
    return call(name, body);
  };
  f.sessions.get('source')!.status = 'running';
  const backend = await f.activate();
  await backend.onReady!();
  f.sessions.get('source')!.status = 'idle';
  await activePrompt.run(true, () => backend.events!.handle({
    sessionId: 'source', cwd: '/synthetic',
    event: { id: 'source-idle', type: 'session.idle', data: {} },
  }));
  assert.equal(f.errors.length, 1);
  assert.match(String(f.errors[0]), /Recursive host\.call\(prompt\)/);
  assert.equal(f.calls.filter(call => call.name === 'prompt').length, 0, 'Host guard rejected before native dispatch');
  assert.equal(f.state().inbox[0]!.notice_state, 'unknown');
  assert.equal(f.state().inbox[0]!.notification_receipt, null);
  assert.equal((await callTool(backend, 'assistant_watch', 'disable-after-guard', { sessionId: 'source', enabled: false })).result.isError, false);
  await backend.events!.handle({ sessionId: 'source', cwd: '/synthetic',
    event: { id: 'disabled-reply', type: 'assistant.message', data: { messageId: 'disabled-reply', content: 'Not collected' } } });
  assert.equal((await callTool(backend, 'assistant_watch', 'reenable-after-guard', { sessionId: 'source', enabled: true })).result.isError, false);
  await backend.controlEvents!.handle({ type: 'session/invalidated', sessionId: 'source', resources: ['queue'] });
  assert.equal(f.calls.filter(call => call.name === 'prompt').length, 0, 'A later clean context is not replay authority');
  assert.equal(f.state().inbox.length, 1, 'The original source remains available for explicit handling');
});

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

test('activation requires public role and cache capabilities before opening data', async t => {
  for (const capability of ['roleAssignmentVersion', 'roleAvailabilityVersion', 'sessionDirectoryVersion', 'chatReadVersion'] as const) {
    const f = fixture(t, false), host = { ...f.context.host };
    delete host[capability];
    await assert.rejects(activate({ ...f.context, host }), { code: 'HOST_CAPABILITY' });
    assert.equal(existsSync(f.dataRoot), false);
    assert.deepEqual(f.calls, []);
  }
});

test('activation does not require unrelated prompt origin or native resource isolation', async t => {
  const f = fixture(t, false);
  const { promptOriginVersion: _version, roleResourcePolicyVersion: _policy, ...host } = f.context.host;
  const backend = await activate({ ...f.context, host });
  assert.equal(existsSync(f.dataRoot), true);
  await backend.dispose!();
});

test('backend exposes single-owner preflight and permit without selecting or waking from saved hooks', async t => {
  const f = fixture(t), backend = await f.activate(), hooks = backend.roleAssignments!;
  const roles = [{ moduleId: 'assistant', roleId: 'coordinator' }];
  const selection = { roles, sessionId: 'source' }, signal = new AbortController().signal;
  const availability = await hooks.availability!({ ...selection, operation: 'add', previousRoles: [] }, signal);
  assert.equal(availability.reasons[0]!.status, 'denied');
  assert.equal((await hooks.permit!({ ...selection, operation: 'add', previousRoles: [] }, signal)).allowed, false);
  assert.equal((await hooks.permit!({ roles, sessionId: 'front', operation: 'add', previousRoles: roles }, signal)).allowed, true);
  const before = f.calls.length;
  await hooks.saved!({ roles, previousRoles: [], operation: 'add', sessionId: 'front', notificationId: 'saved-role' }, signal);
  assert.equal(f.calls.length, before, 'Saved callback invalidates only, with no Host calls under the role lock');
  assert.equal(f.calls.some(call => call.name === 'prompt' || call.name === 'session/load'), false);
});

test('a next passive discovery starting before the notification waiter resumes cannot suppress its wake', async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  const foreground = NativeChat.prototype.foreground;
  let started = false, blockNext = false, competing: ReturnType<NativeChat['foreground']> | undefined;
  f.respond((name, result) => {
    if (name !== 'session/directory' || !blockNext) return result;
    blockNext = false; entered.resolve();
    return release.promise.then(() => result);
  });
  t.mock.method(NativeChat.prototype, 'foreground', async function(this: NativeChat) {
    const result = await foreground.call(this);
    if (!started) {
      started = true; blockNext = true;
      competing = foreground.call(this);
    }
    return result;
  });
  const backend = await f.activate(), ready = backend.onReady!();
  try {
    await entered.promise;
    await setImmediate();
    assert.deepEqual(f.errors, []);
  } finally { release.resolve(); }
  await Promise.all([ready, competing]);
  assert.equal(f.calls.filter(call => call.name === 'prompt').length, 1);
  assert.equal(f.state().inbox[0]!.notice_state, 'notified');
});

test('cache event wiring ignores activity feedback but invalidates content, rewind and deletion', async t => {
  const f = fixture(t, false), changed = t.mock.method(RecentSessions.prototype, 'invalidate');
  const backend = await f.activate();
  await backend.onReady!();
  await backend.controlEvents!.handle({ type: 'session/patch', sessionId: 'unregistered', activeOperations: 1 });
  await backend.controlEvents!.handle({ type: 'session/invalidated', sessionId: 'unregistered', resources: ['usage'] });
  assert.equal(changed.mock.callCount(), 0);
  await backend.controlEvents!.handle({ type: 'session/patch', sessionId: 'unregistered', title: 'Changed scope' });
  await backend.controlEvents!.handle({ type: 'chat/invalidated', sessionId: 'unregistered', reason: 'rewind' });
  await backend.controlEvents!.handle({ type: 'session/removed', sessionId: 'unregistered' });
  assert.deepEqual(changed.mock.calls.map(call => call.arguments), [
    ['unregistered', 'dirty'], ['unregistered', 'reset'], ['unregistered', 'delete'],
  ]);
  assert.equal(f.calls.some(call => call.name === 'prompt' || call.name === 'session/load'), false);
});

test('missing or conflicting roles never fall back to retained foreground configuration', async t => {
  for (const conflict of [false, true]) {
    await t.test(conflict ? 'conflicting' : 'missing', async t => {
      const f = fixture(t), front = f.sessions.get('front')!;
      f.context.config = { foregroundSessionId: 'front' };
      if (conflict) {
        f.sessions.get('source')!.roles = structuredClone(front.roles);
        f.sessions.get('source')!.appliedRoles = structuredClone(front.appliedRoles);
      } else { front.roles = []; front.appliedRoles = []; }
      const backend = await f.activate();
      await backend.onReady!();
      const result = await callTool(backend, 'assistant_foreground', 'health', {});
      const health = JSON.parse(result.result.content[0]!.text);
      assert.equal(health.foregroundSessionId, null);
      assert.equal(health.current.status, conflict ? 'unknown' : 'unconfigured');
      assert.equal(health.destination, 'coordinator-role');
      assert.equal(f.calls.some(call => call.name === 'prompt' || call.name === 'session/load'), false);
      assert.equal(f.state().inbox[0]!.notice_state, 'pending');
      const invalid = await callTool(backend, 'assistant_foreground', 'obsolete-setter', { sessionId: 'front' });
      assert.equal(invalid.result.isError, true);
      assert.match(invalid.result.content[0]!.text, /INVALID_INPUT/);
    });
  }
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

test('MCP advertises eight session-centered tools and watch calls never scan, load, prompt or create a topic', async t => {
  const f = fixture(t, false);
  t.mock.method(RecentSessions.prototype, 'start', () => {});
  const backend = await f.activate();
  await backend.onReady!();
  const route = backend.routes.find(route => route.path === '/mcp')!;
  const request = (body: unknown) => route.handler({
    params: {}, query: {}, headers: {}, signal: f.context.signal, body,
  });
  const initialized = await request({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } } });
  assert.equal((initialized.body as { result: { serverInfo: { version: string } } }).result.serverInfo.version, '6');
  const response = await request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const listed = (response.body as { result: { tools: { name: string; inputSchema: {
    properties: Record<string, unknown>; required: string[]; additionalProperties: boolean;
  } }[] } }).result.tools;
  assert.deepEqual(listed.map(tool => tool.name), ['assistant_topics', 'assistant_watches', 'assistant_watch',
    'assistant_search', 'assistant_foreground', 'assistant_inbox', 'assistant_checkpoint', 'assistant_resolve']);
  const watchSchema = listed.find(tool => tool.name === 'assistant_watch')!.inputSchema;
  assert.deepEqual(watchSchema.required, ['sessionId', 'enabled']);
  assert.deepEqual(Object.keys(watchSchema.properties), ['sessionId', 'enabled', 'expectedVersion']);
  assert.equal(watchSchema.additionalProperties, false);
  const retired = await callTool(backend, 'assistant_topic', 'retired-topic', { title: 'Do not create', sessionId: 'source' });
  assert.equal(retired.result.isError, true);
  assert.equal(JSON.parse(retired.result.content[0]!.text).error.code, 'TOOL_RETIRED');
  const enabled = await callTool(backend, 'assistant_watch', 'enable-source', { sessionId: 'source', enabled: true, expectedVersion: 0 });
  assert.equal(enabled.result.isError, false);
  assert.equal(JSON.parse(enabled.result.content[0]!.text).version, 1);
  const watches = await callTool(backend, 'assistant_watches', 'list-attention', {});
  const items = JSON.parse(watches.result.content[0]!.text).items as { sessionId: string; enabled: boolean; version: number }[];
  assert.deepEqual(items.map(item => [item.sessionId, item.enabled, item.version]), [['source', true, 1]]);
  assert.ok(f.calls.every(call => call.name === 'session/get'), 'Only caller and enable-target existence checks use the Host');
  assert.deepEqual(f.state().topics, []); assert.deepEqual(f.state().inbox, []); assert.deepEqual(f.errors, []);
});

test('disabled watches and unread checkpoints survive backend restart without wakes until re-enable and a natural event', async t => {
  const f = fixture(t);
  t.mock.method(RecentSessions.prototype, 'start', () => {});
  f.sessions.get('source')!.status = 'running';
  const backend = await f.activate();
  await backend.onReady!();
  const first = await callTool(backend, 'assistant_inbox', 'read-before-disable', {});
  const { receipt } = JSON.parse(first.result.content[0]!.text) as { receipt: { id: string; inboxIds: string[] } };
  const checkpoint = await callTool(backend, 'assistant_checkpoint', 'checkpoint-before-disable', {
    receiptId: receipt.id, sessionId: 'source', readIds: receipt.inboxIds, complete: true,
    position: { query: { source: 'persisted', direction: 'backward' }, nextQuery: null,
      boundaryEventId: 'original-source-event', hostCheckpoint: 'synthetic-host-checkpoint' },
  });
  assert.equal(checkpoint.result.isError, false);
  assert.equal((await callTool(backend, 'assistant_watch', 'disable-source', {
    sessionId: 'source', enabled: false, expectedVersion: 1,
  })).result.isError, false);
  const retained = f.state();
  f.sessions.get('source')!.status = 'idle';
  for (const event of [
    { id: 'disabled-reply', type: 'assistant.message', data: { messageId: 'disabled-reply', content: 'Not collected' } },
    { id: 'disabled-idle', type: 'session.idle', data: {} },
  ]) await backend.events!.handle({ sessionId: 'source', cwd: '/synthetic', event });
  assert.deepEqual(f.state(), retained);
  assert.equal(f.calls.some(call => call.name === 'session/load' || call.name === 'prompt'), false);
  await backend.dispose!();
  f.restart(); f.sessions.get('front')!.loaded = false;
  const beforeRestart = f.calls.length, restarted = await f.activate();
  await restarted.onReady!();
  assert.deepEqual(f.state(), retained);
  assert.equal(f.calls.length, beforeRestart, 'Disabled pending mail does not discover or wake the cold role owner');
  const unread = await callTool(restarted, 'assistant_inbox', 'read-after-restart', {});
  const restored = JSON.parse(unread.result.content[0]!.text);
  assert.equal(restored.receipt.id, receipt.id);
  assert.equal(restored.items[0].watched, false);
  assert.equal(restored.receipt.progress[0].position.hostCheckpoint, 'synthetic-host-checkpoint');
  assert.deepEqual(restored.receipt.progress[0].readIds, receipt.inboxIds);
  const reenabled = await callTool(restarted, 'assistant_watch', 'reenable-source', {
    sessionId: 'source', enabled: true, expectedVersion: 2,
  });
  assert.equal(reenabled.result.isError, false);
  assert.equal(JSON.parse(reenabled.result.content[0]!.text).version, 3);
  assert.equal(f.calls.some(call => ['session/load', 'prompt', 'session/chat'].includes(call.name)), false);
  await restarted.controlEvents!.handle({ type: 'session/invalidated', sessionId: 'source', resources: ['queue'] });
  assert.deepEqual(f.calls.filter(call => call.name === 'session/load' || call.name === 'prompt').map(call => call.name),
    ['session/load', 'prompt']);
  assert.equal(f.state().inbox.length, 1); assert.equal(f.state().inbox[0]!.notice_state, 'notified');
  assert.deepEqual(f.state().topics, []); assert.deepEqual(f.errors, []);
});

test('shutdown drains a watch caller read and returns an explicit error without persisting attention', { timeout: 5000 }, async t => {
  const f = fixture(t, false);
  t.mock.method(RecentSessions.prototype, 'start', () => {});
  const backend = await f.activate();
  await backend.onReady!();
  const gate = f.gate('session/get');
  const editing = callTool(backend, 'assistant_watch', 'enable-during-stop', { sessionId: 'source', enabled: true });
  await gate.entered;
  f.stop();
  let drained = false;
  const drain = Promise.resolve(backend.onStop!()).then(() => { drained = true; });
  await setImmediate();
  assert.equal(drained, false);
  await assertIngressStopped(backend, f);
  gate.release();
  const [response] = await Promise.all([editing, drain]);
  assert.equal(response.result.isError, true);
  assert.equal(JSON.parse(response.result.content[0]!.text).error.code, 'STOPPING');
  assert.deepEqual(f.state().watches, []);
  assert.equal(f.calls.some(call => call.name !== 'session/get'), false);
});

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
      assert.equal(f.calls.some(call => ['roles/availability', 'roles/readiness', 'session/tool-scope'].includes(call.name)), false);
    });
  }
}
test('unrelated role availability does not requalify existing Host-granted Assistant tools', async t => {
  for (const state of ['denied', 'unknown', 'changed', 'organizer']) {
    await t.test(state, async t => {
      const f = fixture(t), front = f.sessions.get('front')!;
      addConnections(front, 'multiple'); front.loaded = false; front.appliedRoles = [];
      if (state === 'organizer') front.roles!.push({ ...front.roles![1]!, roleId: 'organizer' });
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

test('a role-owner change during final native readback cannot send to the old address', async t => {
  const f = fixture(t);
  const backend = await f.activate();
  let foregroundReads = 0, switched = false;
  f.respond((name, result) => {
    if (name !== 'session/get' || (result as ModuleHostIntentResult<'session/get'>).meta?.sessionId !== 'front')
      return result;
    if (++foregroundReads !== 2 || switched) return result;
    switched = true;
    const role = f.sessions.get('front')!.roles![0]!;
    f.sessions.get('front')!.roles = []; f.sessions.get('front')!.appliedRoles = [];
    f.sessions.get('source')!.roles = [role]; f.sessions.get('source')!.appliedRoles = [role];
    return { meta: structuredClone(f.sessions.get('front')) };
  });

  await backend.onReady!();
  assert.equal(switched, true);
  assert.equal(f.calls.some(call => call.name === 'prompt'), false);
  assert.equal(f.state().inbox[0]!.notice_state, 'pending');
  assert.ok(f.errors.length > 0);
});

test('role removal during discovery cannot load the former owner', async t => {
  const f = fixture(t);
  f.sessions.get('front')!.loaded = false;
  const backend = await f.activate();
  let disabled = false;
  f.respond((name, result) => {
    if (disabled || name !== 'session/get' || (result as ModuleHostIntentResult<'session/get'>).meta?.sessionId !== 'front')
      return result;
    disabled = true;
    f.sessions.get('front')!.roles = []; f.sessions.get('front')!.appliedRoles = [];
    return { meta: structuredClone(f.sessions.get('front')) };
  });
  await backend.onReady!();
  assert.equal(disabled, true);
  assert.equal(f.calls.some(call => call.name === 'session/load' || call.name === 'prompt'), false);
  assert.equal(f.state().wake, null);
  assert.equal(f.state().inbox[0]!.notice_state, 'pending');
  assert.ok(f.errors.length > 0);
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
    assert.equal(f.calls.slice(before).some(call => call.name === 'session/load' || call.name === 'prompt'), false,
      'Durable notice state prevents both load and prompt replay, not passive cache refresh');
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
