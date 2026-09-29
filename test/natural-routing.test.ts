import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, proof } from './fixtures.ts';
import { questionKey } from '../src/service.ts';
import { inputSchema, receiptInputSchema } from '../src/attachments.ts';
import { inputReceipt } from '../src/ui.ts';
import { fingerprint } from '../src/database.ts';

function question(f: ReturnType<typeof fixture>, sessionId = 's1', requestId = 'q') {
  const request = { requestId, question: 'Apply the proposed change?',
    choices: ['Approve', 'Decline'], allowFreeform: true };
  f.service.syncQuestions(sessionId, [request], true);
  f.metas.get(sessionId)!.ask = request;
  return f.db.must('questions', questionKey(sessionId, requestId));
}

function answer(f: ReturnType<typeof fixture>, text: string) {
  const q = question(f);
  const input = f.service.accept({ requestId: 'natural-answer', text });
  const work = f.service.claim(f.identities.coordinator, 'coordinator', 1, input.work.id)!;
  const decision = { ...proof(work), topic: { title: 'Implementation', independent: true },
    reason: 'The latest question and ongoing topic identify the recipient',
    action: { kind: 'route', sessionIds: ['s1'], routeVersion: 0, answerQuestionId: q.id } };
  f.service.decide(f.identities.coordinator, decision);
  const delivery = f.db.find('deliveries', item => item.messageId === input.message.id)[0]!;
  return { q, input, work, decision, delivery };
}

test('natural reservations, comments and follow-up questions reach the native ask verbatim', async () => {
  for (const text of [
    'Yes, but does that remain inside the same application?',
    'I prefer the current design; can you explain the alternatives?',
    'Approve',
    ' Approve ',
  ]) {
    const f = fixture();
    try {
      const result = answer(f, text);
      await f.runtime.wake();
      assert.deepEqual(f.calls.filter(call => call.name === 'answer').map(call => call.body), [{
        sessionId: 's1', requestId: 'q', answer: text, wasFreeform: text !== 'Approve',
      }]);
      assert.equal(f.db.must('deliveries', result.delivery.id).state, 'accepted');
      assert.equal(f.db.find('publications', item => item.type === 'clarification').length, 0);
      assert.equal(f.db.find('anchors', () => true).length, 0);
      assert.equal(f.calls.some(call => call.name === 'prompt'
        && (call.body as { sessionId: string }).sessionId === 's1'), false);
    } finally { f.close(); }
  }
});

test('context chooses one freeform ask among parallel topics and validates its session identity', async () => {
  const f = fixture();
  try {
    question(f, 's1', 'one');
    const target = question(f, 's2', 'two');
    const input = f.service.accept({ requestId: 'comment', text: 'For the second project, why is this needed?' });
    const work = f.service.claim(f.identities.coordinator, 'coordinator', 1, input.work.id)!;
    const value = { ...proof(work), topic: { title: 'Second project', independent: true },
      reason: 'User names the second project', action: { kind: 'route', sessionIds: ['s1'],
        answerQuestionId: target.id, routeVersion: 0 } };
    assert.throws(() => f.service.decide(f.identities.coordinator, value), { code: 'QUESTION_TARGET_MISMATCH' });
    f.service.decide(f.identities.coordinator, { ...value, action: { ...value.action, sessionIds: ['s2'] } });
    await f.runtime.wake();
    assert.deepEqual(f.calls.filter(call => call.name === 'answer').map(call => call.body), [{
      sessionId: 's2', requestId: 'two', answer: input.message.raw, wasFreeform: true,
    }]);
    assert.equal(f.db.must('questions', questionKey('s1', 'one')).state, 'pending');
  } finally { f.close(); }
});

test('new topics and ordinary comments use context without being captured by another session ask', async () => {
  const f = fixture();
  try {
    question(f);
    const prior = f.service.addMessage({ kind: 'reply', raw: 'A draft for the other project', sessionId: 's2' });
    const input = f.service.accept({ requestId: 'new-topic', text: 'Change the second paragraph of that draft.' });
    const work = f.service.claim(f.identities.coordinator, 'coordinator', 1, input.work.id)!;
    f.service.decide(f.identities.coordinator, { ...proof(work), topic: { title: 'Other project', independent: true },
      reason: `Continuation of source ${prior.id}`, action: { kind: 'route', sessionIds: ['s2'], routeVersion: 0 } });
    await f.runtime.wake();
    assert.equal(f.calls.filter(call => call.name === 'answer').length, 0);
    assert.equal(f.calls.filter(call => call.name === 'prompt'
      && (call.body as { sessionId: string }).sessionId === 's2').length, 1);
    assert.equal(f.db.must('questions', questionKey('s1', 'q')).state, 'pending');
  } finally { f.close(); }
});

