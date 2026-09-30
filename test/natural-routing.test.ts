import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AskRequest } from '@waksana/cockpit-module-sdk/backend';
import { fixture, topic } from './fixtures.ts';
import { questionKey } from '../src/service.ts';
import { inputSchema } from '../src/attachments.ts';
import { inputReceipt } from '../src/ui.ts';

function batch(f: ReturnType<typeof fixture>) {
  return f.service.startBatch(f.db.must('bindings', 'coordinator'))!;
}

function question(f: ReturnType<typeof fixture>, sessionId = 's1', requestId = 'q',
  options: Partial<AskRequest> = {}) {
  const request = { requestId, question: 'Apply the proposed change?',
    choices: ['Approve', 'Decline'], allowFreeform: true, ...options };
  f.service.syncQuestions(sessionId, [request], true);
  f.metas.get(sessionId)!.ask = request;
  return f.db.must('questions', questionKey(sessionId, requestId));
}

function classify(f: ReturnType<typeof fixture>, questions: { messageId: string }[], topicIds: string[]) {
  const current = batch(f);
  f.service.attribute(f.identities.coordinator, {
    items: questions.map((q, index) => ({ messageId: q.messageId, topicId: topicIds[index]! })),
  });
  f.service.finishBatch(current.id, 'finished');
}

function answer(f: ReturnType<typeof fixture>, text: string) {
  topic(f, 'implementation');
  const q = question(f);
  classify(f, [q], ['implementation']);
  const input = f.service.accept({ requestId: 'natural-answer', text });
  const current = batch(f);
  const dispatch = { items: [{ topicId: 'implementation', prompt: text }] };
  f.service.dispatch(f.identities.coordinator, dispatch);
  const delivery = f.db.find('deliveries', item => item.messageId === input.message.id)[0]!;
  return { q, input, current, dispatch, delivery };
}

test('natural reservations, comments and exact choices reach the attributed native ask verbatim', async () => {
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
      assert.equal(f.calls.some(call => call.name === 'prompt'
        && (call.body as { sessionId: string }).sessionId === 's1'), false);
      assert.equal(inputReceipt(f.service, 'natural-answer').input.text, text);
    } finally { f.close(); }
  }
});

test('topic mapping selects one attributed ask among parallel sessions without public request identifiers', async () => {
  const f = fixture();
  try {
    topic(f, 'first', 's1'); topic(f, 'second', 's2');
    const first = question(f, 's1', 'one');
    const target = question(f, 's2', 'two');
    classify(f, [first, target], ['first', 'second']);
    const input = f.service.accept({ requestId: 'comment', text: 'For the second project, why is this needed?' });
    batch(f);
    assert.throws(() => f.service.dispatch(f.identities.coordinator, { items: [{
      topicId: 'second', prompt: input.message.raw, answerQuestionId: first.id,
    }] }), /Unrecognized key/);
    f.service.dispatch(f.identities.coordinator, { items: [{ topicId: 'second', prompt: input.message.raw }] });
    await f.runtime.wake();
    assert.deepEqual(f.calls.filter(call => call.name === 'answer').map(call => call.body), [{
      sessionId: 's2', requestId: 'two', answer: input.message.raw, wasFreeform: true,
    }]);
    assert.equal(f.db.must('questions', first.id).state, 'pending');
  } finally { f.close(); }
});

test('unclassified and wrong-topic native questions block dispatch atomically', () => {
  for (const attributed of [false, true]) {
    const f = fixture();
    try {
      topic(f, 'first'); topic(f, 'other');
      const q = question(f);
      if (attributed) classify(f, [q], ['other']);
      const input = f.service.accept({ requestId: 'comment', text: 'Please explain that option.' });
      batch(f);
      const before = f.db.list('publications').items;
      assert.throws(() => f.service.dispatch(f.identities.coordinator, {
        items: [{ topicId: 'first', prompt: input.message.raw }],
      }), { code: 'AMBIGUOUS_NATIVE_ASK' });
      assert.equal(f.db.list('deliveries').items.length, 0);
      assert.equal(f.db.must('work', input.work.id).state, 'leased');
      assert.deepEqual(f.db.list('publications').items, before);
      f.service.clarify(f.identities.coordinator, { text: 'Which project is this about?' });
      assert.equal(f.db.must('work', input.work.id).state, 'done');
    } finally { f.close(); }
  }
});

