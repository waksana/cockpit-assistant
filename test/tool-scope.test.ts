import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './fixtures.ts';
import { roleScopeProof } from '../src/topic-session.ts';
import { configSchema } from '../src/schema.ts';
import type { SessionToolScope } from '@waksana/cockpit-module-sdk/backend';
import { AssistantService } from '../src/service.ts';
import { Runtime } from '../src/runtime.ts';

test('foreground readiness uses the real public scope read and actual raw identities, never session/get metadata', async () => {
  const f = fixture();
  try {
    const scope = await f.native.scope('coordinator');
    assert.deepEqual(f.calls.at(-1), { name: 'session/tool-scope', body: { sessionId: 'coordinator' } });
    assert.equal(roleScopeProof(scope, 'coordinator'), true);
    assert.equal((await f.runtime.readiness()).canSend, true);
    f.scopes.set('coordinator', { ...scope, configured: null, applied: null, tools: [{ name: 'bash' }] });
    assert.equal(f.metas.get('coordinator')!.toolScope!.builtins.length, 0);
    assert.equal((await f.runtime.readiness()).canSend, false);
    await assert.rejects(f.runtime.acceptReady({ requestId: 'forged-meta', text: 'Never use broad fallback' }),
      { code: 'COORDINATOR_NOT_READY' });
    assert.equal(f.db.list('messages').items.length, 0);
    assert.equal(f.calls.some(call => call.name === 'prompt'), false);
  } finally { f.close(); }
});
test('uninitialized offered tools are unconfirmed and reading scope never initializes or loads them', async () => {
  const f = fixture();
  try {
    const scope = await f.native.scope('coordinator');
    f.scopes.set('coordinator', { ...scope, tools: null });
    assert.equal((await f.runtime.readiness()).roles[0]!.status, 'unknown');
    assert.equal(f.calls.some(call => ['session/load', 'session/resources-prepare', 'session/new'].includes(call.name)), false);
  } finally { f.close(); }
});
test('scope proof rejects guessed normalized names, unexpected builtins, foreign raw identities and alias collisions', async () => {
  const f = fixture();
  try {
    const valid = await f.native.scope('coordinator');
    const mutations: ((scope: SessionToolScope) => void)[] = [
      scope => { delete scope.tools![0]!.mcpToolName; },
      scope => { delete scope.tools![0]!.mcpServerName; },
      scope => { scope.tools![0]!.mcpServerName = 'other-server'; },
      scope => { scope.tools![0]!.mcpToolName = 'different_raw_tool'; },
      scope => { scope.tools![1]!.name = scope.tools![0]!.name; },
      scope => { scope.tools![0]!.namespacedName = scope.tools![1]!.name; },
      scope => { scope.tools!.push({ name: 'ask_user' }); },
      scope => { scope.tools![0]!.name = ''; },
      scope => { scope.applied!.builtins.push('bash'); },
      scope => { scope.configured = null; },
    ];
    for (const mutate of mutations) {
      const scope = structuredClone(valid); mutate(scope);
      assert.equal(roleScopeProof(scope, 'coordinator'), false);
      f.scopes.set('coordinator', scope);
      assert.equal((await f.runtime.readiness()).canSend, false);
    }
  } finally { f.close(); }
});
test('scope input rejects unsupported raw namespaces and duplicate selectors instead of normalizing them', () => {
  for (const toolScope of [
    { builtins: ['view', 'view'], mcpServers: [] },
    { builtins: ['*'], mcpServers: [] },
    { builtins: [], mcpServers: [{ name: 'research', tools: ['raw-name'] }] },
    { builtins: [], mcpServers: [{ name: 'research', tools: ['raw', 'raw'] }] },
    { builtins: [], mcpServers: [{ name: 'research', tools: [] }, { name: 'research', tools: [] }] },
  ]) assert.equal(configSchema.safeParse({ worker: { toolScope } }).success, false);
});
test('unsupported persistent resources are rejected during config input, not after one-time preparation', () => {
  for (const worker of [{ skills: ['selected'] }, { mcpServers: [{ name: 'selected' }] }])
    assert.throws(() => configSchema.parse({ worker }), /Unsupported persistent worker/);
  assert.deepEqual(configSchema.parse({ defaultCwd: '/legacy-default', worker: { skills: [], mcpServers: [] } }).worker,
    { skills: [], mcpServers: [] });
});
test('roles are not a foreground selector: an explicit config or operator binding chooses exactly one ID', async () => {
  const f = fixture();
  const runtime = new Runtime(new AssistantService(f.db, Date.now, { defaultCwd: '/synthetic' }),
    f.native, error => f.errors.push(error), () => {});
  try {
    const unbound = await runtime.readiness();
    assert.equal(unbound.roles[0]!.status, 'unbound');
    assert.equal(unbound.roles[0]!.sessionId, null);
    await assert.rejects(runtime.acceptReady({ requestId: 'unselected', text: 'Do not guess role labels' }),
      { code: 'COORDINATOR_NOT_READY' });
    assert.equal(f.calls.some(call => call.name === 'session/directory'), false);
    const other = await f.runtime.create({ requestId: 'parked', cwd: '/synthetic', role: 'coordinator' });
    assert.ok(other.sessionId);
    const activated = await runtime.activateRoles({ requestId: 'explicit', bindings: [{ role: 'coordinator', sessionId: 'coordinator' }] });
    assert.equal(activated.state, 'accepted');
    assert.equal((activated.result as { persistent: boolean }).persistent, false);
    assert.equal((await runtime.readiness()).roles[0]!.sessionId, 'coordinator');
    assert.equal((await runtime.readiness()).canSend, true);
    assert.equal((await f.runtime.readiness()).roles[0]!.sessionId, 'coordinator');
    assert.equal(f.calls.filter(call => call.name === 'session/new').length, 1);
  } finally { runtime.stop(); f.close(); }
});
