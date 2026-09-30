import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationItems, mergeSnapshots } from '../frontend/timeline.ts';
import type { TimelineItem } from '../src/ui-types.ts';

const item = (sequence: number, patch: Partial<TimelineItem> = {}): TimelineItem => ({
  id: `m${sequence}`, messageId: `m${sequence}`, sequence, snapshotRevision: sequence,
  type: 'message', topicId: 'topic', text: `message ${sequence}`, attachments: [], createdAt: sequence,
  clarifications: [], diagnostic: null, deliveryIssues: [],
  topicTitle: 'Travel', speaker: 'assistant', sessionId: 'reception', question: null, ...patch,
});

test('conversation filters system snapshots and preserves original display order rather than revision order', () => {
  const records = [item(4, { snapshotRevision: 40 }), item(2, { speaker: 'system' }),
    item(3, { type: 'question', question: { state: 'pending', stateVersion: 1, requestId: 'ask-3' } }), item(1, { snapshotRevision: 90 })];
  assert.deepEqual(conversationItems(records).map(entry => entry.sequence), [1, 3, 4]);
});

test('complete snapshots replace corrected source and attachments in place, never add a second bubble', () => {
  const original = item(1);
  const corrected = { ...original, snapshotRevision: 20, text: 'Corrected original',
    attachments: [{ type: 'file' as const, path: '/corrected.txt' }] };
  const visible = conversationItems([original, item(2), corrected, original, corrected]);
  assert.equal(visible.length, 2);
  assert.equal(visible[0]!.id, original.id);
  assert.equal(visible[0]!.sequence, original.sequence);
  assert.equal(visible[0]!.text, corrected.text);
  assert.deepEqual(visible[0]!.attachments, corrected.attachments);
  assert.equal(original.text, 'message 1');
});

test('one snapshot revision governs all fields, including clearing topic attribution and question state', () => {
  const question = item(1, { type: 'question', question: { state: 'pending', stateVersion: 3, requestId: 'ask-1', choices: ['A', 'B'] } });
  const newest = { ...question, snapshotRevision: 80, topicId: null, topicTitle: null,
    question: { state: 'answered' as const, stateVersion: 4, requestId: 'ask-1' } };
  const stale = { ...question, snapshotRevision: 50,
    question: { state: 'unknown' as const, stateVersion: 99, requestId: 'ask-1' } };
  const [visible] = conversationItems([newest, stale, question]);
  assert.equal(visible!.id, question.id);
  assert.equal(visible!.topicId, null);
  assert.equal(visible!.question?.state, 'answered');
  assert.equal(visible!.question?.choices, undefined);
});

test('user originals remain topicless when a clarification is attached in place', () => {
  const original = item(1, { speaker: 'user' });
  const clarification = { id: 'q1', question: 'Which city?', choices: [], allowFreeform: true,
    createdAt: 2, answer: null, answeredAt: null, requestId: null };
  const visible = conversationItems([original, { ...original, snapshotRevision: 3,
    clarifications: [clarification] }, item(2)]);
  assert.equal(visible.length, 2);
  assert.equal(visible[0]!.topicId, null);
  assert.equal(visible[0]!.topicTitle, null);
  assert.equal(visible[0]!.text, original.text);
  assert.deepEqual(visible[0]!.clarifications, [clarification]);
});

test('newer system snapshots hide previously visible messages, stale replays cannot resurrect them', () => {
  const original = item(1);
  assert.deepEqual(conversationItems([original, { ...original, snapshotRevision: 20, speaker: 'system' }, original]), []);
});

test('snapshot updates cannot change eternal display position', () => {
  assert.throws(() => mergeSnapshots([item(1), { ...item(1), sequence: 2, snapshotRevision: 20 }]), /显示顺序/);
});