test('coalesced independent answers retain their uniquely matching original source and native request', async t => {
  const f = fixture(); t.after(() => f.close());
  topic(f, 'first', 's1'); topic(f, 'second', 's2');
  const first = question(f, 's1', 'first-ask', { choices: ['blue'], allowFreeform: false });
  const second = question(f, 's2', 'second-ask', { choices: ['green'], allowFreeform: false });
  classify(f, [first, second], ['first', 'second']);
  const blue = f.service.accept({ requestId: 'blue', text: 'blue' });
  const green = f.service.accept({ requestId: 'green', text: 'green' });
  batch(f);
  f.service.dispatch(f.identities.coordinator, { items: [
    { topicId: 'first', prompt: 'blue' }, { topicId: 'second', prompt: 'green' },
  ] });
  assert.deepEqual(f.db.find('deliveries', d => d.kind === 'ask').map(d => [d.messageIds, d.requestId]),
    [[[blue.message.id], 'first-ask'], [[green.message.id], 'second-ask']]);
  await f.runtime.wake();
  assert.deepEqual(f.calls.filter(call => call.name === 'answer').map(call => call.body), [
    { sessionId: 's1', requestId: 'first-ask', answer: 'blue', wasFreeform: false },
    { sessionId: 's2', requestId: 'second-ask', answer: 'green', wasFreeform: false },
  ]);
});

test('a coalesced native answer and normal request dispatch without merging the answer source', t => {
  const f = fixture(); t.after(() => f.close());
  topic(f, 'ask', 's1'); topic(f, 'normal', 's2');
  const q = question(f);
  classify(f, [q], ['ask']);
  const answer = f.service.accept({ requestId: 'answer', text: 'Approve' });
  const normal = f.service.accept({ requestId: 'normal', text: 'Write a plan' });
  batch(f);
  f.service.dispatch(f.identities.coordinator, { items: [
    { topicId: 'ask', prompt: 'Approve' }, { topicId: 'normal', prompt: 'Write a plan' },
  ] });
  const deliveries = f.db.list('deliveries').items;
  assert.deepEqual(deliveries.find(d => d.kind === 'ask')!.messageIds, [answer.message.id]);
  assert.equal(deliveries.find(d => d.kind === 'prompt')!.text, normal.message.raw);
  assert.equal(f.db.must('work', answer.work.id).state, 'done');
  assert.equal(f.db.must('work', normal.work.id).state, 'done');
});

test('identical coalesced answers and reused answer sources fail atomically rather than guessing', () => {
  for (const originals of [1, 2]) {
    const f = fixture();
    try {
      topic(f, 'first', 's1'); topic(f, 'second', 's2');
      classify(f, [question(f, 's1', 'one'), question(f, 's2', 'two')], ['first', 'second']);
      for (let i = 0; i < originals; i++) f.service.accept({ requestId: `${i}`, text: 'Approve' });
      const active = batch(f);
      assert.throws(() => f.service.dispatch(f.identities.coordinator, { items: [
        { topicId: 'first', prompt: 'Approve' }, { topicId: 'second', prompt: 'Approve' },
      ] }), { code: 'AMBIGUOUS_ANSWER_SOURCE' });
      assert.equal(f.db.list('deliveries').items.length, 0);
      assert.ok(active.workIds.every(id => f.db.must('work', id).state === 'leased'));
    } finally { f.close(); }
  }
});

test('a changed topic mapping never redirects an answer away from its original native request', async t => {
  const f = fixture(); t.after(() => f.close());
  topic(f, 'question-topic', 's1');
  const q = question(f, 's1', 'original');
  classify(f, [q], ['question-topic']);
  const input = f.service.accept({ requestId: 'answer', text: 'Approve' });
  batch(f);
  f.service.map(f.identities.coordinator, { topicId: 'question-topic', sessionId: 's2' });
  f.service.dispatch(f.identities.coordinator, { items: [{ topicId: 'question-topic', prompt: input.message.raw }] });
  await f.runtime.wake();
  assert.deepEqual(f.calls.filter(call => call.name === 'answer').map(call => call.body), [
    { sessionId: 's1', requestId: 'original', answer: 'Approve', wasFreeform: false },
  ]);
  assert.equal(f.db.must('topics', 'question-topic').sessionId, 's2');
});

test('ordinary comments are not captured by a question in another session', async () => {
  const f = fixture();
  try {
    question(f);
    topic(f, 'other', 's2');
    const input = f.service.accept({ requestId: 'new-topic', text: 'Change the second paragraph of that draft.' });
    batch(f);
    f.service.dispatch(f.identities.coordinator, { items: [{ topicId: 'other', prompt: input.message.raw }] });
    await f.runtime.wake();
    assert.equal(f.calls.filter(call => call.name === 'answer').length, 0);
    const sent = f.calls.filter(call => call.name === 'prompt'
      && (call.body as { sessionId: string }).sessionId === 's2');
    assert.equal(sent.length, 1);
    assert.equal((sent[0]!.body as { text: string }).text, input.message.raw);
    assert.equal(f.db.must('questions', questionKey('s1', 'q')).state, 'pending');
  } finally { f.close(); }
});