test('recipient clarification retains source and topic; its continuation does not require an anchor', () => {
  const f = fixture();
  try {
    const one = question(f, 's1', 'one');
    question(f, 's2', 'two');
    const input = f.service.accept({ requestId: 'unclear', text: 'Please explain that option.' });
    const work = f.service.claim(f.identities.coordinator, 'coordinator', 1, input.work.id)!;
    f.service.decide(f.identities.coordinator, { ...proof(work), topic: { title: 'Discussion', independent: false },
      reason: 'Both projects are equally plausible recipients',
      action: { kind: 'clarify', text: 'The first project or the second?' } });
    const clarification = f.db.find('publications', item => item.type === 'clarification')[0]!;
    assert.equal(clarification.messageId, input.message.id);
    assert.equal(clarification.sources[0]!.messageId, input.message.id);
    assert.equal(clarification.anchorId, null);
    const followup = f.service.accept({ requestId: 'clarified', text: 'The first, and explain the risks too.' });
    const next = f.service.claim(f.identities.coordinator, 'coordinator', 1, followup.work.id)!;
    f.service.decide(f.identities.coordinator, { ...proof(next), topic: { id: clarification.topicId! },
      reason: 'The clarification and follow-up identify the first project',
      action: { kind: 'route', sessionIds: ['s1'], routeVersion: 0, answerQuestionId: one.id } });
    assert.equal(f.db.find('publications', item => item.type === 'clarification').length, 1);
    assert.equal(f.db.find('deliveries', item => item.messageId === followup.message.id)[0]!.text, followup.message.raw);
  } finally { f.close(); }
});

test('a disappeared or replaced ask before dispatch recovers the original work without answering another request', async () => {
  for (const replacement of [false, true]) {
    const f = fixture();
    try {
      const result = answer(f, 'Please explain the tradeoff first.');
      const replacementAsk = { requestId: 'replacement', question: 'Unrelated new choice?', choices: ['Other'], allowFreeform: true };
      f.metas.get('s1')!.ask = replacement ? replacementAsk : null;
      await f.runtime.wake();
      assert.equal(f.db.must('deliveries', result.delivery.id).state, 'rejected');
      assert.equal(f.db.must('questions', result.q.id).state, 'stale');
      const recovered = f.db.must('work', result.work.id);
      assert.equal(recovered.state, 'pending');
      assert.equal(recovered.token, null);
      assert.deepEqual((recovered.result as { recovery: { currentQuestions: unknown[] } }).recovery.currentQuestions,
        replacement ? [replacementAsk] : []);
      assert.equal(f.calls.some(call => call.name === 'answer'), false);
      assert.equal(f.calls.some(call => call.name === 'prompt'
        && (call.body as { sessionId: string }).sessionId === 's1'), false);
      assert.deepEqual(f.service.decide(f.identities.coordinator, result.decision), { deliveries: [result.delivery] },
        'old decision request returns its receipt, not a replay');
      assert.equal(f.db.must('work', result.work.id).state, 'pending');
      if (replacement) {
        f.service.syncQuestions('s1', [replacementAsk], true);
      }
      const fresh = f.service.claim(f.identities.coordinator, 'coordinator', 1, result.work.id)!;
      const topicId = f.db.must('messages', result.input.message.id).topicId!;
      f.service.decide(f.identities.coordinator, { ...proof(fresh, 'reconsider-stale-ask'),
        topic: { id: topicId }, reason: 'Original request ended; clarify whether the new conversation is intended',
        action: { kind: 'clarify', text: 'The earlier question has closed. Is this about the current discussion?' } });
      assert.equal(f.db.find('publications', item => item.type === 'message'
        && item.messageId === result.input.message.id).length, 1);
      assert.equal(f.db.find('deliveries', item => item.messageId === result.input.message.id).length, 1);
      assert.equal(f.db.must('work', result.work.id).state, 'done');
    } finally { f.close(); }
  }
});

