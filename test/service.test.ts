import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, topic } from './fixtures.ts';

test('original input and request receipt are immutable, deduplicated, and never include split prompts', () => {
  const f = fixture();
  try {
    const input = { requestId: 'stable', text: '  Raw original\n', attachments: [{ type: 'file' as const, path: '/synthetic/input' }] };
    const receipt = f.service.accept(input);
    assert.equal(f.service.accept(input).message.id, receipt.message.id);
    assert.deepEqual(receipt.input, input);
    assert.throws(() => f.service.accept({ ...input, text: 'changed' }), /request changed/);
    for (const edit of [{ raw: 'changed' }, { attachments: [] }, { sequence: 99 }, { sessionId: 's1' }])
      assert.throws(() => f.db.put('messages', { ...receipt.message, ...edit }), /cannot change/);
    topic(f);
    f.service.complete({ messageId: receipt.message.id, items: [{ topicId: 'topic', prompt: 'Relevant split' }] });
    const saved = f.db.must('messages', receipt.message.id);
    assert.equal(saved.raw, input.text);
    for (const key of ['topicIds','dispatches','coordinator','work','batch']) assert.equal(key in saved, false);
    assert.deepEqual(f.service.receipt(saved).input, input);
  } finally { f.close(); }
});
test('complete result transaction rolls back definitions, mapping, associations and processed on any error', () => {
  const f = fixture();
  try {
    const message = f.service.accept({ requestId: 'atomic', text: 'A and B' }).message;
    topic(f, 'a', 's1');
    const watermark = f.db.watermark;
    assert.throws(() => f.service.complete({ messageId: message.id,
      topics: [{ topicId: 'a', title: 'Changed', content: 'changed', sessionId: 's2' }],
      items: [{ topicId: 'a', prompt: 'A' }, { topicId: 'missing', prompt: 'B' }] }), /record not found/);
    assert.equal(f.db.must('topics', 'a').title, 'a');
    assert.equal(f.db.must('topics', 'a').sessionId, 's1');
    assert.equal(f.db.topicMessages(message.id).length, 0);
    assert.equal(f.db.must('messages', message.id).processed, false);
    assert.equal(f.db.watermark, watermark);
    const result = f.service.complete({ messageId: message.id,
      topics: [{ topicId: 'b', title: 'B', content: 'B' }],
      items: [{ topicId: 'a', prompt: 'A' }, { topicId: 'b', prompt: 'B' }] });
    assert.equal(result.message.processed, true);
    assert.equal(result.topicMessages.length, 2);
    assert.equal(result.topicMessages.every(row => row.state === 'pending'), true);
  } finally { f.close(); }
});
test('completed results are idempotent and never reapplied, even when a newer decision differs', () => {
  const f = fixture();
  try {
    const message = f.service.accept({ requestId: 'done', text: 'Original' }).message;
    topic(f);
    const value = { messageId: message.id, items: [{ topicId: 'topic', prompt: 'Prompt' }] };
    f.service.complete(value);
    const revision = f.db.watermark;
    assert.equal(f.service.complete({ ...value, topics: [{ topicId: 'topic', title: 'Changed', content: '' }] }).alreadyProcessed, true);
    assert.equal(f.db.watermark, revision);
    assert.equal(f.db.must('topics', 'topic').title, 'topic');
    assert.equal(f.db.topicMessages(message.id).length, 1);
  } finally { f.close(); }
});
test('session association neither copies nor rewrites native reply, and only new topics adopt the source', () => {
  const f = fixture();
  try {
    topic(f, 'existing', 's1');
    const source = f.service.addMessage({ kind: 'reply', raw: 'I mention existing and introduce a new topic.',
      attachments: [], sessionId: 's2', nativeMessageId: 'native' });
    assert.throws(() => f.service.complete({ messageId: source.id, items: [{ topicId: 'existing', prompt: 'Rewrite' }] }), /must not copy/);
    f.service.complete({ messageId: source.id, topics: [{ topicId: 'new', title: 'New', content: '' }],
      items: [{ topicId: 'existing' }, { topicId: 'new' }] });
    assert.equal(f.db.must('topics', 'existing').sessionId, 's1');
    assert.equal(f.db.must('topics', 'new').sessionId, 's2');
    for (const row of f.db.topicMessages(source.id)) {
      assert.equal(row.origin, 'session'); assert.equal(row.prompt, null); assert.equal(row.state, null);
    }
    assert.equal(f.db.must('messages', source.id).raw, source.raw);
  } finally { f.close(); }
});
test('explicit native handoff can remap only a real affected topic, not arbitrary Task/general subtask prose', () => {
  const f = fixture();
  try {
    topic(f);
    const source = f.service.addMessage({ kind: 'reply', raw: 'I created/assigned session s2 to handle this topic.',
      attachments: [], sessionId: 's1', nativeMessageId: 'handoff' });
    f.service.complete({ messageId: source.id, topics: [{ topicId: 'topic', title: 'topic', content: '', sessionId: 's2' }],
      items: [{ topicId: 'topic' }] });
    assert.equal(f.db.must('topics', 'topic').sessionId, 's2');
    const vague = f.service.addMessage({ kind: 'reply', raw: 'Task abc owns a general subtask.', attachments: [],
      sessionId: 's1', nativeMessageId: 'vague' });
    assert.throws(() => f.service.complete({ messageId: vague.id,
      topics: [{ topicId: 'topic', title: 'topic', content: '', sessionId: 's1' }],
      items: [{ topicId: 'topic' }] }), /explicitly identify/);
  } finally { f.close(); }
});
test('a source-local question leaves raw and processed untouched, skips waiting work, and preserves its answer', () => {
  const f = fixture();
  try {
    const first = f.service.accept({ requestId: 'first', text: 'Ambiguous raw' }).message;
    const second = f.service.accept({ requestId: 'second', text: 'Clear raw' }).message;
    const q = f.service.clarify({ messageId: first.id, question: 'Which?', choices: ['A','B'], allowFreeform: false }).clarification;
    assert.equal(f.db.must('messages', first.id).processed, false);
    assert.equal(f.db.eligible()!.id, second.id);
    assert.throws(() => f.service.answerClarification(first.id, q.id, { requestId: 'answer', answer: 'not offered' }), /exact offered/);
    const result = f.service.answerClarification(first.id, q.id, { requestId: 'answer', answer: 'A' });
    assert.equal(result.clarification.answer, 'A');
    assert.equal(f.db.eligible()!.id, first.id);
    assert.equal(f.db.must('messages', first.id).processed, false);
    assert.equal(f.db.must('messages', first.id).raw, 'Ambiguous raw');
    assert.equal(f.db.find('messages', () => true).length, 2);
    topic(f);
    f.service.complete({ messageId: first.id, items: [{ topicId: 'topic', prompt: 'Clarified raw A' }] });
    assert.equal(f.db.must('messages', first.id).clarificationHistory[0]!.answer, 'A');
  } finally { f.close(); }
});
test('clarification exact identity, duplicate receipts, stale question and changed request are explicit', () => {
  const f = fixture();
  try {
    const m = f.service.accept({ requestId: 'q', text: 'Raw' }).message;
    const q1 = f.service.clarify({ messageId: m.id, question: 'First?' }).clarification;
    const answer = { requestId: 'a1', answer: 'First answer' };
    f.service.answerClarification(m.id, q1.id, answer);
    assert.equal(f.service.answerClarification(m.id, q1.id, answer).clarification.requestId, 'a1');
    const q2 = f.service.clarify({ messageId: m.id, question: 'Second?' }).clarification;
    assert.equal(f.service.answerClarification(m.id, q1.id, answer).clarification.id, q1.id);
    assert.equal(f.db.must('messages', m.id).clarification!.id, q2.id);
    assert.throws(() => f.service.answerClarification(m.id, q1.id, { requestId: 'different', answer: 'late' }), /no longer waiting/);
    assert.throws(() => f.service.answerClarification(m.id, q2.id, { requestId: 'a1', answer: 'First answer' }), /already names another/);
    assert.throws(() => f.service.answerClarification(m.id, 'not-this-question', answer), /does not belong/);
    assert.throws(() => f.service.answerClarification(m.id, q1.id, { ...answer, answer: 'Changed' }), /already names another/);
  } finally { f.close(); }
});
test('original text, local question, literal choices, answers and split prompts preserve whitespace exactly', () => {
  const f = fixture();
  try {
    const raw = ' \tOriginal wording\r\n trailing  ';
    const literal = ' \tLiteral choice A\n  ';
    const question = '  Which literal choice?\n ';
    const receipt = f.service.accept({ requestId: 'exact-wording', text: raw });
    assert.equal(receipt.input.text, raw);
    assert.equal(receipt.message.raw, raw);
    const card = f.service.clarify({ messageId: receipt.message.id, question, choices: [literal], allowFreeform: false }).clarification;
    assert.equal(card.question, question);
    assert.deepEqual(card.choices, [literal]);
    assert.throws(() => f.service.answerClarification(receipt.message.id, card.id,
      { requestId: 'trimmed-choice', answer: literal.trim() }), /exact offered/);
    const answer = { requestId: 'literal-answer', answer: literal };
    assert.equal(f.service.answerClarification(receipt.message.id, card.id, answer).clarification.answer, literal);
    assert.equal(f.service.answerClarification(receipt.message.id, card.id, answer).clarification.answer, literal);
    topic(f);
    const result = f.service.complete({ messageId: receipt.message.id, items: [{ topicId: 'topic', prompt: literal }] });
    assert.equal(result.topicMessages[0]!.prompt, literal);
    assert.equal(result.message.clarificationHistory[0]!.answer, literal);
    assert.equal(f.service.receipt(result.message).input.text, raw);
  } finally { f.close(); }
});