test('recipient clarification retains the original input and continuation uses the identified topic', () => {
  const f = fixture();
  try {
    topic(f, 'first', 's1'); topic(f, 'second', 's2');
    const one = question(f, 's1', 'one');
    const two = question(f, 's2', 'two');
    classify(f, [one, two], ['first', 'second']);
    const input = f.service.accept({ requestId: 'unclear', text: 'Please explain that option.' });
    const current = batch(f);
    f.service.clarify(f.identities.coordinator, { text: 'The first project or the second?' });
    const clarification = f.db.find('publications', item => item.type === 'clarification')[0]!;
    assert.equal(clarification.messageId, input.message.id);
    assert.equal(f.db.must('messages', input.message.id).raw, input.message.raw);
    assert.equal(f.db.list('deliveries').items.length, 0);
    f.service.finishBatch(current.id, 'finished');
    const followup = f.service.accept({ requestId: 'clarified', text: 'The first, and explain the risks too.' });
    batch(f);
    f.service.dispatch(f.identities.coordinator, { items: [{ topicId: 'first', prompt: followup.message.raw }] });
    assert.equal(f.db.find('publications', item => item.type === 'clarification').length, 1);
    const delivery = f.db.find('deliveries', item => item.messageId === followup.message.id)[0]!;
    assert.equal(delivery.text, followup.message.raw);
    assert.equal(delivery.requestId, 'one');
    assert.equal(delivery.kind, 'ask');
  } finally { f.close(); }
});

test('choice-only and duplicate-choice restrictions reject answers without consuming the batch', () => {
  for (const options of [
    { choices: ['Approve'], allowFreeform: false },
    { choices: ['Approve', 'Approve'], allowFreeform: true },
  ]) {
    const f = fixture();
    try {
      topic(f);
      const q = question(f, 's1', 'q', options);
      classify(f, [q], ['topic']);
      const input = f.service.accept({ requestId: 'answer', text: options.allowFreeform ? 'Approve' : 'Sure' });
      batch(f);
      assert.throws(() => f.service.dispatch(f.identities.coordinator, {
        items: [{ topicId: 'topic', prompt: options.allowFreeform ? 'Approve' : 'Sure' }],
      }), /exactly match|duplicate literal choices/);
      assert.equal(f.db.must('work', input.work.id).state, 'leased');
      assert.equal(f.db.list('deliveries').items.length, 0);
    } finally { f.close(); }
  }
});

test('native answer dispatch cannot trim or paraphrase the original user answer into an allowed choice', () => {
  const f = fixture();
  try {
    topic(f);
    const q = question(f, 's1', 'q', { choices: ['Approve'], allowFreeform: false });
    classify(f, [q], ['topic']);
    const input = f.service.accept({ requestId: 'answer', text: ' Approve ' });
    batch(f);
    assert.throws(() => f.service.dispatch(f.identities.coordinator, {
      items: [{ topicId: 'topic', prompt: 'Approve' }],
    }), { code: 'ANSWER_NOT_VERBATIM' });
    assert.throws(() => f.service.dispatch(f.identities.coordinator, {
      items: [{ topicId: 'topic', prompt: input.message.raw }],
    }), { code: 'FREEFORM_FORBIDDEN' });
    assert.equal(f.db.list('deliveries').items.length, 0);
  } finally { f.close(); }
});

test('a disappeared or replaced ask never answers the replacement or replays the frozen dispatch', async () => {
  for (const replacement of [false, true]) {
    const f = fixture();
    try {
      const result = answer(f, 'Please explain the tradeoff first.');
      f.service.grantConsumer(f.identities.coordinator, f.service.activeBatch()!);
      const replacementAsk = { requestId: 'replacement', question: 'Unrelated new choice?', choices: ['Other'], allowFreeform: true };
      f.metas.get('s1')!.ask = replacement ? replacementAsk : null;
      await f.runtime.wake();
      assert.equal(f.db.must('deliveries', result.delivery.id).state, 'rejected');
      assert.equal(f.db.must('questions', result.q.id).state, 'stale');
      assert.equal(f.calls.some(call => call.name === 'answer'), false);
      assert.equal(f.calls.some(call => call.name === 'prompt'
        && (call.body as { sessionId: string }).sessionId === 's1'), false);
      assert.throws(() => f.service.dispatch(f.identities.coordinator, result.dispatch), /retired batch/);
      await f.runtime.wake();
      assert.equal(f.db.find('deliveries', item => item.messageId === result.input.message.id).length, 1);
      assert.equal(f.db.must('deliveries', result.delivery.id).state, 'rejected');
      assert.equal(f.db.must('messages', result.input.message.id).raw, result.input.message.raw);
    } finally { f.close(); }
  }
});