test('a definitive callback rejection reopens computation, but an unknown callback never does or resends', async () => {
  for (const uncertain of [false, true]) {
    const f = fixture();
    try {
      const result = answer(f, 'What is the expected impact?');
      if (uncertain) f.fail(new Error('Lost native acknowledgment'));
      else f.native.answer = async () => ({ accepted: false, result: { ok: false } });
      await f.runtime.wake();
      assert.equal(f.db.must('deliveries', result.delivery.id).state, uncertain ? 'unknown' : 'rejected');
      assert.equal(f.db.must('work', result.work.id).state, uncertain ? 'done' : 'pending');
      f.fail(null);
      await f.runtime.wake();
      if (uncertain) {
        f.service.recover();
        assert.equal(f.db.must('work', result.work.id).state, 'done');
        assert.equal(f.calls.filter(call => call.name === 'answer').length, 1);
      }
    } finally { f.close(); }
  }
});

test('unavailable native ask targets retain recoverable input rather than completing a rejected answer', async () => {
  const f = fixture();
  try {
    const result = answer(f, 'Explain the consequences first.');
    f.metas.delete('s1');
    await f.runtime.wake();
    assert.equal(f.db.must('deliveries', result.delivery.id).state, 'rejected');
    const work = f.db.must('work', result.work.id);
    assert.equal(work.state, 'pending');
    assert.equal((work.result as { recovery: { questionObservation: string } }).recovery.questionObservation, 'unavailable');
    assert.equal(f.calls.some(call => call.name === 'answer'), false);
    assert.equal(f.db.find('deliveries', item => item.messageId === result.input.message.id).length, 1);
  } finally { f.close(); }
});

for (const change of ['deleted', 'internal'] as const) {
  test(`session-scoped wake recovers an unsent ask when its target becomes ${change}`, async () => {
    const f = fixture();
    try {
      const result = answer(f, 'Please explain the consequences first.');
      if (change === 'deleted') f.metas.delete('s1');
      else f.metas.get('s1')!.roles = [{
        moduleId: 'assistant', roleId: 'memory', moduleName: 'Assistant', name: 'memory',
      }];
      await f.runtime.wake('s1');
      const delivery = f.db.must('deliveries', result.delivery.id);
      assert.equal(delivery.state, 'cancelled');
      assert.equal(delivery.error, change === 'deleted' ? 'Target no longer exists' : 'Target is an internal role carrier');
      const recovered = f.db.must('work', result.work.id);
      assert.equal(recovered.state, 'pending');
      assert.equal(recovered.token, null);
      assert.equal(recovered.epoch, null);
      assert.equal(recovered.leaseUntil, 0);
      const recovery = (recovered.result as { recovery: {
        deliveryId: string; reason: string; questionObservation: string;
      } }).recovery;
      assert.equal(recovery.deliveryId, delivery.id);
      assert.equal(recovery.reason, delivery.error);
      assert.equal(recovery.questionObservation, 'unavailable');
      assert.equal(f.db.must('questions', result.q.id).state, 'unknown');
      assert.equal(f.db.must('messages', result.input.message.id).raw, result.input.message.raw);
      assert.equal(f.db.find('deliveries', item => item.messageId === result.input.message.id).length, 1);
      assert.equal(f.calls.some(call => call.name === 'answer'), false);
      assert.equal(f.calls.some(call => call.name === 'prompt'
        && (call.body as { sessionId: string }).sessionId === 's1'), false);
      assert.equal(f.service.claim(f.identities.coordinator, 'coordinator', 1, result.work.id)!.id, result.work.id);
      await f.runtime.wake('s1');
      assert.equal(f.db.must('work', result.work.id).state, 'leased');
      assert.equal(f.db.must('deliveries', delivery.id).state, 'cancelled');
      assert.equal(f.calls.some(call => call.name === 'answer'), false);
    } finally { f.close(); }
  });
}

test('session-scoped target retirement never restores work for calling, accepted or unknown native answers', async () => {
  for (const change of ['deleted', 'internal'] as const) {
    for (const state of ['calling', 'accepted', 'unknown'] as const) {
      const f = fixture();
      try {
        const result = answer(f, 'Please explain before proceeding.');
        f.db.put('deliveries', { ...result.delivery, state });
        if (change === 'deleted') f.metas.delete('s1');
        else f.metas.get('s1')!.appliedRoles = [{
          moduleId: 'assistant', roleId: 'coordinator', moduleName: 'Assistant', name: 'coordinator',
        }];
        await f.runtime.wake('s1');
        assert.equal(f.db.must('deliveries', result.delivery.id).state, state);
        assert.equal(f.db.must('work', result.work.id).state, 'done');
        assert.throws(() => f.service.claim(f.identities.coordinator, 'coordinator', 1, result.work.id),
          { code: 'WORK_UNAVAILABLE' });
        assert.equal(f.calls.some(call => call.name === 'answer'), false);
        assert.equal(f.db.find('deliveries', item => item.messageId === result.input.message.id).length, 1);
      } finally { f.close(); }
    }
  }
});

