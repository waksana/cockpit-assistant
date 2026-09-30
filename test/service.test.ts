import assert from 'node:assert/strict';
import { test } from 'node:test';
import { homedir } from 'node:os';
import { Database } from '../src/database.ts';
import { dispatchSchema } from '../src/schema.ts';
import { fixture, topic } from './fixtures.ts';
import { timeline } from '../src/ui.ts';

function batch(f: ReturnType<typeof fixture>) {
  return f.service.startBatch(f.db.must('bindings', 'coordinator'))!;
}

test('compound original is immediately visible once before classification and immutable on replay', t => {
  const f = fixture(); t.after(() => f.close());
  const input = { requestId: 'one', text: 'Weather and code please' };
  const first = f.service.accept(input);
  assert.equal(timeline(f.service, undefined, undefined, 100).items[0]?.text, input.text);
  assert.equal(f.db.list('publications').items[0]?.topicId, null);
  assert.equal(f.service.accept(input).message.id, first.message.id);
  assert.equal(f.db.list('messages').items.length, 1);
  assert.equal(f.db.list('publications').items.length, 1);
  assert.throws(() => f.service.accept({ ...input, text: 'Different' }), /different input/);
  assert.equal(f.service.config.defaultCwd, homedir());
});

test('one dispatch freezes different topic prompts without duplicating the original bubble', t => {
  const f = fixture(); t.after(() => f.close());
  topic(f, 'weather', 's1'); topic(f, 'code', 's2');
  const original = f.service.accept({ requestId: 'one', text: 'Weather and code' });
  const current = batch(f);
  const value = { items: [{ topicId: 'weather', prompt: 'Weather only' }, { topicId: 'code', prompt: 'Code only' }] };
  assert.deepEqual(f.service.dispatch(f.identities.coordinator, value), { queued: 2 });
  assert.deepEqual(f.db.list('deliveries').items.map(d => [d.sessionId, d.text]), [['s1', 'Weather only'], ['s2', 'Code only']]);
  assert.equal(f.db.must('messages', original.message.id).topicId, null);
  assert.equal(f.db.list('messageTopics').items.length, 2);
  assert.equal(f.db.list('publications').items.length, 1);
  f.service.dispatch(f.identities.coordinator, value);
  assert.equal(f.db.list('deliveries').items.length, 2);
  assert.throws(() => f.service.dispatch(f.identities.coordinator, { items: [value.items[0]] }), /different durable dispatch/);
  assert.equal(f.db.must('work', original.work.id).state, 'done');
  f.service.finishBatch(current.id, 'finished');
  assert.equal(f.service.activeBatch(), undefined);
  assert.equal(batch(f), null);
});

test('dispatch schema contains exactly two fields per item and no coordinator proof', () => {
  const item = { topicId: 'topic', prompt: 'hello' };
  for (const field of ['sessionId', 'workId', 'token', 'epoch', 'lease', 'replyTo', 'context'])
    assert.equal(dispatchSchema.safeParse({ items: [{ ...item, [field]: 'invalid' }] }).success, false);
  assert.equal(dispatchSchema.safeParse({ items: [item], workId: 'old' }).success, false);
  assert.equal(dispatchSchema.safeParse({ items: [item] }).success, true);
});

