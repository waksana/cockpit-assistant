import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { test } from 'node:test';
import { fixture, stageDelivery, topic } from './fixtures.ts';
import { ensureTopicSession } from '../src/topic-session.ts';

test('an unbound topic automatically creates once using default cwd and native default model', async () => {
  const f = fixture();
  try {
    stageDelivery(f, { sessionId: '', topicId: 'unbound' });
    await f.runtime.wake();
    assert.deepEqual(f.calls.find(c => c.name === 'session/new')!.body, { cwd: homedir() });
    assert.equal(f.db.must('topics', 'unbound').sessionId, 'new-synthetic');
    assert.equal(f.db.must('deliveries', 'delivery').sessionId, 'new-synthetic');
    assert.equal(f.db.must('deliveries', 'delivery').state, 'accepted');
    stageDelivery(f, { id: 'second', sessionId: '', topicId: 'unbound' });
    await f.runtime.wake();
    assert.equal(f.calls.filter(c => c.name === 'session/new').length, 1);
    assert.equal(f.db.must('deliveries', 'second').sessionId, 'new-synthetic');
  } finally { f.close(); }
});

test('configured cwd is honored without overriding host model selection', async () => {
  const f = fixture();
  try {
    f.db.setMeta('config', { defaultCwd: '/explicit/project', maxReceptions: 32 });
    stageDelivery(f, { sessionId: '' });
    await f.runtime.wake();
    assert.deepEqual(f.calls.find(c => c.name === 'session/new')!.body, { cwd: '/explicit/project' });
  } finally { f.close(); }
});

test('unknown creation reserves only its topic and unrelated topics can still create', async () => {
  const f = fixture();
  try {
    stageDelivery(f, { topicId: 'uncertain', sessionId: '' });
    f.fail(new Error('Lost create receipt'));
    await f.runtime.wake();
    f.fail(null);
    f.advance(1000);
    stageDelivery(f, { id: 'other', topicId: 'other', sessionId: '' });
    await f.runtime.wake();
    assert.equal(f.db.must('deliveries', 'delivery').state, 'unknown');
    assert.equal(f.db.must('deliveries', 'other').state, 'accepted');
    assert.equal(f.calls.filter(c => c.name === 'session/new').length, 2);
    stageDelivery(f, { id: 'same-topic-later', topicId: 'uncertain', sessionId: '' });
    await f.runtime.wake();
    assert.equal(f.calls.filter(c => c.name === 'session/new').length, 2);
    assert.equal(f.db.must('deliveries', 'same-topic-later').state, 'unknown');
  } finally { f.close(); }
});

test('known created ID and mapping persist before observation fails and retry reuses exact ID', async () => {
  const f = fixture();
  try {
    stageDelivery(f, { topicId: 'created', sessionId: '' });
    f.onGet(async id => { if (id === 'new-synthetic') throw new Error('Observation unavailable'); });
    await f.runtime.wake();
    assert.equal(f.db.must('topics', 'created').sessionId, 'new-synthetic');
    assert.equal(f.db.must('deliveries', 'delivery').sessionId, 'new-synthetic');
    assert.equal(f.db.must('deliveries', 'delivery').state, 'pending');
    f.onGet(null);
    f.advance(1000);
    await f.runtime.wake();
    assert.equal(f.calls.filter(c => c.name === 'session/new').length, 1);
    assert.equal(f.db.must('deliveries', 'delivery').state, 'accepted');
  } finally { f.close(); }
});

test('partial native create errors carrying a known ID never trigger replacement', async () => {
  const f = fixture();
  try {
    stageDelivery(f, { topicId: 'partial', sessionId: '' });
    f.metas.set('known-created', { ...f.metas.get('s1')!, sessionId: 'known-created' });
    f.fail(Object.assign(new Error('Post-create failure'), { sessionId: 'known-created' }));
    await ensureTopicSession(f.service, f.runtime, 'delivery');
    assert.equal(f.db.must('topics', 'partial').sessionId, 'known-created');
    f.fail(null);
    await f.runtime.wake();
    assert.equal(f.db.must('deliveries', 'delivery').state, 'accepted');
    assert.equal(f.calls.filter(c => c.name === 'session/new').length, 1);
  } finally { f.close(); }
});

test('an explicit concurrent mapping wins without forgetting a created native ID', async () => {
  const f = fixture();
  try {
    topic(f, 'topic', null);
    stageDelivery(f, { topicId: 'topic', sessionId: '' });
    const original = f.runtime.create.bind(f.runtime);
    f.runtime.create = async input => {
      const result = await original(input);
      f.db.put('topics', { ...f.db.must('topics', 'topic'), sessionId: 's2' });
      return result;
    };
    await ensureTopicSession(f.service, f.runtime, 'delivery');
    assert.equal(f.db.must('deliveries', 'delivery').sessionId, 's2');
    assert.deepEqual(f.db.must('operations', 'create:topic:topic').result, { sessionId: 'new-synthetic' });
  } finally { f.close(); }
});
