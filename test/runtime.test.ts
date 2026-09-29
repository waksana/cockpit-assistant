import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, proof } from './fixtures.ts';
import { questionKey } from '../src/service.ts';

function route(f: ReturnType<typeof fixture>) {
  const input = f.service.accept({ requestId: 'one', text: 'Hi' });
  const work = f.service.claim(f.identities.coordinator, 'coordinator', 1, input.work.id)!;
  f.service.decide(f.identities.coordinator, { ...proof(work), topic: { title: 'T', independent: true },
    reason: 'New', action: { kind: 'route', sessionIds: ['s1'], routeVersion: 0 } });
  return f.db.find('deliveries', d => d.kind === 'prompt')[0]!;
}
test('accepted effects do not resend across pump and recovery', async () => {
  const f = fixture();
  try {
    const delivery = route(f);
    await f.runtime.wake();
    assert.equal(f.db.must('deliveries', delivery.id).state, 'accepted');
    f.service.recover();
    await f.runtime.wake();
    assert.equal(f.calls.filter(c => c.name === 'prompt').length, 1);
  } finally { f.close(); }
});
test('native exception after call intent leaves unknown, never blindly retries', async () => {
  const f = fixture();
  try {
    const delivery = route(f);
    f.fail(new Error('Connection dropped after native accepted'));
    await f.runtime.wake();
    assert.equal(f.db.must('deliveries', delivery.id).state, 'unknown');
    f.fail(null);
    await f.runtime.wake();
    assert.equal(f.calls.filter(c => c.name === 'prompt').length, 1);
  } finally { f.close(); }
});
test('deleted reception never redirects an anchored message', async () => {
  const f = fixture();
  try {
    const delivery = route(f);
    f.metas.delete('s1');
    await f.runtime.wake();
    assert.equal(f.db.must('deliveries', delivery.id).state, 'rejected');
    assert.equal(f.calls.filter(c => c.name === 'prompt' && JSON.stringify(c.body).includes('"s1"')).length, 0);
  } finally { f.close(); }
});
test('native answers use request interface, not prompt; stale request is rejected', async () => {
  const f = fixture();
  try {
    const ask = { requestId: 'q', question: 'Proceed?', choices: ['Yes'], allowFreeform: false };
    f.db.transaction(() => f.service.syncQuestions('s1', [ask], true));
    f.metas.get('s1')!.ask = ask;
    const q = f.db.must('questions', questionKey('s1', 'q'));
    f.db.put('anchors', { id: q.messageId, messageId: q.messageId, sessionId: 's1', kind: 'ask', requestId: 'q' });
    const input = f.service.accept({ requestId: 'answer', text: 'Yes' });
    const work = f.service.claim(f.identities.coordinator, 'coordinator', 1, input.work.id)!;
    f.service.decide(f.identities.coordinator, { ...proof(work), topic: { title: 'T', independent: true },
      reason: 'Context selects answer', action: { kind: 'route', sessionIds: ['s1'], routeVersion: 0, answerQuestionId: q.id } });
    await f.runtime.wake();
    assert.equal(f.calls.filter(c => c.name === 'answer').length, 1);
    assert.equal(f.calls.filter(c => c.name === 'prompt' && JSON.stringify(c.body).includes('"s1"')).length, 0);
    assert.equal(f.db.must('questions', q.id).state, 'answered');
  } finally { f.close(); }
});
test('cursor page commits atomically, overlap deduplicates, only evidenced complete primary responses qualify', async () => {
  const f = fixture();
  try {
    const events = [
      { id: 'start', type: 'assistant.turn_start', data: {}, parentId: null },
      { id: 'message', type: 'assistant.message', data: { content: 'Complete', messageId: 'native-m', toolRequests: [] }, parentId: 'start' },
      { id: 'end', type: 'assistant.turn_end', data: {}, parentId: 'message' },
    ];
    f.runtime.ingestion.apply('s1', 1, events.slice(0, 2), 'c1');
    assert.equal(f.db.list('messages').items.length, 0);
    f.runtime.ingestion.apply('s1', 1, events, 'c2');
    assert.equal(f.db.list('messages').items.length, 1);
    f.runtime.ingestion.apply('s1', 1, events, 'c2');
    assert.equal(f.db.list('messages').items.length, 1);
    f.runtime.ingestion.apply('s1', 1, events.map(e => ({ ...e, id: `child-${e.id}`, parentId: e.parentId ? `child-${e.parentId}` : null, agentId: 'child' })), 'c3');
    assert.equal(f.db.list('messages').items.length, 1);
    assert.throws(() => f.runtime.ingestion.apply('s1', 1, [
      { ...events[1]!, data: { content: 'Mutated event ID' } },
    ], 'bad'), /changed its durable payload/);
    assert.equal(f.db.must('receptions', 's1').cursor, 'c3');
  } finally { f.close(); }
});
test('tool commentary and idle never become final replies; unenrolled input is rejected', () => {
  const f = fixture();
  try {
    f.runtime.ingestion.apply('s1', 1, [
      { id: 'start', type: 'assistant.turn_start', data: {} },
      { id: 'm', type: 'assistant.message', parentId: 'start', data: { content: 'Working', toolRequests: [{}] } },
      { id: 'end', type: 'assistant.turn_end', parentId: 'm', data: {} },
      { id: 'idle', type: 'session.idle', data: {} },
    ], 'c');
    assert.equal(f.db.list('messages').items.length, 0);
    assert.throws(() => f.runtime.ingestion.apply('private', 1, [], 'c'), /not found/);
  } finally { f.close(); }
});
test('expired cursors expose gaps without taking a new tail', async () => {
  const f = fixture();
  try {
    f.pages.push({ events: [], cursor: null, cursorStatus: 'expired', hasMore: false });
    await f.runtime.consume('s1');
    assert.match(f.db.must('receptions', 's1').gap!, /expired/);
    await f.runtime.consume('s1');
    assert.equal(f.calls.filter(c => c.name === 'chat').length, 1);
  } finally { f.close(); }
});
test('unknown create blocks a new attempt and replay does not create another session', async () => {
  const f = fixture();
  try {
    f.fail(new Error('Creation acknowledgment lost'));
    await assert.rejects(f.runtime.create({ requestId: 'create1', cwd: '/synthetic' }));
    await f.runtime.create({ requestId: 'create1', cwd: '/synthetic' });
    await assert.rejects(f.runtime.create({ requestId: 'create2', cwd: '/synthetic' }), /Resolve uncertain/);
    assert.equal(f.calls.filter(c => c.name === 'session/new').length, 1);
  } finally { f.close(); }
});