test('multiple text inputs coalesce and attachment input isolates from both adjacent batches', t => {
  const f = fixture(); t.after(() => f.close());
  topic(f);
  f.service.accept({ requestId: 'a', text: 'First' });
  f.service.accept({ requestId: 'b', text: 'Second' });
  const attached = f.service.accept({ requestId: 'c', text: 'File',
    attachments: [{ type: 'file', path: '/fixture.ts' }] });
  f.service.accept({ requestId: 'd', text: 'Last' });
  const first = batch(f);
  assert.equal(first.workIds.length, 2);
  f.service.dispatch(f.identities.coordinator, { items: [{ topicId: 'topic', prompt: 'First two' }] });
  f.service.finishBatch(first.id, 'finished');
  const second = batch(f);
  assert.deepEqual(second.workIds, [attached.work.id]);
  f.service.dispatch(f.identities.coordinator, { items: [
    { topicId: 'topic', prompt: 'Read file' }, { topicId: 'topic', prompt: 'Explain file' },
  ] });
  const deliveries = f.db.list('deliveries').items;
  assert.equal(deliveries[0]!.attachments.length, 0);
  assert.deepEqual(deliveries[1]!.attachments, attached.message.attachments);
  assert.deepEqual(deliveries[2]!.attachments, attached.message.attachments);
  f.service.finishBatch(second.id, 'finished');
  assert.equal(batch(f).workIds.length, 1);
});

test('topic management is flat and session creation belongs to the service not topic creation', t => {
  const f = fixture(); t.after(() => f.close());
  f.service.accept({ requestId: 'one', text: 'A new topic' }); batch(f);
  const created = f.service.topic(f.identities.coordinator, { title: 'Trip-hotels', content: 'Find a hotel' });
  assert.equal(created.sessionId, null);
  assert.equal(f.calls.length, 0);
  assert.equal(f.service.topic(f.identities.coordinator, { title: 'Trip-hotels', content: 'Find a hotel' }).id, created.id);
  assert.throws(() => f.service.topic(f.identities.coordinator, {
    title: 'Child', content: '', parentTopicId: created.id,
  }));
  f.service.map(f.identities.coordinator, { topicId: created.id, sessionId: 's1' });
  assert.equal(f.db.must('topics', created.id).sessionId, 's1');
  f.service.dispatch(f.identities.coordinator, { items: [{ topicId: created.id, prompt: 'Find hotel' }] });
  assert.throws(() => f.service.map(f.identities.coordinator, { topicId: created.id, sessionId: 's2' }), /current topic delivery/);
});

test('shared session receives short current-topic context and no forced migration', t => {
  const f = fixture(); t.after(() => f.close());
  topic(f, 'one'); topic(f, 'two');
  f.service.accept({ requestId: 'input', text: 'Both topics' }); batch(f);
  f.service.dispatch(f.identities.coordinator, { items: [{ topicId: 'one', prompt: 'First topic' }] });
  const delivery = f.db.list('deliveries').items[0]!;
  assert.match(delivery.supplement!, /Current topic is "one"/);
  assert.match(delivery.supplement!, /not additional user authorization/);
  assert.equal(f.db.must('topics', 'two').sessionId, 's1');
});

test('reply appears before attribution and gains one original-text heading in place', t => {
  const f = fixture(); t.after(() => f.close());
  topic(f, 'topic');
  const message = f.service.addMessage({ kind: 'reply', raw: 'The original answer', sessionId: 's1' });
  f.service.addWork(message);
  const before = timeline(f.service, undefined, undefined, 100).items[0]!;
  assert.equal(before.text, 'The original answer');
  assert.equal(before.topicId, null);
  batch(f);
  f.service.attribute(f.identities.coordinator, { items: [{ messageId: message.id, topicId: 'topic' }] });
  const after = timeline(f.service, undefined, undefined, 100).items[0]!;
  assert.equal(after.id, before.id);
  assert.equal(after.text, before.text);
  assert.equal(after.topicTitle, 'topic');
  assert.equal(after.topicColor, '#336699');
  assert.equal(f.db.find('publications', p => p.type === 'message').length, 1);
  f.service.attribute(f.identities.coordinator, { items: [{ messageId: message.id, topicId: 'topic' }] });
  assert.equal(f.db.find('publications', p => p.type === 'attribution').length, 1);
});

