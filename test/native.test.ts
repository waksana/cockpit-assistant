import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, rm, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { ModuleBackendContext, ModuleRequest } from '@waksana/cockpit-module-sdk/backend';
import { nativeAccess } from '../src/native.ts';
import { activate } from '../src/index.ts';
import { fixture } from './fixtures.ts';

const directory = async () => {
  const path = join(process.cwd(), 'node_modules/.cache', `assistant-lifecycle-${randomUUID()}`);
  await mkdir(path, { recursive: true }); return path;
};
test('public SDK bridge reads exact receipt evidence and calls respondAsk with true identity', async () => {
  const f = fixture();
  try {
    const native = nativeAccess(f.native.host);
    await native.read('coordinator', null, true, false, true);
    assert.deepEqual(f.calls.at(-1)!.body, { sessionId: 'coordinator', source: 'live',
      direction: 'backward', max: 64, waitMs: 0, bootstrap: true, agentScope: 'primary', types: ['user.message','assistant.message'] });
    assert.deepEqual(await native.answer('s1', 'true-request-id', 'Literal', false), { accepted: true, result: { ok: true } });
    assert.deepEqual(f.calls.at(-1), { name: 'respondAsk',
      body: { sessionId: 's1', requestId: 'true-request-id', answer: 'Literal', wasFreeform: false } });
  } finally { f.close(); }
});
test('unsupported Host fails before creating any module data', async () => {
  const f = fixture(), root = await directory(), dataRoot = join(root, 'not-created');
  try {
    const context: ModuleBackendContext = { apiVersion: 1, serviceReadyVersion: 1, moduleId: 'assistant',
      dataRoot, apiBase: '/synthetic', config: {}, signal: new AbortController().signal,
      report() {}, invalidate() {}, publish() {}, host: { ...f.native.host, promptReceiptVersion: undefined } };
    await assert.rejects(activate(context), /requires chatReadVersion/);
    await assert.rejects(access(dataRoot));
  } finally { f.close(); await rm(root, { recursive: true }); }
});
test('synthetic activation separates roles, excludes unmanaged events, and releases writer ownership', async () => {
  const f = fixture(), dataRoot = await directory(), controller = new AbortController();
  const errors: unknown[] = [];
  try {
    const context: ModuleBackendContext = { apiVersion: 1, serviceReadyVersion: 1, moduleId: 'assistant',
      dataRoot, apiBase: '/synthetic', config: {}, signal: controller.signal,
      report(error) { errors.push(error); }, invalidate() {}, publish() {}, host: f.native.host };
    const backend = await activate(context);
    const req: ModuleRequest = { params: {}, query: {}, headers: {}, body: undefined, signal: controller.signal };
    const state = backend.routes.find(route => route.path === '/timeline')!;
    await assert.rejects(async () => state.handler(req), /not ready/);
    await backend.onReady!();
    const memory = await backend.roleAssignments!.permit!({ operation: 'create', sessionId: 'candidate',
      roles: [{ moduleId: 'assistant', roleId: 'memory' }], previousRoles: [] }, controller.signal);
    assert.equal(memory.allowed, false);
    const coordinator = await backend.roleAssignments!.permit!({ operation: 'create', sessionId: 'candidate',
      roles: [{ moduleId: 'assistant', roleId: 'coordinator' }], previousRoles: [] }, controller.signal);
    assert.equal(coordinator.allowed, true);
    f.metas.get('coordinator')!.status = 'running';
    backend.events!.handle({ sessionId: 's1', cwd: '/synthetic',
      event: { id: 'live-original', type: 'assistant.message', data: { content: 'Actual live raw body' } } });
    await setTimeout(20);
    const response = await state.handler(req);
    assert.equal((response.body as { items: { text: string }[] }).items.some(item => item.text === 'Actual live raw body'), false);
    const combined = await backend.roleAssignments!.permit!({ operation: 'create', sessionId: 'candidate',
      roles: [{ moduleId: 'assistant', roleId: 'coordinator' }, { moduleId: 'assistant', roleId: 'worker' }],
      previousRoles: [] }, controller.signal);
    assert.equal(combined.allowed, false);
    backend.dispose!();
    await setTimeout(20);
    const reopened = await activate({ ...context, signal: new AbortController().signal });
    reopened.dispose!();
    await setTimeout(20);
    assert.equal(errors.length, 0);
  } finally { controller.abort(); f.close(); await rm(dataRoot, { recursive: true }); }
});
test('setup receipts are native-backed temporary facts and duplicate IDs never repeat a native operation', async () => {
  const f = fixture();
  try {
    const create = { requestId: 'setup', cwd: '/synthetic', role: 'coordinator' };
    const receipt = await f.runtime.create(create);
    assert.equal(receipt.state, 'accepted');
    assert.equal((await f.runtime.create(create)).id, receipt.id);
    assert.equal(f.calls.filter(call => call.name === 'session/new').length, 1);
    await assert.rejects(f.runtime.create({ ...create, cwd: '/different' }), /request changed/);
    assert.deepEqual(f.db.sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all().map(row => row.name), ['foreground_inputs','inbox','messages','tool_actions','topic_messages','topics','workers']);
    const readiness = await f.runtime.readiness();
    assert.equal(readiness.roles[0]!.status, 'ready');
    assert.equal(readiness.roles[0]!.sessionId, 'coordinator');
  } finally { f.close(); }
});
test('unknown setup creation preserves actual partial native identity and duplicate request does not repeat it', async () => {
  const f = fixture();
  try {
    f.fail('session/new', Object.assign(new Error('Creation acknowledgement lost'),
      { createdId: 'real-created-session', code: 'NATIVE_PARTIAL', roleAssignment: { saved: true, applied: false } }));
    const value = { requestId: 'partial-setup', cwd: '/synthetic', role: 'coordinator' };
    const receipt = await f.runtime.create(value);
    assert.equal(receipt.state, 'unknown');
    assert.equal((receipt.result as { createdId: string }).createdId, 'real-created-session');
    assert.equal((receipt.result as { roleAssignment: { saved: boolean } }).roleAssignment.saved, true);
    await f.runtime.create(value);
    assert.equal(f.calls.filter(call => call.name === 'session/new').length, 1);
  } finally { f.close(); }
});
