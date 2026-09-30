import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, stageDelivery } from './fixtures.ts';

const reply = [
  { id: 'user-envelope', type: 'user.message',
    data: { messageId: 'prompt-receipt', interactionId: 'assistant-interaction' }, parentId: null },
  { id: 'start', type: 'assistant.turn_start', data: {}, parentId: null },
  { id: 'message', type: 'assistant.message', parentId: 'start',
    data: { content: 'Complete', messageId: 'native-m', interactionId: 'assistant-interaction', toolRequests: [] } },
  { id: 'end', type: 'assistant.turn_end', data: {}, parentId: 'message' },
];
function track(f: ReturnType<typeof fixture>) {
  return stageDelivery(f, { state: 'accepted', nativeMessageId: 'prompt-receipt' });
}
function replies(f: ReturnType<typeof fixture>) {
  return f.db.find('messages', message => message.kind === 'reply');
}

test('ordinary directory discovery reads all business sessions without an Assistant delivery', async () => {
  const f = fixture();
  try {
    await f.runtime.start();
    await f.runtime.wake('s1');
    assert.equal(f.calls.some(call => call.name === 'chat'), true);
    assert.equal(f.db.list('native').items.length, 0);
    assert.equal(f.db.list('messages').items.length, 0);
  } finally { f.close(); }
});

test('all ordinary native asks are collected without receipts, while internal asks are excluded', async t => {
  const f = fixture(); t.after(() => f.close());
  const request = { requestId: 'actual-request', question: 'Select a path', choices: ['A', 'B'], allowFreeform: false };
  f.metas.get('s1')!.ask = request;
  f.metas.get('coordinator')!.ask = { ...request, requestId: 'internal-request' };
  await f.runtime.wake('s1');
  await f.runtime.wake('coordinator');
  assert.deepEqual(f.db.list('questions').items.map(question => question.request), [request]);
  assert.equal(f.db.find('messages', message => message.kind === 'ask').length, 1);
  assert.equal(f.db.find('deliveries', delivery => delivery.kind === 'prompt').length, 0);
});

test('ordinary prompt acceptance does not require internal wake receipts and is never resent', async () => {
  const f = fixture();
  try {
    const delivery = stageDelivery(f);
    f.promptResult({ ok: true });
    await f.runtime.wake();
    assert.equal(f.db.must('deliveries', delivery.id).state, 'accepted');
    await f.runtime.wake('s1');
    assert.equal(f.calls.filter(call => call.name === 'prompt').length, 1);
    assert.equal(f.calls.some(call => call.name === 'chat'), true);
  } finally { f.close(); }
});

test('business replies before send acknowledgment are immediately visible without receipt filtering', async () => {
  const f = fixture();
  try {
    const delivery = stageDelivery(f);
    f.promptResult({ ok: true, messageId: 'prompt-receipt' });
    f.onPrompt(async () => {
      f.onPrompt(null);
      f.pages.push({ events: reply, cursor: 'tail', cursorStatus: 'ok', hasMore: false });
      await f.runtime.consume('s1');
      assert.equal(replies(f)[0]?.raw, 'Complete');
    });
    await f.runtime.wake();
    assert.equal(f.db.must('deliveries', delivery.id).nativeMessageId, 'prompt-receipt');
    assert.equal(replies(f)[0]?.deliveryId, undefined);
    assert.equal(replies(f)[0]?.raw, 'Complete');
  } finally { f.close(); }
});

test('accepted and uncertain external effects never resend across pump and recovery', async () => {
  for (const uncertain of [false, true]) {
    const f = fixture();
    try {
      const delivery = stageDelivery(f);
      if (uncertain) f.fail(new Error('Connection dropped after native accepted'));
      await f.runtime.wake();
      assert.equal(f.db.must('deliveries', delivery.id).state, uncertain ? 'unknown' : 'accepted');
      f.fail(null);
      f.service.recover();
      await f.runtime.wake();
      assert.equal(f.calls.filter(c => c.name === 'prompt').length, 1);
      assert.equal(f.db.must('work', `message:${delivery.messageId}:1`).state, 'done');
    } finally { f.close(); }
  }
});

test('cursor page commits atomically, overlap deduplicates, and replies publish before attribution', () => {
  const f = fixture();
  try {
    track(f);
    f.runtime.ingestion.apply('s1', 1, reply.slice(0, 2), 'c1');
    assert.equal(replies(f).length, 0);
    f.runtime.ingestion.apply('s1', 1, reply, 'c2');
    const message = replies(f)[0]!;
    assert.equal(message.raw, 'Complete');
    assert.equal(message.topicId, null);
    assert.equal(f.db.find('publications', p => p.messageId === message.id && p.type === 'message').length, 1);
    f.runtime.ingestion.apply('s1', 1, reply, 'c2');
    f.runtime.ingestion.apply('s1', 1, reply.map(e => ({ ...e, id: `child-${e.id}`,
      parentId: e.parentId ? `child-${e.parentId}` : null, agentId: 'child' })), 'c3');
    assert.equal(replies(f).length, 1);
    assert.throws(() => f.runtime.ingestion.apply('s1', 1, [
      { ...reply[2]!, data: { ...reply[2]!.data, content: 'Mutated event ID' } },
    ], 'bad'), /changed its durable payload/);
    assert.equal(f.db.must('receptions', 's1').cursor, 'c3');
  } finally { f.close(); }
});