test('source batch contains actual source text and session identities, not metadata-only notices', t => {
  const f = fixture(); t.after(() => f.close());
  f.service.accept({ requestId: 'one', text: 'My exact input' });
  const reply = f.service.addMessage({ kind: 'reply', raw: 'Exact original reply', sessionId: 's2' });
  f.service.addWork(reply);
  const text = f.service.batchText(batch(f));
  assert.match(text, /My exact input/); assert.match(text, /Exact original reply/);
  assert.match(text, /sessionId: s2/); assert.match(text, /not new user authorization/);
});

test('interrupted batch does not repeat completed dispatch, retries only unfinished attribution', t => {
  const f = fixture(); t.after(() => f.close());
  topic(f);
  const input = f.service.accept({ requestId: 'one', text: 'Input' });
  const reply = f.service.addMessage({ kind: 'reply', raw: 'Reply', sessionId: 's1' });
  const output = f.service.addWork(reply);
  const first = batch(f);
  f.service.dispatch(f.identities.coordinator, { items: [{ topicId: 'topic', prompt: 'Input' }] });
  f.service.finishBatch(first.id, 'rejected');
  assert.equal(f.db.must('work', input.work.id).state, 'done');
  const next = batch(f);
  assert.deepEqual(next.workIds, [output.id]);
  f.service.attribute(f.identities.coordinator, { items: [{ messageId: reply.id, topicId: 'topic' }] });
  assert.equal(f.db.list('deliveries').items.length, 1);
});

test('definite old failures do not block new inputs, unknown control effects do not blind replay', t => {
  const f = fixture(); t.after(() => f.close());
  const first = f.service.accept({ requestId: 'a', text: 'Old input' });
  f.service.finishBatch(batch(f).id, 'rejected');
  f.service.finishBatch(batch(f).id, 'rejected');
  assert.equal(f.db.must('work', first.work.id).state, 'failed');
  const second = f.service.accept({ requestId: 'b', text: 'New input' });
  const next = batch(f);
  assert.deepEqual(next.workIds, [second.work.id]);
  f.service.finishBatch(next.id, 'unknown');
  assert.equal(f.service.activeBatch(), undefined);
  assert.equal(f.db.must('batches', next.id).state, 'unknown');
  assert.equal(batch(f), null);
});

test('memory receives multi-topic source context without a foreground pointer', t => {
  const f = fixture(); t.after(() => f.close());
  topic(f, 'a'); topic(f, 'b');
  const input = f.service.accept({ requestId: 'one', text: 'Two goals' }); batch(f);
  f.service.dispatch(f.identities.coordinator, { items: [
    { topicId: 'a', prompt: 'Goal A' }, { topicId: 'b', prompt: 'Goal B' },
  ] });
  const memory = f.db.find('work', work => work.role === 'memory');
  assert.deepEqual(memory.map(work => work.topicId).sort(), ['a', 'b']);
  assert.ok(memory.every(work => work.sources[0]?.messageId === input.message.id));
  assert.equal(f.db.meta('foregroundTopic', null), null);
});

test('strict role identity and protocol revision exclude stale carriers and subagents', t => {
  const f = fixture(); t.after(() => f.close());
  f.service.accept({ requestId: 'input', text: 'Hello' }); batch(f);
  assert.throws(() => f.service.topic({ ...f.identities.coordinator, subagent: true }, { title: 'X', content: '' }), /Internal agents/);
  assert.throws(() => f.service.topic(f.identities.memory, { title: 'X', content: '' }), /ready current role/);
  f.db.put('bindings', { ...f.db.must('bindings', 'coordinator'), definitionVersion: '1' });
  assert.throws(() => f.service.topic(f.identities.coordinator, { title: 'X', content: '' }), /protocol 2/);
});

test('schema 2 rejects legacy files without clearing their tables', t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  assert.equal(db.sql.prepare('PRAGMA user_version').get()!.user_version, 2);
  const names = db.sql.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  assert.ok(names.includes('messageTopics'));
  for (const old of ['anchors', 'routes', 'risks', 'exposures']) assert.ok(!names.includes(old));
});
