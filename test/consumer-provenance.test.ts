import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { fixture, proof, toolIdentity, topic } from './fixtures.ts';
import type { HistoryPage } from '../src/runtime.ts';

const page = (events: HistoryPage['events'], cursor = 'tail'): HistoryPage =>
  ({ events, cursor, cursorStatus: 'ok', hasMore: false });

test('a tool arriving during an older in-flight history read gets a bounded fresh continuation observation', async t => {
  const f = fixture(); t.after(() => f.close());
  f.service.accept({ requestId: 'one', text: 'Original input' });
  await f.runtime.wake();
  const read = f.native.read;
  let release: ((page: HistoryPage) => void) | undefined;
  let reads = 0;
  f.native.read = async (...args) => {
    if (args[0] === 'coordinator' && !args[2] && ++reads === 1)
      return new Promise<HistoryPage>(resolve => { release = resolve; });
    return read(...args);
  };
  const pump = f.runtime.wake();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const identity = toolIdentity(f);
  const authorization = f.runtime.authorize(identity, 'coordinator');
  release(page([], 'older-observation'));
  await Promise.all([pump, authorization]);
  assert.equal(reads, 2);
  assert.equal(f.db.consumerEvidence('coordinator', 'toolCallId', identity.toolCallId).length, 1);
  assert.equal(f.calls.filter(call => call.name === 'prompt').length, 1);
});

test('tools join exact native hook identity through interaction to send receipt, ignoring chronological parents', async t => {
  const f = fixture(); t.after(() => f.close());
  f.service.accept({ requestId: 'first', text: 'Actual original' });
  await f.runtime.wake();
  const identity = toolIdentity(f);
  const events = f.controlPages.get('coordinator')![0]!.events;
  events.splice(1, 0, { id: 'unrelated', type: 'user.message',
    data: { messageId: 'another-receipt', interactionId: 'another-interaction', content: 'Private input' } });
  events[2]!.parentId = 'unrelated';
  await f.runtime.authorize(identity, 'coordinator');
  topic(f);
  f.service.dispatch(identity, { items: [{ topicId: 'topic', prompt: 'Actual original' }] });
  assert.equal(f.db.find('deliveries', delivery => delivery.kind === 'prompt').length, 1);
  const evidence = JSON.stringify(f.db.list('native').items);
  assert.doesNotMatch(evidence, /Private input|Do not persist|secret|arguments|parentId/);
});

test('missing, child, ambiguous and wrong-interaction tool evidence fail closed without falling back to the active batch', async () => {
  for (const variant of ['missing-id', 'no-event', 'child', 'wrong-interaction', 'duplicate-tool', 'duplicate-root',
    'duplicate-request'] as const) {
    const f = fixture();
    try {
      f.service.accept({ requestId: variant, text: 'Input' });
      await f.runtime.wake();
      let identity = toolIdentity(f);
      const events = f.controlPages.get('coordinator')![0]!.events;
      if (variant === 'missing-id') identity = { ...identity, toolCallId: '' };
      if (variant === 'no-event') events.pop();
      if (variant === 'child') events[1]!.agentId = 'helper';
      if (variant === 'wrong-interaction') events[1]!.data.interactionId = 'unrelated';
      if (variant === 'duplicate-tool') events.push({ ...events[1]!, id: 'duplicate-tool-event' });
      if (variant === 'duplicate-root') events.push({ ...events[0]!, id: 'duplicate-root-event' });
      if (variant === 'duplicate-request') events[1]!.data.toolRequests = [
        { toolCallId: identity.toolCallId }, { toolCallId: identity.toolCallId },
      ];
      await assert.rejects(f.runtime.authorize(identity, 'coordinator'), /identity|interaction|receipt/i, variant);
      assert.equal(f.db.find('deliveries', delivery => delivery.kind === 'prompt').length, 0);
    } finally { f.close(); }
  }
});

test('a late tool from a completed batch cannot apply to a new batch in the same role epoch', async t => {
  const f = fixture(); t.after(() => f.close());
  topic(f);
  f.service.accept({ requestId: 'first', text: 'First' });
  await f.runtime.wake();
  const first = f.service.activeBatch()!;
  const identity = toolIdentity(f);
  await f.runtime.authorize(identity, 'coordinator');
  f.service.dispatch(identity, { items: [{ topicId: 'topic', prompt: 'First' }] });
  f.service.accept({ requestId: 'next', text: 'Second' });
  await f.runtime.wake();
  const next = f.service.activeBatch()!;
  assert.notEqual(next.id, first.id);
  await assert.rejects(f.runtime.authorize({ ...identity }, 'coordinator'), { code: 'TOOL_PROVENANCE' });
  assert.throws(() => f.service.dispatch(identity, { items: [{ topicId: 'topic', prompt: 'Second' }] }),
    { code: 'STALE_CONSUMER' });
  assert.equal(f.db.must('batches', first.id).state, 'done');
  assert.equal(f.db.must('batches', next.id).dispatchHash, null);
});