test('unidentified native events are neither retained nor turned into business inputs', () => {
  const f = fixture();
  try {
    const events = [
      { id: 'human-or-forward', type: 'user.message', data: { content: 'Identical text', attachments: [] } },
      { id: 'another', type: 'user.message', data: { content: 'Identical text', source: 'unverified' } },
    ];
    f.runtime.ingestion.apply('s1', 1, events, 'cursor');
    assert.deepEqual(f.db.list('native').items, []);
    assert.equal(f.db.list('messages').items.length, 0);
    assert.equal(f.db.list('work').items.length, 0);
  } finally { f.close(); }
});

test('primary commentary is visible but lifecycle events are not replies; unobserved history is rejected', () => {
  const f = fixture();
  try {
    f.runtime.ingestion.apply('s1', 1, [
      { id: 'start', type: 'assistant.turn_start', data: {} },
      { id: 'm', type: 'assistant.message', parentId: 'start', data: { content: 'Working', toolRequests: [{}] } },
      { id: 'end', type: 'assistant.turn_end', parentId: 'm', data: {} },
      { id: 'idle', type: 'session.idle', data: {} },
    ], 'c');
    assert.deepEqual(f.db.list('messages').items.map(message => message.raw), ['Working']);
    assert.throws(() => f.runtime.ingestion.apply('private', 1, [], 'c'), /not found/);
  } finally { f.close(); }
});

test('expired cursors expose gaps without silently taking a new tail', async () => {
  const f = fixture();
  try {
    track(f);
    f.pages.push({ events: [], cursor: null, cursorStatus: 'expired', hasMore: false });
    await f.runtime.consume('s1');
    assert.match(f.db.must('receptions', 's1').gap!, /expired/);
    await f.runtime.consume('s1');
    assert.equal(f.calls.filter(c => c.name === 'chat').length, 1);
  } finally { f.close(); }
});

test('partial role creation retains native identity and never repeats its original intent', async () => {
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

test('bootstrap retains receipt identity for a newly arriving related reply', async () => {
  const f = fixture();
  try {
    track(f);
    f.db.put('receptions', { ...f.db.must('receptions', 's1'), baseline: false, cursor: null });
    f.pages.push(
      { events: [reply[0]!], cursor: 'back', liveCursor: 'live-tail', cursorStatus: 'ok', hasMore: true },
      { events: reply.slice(1), cursor: 'next', cursorStatus: 'ok', hasMore: false },
    );
    await f.runtime.consume('s1');
    assert.equal(replies(f)[0]?.historical, false);
    assert.equal(replies(f)[0]?.raw, 'Complete');
  } finally { f.close(); }
});

test('bounded explicit history recovery preserves historical status and cursor evidence', async () => {
  const f = fixture();
  try {
    const delivery = track(f);
    f.db.put('receptions', { ...f.db.must('receptions', 's1'), gap: 'expired' });
    f.pages.push({ events: reply, cursor: 'older', liveCursor: 'current-tail', cursorStatus: 'ok', hasMore: true });
    await f.runtime.recoverHistory('s1', 'recover', 1, 'Operator acknowledged bounded gap');
    assert.equal(f.db.must('receptions', 's1').cursor, 'current-tail');
    assert.equal(replies(f)[0]!.historical, true);
    assert.equal(f.db.find('publications', p => p.type === 'message' && p.messageId !== delivery.messageId).length, 0);
  } finally { f.close(); }
});

test('partial recovery preserves progress and never repeats the same operation', async () => {
  const f = fixture();
  try {
    track(f);
    let reads = 0;
    f.native.read = async () => {
      if (++reads > 1) throw new Error('Second page failed');
      return { events: reply, cursor: 'older', liveCursor: 'tail', cursorStatus: 'ok', hasMore: true };
    };
    await assert.rejects(f.runtime.recoverHistory('s1', 'partial', 2, 'Explicit bounded import'), /Second page/);
    assert.equal(replies(f).length, 1);
    assert.equal(f.db.must('operations', 'history-recovery:partial').state, 'unknown');
    assert.match(JSON.stringify(f.db.must('operations', 'history-recovery:partial').result), /"pages":1/);
    await f.runtime.recoverHistory('s1', 'partial', 2, 'Explicit bounded import');
    assert.equal(reads, 2);
    await assert.rejects(f.runtime.recoverHistory('s1', 'partial', 1, 'Changed'), /request changed/);
    assert.equal(f.db.must('receptions', 's1').cursor, '');
  } finally { f.close(); }
});
