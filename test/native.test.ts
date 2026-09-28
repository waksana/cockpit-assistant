import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { ModuleBackendContext, ModuleRequest, ModuleRoute } from '@waksana/cockpit-module-sdk/backend';
import { nativeAccess } from '../src/native.ts';
import { activate } from '../src/index.ts';
import { fixture } from './fixtures.ts';

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
    assert.deepEqual(await native.answer('s1', 'original-request', 'Literal', false),
      { accepted: true, result: { ok: true } });
    assert.deepEqual(f.calls.at(-1), { name: 'respondAsk',
      body: { sessionId: 's1', requestId: 'original-request', answer: 'Literal', wasFreeform: false } });
    assert.equal(f.calls.filter(c => c.name === 'prompt').length, 0);
  } finally { f.close(); }
});

test('unsupported host fails before creating module data', async () => {
  const f = fixture();
  const temporary = await mkdtemp(join(tmpdir(), 'assistant-unsupported-'));
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

test('activation uses public lifecycle, explicit enrollment, hooks, and persisted reconnect history', async () => {
  const f = fixture();
  const temporary = await mkdtemp(join(tmpdir(), 'assistant-activation-'));
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
    await assert.rejects(request('GET', '/status'), /not ready/);
    await backend.onReady?.();
    assert.equal(f.calls.length, 0, 'cold empty activation does not enumerate production sessions');
    await request('POST', '/enrollment', { requestId: 'enroll', sessionId: 's1',
      label: 'Synthetic reception', kind: 'reception', evidence: 'Explicit test enrollment' });
    await request('POST', '/wake', { requestId: 'initial' });
    f.pages.push({ events: [
      { id: 'start', type: 'assistant.turn_start', data: {} },
      { id: 'm', type: 'assistant.message', parentId: 'start', data: { messageId: 'reply', content: 'Complete reply', toolRequests: [] } },
      { id: 'end', type: 'assistant.turn_end', parentId: 'm', data: {} },
    ], cursor: 'after-reply', cursorStatus: 'ok', hasMore: false });
    await backend.events?.handle({ sessionId: 's1', cwd: '/synthetic', event: { id: 'end', type: 'assistant.turn_end', data: {} } });
    await request('POST', '/wake', { requestId: 'consume' });
    const messages = (await request('GET', '/messages')).body as { items: { raw: string }[] };
    assert.equal(messages.items[0]?.raw, 'Complete reply');
    await request('POST', '/roles/bind', { requestId: 'bind', role: 'coordinator', sessionId: 'coordinator',
      expectedEpoch: 0, definitionVersion: '1', expectedModelId: 'synthetic' });
    await request('POST', '/wake', { requestId: 'finish' });
    assert.ok(notifications.length > 0);
    const before = f.calls.length;
    await backend.events?.handle({ sessionId: 'private', cwd: '/private', event: { id: 'unknown', type: 'assistant.message', data: {} } });
    assert.equal(f.calls.length, before, 'unenrolled hook never reads a session');
    assert.equal(errors.length, 0);
  } finally {
    backend.dispose?.();
    controller.abort();
    await setTimeout(20);
    f.close();
    await rm(temporary, { recursive: true });
  }
});
