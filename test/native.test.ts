import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, rm, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { ModuleBackendContext, ModuleRequest, ModuleRoute } from '@waksana/cockpit-module-sdk/backend';
import { nativeAccess } from '../src/native.ts';
import { activate } from '../src/index.ts';
import { fixture } from './fixtures.ts';

async function stateDirectory(label: string): Promise<string> {
  const path = join(process.cwd(), `.test-${label}-${randomUUID()}`);
  await mkdir(path);
  return path;
}
async function until(predicate: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await setTimeout(5);
  }
  assert.fail('Expected event-driven native processing to settle');
}

test('published SDK bridge preserves exact chat cursor identity and native ask request', async () => {
  const f = fixture();
  try {
    const native = nativeAccess(f.native.host);
    await native.read('s1', null, true);
    await native.read('s1', '', false);
    await native.read('s1', 'opaque-backward', false, true);
    const calls = f.calls.filter(c => c.name === 'session/chat');
    assert.deepEqual(calls.map(c => c.body), [
      { sessionId: 's1', source: 'live', direction: 'backward', max: 64, waitMs: 0, bootstrap: true,
        agentScope: 'primary', types: ['assistant.turn_start', 'assistant.turn_end', 'assistant.message', 'abort', 'user.message'] },
      { sessionId: 's1', source: 'live', direction: 'forward', max: 64, waitMs: 0, bootstrap: false,
        agentScope: 'primary', types: ['assistant.turn_start', 'assistant.turn_end', 'assistant.message', 'abort', 'user.message'], cursor: '' },
      { sessionId: 's1', source: 'live', direction: 'backward', max: 64, waitMs: 0, bootstrap: false,
        agentScope: 'primary', types: ['assistant.turn_start', 'assistant.turn_end', 'assistant.message', 'abort', 'user.message'], cursor: 'opaque-backward' },
    ]);
    await native.read('coordinator', null, true, false, true);
    assert.deepEqual(f.calls.at(-1)!.body, { sessionId: 'coordinator', source: 'live',
      direction: 'backward', max: 64, waitMs: 0, bootstrap: true, agentScope: 'primary',
      types: ['user.message', 'assistant.message'] },
    'consumer reads use exact receipt/tool identity and do not need chronological parent-chain events');
    assert.deepEqual(await native.answer('s1', 'original-request', 'Literal', false),
      { accepted: true, result: { ok: true } });
    assert.deepEqual(f.calls.at(-1), { name: 'respondAsk',
      body: { sessionId: 's1', requestId: 'original-request', answer: 'Literal', wasFreeform: false } });
    assert.equal(f.calls.filter(c => c.name === 'prompt').length, 0);
  } finally { f.close(); }
});

test('unsupported host fails before creating module data', async () => {
  const f = fixture();
  const temporary = await stateDirectory('assistant-unsupported');
  const dataRoot = join(temporary, 'not-created');
  try {
    const context: ModuleBackendContext = {
      apiVersion: 1, serviceReadyVersion: 1, moduleId: 'assistant', dataRoot, apiBase: '/synthetic',
      config: {}, signal: new AbortController().signal, report() {}, invalidate() {}, publish() {},
      host: { ...f.native.host, chatReadVersion: undefined },
    };
    await assert.rejects(activate(context), /requires chatReadVersion/);
    await assert.rejects(access(dataRoot));
    assert.equal(f.calls.length, 0);
  } finally { f.close(); await rm(temporary, { recursive: true }); }
});

