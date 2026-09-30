import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NativeChatEvent } from '@waksana/cockpit-module-sdk/backend';
import { fixture, stageDelivery } from './fixtures.ts';

const coordinator = { moduleId: 'assistant', roleId: 'coordinator', moduleName: 'Assistant', name: 'coordinator' };
const memory = { ...coordinator, roleId: 'memory', name: 'memory' };
const reply = (prefix: string): NativeChatEvent[] => [
  { id: `${prefix}-start`, type: 'assistant.turn_start', data: {} },
  { id: `${prefix}-message`, type: 'assistant.message', parentId: `${prefix}-start`,
    data: { content: `${prefix} response`, messageId: prefix, toolRequests: [] } },
  { id: `${prefix}-end`, type: 'assistant.turn_end', parentId: `${prefix}-message`, data: {} },
];

test('saved-role permission preserves an unloaded carrier and rejects a shared internal carrier', async () => {
  const f = fixture();
  try {
    f.metas.get('coordinator')!.loaded = false;
    assert.equal((await f.runtime.allowRoles(null, ['coordinator'])).allowed, false);
    assert.equal((await f.runtime.allowRoles('coordinator', ['coordinator'])).allowed, true);
    assert.equal((await f.runtime.allowRoles(null, ['coordinator', 'memory'])).allowed, false);
    assert.equal((await f.runtime.allowRoles('memory', ['coordinator'])).allowed, false);
    f.metas.delete('coordinator');
    assert.equal((await f.runtime.allowRoles(null, ['coordinator'])).allowed, true);
    assert.equal(f.calls.some(call => call.name !== 'session/get'), false);
  } finally { f.close(); }
});

test('saved roles register before readiness, retire old work, and replay without a new epoch', async () => {
  const f = fixture();
  try {
    const input = f.service.accept({ requestId: 'input', text: 'Hello' });
    f.db.put('work', { ...input.work, state: 'leased', epoch: 1 });
    f.metas.delete('coordinator');
    f.metas.set('new-carrier', { ...f.metas.get('s1')!, sessionId: 'new-carrier', roles: [coordinator],
      loaded: false, currentModelId: undefined, rolesNeedReload: true });
    await f.runtime.registerRoles('new-carrier', ['coordinator'], 'saved-1');
    const binding = f.db.must('bindings', 'coordinator');
    assert.equal(binding.sessionId, 'new-carrier');
    assert.equal(binding.epoch, 2);
    assert.equal(binding.ready, false);
    assert.equal(binding.modelId, null);
    assert.equal(f.db.must('work', input.work.id).state, 'pending');
    await f.runtime.registerRoles('new-carrier', ['coordinator'], 'saved-1');
    assert.deepEqual(f.db.must('bindings', 'coordinator'), binding);
    assert.equal(f.calls.some(call => call.name !== 'session/get'), false);
    f.metas.get('new-carrier')!.loaded = true;
    f.metas.get('new-carrier')!.currentModelId = 'synthetic';
    f.metas.get('new-carrier')!.rolesNeedReload = false;
    f.metas.get('new-carrier')!.appliedRoles = [coordinator];
    const ready = await f.runtime.readiness();
    assert.equal(ready.roles[0]!.status, 'ready');
    assert.equal(ready.roles[0]!.modelId, 'synthetic');
  } finally { f.close(); }
});

test('role registration requires actual saved identities and never steals an existing carrier', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.runtime.registerRoles('s1', ['coordinator'], 'steal'), /already registered/);
    f.metas.delete('coordinator');
    await assert.rejects(f.runtime.registerRoles('s1', ['coordinator'], 'unsaved'), /actual saved/);
    f.metas.get('s1')!.roles = [coordinator, memory];
    await assert.rejects(f.runtime.registerRoles('s1', ['coordinator'], 'double'), /cannot share/);
    assert.equal(f.db.must('bindings', 'coordinator').epoch, 1);
  } finally { f.close(); }
});

