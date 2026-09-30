import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationItems } from '../frontend/timeline.ts';
import type { TimelineItem } from '../src/ui-types.ts';

const item = (sequence: number, patch: Partial<TimelineItem> = {}): TimelineItem => ({
  id: `p${sequence}`, sequence, type: 'message', messageId: `m${sequence}`, topicId: 'topic',
  text: `message ${sequence}`, attachments: [], createdAt: sequence,
  sources: [{ messageId: `m${sequence}`, version: 1, assignmentVersion: 0 }],
  topicTitle: 'Travel', topicColor: '#2563eb', speaker: 'assistant', sessionId: 'reception', question: null, ...patch,
});

test('conversation includes only user/assistant speech and questions, never diagnostic publications', () => {
  const records = [
    item(1, { speaker: 'user' }), item(2, { type: 'status', text: 'Native wake accepted' }),
    item(3, { type: 'attribution' }), item(4, { type: 'correction' }),
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

test('original reply wins over rewritten publications at the original position', () => {
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
  assert.equal(visible[0]!.text, 'New source');
});

test('direct replay displays each original once, without topic labels on user speech', () => {
  const user = item(1, { speaker: 'user', text: 'Check the weather and this code' });
  const answer = item(2, { text: 'The original answer' });
  const clarification = item(3, { messageId: null, type: 'clarification', text: 'Which city?' });
  const visible = conversationItems([user, answer, clarification, user, answer, clarification]);
  assert.equal(visible.length, 3);
  assert.equal(visible[0]!.text, user.text);
  assert.equal(visible[0]!.topicId, null);
  assert.equal(visible[0]!.topicTitle, null);
  assert.equal(visible[0]!.topicColor, null);
  assert.equal(visible[1]!.text, answer.text);
  assert.equal(visible[1]!.topicTitle, 'Travel');
  assert.equal(visible[1]!.topicColor, '#2563eb');
});

test('attribution patches an already visible unclassified reply without a second bubble or changed source', () => {
  const reply = item(1, { topicId: null, topicTitle: null, topicColor: null,
    text: 'Original reply before classification', attachments: [{ type: 'file', path: '/original.txt' }] });
  assert.equal(conversationItems([reply])[0]!.topicTitle, null);
  const assignment = item(2, { type: 'attribution', speaker: 'system', messageId: reply.messageId,
    text: 'Internal classification progress', topicAssignmentVersion: 1 });
  const visible = conversationItems([reply, assignment, assignment]);
  assert.equal(visible.length, 1);
  assert.equal(visible[0]!.id, reply.id);
  assert.equal(visible[0]!.sequence, reply.sequence);
  assert.equal(visible[0]!.createdAt, reply.createdAt);
  assert.equal(visible[0]!.text, reply.text);
  assert.deepEqual(visible[0]!.attachments, reply.attachments);
  assert.equal(visible[0]!.topicId, 'topic');
  assert.equal(visible[0]!.topicTitle, 'Travel');
  assert.equal(visible[0]!.topicColor, '#2563eb');
});

test('topic patches never mark original user input and do not inherit onto clarifications', () => {
  const user = item(1, { speaker: 'user', topicId: null, topicTitle: null, topicColor: null });
  const clarification = item(2, { type: 'clarification', messageId: user.messageId,
    text: 'Which city?', topicId: null, topicTitle: null, topicColor: null });
  const assignment = item(3, { type: 'attribution', messageId: user.messageId,
    speaker: 'system', topicAssignmentVersion: 1 });
  const visible = conversationItems([user, clarification, assignment]);
  assert.equal(visible.length, 2);
  for (const entry of visible) {
    assert.equal(entry.topicId, null);
    assert.equal(entry.topicTitle, null);
    assert.equal(entry.topicColor, null);
  }
});

test('fresh topic assignment snapshots beat stale cached patches regardless of publication order', () => {
  const reply = item(1, { topicId: 'latest', topicTitle: 'Latest topic', topicColor: '#059669',
    topicAssignmentVersion: 3 });
  const stale = item(3, { type: 'attribution', speaker: 'system', messageId: reply.messageId,
    topicAssignmentVersion: 2 });
  assert.equal(conversationItems([reply, stale])[0]!.topicId, 'latest');
  const removed = item(4, { type: 'attribution', speaker: 'system', messageId: reply.messageId,
    topicAssignmentVersion: 4, topicId: null, topicTitle: null, topicColor: null });
  const visible = conversationItems([reply, stale, removed]);
  assert.equal(visible[0]!.id, reply.id);
  assert.equal(visible[0]!.topicId, null);
  assert.equal(visible[0]!.topicTitle, null);
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
