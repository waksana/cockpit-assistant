import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, topic, stageDelivery } from './fixtures.ts';
import { askAnswer } from '../src/service.ts';

test('native optional ask fields normalize without weakening real identity or content conflicts', () => {
  const f = fixture();
  try {
    const request = { requestId: 'same-ask', question: '  Which project?\n', choices: undefined, allowFreeform: undefined };
    const original = f.service.question('s1', request)!;
    for (const equivalent of [request, { requestId: request.requestId, question: request.question },
      { ...request, choices: [], allowFreeform: true }]) {
      const revision = f.db.must('messages', original.id).revision;
      assert.equal(f.service.question('s1', equivalent)!.id, original.id);
      const saved = f.db.must('messages', original.id);
      assert.equal(saved.revision, revision); assert.equal(saved.raw, request.question);
      assert.doesNotThrow(() => f.db.put('messages', { ...saved, question: { ...saved.question!, request: equivalent } }));
      assert.equal(f.db.must('messages', original.id).question!.request.allowFreeform, undefined);
    }
    for (const changed of [{ ...request, question: 'Changed question' },
      { ...request, choices: ['First', 'Second'] }, { ...request, allowFreeform: false }])
      assert.throws(() => f.service.question('s1', changed), { code: 'NATIVE_ID_CONFLICT' });
    const saved = f.db.must('messages', original.id);
    assert.throws(() => f.db.put('messages', { ...saved,
      question: { ...saved.question!, request: { ...request, requestId: 'different-native-ask' } } }),
      { code: 'IMMUTABLE_ORIGINAL' });
    const choices = f.service.question('s2', { requestId: 'ordered', question: 'Choose', choices: ['A', 'B'] })!;
    assert.throws(() => f.service.question('s2', { ...choices.question!.request, choices: ['B', 'A'] }),
      { code: 'NATIVE_ID_CONFLICT' });
  } finally { f.close(); }
});
test('original HTTP input fingerprint is immutable and independent from dispatch facts', () => {
  const f = fixture();
  try {
    const input = { requestId: 'human', text: '  faithful original\n' };
    const receipt = f.service.accept(input, 'coordinator');
    assert.equal(f.service.accept(input, 'other').message.id, receipt.message.id);
    assert.throws(() => f.service.accept({ ...input, text: 'changed' }, 'coordinator'), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.equal(receipt.message.conversation!.channel, 'user');
    assert.equal(f.db.record('foreground_inputs', receipt.message.id)!.state, 'pending');
    assert.equal(f.db.record('foreground_inputs', receipt.message.id)!.text, null);
    assert.throws(() => f.db.put('messages', { ...receipt.message, raw: 'rewritten' }), { code: 'IMMUTABLE_ORIGINAL' });
  } finally { f.close(); }
});
test('one accepted genuine human input has one frozen multi-topic dispatch, never append or notification work', () => {
  const f = fixture();
  try {
    topic(f, 'one'); topic(f, 'two', 's2');
    const staged = stageDelivery(f, 'human', ['one', 'two']);
    const root = f.db.record('foreground_inputs', staged.message.id)!;
    const input = { items: [{ topicId: 'one', prompt: 'Faithful one prompt' }, { topicId: 'two', prompt: 'Faithful two prompt' }] };
    assert.deepEqual(f.service.dispatch(input, root), staged.topicMessages);
    assert.throws(() => f.service.dispatch({ items: [{ topicId: 'one', prompt: 'extra followup' }] }, root),
      { code: 'FROZEN_DISPATCH' });
    for (const kind of ['notification', 'organizer'] as const)
      assert.throws(() => f.service.dispatch(input, { ...root, kind }), { code: 'HUMAN_REQUIRED' });
    assert.equal(f.db.must('messages', staged.message.id).raw, 'Original compound input');
    assert.equal(f.db.must('messages', staged.message.id).processed, false);
  } finally { f.close(); }
});
test('registry actions deduplicate native toolCallId and topic ids are service-generated', () => {
  const f = fixture();
  try {
    const staged = stageDelivery(f), root = f.db.record('foreground_inputs', staged.message.id)!;
    const input = { title: 'Architecture is a business topic', content: 'Route work, do not design here' };
    const created = f.service.topic(input, root, 'actual-tool');
    assert.equal(f.service.topic(input, root, 'actual-tool').id, created.id);
    assert.equal(created.version, 1);
    assert.throws(() => f.service.topic({ ...input, content: 'changed' }, root, 'actual-tool'), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.throws(() => f.service.topic(input, { ...root, kind: 'notification' }, 'notice-tool'), { code: 'HUMAN_REQUIRED' });
  } finally { f.close(); }
});
test('native choices remain exact and missing defaults do not bypass constraints', () => {
  assert.deepEqual(askAnswer({ requestId: 'ask', question: 'Pick', choices: ['Exact'], allowFreeform: false }, 'Exact', []),
    { answer: 'Exact', wasFreeform: false });
  assert.throws(() => askAnswer({ requestId: 'ask', question: 'Pick', choices: ['Exact'], allowFreeform: false }, 'exact', []),
    { code: 'ASK_CHOICE' });
  assert.deepEqual(askAnswer({ requestId: 'freeform', question: 'Tell me' }, 'Human reply', []),
    { answer: 'Human reply', wasFreeform: true });
});