test('tool callback arriving before its native send receipt waits, then uses exact evidence', async t => {
  const f = fixture(); t.after(() => f.close());
  f.service.accept({ requestId: 'first', text: 'Input' });
  f.promptResult({ ok: true, messageId: 'early-receipt' });
  let authorization: Promise<unknown> | undefined;
  f.onPrompt(async () => {
    const batch = f.service.activeBatch()!;
    assert.equal(f.db.must('deliveries', `batch:${batch.id}`).state, 'calling');
    f.controlPages.set('coordinator', [page([
      { id: 'root-envelope', type: 'user.message', data: { messageId: 'early-receipt', interactionId: 'early' } },
      { id: 'tool-envelope', type: 'assistant.message',
        data: { interactionId: 'early', toolRequests: [{ toolCallId: 'early-tool' }] } },
    ])]);
    authorization = f.runtime.authorize({ ...f.identities.coordinator, ...{ toolCallId: 'early-tool' } }, 'coordinator');
    await new Promise(resolve => setImmediate(resolve));
  });
  await f.runtime.wake();
  assert.ok(authorization);
  await authorization;
});

test('receipt-less wake stays unknown without resend, and does not permanently block new work', async t => {
  const f = fixture(); t.after(() => f.close());
  const input = f.service.accept({ requestId: 'lost', text: 'Unknown original' });
  f.promptResult({ ok: true });
  await f.runtime.wake();
  assert.equal(f.service.activeBatch(), undefined);
  assert.equal(f.db.must('work', input.work.id).state, 'failed');
  f.promptResult({ ok: true, messageId: 'next-receipt' });
  f.service.accept({ requestId: 'next', text: 'Independent input' });
  await f.runtime.wake();
  const wakes = f.db.find('deliveries', delivery => delivery.kind === 'wake');
  assert.equal(wakes.length, 2);
  assert.doesNotMatch(wakes[1]!.text, /Unknown original/);
});

test('lifecycle events and elapsed time cannot discard a slow batch; later attribution finishes it without redispatch', async t => {
  const f = fixture(); t.after(() => f.close());
  topic(f);
  const input = f.service.accept({ requestId: 'first', text: 'First' });
  const reply = f.service.addMessage({ kind: 'reply', raw: 'Original reply', sessionId: 's1' });
  const output = f.service.addWork(reply);
  await f.runtime.wake();
  const first = f.service.activeBatch()!;
  const identity = toolIdentity(f);
  await f.runtime.authorize(identity, 'coordinator');
  f.service.dispatch(identity, { items: [{ topicId: 'topic', prompt: 'First' }] });
  f.controlPages.set('coordinator', [page([
    { id: 'turn-end', type: 'assistant.turn_end', data: {} },
    { id: 'idle', type: 'session.idle', data: {} },
    { id: 'abort', type: 'abort', data: {} },
  ])]);
  await f.runtime.wake();
  assert.equal(f.service.activeBatch()!.id, first.id);
  f.advance(300_001);
  f.metas.get('coordinator')!.status = 'running';
  f.metas.get('coordinator')!.activity!.processing = true;
  f.service.accept({ requestId: 'next', text: 'Independent new work' });
  await f.runtime.wake();
  assert.equal(f.db.must('work', input.work.id).state, 'done');
  assert.equal(f.db.must('work', output.id).state, 'leased');
  assert.equal(f.service.activeBatch()!.id, first.id);
  const later = toolIdentity(f);
  await f.runtime.authorize(later, 'coordinator');
  f.service.attribute(later, { items: [{ messageId: reply.id, topicId: 'topic' }] });
  f.metas.get('coordinator')!.status = 'idle';
  f.metas.get('coordinator')!.activity!.processing = false;
  await f.runtime.wake();
  assert.equal(f.db.must('batches', first.id).state, 'done');
  const next = f.service.activeBatch()!;
  assert.notEqual(next.id, first.id);
  assert.doesNotMatch(f.db.must('deliveries', `batch:${next.id}`).text, /Original reply/);
  assert.equal(f.db.find('deliveries', delivery => delivery.kind === 'prompt').length, 1);
});

