import assert from 'node:assert/strict';
import { test } from 'node:test';
import { timeline, timelineItem } from '../src/ui.ts';
import { AssistantService } from '../src/service.ts';
import { Database } from '../src/database.ts';
import { conversationItems } from '../frontend/timeline.ts';
import type { Message } from '../src/types.ts';

function fixture(kind: Message['kind']) {
  const db = new Database(':memory:');
  const service = new AssistantService(db, () => 1000);
  const message: Message = kind === 'user' ? service.accept({ requestId: 'original',
    text: 'Complete original wording', attachments: [{ type: 'file', path: '/synthetic/file.txt' }] }, 'foreground').message : {
    id: 'original', kind, raw: 'Complete original wording', attachments: [{ type: 'file', path: '/synthetic/file.txt' }],
    sessionId: 'reception', nativeEventId: 'native-event', nativeMessageId: 'native-message',
    sequence: 1, revision: 1, createdAt: 1, processed: false, excluded: false, diagnostic: null,
    question: null, clarification: null, clarificationHistory: [],
  };
  if (kind !== 'user') db.put('messages', message);
  return { message, service, db };
}

test('UI projects a genuine foreground user original without requiring a classification result', t => {
  const { message, service, db } = fixture('user');
  t.after(() => db.close());
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

test('retained original worker messages are read only through legacy history, not foreground conversation', t => {
  const { message, service, db } = fixture('reply');
  t.after(() => db.close());
  assert.deepEqual(timeline(service, undefined, undefined, 50).items, []);
  const [archived] = timeline(service, undefined, undefined, 50, undefined, true).items;
  assert.equal(archived!.id, message.id);
  assert.equal(archived!.text, message.raw);
  assert.deepEqual(archived!.attachments, message.attachments);
  assert.equal(db.list('messages').items.length, 1);
  assert.equal(db.topicMessages(message.id).length, 0);
});