test('carrier event verifies a registered loaded replacement and resumes retired work', async () => {
  const f = fixture();
  try {
    const input = f.service.accept({ requestId: 'resume-input', text: 'Waiting for coordinator' });
    f.db.put('work', { ...input.work, state: 'leased', epoch: 1 });
    f.metas.delete('coordinator');
    f.metas.set('replacement', { ...f.metas.get('s1')!, sessionId: 'replacement',
      roles: [coordinator], appliedRoles: [coordinator], rolesNeedReload: false });
    await f.runtime.registerRoles('replacement', ['coordinator'], 'resume-save');
    assert.equal(f.db.must('bindings', 'coordinator').ready, false);
    assert.equal(f.calls.some(call => call.name === 'prompt'), false);
    await f.runtime.wake('replacement');
    assert.equal(f.db.must('bindings', 'coordinator').ready, true);
    assert.equal(f.calls.filter(call => call.name === 'prompt'
      && (call.body as { sessionId: string }).sessionId === 'replacement').length, 1);
    assert.equal(f.calls.some(call => call.name === 'session/load' || call.name === 'session/resources-prepare'), false);
  } finally { f.close(); }
});

test('concurrent role notifications can register only one replacement', async () => {
  const f = fixture();
  try {
    f.metas.delete('coordinator');
    for (const id of ['a', 'b']) f.metas.set(id, { ...f.metas.get('s1')!, sessionId: id, roles: [coordinator] });
    const results = await Promise.allSettled([
      f.runtime.registerRoles('a', ['coordinator'], 'saved-a'),
      f.runtime.registerRoles('b', ['coordinator'], 'saved-b'),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(f.db.must('bindings', 'coordinator').epoch, 2);
  } finally { f.close(); }
});

test('aborted saved callback cannot commit a late role registration', async () => {
  const f = fixture();
  try {
    f.metas.delete('coordinator');
    f.metas.get('s1')!.roles = [coordinator];
    const controller = new AbortController();
    const registration = f.runtime.registerRoles('s1', ['coordinator'], 'aborted-save', controller.signal);
    controller.abort();
    await assert.rejects(registration, /stopped/);
    assert.equal(f.db.must('bindings', 'coordinator').sessionId, 'coordinator');
    assert.equal(f.db.get('operations', 'role-registration:aborted-save'), undefined);
  } finally { f.close(); }
});

test('ordinary sessions need no enrollment while saved and applied internal roles are excluded', async () => {
  const f = fixture();
  try {
    for (const id of ['ordinary', 'saved', 'applied']) {
      f.metas.set(id, { ...f.metas.get('s1')!, sessionId: id });
    }
    f.metas.get('saved')!.roles = [coordinator];
    f.metas.get('applied')!.appliedRoles = [memory];
    await f.runtime.observe('ordinary');
    await f.runtime.observe('saved');
    await f.runtime.observe('applied');
    assert.equal(f.db.must('receptions', 'ordinary').enabled, true);
    assert.equal(f.db.get('receptions', 'saved'), undefined);
    assert.equal(f.db.get('receptions', 'applied'), undefined);
    const version = f.service.version;
    await f.runtime.observe('ordinary');
    assert.equal(f.service.version, version);
    f.metas.delete('ordinary');
    await f.runtime.observe('ordinary');
    assert.equal(f.db.must('receptions', 'ordinary').availability, 'missing');
    assert.equal(f.db.must('receptions', 'ordinary').enabled, false);
  } finally { f.close(); }
});

test('converting an observed session to an internal role cancels pending ordinary effects once', async () => {
  const f = fixture();
  try {
    stageDelivery(f);
    f.metas.get('s1')!.roles = [coordinator];
    await f.runtime.observe('s1');
    assert.equal(f.db.list('deliveries').items[0]!.state, 'cancelled');
    assert.equal(f.db.must('receptions', 's1').enabled, false);
    const version = f.service.version;
    await f.runtime.observe('s1');
    assert.equal(f.service.version, version);
    await f.runtime.wake('s1');
    assert.equal(f.calls.some(call => call.name === 'chat' && JSON.stringify(call.body).includes('s1')), false);
  } finally { f.close(); }
});

test('initial history stays historical but a completed response observed live before bootstrap is new', async () => {
  const f = fixture();
  try {
    f.metas.set('fresh', { ...f.metas.get('s1')!, sessionId: 'fresh' });
    await f.runtime.observe('fresh');
    const old = reply('old');
    const live = reply('live');
    f.runtime.noteEvent('fresh', live.find(event => event.type === 'assistant.message')!);
    f.pages.push({ events: [...old, ...live], cursor: 'back', liveCursor: 'tail', cursorStatus: 'ok', hasMore: false });
    await f.runtime.consume('fresh');
    const messages = f.db.list('messages').items;
    assert.equal(messages.find(item => item.nativeMessageId === 'old')!.historical, true);
    assert.equal(messages.find(item => item.nativeMessageId === 'live')!.historical, false);
    await f.runtime.consume('fresh');
    assert.equal(f.db.list('messages').items.length, 2);
  } finally { f.close(); }
});

test('new completion reconciliation uses indexed session-local native and message lookups', () => {
  const f = fixture();
  try {
    const original = f.db.find.bind(f.db);
    f.db.find = (table, predicate) => {
      assert.notEqual(table, 'native', 'Do not scan every session native history');
      assert.notEqual(table, 'messages', 'Do not scan every session messages');
      return original(table, predicate);
    };
    f.runtime.ingestion.apply('s1', 1, reply('indexed'), 'next');
    assert.equal(f.db.list('messages').items.length, 1);
    f.runtime.ingestion.apply('s1', 1, reply('indexed'), 'next');
    assert.equal(f.db.list('messages').items.length, 1);
  } finally { f.close(); }
});

test('a role saved while a native page is in flight cannot leak internal output', async () => {
  const f = fixture();
  try {
    f.native.read = async () => {
      f.metas.get('s1')!.roles = [coordinator];
      return { events: reply('internal'), cursor: 'next', cursorStatus: 'ok', hasMore: false };
    };
    await f.runtime.consume('s1');
    assert.equal(f.db.list('native').items.length, 0);
    assert.equal(f.db.list('messages').items.length, 0);
    assert.equal(f.db.must('receptions', 's1').enabled, false);
  } finally { f.close(); }
});

const bindings = [
  { role: 'coordinator', sessionId: 'coordinator', epoch: 1 },
  { role: 'memory', sessionId: 'memory', epoch: 1 },
];
test('activation loads registered unloaded carriers only and returns distinct readiness', async () => {
  const f = fixture();
  try {
    f.metas.get('memory')!.loaded = false;
    const result = await f.runtime.activateRoles({ requestId: 'open-1', bindings });
    assert.equal(result.state, 'accepted');
    assert.deepEqual(f.calls.filter(call => call.name === 'session/load').map(call => call.body), [{ sessionId: 'memory' }]);
    assert.equal(f.calls.some(call => ['session/new', 'session/resources-prepare'].includes(call.name)), false);
    assert.equal(f.db.must('bindings', 'memory').epoch, 1);
    assert.deepEqual(await f.runtime.activateRoles({ requestId: 'open-1', bindings }), result);
    assert.equal(f.calls.filter(call => call.name === 'session/load').length, 1);
  } finally { f.close(); }
});

test('stale activation vectors do not load or register a new operation', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.runtime.activateRoles({ requestId: 'stale', bindings: [bindings[0]] }), /carriers changed/);
    assert.equal(f.db.get('operations', 'activate:stale'), undefined);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('unknown activation keeps original receipt and blocks a new ID or concurrent tab', async () => {
  const f = fixture();
  try {
    f.metas.get('coordinator')!.loaded = false;
    f.fail(new Error('Load acknowledgement lost'));
    const first = f.runtime.activateRoles({ requestId: 'open-1', bindings });
    await assert.rejects(f.runtime.activateRoles({ requestId: 'open-2', bindings }), /outstanding role activation/);
    assert.equal((await first).state, 'unknown');
    f.fail(null);
    assert.equal((await f.runtime.activateRoles({ requestId: 'open-1', bindings })).state, 'unknown');
    await assert.rejects(f.runtime.activateRoles({ requestId: 'open-3', bindings }), /outstanding role activation/);
    assert.equal(f.calls.filter(call => call.name === 'session/load').length, 1);
  } finally { f.close(); }
});

test('missing carrier activation is rejected without native writes or automatic replacement', async () => {
  const f = fixture();
  try {
    f.metas.delete('coordinator');
    const result = await f.runtime.activateRoles({ requestId: 'missing', bindings });
    assert.equal(result.state, 'rejected');
    assert.equal(f.calls.some(call => call.name === 'session/load' || call.name === 'session/new'), false);
    assert.equal(f.db.must('bindings', 'coordinator').sessionId, 'coordinator');
  } finally { f.close(); }
});