test('recovered computation gets a new wake without replaying an earlier accepted wake', async () => {
  const f = fixture();
  try {
    const q = question(f);
    const output = f.service.claim(f.identities.coordinator, 'coordinator', 1, `message:${q.messageId}:1`)!;
    f.service.decide(f.identities.coordinator, { ...proof(output), topic: { title: 'Question', independent: true },
      reason: 'Publish native question before handling input', action: { kind: 'publish' } });
    const input = f.service.accept({ requestId: 'recover-wake', text: 'Explain the proposal.' });
    await f.runtime.wake();
    const wakeCount = () => f.calls.filter(call => call.name === 'prompt'
      && (call.body as { sessionId: string }).sessionId === 'coordinator').length;
    assert.equal(wakeCount(), 1);
    const wake = f.db.find('deliveries', d => d.kind === 'wake').at(-1)!;
    const work = f.service.claim(f.identities.coordinator, 'coordinator', 1, input.work.id, wake.id)!;
    f.service.decide(f.identities.coordinator, { ...proof(work), topic: { title: 'Project', independent: true },
      reason: 'Context selects this request', action: { kind: 'route', sessionIds: ['s1'],
        routeVersion: 0, answerQuestionId: q.id } });
    assert.equal(f.service.claim(f.identities.coordinator, 'coordinator', 1, undefined, wake.id), null);
    f.metas.get('s1')!.ask = null;
    await f.runtime.wake();
    assert.equal(wakeCount(), 2);
    await f.runtime.wake();
    assert.equal(wakeCount(), 2);
    assert.equal(f.db.must('work', work.id).state, 'pending');
    assert.equal(f.calls.some(call => call.name === 'answer'), false);
  } finally { f.close(); }
});

test('existing pending, accepted or unknown delivery blocks duplicate rerouting even with reclaimed computation', () => {
  for (const state of ['pending', 'calling', 'accepted', 'unknown'] as const) {
    const f = fixture();
    try {
      const result = answer(f, 'Please explain before making a decision.');
      f.db.put('deliveries', { ...result.delivery, state });
      f.db.put('work', { ...f.db.must('work', result.work.id), state: 'pending' });
      const fresh = f.service.claim(f.identities.coordinator, 'coordinator', 1, result.work.id)!;
      assert.throws(() => f.service.decide(f.identities.coordinator, { ...result.decision,
        ...proof(fresh, 'must-not-resend'), topic: { id: f.db.must('messages', result.input.message.id).topicId! } }),
      { code: 'INPUT_ALREADY_ROUTED' });
      assert.equal(f.db.find('deliveries', item => item.messageId === result.input.message.id).length, 1);
      assert.equal(f.db.must('deliveries', result.delivery.id).state, state);
    } finally { f.close(); }
  }
});

test('new API rejects legacy reply fields and GET receipts retain their exact historical identity', () => {
  const f = fixture();
  try {
    for (const replyTo of ['old-anchor', null]) {
      assert.equal(inputSchema.safeParse({ requestId: 'new', text: 'Comment', replyTo }).success, false);
    }
    assert.equal(Object.hasOwn(inputSchema.parse({ requestId: 'new', text: 'Comment' }), 'replyTo'), false);
    const old = f.service.accept({ requestId: 'old', text: 'Original' });
    const legacy = { requestId: 'old', text: 'Original', attachments: [], replyTo: 'old-anchor' };
    const message = { ...old.message, replyTo: 'old-anchor' };
    f.db.put('messages', message);
    f.db.put('operations', { id: 'input:old', fingerprint: fingerprint(legacy), state: 'accepted',
      result: { ...old, message, input: legacy } });
    f.db.put('anchors', { id: 'old-anchor', messageId: 'historical', sessionId: 's1', requestId: null, kind: 'comment' });
    assert.deepEqual(inputReceipt(f.service, 'old').input, receiptInputSchema.parse(legacy));
    assert.throws(() => f.service.accept(legacy), /Unrecognized key/);
    assert.throws(() => f.service.accept({ requestId: 'old', text: 'Original' }), /different input/);
    assert.equal(f.db.must('anchors', 'old-anchor').sessionId, 's1');
    assert.equal(f.db.find('deliveries', () => true).length, 0);
  } finally { f.close(); }
});