test('partial role creation retains native identity and notification recovery without claiming success', async () => {
  const f = fixture();
  try {
    const roleAssignment = { notificationId: 'notification-1', saved: true,
      roles: [{ moduleId: 'assistant', roleId: 'coordinator' }], recovery: 'roles/notify' };
    f.fail(Object.assign(new Error('Role notification incomplete'), {
      code: 'ROLE_ASSIGNMENT_INCOMPLETE', sessionId: 'created-before-notification', roleAssignment,
    }));
    await assert.rejects(f.runtime.create({ requestId: 'partial-role', cwd: '/synthetic', role: 'coordinator' }));
    const operation = f.db.must('operations', 'create:partial-role');
    assert.equal(operation.state, 'unknown');
    assert.deepEqual(operation.result, { error: 'Role notification incomplete', code: 'ROLE_ASSIGNMENT_INCOMPLETE',
      sessionId: 'created-before-notification', roleAssignment });
    assert.deepEqual(await f.runtime.create({ requestId: 'partial-role', cwd: '/synthetic', role: 'coordinator' }), operation);
    assert.equal(f.calls.filter(c => c.name === 'session/new').length, 1);
  } finally { f.close(); }
});

test('bootstrap retains historical turn linkage for a newly completed reply', async () => {
  const f = fixture();
  try {
    f.db.put('receptions', { ...f.db.must('receptions', 's1'), baseline: false, cursor: null });
    f.pages.push(
      { events: [{ id: 'start', type: 'assistant.turn_start', data: {} }],
        cursor: 'back', liveCursor: 'live-tail', cursorStatus: 'ok', hasMore: true },
      { events: [
        { id: 'm', type: 'assistant.message', parentId: 'start',
          data: { messageId: 'native', content: 'Completed after enrollment', toolRequests: [] } },
        { id: 'end', type: 'assistant.turn_end', parentId: 'm', data: {} },
      ], cursor: 'next', cursorStatus: 'ok', hasMore: false },
    );
    await f.runtime.consume('s1');
    assert.equal(f.db.list('messages').items[0]?.historical, false);
    assert.equal(f.db.list('messages').items[0]?.raw, 'Completed after enrollment');
  } finally { f.close(); }
});

