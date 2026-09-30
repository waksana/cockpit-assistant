import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, topic, toolIdentity, stageDelivery } from './fixtures.ts';
import { inputReceipt, timeline, timelineItem } from '../src/ui.ts';
import { publicationStream } from '../src/stream.ts';
test('main feed is only exact HTTP human originals and authenticated natural foreground output', async () => {
  const f = fixture();
  try {
    f.service.addMessage({ kind: 'reply', raw: 'Legacy preserved', sessionId: 's1', nativeEventId: 'legacy', attachments: [] });
    const input = await f.runtime.acceptReady({ requestId: 'human', text: 'What topics exist?' });
    const root = await f.runtime.authorize(toolIdentity(f, input.message.id));
    await f.event('coordinator', { id: 'front', type: 'assistant.message',
      data: { messageId: 'front-native', interactionId: root.interactionId, content: 'The registry contains no topics.' } });
    assert.deepEqual(timeline(f.service, undefined, undefined, 50).items.map(i => i.text),
      ['What topics exist?', 'The registry contains no topics.']);
    const snapshot = timeline(f.service, undefined, undefined, 50).items[1]!;
    assert.equal(snapshot.sessionId, 'coordinator'); assert.deepEqual(snapshot.clarifications, []);
    assert.equal(snapshot.id, snapshot.messageId);
    assert.deepEqual(timeline(f.service, undefined, undefined, 50, undefined, true).items.map(i => i.text), ['Legacy preserved']);
    assert.equal(inputReceipt(f.service, 'human').message.id, input.message.id);
  } finally { f.close(); }
});
test('SSE current feed does not leak native notice or archived history user bubbles', async () => {
  const f = fixture(), controller = new AbortController();
  try {
    f.service.addMessage({ kind: 'reply', raw: 'Legacy body', sessionId: 's1', nativeEventId: 'old', attachments: [] });
    topic(f);
    await f.event('s1', { id: 'worker', type: 'assistant.message', data: { content: 'Worker body' } });
    const input = await f.runtime.acceptReady({ requestId: 'visible', text: 'Visible human' });
    const response = publicationStream(f.service, 0, controller.signal, m => timelineItem(f.service, m));
    const stream = response.body as AsyncIterable<string>;
    for await (const chunk of stream) {
      assert.equal(chunk.includes('Legacy body'), false); assert.equal(chunk.includes('New managed-worker'), false);
      assert.equal(chunk.includes('Worker body'), false); assert.equal(chunk.includes('Visible human'), true);
      assert.equal(chunk.includes(input.message.id), true);
      controller.abort(); break;
    }
  } finally { controller.abort(); f.close(); }
});
test('main user dispatch snapshots never add topic-title headers to the real original body', () => {
  const f = fixture();
  try {
    const input = stageDelivery(f);
    const item = timeline(f.service, undefined, undefined, 50).items[0]!;
    assert.equal(item.messageId, input.message.id);
    assert.equal(item.text, 'Original compound input');
    assert.equal(item.topicTitle, null);
    assert.deepEqual(item.clarifications, []);
  } finally { f.close(); }
});
