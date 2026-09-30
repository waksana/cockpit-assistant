import assert from 'node:assert/strict';
import { test } from 'node:test';
import { timelineItem } from '../src/ui.ts';
import { AssistantService } from '../src/service.ts';
import { Database } from '../src/database.ts';
import { conversationItems } from '../frontend/timeline.ts';
import type { Message, Topic } from '../src/types.ts';

function fixture(kind: Message['kind']) {
  const db = new Database(':memory:');
  const service = new AssistantService(db, () => 1000);
  const message: Message = kind === 'user' ? service.accept({ requestId: 'original',
    text: 'Complete original wording', attachments: [{ type: 'file', path: '/synthetic/file.txt' }] }).message : {
    id: 'original', kind, raw: 'Complete original wording', attachments: [{ type: 'file', path: '/synthetic/file.txt' }],
    sessionId: 'reception', nativeEventId: 'native-event', nativeMessageId: 'native-message',
    sequence: 1, revision: 1, createdAt: 1, processed: false, excluded: false, diagnostic: null,
    question: null, clarification: null, clarificationHistory: [],
  };
  const topic: Topic = { id: 'topic', title: 'Weather', content: 'Forecast',
    sessionId: 'reception', archived: false, version: 1, mappingState: 'bound',
    mappingError: null, creationReceipt: null };
  if (kind !== 'user') db.put('messages', message);
  db.put('topics', topic);
  return { message, topic, service, db };
}

test('UI projects a processed user original with its stable identity and no topic label', t => {
  const { message, service, db } = fixture('user');
  t.after(() => db.close());
  service.complete({ messageId: message.id, items: [{ topicId: 'topic', prompt: 'Faithful weather request' }] });
  const saved = db.must('messages', message.id);
  const [item] = conversationItems([timelineItem(service, saved)]);
  assert.ok(item);
  assert.equal(item.id, message.id);
  assert.equal(item.messageId, message.id);
  assert.equal(item.sequence, 1);
  assert.equal(item.snapshotRevision, saved.revision);
  assert.equal(item.text, message.raw);
  assert.deepEqual(item.attachments, message.attachments);
  assert.equal(item.speaker, 'user');
  assert.equal(item.topicId, null);
  assert.equal(item.topicTitle, null);
  assert.equal(Object.hasOwn(item, 'topicColor'), false);
  assert.equal(Object.hasOwn(saved, 'topicIds'), false);
});

test('multiple topic associations preserve the native original and only change its plain heading', t => {
  const { message, topic, service, db } = fixture('reply');
  t.after(() => db.close());
  db.put('topics', { ...topic, id: 'code', title: 'Code' });
  const initial = timelineItem(service, message);
  assert.equal(initial.topicTitle, null);
  service.complete({ messageId: message.id, items: [{ topicId: topic.id }, { topicId: 'code' }] });
  const assigned = timelineItem(service, db.must('messages', message.id));
  assert.equal(assigned.id, initial.id);
  assert.equal(assigned.sequence, initial.sequence);
  assert.equal(assigned.text, initial.text);
  assert.equal(assigned.topicTitle, '关于Weather和Code');
  assert.equal(Object.hasOwn(assigned, 'topicColor'), false);
  assert.ok(assigned.snapshotRevision > initial.snapshotRevision);
  assert.equal(db.list('messages').items.length, 1);
  assert.ok(db.topicMessages(message.id).every(row => row.prompt === null && row.state === null));
});
