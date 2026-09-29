import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationItems } from '../frontend/timeline.ts';
import type { TimelineItem } from '../src/ui-types.ts';

const item = (sequence: number, patch: Partial<TimelineItem> = {}): TimelineItem => ({
  id: `p${sequence}`, sequence, type: 'message', messageId: `m${sequence}`, topicId: 'topic',
  text: `message ${sequence}`, attachments: [], anchorId: null, createdAt: sequence,
  sources: [{ messageId: `m${sequence}`, version: 1, assignmentVersion: 0 }],
  topicTitle: 'Metadata only', speaker: 'assistant', sessionId: 'reception', question: null, ...patch,
});

test('conversation includes only user/assistant speech and questions, never diagnostic publications', () => {
  const records = [
    item(1, { speaker: 'user' }), item(2, { type: 'status', text: 'Native wake accepted' }),
    item(3, { type: 'risk' }), item(4, { type: 'correction' }),
    item(5, { speaker: 'system' }), item(6),
    item(7, { type: 'question', question: { state: 'pending', stateVersion: 1 } }),
    item(8, { type: 'clarification', text: 'Which project?' }),
  ];
  assert.deepEqual(conversationItems(records).map(entry => entry.sequence), [1, 6, 7, 8]);
  assert.equal(records.length, 8);
});

test('hidden correction updates source body and attachments without an extra message or identity change', () => {
  const original = item(1, { speaker: 'user' });
  const clarification = item(2, { messageId: 'm1', type: 'clarification', text: 'Which project?' });
  const correction = item(3, { messageId: 'm1', type: 'correction', speaker: 'system',
    revision: { version: 2, text: 'Corrected message', attachments: [{ type: 'file', path: '/corrected.txt' }] } });
  const visible = conversationItems([original, clarification, correction]);
  assert.deepEqual(visible.map(entry => entry.sequence), [1, 2]);
  assert.equal(visible[0]!.id, original.id);
  assert.equal(visible[0]!.text, 'Corrected message');
  assert.deepEqual(visible[0]!.attachments, [{ type: 'file', path: '/corrected.txt' }]);
  assert.equal(visible[1]!.text, 'Which project?');
  assert.equal(original.text, 'message 1');
});

test('newer published summary wins at the original position; stale correction cannot undo it', () => {
  const original = item(1);
  const correction = item(2, { messageId: 'm1', type: 'correction', speaker: 'system',
    revision: { version: 2, text: 'New source', attachments: [] } });
  const summary = item(3, { messageId: 'm1', text: 'New published summary',
    sources: [{ messageId: 'm1', version: 2, assignmentVersion: 0 }],
    revision: { version: 2, text: 'New source', attachments: [] } });
  const classification = item(4, { messageId: 'm1', type: 'correction', speaker: 'system',
    revision: { version: 2, text: 'New source', attachments: [] } });
  const visible = conversationItems([original, correction, summary, classification]);
  assert.equal(visible.length, 1);
  assert.equal(visible[0]!.id, original.id);
  assert.equal(visible[0]!.sequence, 1);
  assert.equal(visible[0]!.text, 'New published summary');
});

test('question lifecycle updates its choices in place without showing status bubbles', () => {
  const question = item(1, { type: 'question', question: { state: 'pending', stateVersion: 1, choices: ['A', 'B'] } });
  const status = item(2, { messageId: 'm1', type: 'status', speaker: 'system',
    question: { state: 'stale', stateVersion: 2, choices: ['A', 'B'] } });
  const visible = conversationItems([question, status]);
  assert.equal(visible.length, 1);
  assert.equal(visible[0]!.question?.state, 'stale');
});

test('a freshly read older question snapshot wins over a higher-sequence cached stale state', () => {
  const question = item(1, { type: 'question',
    question: { state: 'pending', stateVersion: 3, choices: ['A', 'B'] } });
  const status = item(2, { messageId: 'm1', type: 'status', speaker: 'system',
    question: { state: 'unknown', stateVersion: 2, choices: ['A', 'B'] } });
  const visible = conversationItems([question, status]);
  assert.equal(visible.length, 1);
  assert.equal(visible[0]!.question?.state, 'pending');
  assert.equal(visible[0]!.question?.stateVersion, 3);
});