test('activation uses public lifecycle, ordinary-session hooks, and persisted reconnect history', async () => {
  const f = fixture();
  const temporary = await stateDirectory('assistant-activation');
  const controller = new AbortController();
  const notifications: unknown[] = [];
  const errors: unknown[] = [];
  const context: ModuleBackendContext = {
    apiVersion: 1, serviceReadyVersion: 1, moduleId: 'assistant', dataRoot: temporary, apiBase: '/synthetic',
    config: {}, signal: controller.signal, report: error => errors.push(error), invalidate() {},
    publish: value => notifications.push(value), host: f.native.host,
  };
  const backend = await activate(context);
  const request = async (method: ModuleRoute['method'], path: string, body?: unknown, params = {}) => {
    const route = backend.routes.find(r => r.method === method && r.path === path)!;
    const req: ModuleRequest = { params, query: {}, headers: {}, body, signal: controller.signal };
    return route.handler(req);
  };
  try {
    await assert.rejects(request('GET', '/state'), /not ready/);
    await backend.onReady?.();
    assert.equal(f.calls.filter(call => call.name === 'session/directory').length, 1,
      'initial public metadata directory registers ordinary sessions without a repeated scan');
    assert.equal(f.calls.some(call => call.name === 'session/chat'
      && /coordinator|memory/.test(JSON.stringify(call.body))), false);
    f.pages.push({ events: [
      { id: 'start', type: 'assistant.turn_start', data: {} },
      { id: 'm', type: 'assistant.message', parentId: 'start', data: { messageId: 'reply', content: 'Complete reply', toolRequests: [] } },
      { id: 'end', type: 'assistant.turn_end', parentId: 'm', data: {} },
    ], cursor: 'after-reply', cursorStatus: 'ok', hasMore: false });
    await backend.events?.handle({ sessionId: 's1', cwd: '/synthetic', event: { id: 'end', type: 'assistant.turn_end', data: {} } });
    await until(async () => ((await request('GET', '/messages')).body as { items: unknown[] }).items.length > 0);
    const messages = (await request('GET', '/messages')).body as { items: { raw: string }[] };
    assert.equal(messages.items[0]?.raw, 'Complete reply');
    await request('POST', '/roles/bind', { requestId: 'bind', role: 'coordinator', sessionId: 'coordinator',
      expectedEpoch: 0, definitionVersion: '2', expectedModelId: 'synthetic' });
    await until(() => notifications.length > 0);
    const before = f.calls.length;
    await backend.events?.handle({ sessionId: 'private', cwd: '/private', event: { id: 'unknown', type: 'assistant.message', data: {} } });
    await until(() => f.calls.slice(before).some(call => call.name === 'session/get'
      && JSON.stringify(call.body).includes('private')));
    assert.equal(f.calls.slice(before).some(call => call.name === 'session/chat'
      && JSON.stringify(call.body).includes('private')), false, 'missing session events never read history');
    const identityStart = f.calls.length;
    f.metas.set('identity-event', { ...f.metas.get('s1')!, sessionId: 'identity-event' });
    await backend.controlEvents?.handle({
      type: 'session/invalidated', sessionId: 'identity-event', resources: ['identity'],
    });
    await until(() => f.calls.slice(identityStart).some(call => call.name === 'session/get'
      && JSON.stringify(call.body).includes('identity-event')));
    assert.equal(errors.length, 0);
  } finally {
    backend.dispose?.();
    controller.abort();
    await setTimeout(20);
    f.close();
    await rm(temporary, { recursive: true });
  }
});

test('public role hooks register saved identity without readiness or native preparation', async () => {
  const f = fixture();
  const temporary = await stateDirectory('assistant-role-hooks');
  const controller = new AbortController();
  const errors: unknown[] = [];
  const backend = await activate({
    apiVersion: 1, serviceReadyVersion: 1, moduleId: 'assistant', dataRoot: temporary, apiBase: '/synthetic',
    config: {}, signal: controller.signal, report: error => errors.push(error),
    invalidate() {}, publish() {}, host: f.native.host,
  });

  try {
    const roles = [{ moduleId: 'assistant', roleId: 'coordinator' }];
    const permission = await backend.roleAssignments!.permit!({
      operation: 'add', sessionId: 'coordinator', roles, previousRoles: [],
    }, controller.signal);
    assert.equal(permission.allowed, true);
    await backend.roleAssignments!.saved!({
      notificationId: 'role-save-1', operation: 'add', sessionId: 'coordinator', roles, previousRoles: [],
    }, controller.signal);
    const other = await backend.roleAssignments!.permit!({
      operation: 'create', sessionId: 'new-coordinator', roles, previousRoles: [],
    }, controller.signal);
    assert.equal(other.allowed, false);
    assert.equal(f.calls.some(call => call.name !== 'session/get'), false);
    await backend.onReady?.();
    const role = backend.routes.find(route => route.method === 'GET' && route.path === '/state')!;
    const response = await role.handler({ params: {}, query: {}, headers: {},
      body: undefined, signal: controller.signal });
    assert.equal((response.body as { roles: { sessionId: string }[] }).roles[0]?.sessionId, 'coordinator');
    assert.equal(errors.length, 0);
  } finally {
    backend.dispose?.(); controller.abort();
    await setTimeout(20);
    f.close();
    await rm(temporary, { recursive: true });
  }
});

test('directory failure leaves startup visibly unavailable instead of partially ready', async () => {
  const f = fixture();
  const temporary = await stateDirectory('assistant-directory-failure');
  const controller = new AbortController();
  const call = f.native.host.call.bind(f.native.host);
  f.native.host.call = async (name, body) => {
    if (name === 'session/directory') throw new Error('Directory catalog changed; restart the read');
    return call(name, body);
  };
  const backend = await activate({
    apiVersion: 1, serviceReadyVersion: 1, moduleId: 'assistant', dataRoot: temporary, apiBase: '/synthetic',
    config: {}, signal: controller.signal, report() {}, invalidate() {}, publish() {}, host: f.native.host,
  });
  try {
    await assert.rejects(async () => backend.onReady!(), /Directory catalog changed/);
    const role = backend.routes.find(route => route.method === 'GET' && route.path === '/state')!;
    await assert.rejects(async () => role.handler({ params: {}, query: {}, headers: {},
      body: undefined, signal: controller.signal }), /not ready/);
  } finally {
    backend.dispose?.(); controller.abort();
    await setTimeout(20);
    f.close();
    await rm(temporary, { recursive: true });
  }
});