test('definite callback rejection and unknown acknowledgment remain distinct and never resend automatically', async () => {
  for (const uncertain of [false, true]) {
    const f = fixture();
    try {
      const result = answer(f, 'What is the expected impact?');
      let attempts = 0;
      f.native.answer = async () => {
        attempts++;
        if (uncertain) throw new Error('Lost native acknowledgment');
        return { accepted: false, result: { ok: false } };
      };
      await f.runtime.wake();
      assert.equal(f.db.must('deliveries', result.delivery.id).state, uncertain ? 'unknown' : 'rejected');
      await f.runtime.wake();
      f.service.recover();
      await f.runtime.wake();
      assert.equal(attempts, 1);
      assert.equal(f.db.find('deliveries', item => item.messageId === result.input.message.id).length, 1);
      assert.equal(f.db.must('operations', 'input:natural-answer').state, 'accepted');
    } finally { f.close(); }
  }
});

test('session retirement cancels only unsent answers and preserves uncertain or completed effects', async () => {
  for (const change of ['deleted', 'internal'] as const) {
    for (const state of ['pending', 'calling', 'accepted', 'unknown'] as const) {
      const f = fixture();
      try {
        const result = answer(f, 'Please explain before proceeding.');
        f.db.put('deliveries', { ...result.delivery, state });
        if (change === 'deleted') f.metas.delete('s1');
        else f.metas.get('s1')!.appliedRoles = [{
          moduleId: 'assistant', roleId: 'coordinator', moduleName: 'Assistant', name: 'coordinator',
        }];
        await f.runtime.wake('s1');
        const delivery = f.db.must('deliveries', result.delivery.id);
        assert.equal(delivery.state, state === 'pending' ? 'cancelled' : state);
        if (state === 'pending') assert.equal(delivery.error,
          change === 'deleted' ? 'Target no longer exists' : 'Target is an internal role carrier');
        assert.equal(f.db.must('questions', result.q.id).state, 'unknown');
        assert.equal(f.calls.some(call => call.name === 'answer'), false);
        assert.equal(f.calls.some(call => call.name === 'prompt'
          && (call.body as { sessionId: string }).sessionId === 's1'), false);
        assert.equal(inputReceipt(f.service, 'natural-answer').input.text, result.input.message.raw);
        await f.runtime.wake('s1');
        assert.equal(f.db.must('deliveries', delivery.id).state, delivery.state);
      } finally { f.close(); }
    }
  }
});

test('pending or uncertain answers cannot be duplicated by a later input batch', () => {
  for (const state of ['pending', 'calling', 'accepted', 'unknown'] as const) {
    const f = fixture();
    try {
      const result = answer(f, 'Please explain before making a decision.');
      f.db.put('deliveries', { ...result.delivery, state });
      f.service.finishBatch(result.current.id, 'finished');
      const next = f.service.accept({ requestId: 'second-answer', text: 'Approve' });
      batch(f);
      assert.throws(() => f.service.dispatch(f.identities.coordinator, {
        items: [{ topicId: 'implementation', prompt: 'Approve' }],
      }), { code: 'ASK_IN_FLIGHT' });
      assert.equal(f.db.must('work', next.work.id).state, 'leased');
      assert.equal(f.db.find('deliveries', item => item.kind === 'ask').length, 1);
      assert.equal(f.db.must('deliveries', result.delivery.id).state, state);
    } finally { f.close(); }
  }
});

test('semantic routing rejects untrusted role identities and legacy explicit reply fields', () => {
  const f = fixture();
  try {
    topic(f);
    f.service.accept({ requestId: 'new', text: 'Comment' });
    batch(f);
    for (const identity of [f.identities.memory, { ...f.identities.coordinator, subagent: true },
      { ...f.identities.coordinator, runtimeSessionId: 'different' }]) {
      assert.throws(() => f.service.dispatch(identity, { items: [{ topicId: 'topic', prompt: 'Comment' }] }),
        /Internal agents|ready current role/);
    }
    for (const fields of [{ replyTo: 'old-anchor' }, { replyTo: null }, { topicId: 'topic' }]) {
      assert.equal(inputSchema.safeParse({ requestId: 'new', text: 'Comment', ...fields }).success, false);
    }
    assert.equal(f.db.list('deliveries').items.length, 0);
  } finally { f.close(); }
});