test('memory wakes have durable source-bound batches and finish on stored extraction, not native idle', async t => {
  const f = fixture(); t.after(() => f.close());
  topic(f);
  const source = f.service.addMessage({ kind: 'reply', raw: 'Reported fact', topicId: 'topic', sessionId: 's1' });
  f.service.memory.schedule('topic');
  await f.runtime.wake();
  const batch = f.service.activeBatch('memory')!;
  assert.ok(batch);
  const identity = toolIdentity(f, 'memory');
  await f.runtime.authorize(identity, 'memory');
  const work = f.service.claim(identity, 'memory', 1)!;
  assert.deepEqual(work.sources, [{ messageId: source.id, version: 1, assignmentVersion: 0 }]);
  f.service.remember(identity, { ...proof(work), entries: [] });
  await f.runtime.wake();
  assert.equal(f.db.must('batches', batch.id).state, 'done');
  assert.equal(f.service.activeBatch('memory'), undefined);
  assert.equal(f.db.find('deliveries', delivery => delivery.kind === 'wake').length, 1);
  await assert.rejects(f.runtime.authorize({ ...identity }, 'memory'), { code: 'NO_ACTIVE_BATCH' });
});

test('a consumer cursor conflict rolls back evidence and never authorizes a tool from the uncommitted page', async t => {
  const f = fixture(); t.after(() => f.close());
  f.service.accept({ requestId: 'one', text: 'Input' });
  await f.runtime.wake();
  const identity = toolIdentity(f);
  await f.runtime.authorize(identity, 'coordinator');
  const batch = f.service.activeBatch()!;
  const key = `consumer:batch:${batch.id}`;
  const before = f.db.meta(key, null);
  const evidence = f.db.list('native').items;
  const root = evidence.find(record => record.event.type === 'user.message')!.event;
  f.controlPages.set('coordinator', [page([
    { id: 'new-tool', type: 'assistant.message',
      data: { interactionId: root.data.interactionId, toolRequests: [{ toolCallId: 'uncommitted-tool' }] } },
    { ...root, data: { ...root.data, interactionId: 'mutated' } },
  ], 'bad-page')]);
  await assert.rejects(f.runtime.authorize({ ...identity, ...{ toolCallId: 'uncommitted-tool' } }, 'coordinator'),
    { code: 'EVENT_ID_CONFLICT' });
  assert.deepEqual(f.db.meta(key, null), before);
  assert.deepEqual(f.db.list('native').items, evidence);
});

test('receipt, consumer cursor and minimal tool evidence survive restart without re-sending a wake', async () => {
  const path = `test/.consumer-${randomUUID()}.sqlite`;
  let f = fixture(path);
  try {
    f.service.accept({ requestId: 'one', text: 'Saved original' });
    await f.runtime.wake();
    const batch = f.service.activeBatch()!;
    const identity = toolIdentity(f);
    await f.runtime.authorize(identity, 'coordinator');
    const cursor = f.db.meta(`consumer:batch:${batch.id}`, null);
    f.close();
    f = fixture(path);
    await f.runtime.start();
    assert.equal(f.service.activeBatch()!.id, batch.id);
    assert.deepEqual(f.db.meta(`consumer:batch:${batch.id}`, null), cursor);
    await f.runtime.authorize(identity, 'coordinator');
    topic(f);
    f.service.dispatch(identity, { items: [{ topicId: 'topic', prompt: 'Saved original' }] });
    assert.equal(f.calls.filter(call => call.name === 'prompt').length, 0);
    assert.equal(f.db.find('deliveries', delivery => delivery.kind === 'wake').length, 1);
  } finally {
    f.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  }
});

test('temporary role unavailability and elapsed time preserve an accepted unfinished batch', async t => {
  const f = fixture(); t.after(() => f.close());
  f.service.accept({ requestId: 'one', text: 'Interrupted' });
  await f.runtime.wake();
  const batch = f.service.activeBatch()!;
  f.db.put('bindings', { ...f.db.must('bindings', 'coordinator'), ready: false });
  f.advance(86_400_000);
  await f.runtime.wake();
  assert.equal(f.db.must('batches', batch.id).state, 'running');
  assert.equal(f.service.activeBatch()!.id, batch.id);
  assert.equal(f.db.must('work', batch.workIds[0]!).state, 'leased');
  assert.equal(f.db.must('deliveries', `batch:${batch.id}`).state, 'accepted');
  await f.runtime.wake();
  assert.equal(f.db.find('deliveries', delivery => delivery.kind === 'wake').length, 1);
});