test('expired computational lease receives a new wake, not a replay of the accepted wake', async () => {
  const f = fixture();
  try {
    const input = f.service.accept({ requestId: 'one', text: 'Work' });
    await f.runtime.wake();
    const wake = f.db.find('deliveries', d => d.kind === 'wake')[0]!;
    f.service.claim(f.identities.coordinator, 'coordinator', 1, input.work.id, wake.id);
    f.advance(300_001);
    await f.runtime.wake();
    const wakes = f.db.find('deliveries', d => d.kind === 'wake');
    assert.equal(wakes.length, 2);
    assert.ok(wakes.every(w => w.state === 'accepted'));
    await f.runtime.wake();
    assert.equal(f.db.find('deliveries', d => d.kind === 'wake').length, 2);
  } finally { f.close(); }
});

test('role replacement fences old leases while preserving accepted reception deliveries', async () => {
  const f = fixture();
  try {
    const delivery = route(f);
    await f.runtime.wake();
    const next = f.service.accept({ requestId: 'two', text: 'More work' });
    const oldWork = f.service.claim(f.identities.coordinator, 'coordinator', 1, next.work.id)!;
    f.metas.set('replacement', { ...f.metas.get('coordinator')!, sessionId: 'replacement',
      appliedRoles: [{ moduleId: 'assistant', moduleName: 'Assistant', name: 'Coordinator', roleId: 'coordinator' }] });
    await f.runtime.bind({ requestId: 'replace', role: 'coordinator', sessionId: 'replacement',
      expectedEpoch: 1, expectedModelId: 'synthetic', definitionVersion: '1' });
    assert.equal(f.db.must('bindings', 'coordinator').epoch, 2);
    assert.equal(f.db.must('work', oldWork.id).state, 'pending');
    assert.throws(() => f.service.claim(f.identities.coordinator, 'coordinator', 1), /current role epoch/);
    const current = f.service.claim({ sessionId: 'replacement', runtimeSessionId: 'replacement', subagent: false },
      'coordinator', 2, next.work.id)!;
    assert.equal(current.epoch, 2);
    assert.equal(f.db.must('deliveries', delivery.id).state, 'accepted');
    await f.runtime.wake();
    assert.equal(f.calls.filter(c => c.name === 'prompt' && JSON.stringify(c.body).includes('"sessionId":"s1"')).length, 1);
  } finally { f.close(); }
});

test('bounded explicit history recovery classifies historical data without new reply publication', async () => {
  const f = fixture();
  try {
    f.db.put('receptions', { ...f.db.must('receptions', 's1'), gap: 'expired' });
    f.pages.push({ events: [
      { id: 'start', type: 'assistant.turn_start', data: {} },
      { id: 'm', type: 'assistant.message', parentId: 'start', data: { content: 'Old answer', toolRequests: [] } },
      { id: 'end', type: 'assistant.turn_end', parentId: 'm', data: {} },
    ], cursor: 'older', liveCursor: 'current-tail', cursorStatus: 'ok', hasMore: true });
    await f.runtime.recoverHistory('s1', 'recover', 1, 'Operator acknowledged bounded gap');
    assert.equal(f.db.must('receptions', 's1').cursor, 'current-tail');
    const message = f.db.list('messages').items[0]!;
    assert.equal(message.historical, true);
    const work = f.service.claim(f.identities.coordinator, 'coordinator', 1)!;
    assert.throws(() => f.service.decide(f.identities.coordinator, { ...proof(work),
      topic: { title: 'Old', independent: true }, reason: 'Imported history',
      action: { kind: 'publish' } }), /newly received/);
  } finally { f.close(); }
});

test('partial recovery preserves a progress receipt and never replays the same operation', async () => {
  const f = fixture();
  try {
    let reads = 0;
    f.native.read = async () => {
      if (++reads > 1) throw new Error('Second page failed');
      return { events: [
        { id: 'start', type: 'assistant.turn_start', data: {} },
        { id: 'm', type: 'assistant.message', parentId: 'start', data: { content: 'Old', toolRequests: [] } },
        { id: 'end', type: 'assistant.turn_end', parentId: 'm', data: {} },
      ], cursor: 'older', liveCursor: 'tail', cursorStatus: 'ok', hasMore: true };
    };
    await assert.rejects(f.runtime.recoverHistory('s1', 'partial', 2, 'Explicit bounded import'), /Second page/);
    assert.equal(f.db.list('messages').items.length, 1);
    assert.equal(f.db.must('operations', 'history-recovery:partial').state, 'unknown');
    assert.match(JSON.stringify(f.db.must('operations', 'history-recovery:partial').result), /"pages":1/);
    await f.runtime.recoverHistory('s1', 'partial', 2, 'Explicit bounded import');
    assert.equal(reads, 2);
    await assert.rejects(f.runtime.recoverHistory('s1', 'partial', 1, 'Changed'), /request changed/);
    assert.equal(f.db.must('receptions', 's1').cursor, '');
  } finally { f.close(); }
});
