import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, topic, stageDelivery } from './fixtures.ts';

test('unbound user topic creates a real default-config session once, records it, and reuses it', async () => {
  const f = fixture();
  try {
    topic(f, 'topic', null);
    const first = stageDelivery(f, 'first');
    await f.runtime.wake();
    assert.equal(f.db.must('topics', 'topic').sessionId, 'created-1');
    assert.equal(f.db.topicMessages(first.message.id)[0]!.sessionId, 'created-1');
    assert.deepEqual(f.calls.find(call => call.name === 'session/new')!.body, { cwd: '/synthetic' });
    const next = stageDelivery(f, 'next');
    await f.runtime.wake();
    assert.equal(f.calls.filter(call => call.name === 'session/new').length, 1);
    assert.equal(f.db.topicMessages(next.message.id)[0]!.sessionId, 'created-1');
  } finally { f.close(); }
});
test('unknown creation is retained on the topic with partial real identity, never automatically repeated', async () => {
  const f = fixture();
  try {
    topic(f, 'topic', null);
    f.fail('session/new', Object.assign(new Error('Lost creation response'), { createdId: 'real-partial' }));
    const first = stageDelivery(f, 'first');
    await f.runtime.wake();
    const t = f.db.must('topics', 'topic');
    assert.equal(t.mappingState, 'unknown'); assert.equal(t.sessionId, null);
    assert.equal((t.creationReceipt as { createdId: string }).createdId, 'real-partial');
    assert.equal(f.db.topicMessages(first.message.id)[0]!.state, 'unknown');
    stageDelivery(f, 'next'); f.fail('session/new', null);
    await f.runtime.wake();
    assert.equal(f.calls.filter(call => call.name === 'session/new').length, 1);
    assert.equal(f.db.must('topics', 'topic').mappingState, 'unknown');
    assert.ok(f.errors.length >= 2);
  } finally { f.close(); }
});
test('missing mapped session rejects visibly, rather than creating a replacement', async () => {
  const f = fixture();
  try {
    topic(f, 'topic', 'missing');
    const staged = stageDelivery(f);
    await f.runtime.wake();
    assert.equal(f.db.topicMessages(staged.message.id)[0]!.state, 'rejected');
    assert.equal(f.calls.some(call => call.name === 'session/new'), false);
  } finally { f.close(); }
});
test('uncertain original load is not reset to pending or followed by a prompt', async () => {
  const f = fixture();
  try {
    const staged = stageDelivery(f);
    f.metas.get('s1')!.loaded = false;
    f.fail('session/load', new Error('Connection lost after load may have applied'));
    await f.runtime.wake(); await f.runtime.wake();
    assert.equal(f.db.topicMessages(staged.message.id)[0]!.state, 'unknown');
    assert.equal(f.calls.filter(call => call.name === 'session/load').length, 1);
    assert.equal(f.calls.some(call => call.name === 'prompt'), false);
  } finally { f.close(); }
});
test('original load is marked calling durably before invoking Host, so a crash cannot silently repeat it', async () => {
  const f = fixture();
  try {
    const staged = stageDelivery(f);
    f.metas.get('s1')!.loaded = false;
    f.onLoad(async sessionId => {
      assert.equal(sessionId, 's1');
      const row = f.db.topicMessages(staged.message.id)[0]!;
      assert.equal(row.state, 'calling');
      assert.equal(row.sessionId, 's1');
      assert.equal(row.mode, null);
    });
    await f.runtime.wake();
    assert.equal(f.db.topicMessages(staged.message.id)[0]!.state, 'accepted');
  } finally { f.close(); }
});
test('transition to internal during a confirmed original load cancels the still-unsent business content truthfully', async () => {
  const f = fixture();
  try {
    const staged = stageDelivery(f);
    f.metas.get('s1')!.loaded = false;
    f.onLoad(async () => { f.metas.get('s1')!.roles = f.metas.get('coordinator')!.roles; });
    await f.runtime.wake();
    const row = f.db.topicMessages(staged.message.id)[0]!;
    assert.equal(row.state, 'cancelled');
    assert.equal(f.calls.some(call => call.name === 'prompt'), false);
    assert.ok(f.errors.some(error => (error as { topicMessageId?: string }).topicMessageId === row.id));
  } finally { f.close(); }
});
test('a coordinator cannot clear unknown creation back to unbound and cause a speculative recreation', () => {
  const f = fixture();
  try {
    const t = topic(f, 'topic', null);
    f.db.put('topics', { ...t, mappingState: 'unknown', mappingError: 'Unknown native creation' });
    const m = f.service.accept({ requestId: 'clear', text: 'Another request' }).message;
    assert.throws(() => f.service.complete({ messageId: m.id,
      topics: [{ topicId: 'topic', title: 'topic', content: '', sessionId: null }],
      items: [{ topicId: 'topic', prompt: 'Request' }] }), /cannot be cleared/);
    assert.equal(f.db.must('topics', 'topic').mappingState, 'unknown');
    assert.equal(f.db.must('messages', m.id).processed, false);
  } finally { f.close(); }
});
