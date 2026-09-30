import assert from 'node:assert/strict';
import { test } from 'node:test';
import { timelineItem } from '../src/ui.ts';
import type { AssistantService } from '../src/service.ts';
import type { Message, Publication, Topic } from '../src/types.ts';

function fixture(kind: Message['kind']) {
  const message: Message = {
    id: 'original', kind, raw: 'Complete original wording', attachments: [{ type: 'file', path: '/synthetic/file.txt' }],
    version: 1, topicId: kind === 'user' ? null : 'topic', assignmentVersion: 0, assignmentReason: null,
    sessionId: kind === 'user' ? null : 'reception', nativeEventId: null, nativeMessageId: null,
    nativeParentId: null, correlation: 'unknown', historical: false, sequence: 1, createdAt: 1,
  };
  const topic: Topic = { id: 'topic', title: 'Weather', content: 'Forecast', color: '#2563eb',
    sessionId: 'reception', archived: false, version: 1, dirtyThrough: 0, memoryThrough: 0 };
  const publication: Publication = { id: 'publication', sequence: 1, type: 'message', messageId: message.id,
    topicId: topic.id, text: 'A rewritten legacy summary', attachments: [], sources: [], createdAt: 1 };
  const service = { db: {
    get(table: string, id: string) {
      if (table === 'messages' && id === message.id) return message;
      if (table === 'topics' && id === topic.id) return topic;
      return undefined;
    },
    forMessage: () => ({ items: [] }),
  } } as unknown as AssistantService;
  return { message, topic, publication, service };
}

test('UI projection shows original input and attachments without an inherited legacy topic label', () => {
  const { message, publication, service } = fixture('user');
  const item = timelineItem(service, publication);
  assert.equal(item.text, message.raw);
  assert.deepEqual(item.attachments, message.attachments);
  assert.equal(item.speaker, 'user');
  assert.equal(item.topicId, null);
  assert.equal(item.topicTitle, null);
  assert.equal(item.topicColor, null);
  assert.equal(publication.text, 'A rewritten legacy summary', 'projection does not rewrite stored history');
});

test('UI projection shows full original reply with stable topic color across title changes and corrections', () => {
  const { message, topic, publication, service } = fixture('reply');
  const item = timelineItem(service, publication);
  assert.equal(item.text, message.raw);
  assert.deepEqual(item.attachments, message.attachments);
  assert.equal(item.speaker, 'assistant');
  assert.equal(item.topicTitle, topic.title);
  assert.equal(item.topicColor, topic.color);
  topic.title = 'Hangzhou weather';
  message.raw = 'Corrected complete original reply';
  message.version++;
  const corrected = timelineItem(service, publication);
  assert.equal(corrected.topicTitle, topic.title);
  assert.equal(corrected.topicColor, item.topicColor);
  assert.equal(corrected.text, message.raw);
  assert.equal(corrected.revision?.version, 2);
});

test('a raw reply starts without a topic and the same publication reflects later assignment', () => {
  const { message, topic, publication, service } = fixture('reply');
  message.topicId = null;
  publication.topicId = null;
  const initial = timelineItem(service, publication);
  assert.equal(initial.text, message.raw);
  assert.equal(initial.topicId, null);
  assert.equal(initial.topicTitle, null);
  assert.equal(initial.topicColor, null);
  message.topicId = topic.id;
  message.assignmentVersion = 1;
  const refreshed = timelineItem(service, publication);
  assert.equal(refreshed.id, initial.id);
  assert.equal(refreshed.sequence, initial.sequence);
  assert.equal(refreshed.topicId, topic.id);
  assert.equal(refreshed.topicAssignmentVersion, 1);
  const patch = timelineItem(service, { ...publication, id: 'assignment', sequence: 2,
    type: 'attribution', topicId: topic.id, text: 'Classified' });
  assert.equal(patch.topicColor, topic.color);
  assert.equal(patch.topicAssignmentVersion, 1);
  assert.equal(patch.revision?.text, message.raw);
  assert.equal(patch.speaker, 'system');
});

test('UI projection leaves clarification and status wording separate from original source text', () => {
  const { publication, service } = fixture('user');
  const clarification = timelineItem(service, { ...publication, type: 'clarification', text: 'Which city?' });
  const status = timelineItem(service, { ...publication, type: 'status', text: 'Internal progress' });
  assert.equal(clarification.text, 'Which city?');
  assert.equal(clarification.speaker, 'assistant');
  assert.equal(clarification.revision, undefined);
  assert.equal(status.text, 'Internal progress');
  assert.equal(status.speaker, 'system');
});
