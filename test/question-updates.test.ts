import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { fixture, stageDelivery } from './fixtures.ts';
import { questionKey } from '../src/service.ts';
import { timeline, timelineItem } from '../src/ui.ts';
import { publicationStream } from '../src/stream.ts';
import { conversationItems } from '../frontend/timeline.ts';

function setup() {
  const f = fixture();
  const request = { requestId: 'actual-ask', question: 'Pick a color', choices: ['blue', 'green'], allowFreeform: false };
  f.metas.get('s1')!.ask = request;
  f.db.transaction(() => f.service.syncQuestions('s1', [request], true));
  const question = f.db.must('questions', questionKey('s1', request.requestId));
  const work = f.db.must('work', `message:${question.messageId}:1`);
  f.db.put('work', { ...work, state: 'done' });
  const delivery = stageDelivery(f, { kind: 'ask', requestId: request.requestId, text: 'blue', answerFreeform: false });
  const original = timeline(f.service, undefined, undefined, 100);
  const originalQuestion = original.items.find(item => item.messageId === question.messageId)!;
  assert.equal(originalQuestion.question!.state, 'pending');
  return { ...f, question, delivery, original, originalQuestion };
}

test('successful native answer emits a live question patch without reloading or publishing a second question', async t => {
  const f = setup(); t.after(() => f.close());
  const answer = f.native.answer;
  f.native.answer = async (...args) => {
    const result = await answer(...args);
    f.metas.get('s1')!.ask = null;
    return result;
  };
  const controller = new AbortController(); t.after(() => controller.abort());
  const stream = publicationStream(f.service, f.original.watermark, controller.signal,
    publication => timelineItem(f.service, publication));
  assert.ok(stream.body instanceof Readable);
  const iterator = stream.body[Symbol.asyncIterator]();
  await f.runtime.wake();
  const frame = String((await iterator.next()).value);
  assert.match(frame, /"state":"answered","stateVersion":2/);
  assert.ok(frame.includes(`"messageId":"${f.question.messageId}"`));
  controller.abort(); await iterator.return?.();
  const delta = timeline(f.service, undefined, f.original.watermark, 100);
  const update = delta.items.find(item => item.messageId === f.question.messageId)!;
  assert.equal(update.type, 'status');
  assert.deepEqual(update.question, { state: 'answered', stateVersion: 2, choices: ['blue', 'green'], allowFreeform: false });
  const projected = conversationItems([...f.original.items, ...delta.items]);
  const question = projected.find(item => item.messageId === f.question.messageId)!;
  assert.equal(question.id, f.originalQuestion.id);
  assert.equal(question.question!.state, 'answered');
  assert.equal(projected.filter(item => item.messageId === f.question.messageId).length, 1);
  assert.equal(f.originalQuestion.question!.state, 'pending', 'the cached original was not refetched');
  await f.runtime.wake('s1');
  assert.equal(f.calls.filter(call => call.name === 'answer').length, 1);
  assert.equal(f.db.find('publications', p => p.messageId === f.question.messageId && p.type === 'status').length, 1);
});

test('unknown native answer emits a disabled question patch and a still-present callback does not reopen it', async t => {
  const f = setup(); t.after(() => f.close());
  f.fail(new Error('Lost answer acknowledgement'));
  await f.runtime.wake();
  f.fail(null);
  await f.runtime.wake('s1');
  const delta = timeline(f.service, undefined, f.original.watermark, 100);
  const projected = conversationItems([...f.original.items, ...delta.items]);
  assert.equal(projected.find(item => item.messageId === f.question.messageId)!.question!.state, 'unknown');
  assert.equal(f.db.must('questions', f.question.id).stateVersion, 2);
  assert.equal(f.db.must('deliveries', f.delivery.id).state, 'unknown');
  assert.equal(f.metas.get('s1')!.ask!.requestId, 'actual-ask');
  assert.equal(f.calls.filter(call => call.name === 'answer').length, 1);
});

test('definitely rejected answers reconcile the original callback and never repeat the rejected send', async () => {
  for (const stillPending of [true, false]) {
    const f = setup();
    try {
      const answer = f.native.answer;
      f.native.answer = async (...args) => {
        await answer(...args);
        if (!stillPending) f.metas.get('s1')!.ask = null;
        return { accepted: false, result: { ok: false } };
      };
      await f.runtime.wake();
      const delta = timeline(f.service, undefined, f.original.watermark, 100);
      const question = conversationItems([...f.original.items, ...delta.items])
        .find(item => item.messageId === f.question.messageId)!;
      assert.equal(question.question!.state, stillPending ? 'pending' : 'stale');
      assert.equal(f.db.must('deliveries', f.delivery.id).state, 'rejected');
      await f.runtime.wake('s1');
      assert.equal(f.calls.filter(call => call.name === 'answer').length, 1);
    } finally { f.close(); }
  }
});

test('question state and publication commit atomically, including unknown recovery after an interrupted answer', async t => {
  const f = setup(); t.after(() => f.close());
  const publish = f.service.publish.bind(f.service);
  f.service.publish = () => { throw new Error('Publication write failed'); };
  assert.throws(() => f.db.transaction(() =>
    f.service.questionState(f.db.must('questions', f.question.id), 'answered')), /Publication write failed/);
  assert.equal(f.db.must('questions', f.question.id).state, 'pending');
  assert.equal(f.db.must('questions', f.question.id).stateVersion, 1);
  f.service.publish = publish;
  f.db.put('deliveries', { ...f.delivery, state: 'calling' });
  f.service.recover();
  const delta = timeline(f.service, undefined, f.original.watermark, 100);
  assert.equal(conversationItems([...f.original.items, ...delta.items])
    .find(item => item.messageId === f.question.messageId)!.question!.state, 'unknown');
  assert.equal(f.db.must('deliveries', f.delivery.id).state, 'unknown');
  await f.runtime.wake('s1');
  assert.equal(f.calls.filter(call => call.name === 'answer').length, 0);
});

test('restoring an unavailable but unanswered question emits its new pending state', t => {
  const f = setup(); t.after(() => f.close());
  f.db.transaction(() => f.service.syncQuestions('s1', [], false));
  const unavailable = timeline(f.service, undefined, undefined, 100);
  assert.equal(unavailable.items.find(item => item.messageId === f.question.messageId)!.question!.state, 'unknown');
  f.db.transaction(() => f.service.syncQuestions('s1', [f.question.request], true));
  const delta = timeline(f.service, undefined, unavailable.watermark, 100);
  const question = conversationItems([...unavailable.items, ...delta.items])
    .find(item => item.messageId === f.question.messageId)!;
  assert.equal(question.question!.state, 'pending');
  assert.equal(question.question!.stateVersion, 3);
});
