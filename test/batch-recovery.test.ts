import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { fixture } from './fixtures.ts';

const wakes = (f: ReturnType<typeof fixture>) => f.calls.filter(call =>
  call.name === 'prompt' && (call.body as { sessionId: string }).sessionId === 'coordinator');

test('reservation, consumer boundary and outbox roll back together if provisioning fails', async t => {
  const f = fixture(); t.after(() => f.close());
  const input = f.service.accept({ requestId: 'one', text: 'Original' });
  const put = f.db.put.bind(f.db);
  f.db.put = (table, record) => {
    if (table === 'deliveries' && 'kind' in record && record.kind === 'wake') throw new Error('Outbox write failed');
    return put(table, record);
  };
  await f.runtime.wake();
  assert.equal(f.service.activeBatch(), undefined);
  assert.equal(f.db.list('batches').items.length, 0);
  assert.equal(f.db.must('work', input.work.id).state, 'pending');
  assert.equal(f.db.must('work', input.work.id).attempts, undefined);
  assert.equal(f.db.sql.prepare("SELECT count(*) AS count FROM meta WHERE key LIKE 'consumer:%'").get()!.count, 0);
  assert.equal(wakes(f).length, 0);
  f.db.put = put;
  await f.runtime.wake();
  const batch = f.service.activeBatch()!;
  assert.equal(f.db.must('deliveries', `batch:${batch.id}`).state, 'accepted');
  assert.ok(f.db.meta(`consumer:batch:${batch.id}`, null));
  assert.equal(wakes(f).length, 1);
});

test('restart safely releases a legacy orphan reservation with no durable call intent', async () => {
  const path = `test/.orphan-${randomUUID()}.sqlite`;
  let f = fixture(path);
  try {
    const input = f.service.accept({ requestId: 'original', text: 'Never sent original' });
    const orphan = f.service.startBatch(f.db.must('bindings', 'coordinator'))!;
    f.close();
    f = fixture(path);
    f.advance(86_400_000);
    f.service.accept({ requestId: 'new', text: 'Independent new input' });
    await f.runtime.start();
    assert.equal(f.db.must('batches', orphan.id).state, 'failed');
    assert.equal(f.db.must('work', input.work.id).attempts, 1, 'an unsent reservation did not consume a send attempt');
    assert.deepEqual(f.db.meta(`orphan:${orphan.id}`, null), {
      outcome: 'released', reason: 'Reservation had no durable native-call intent',
    });
    assert.notEqual(f.service.activeBatch()!.id, orphan.id);
    assert.equal(wakes(f).length, 1);
    assert.match((wakes(f)[0]!.body as { text: string }).text, /Never sent original/);
    assert.match((wakes(f)[0]!.body as { text: string }).text, /Independent new input/);
  } finally {
    f.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  }
});

test('orphan recovery never releases a reservation containing a native call intent or applied decision', async () => {
  for (const state of ['calling', 'accepted', 'unknown', 'decision'] as const) {
    const f = fixture();
    try {
      f.service.accept({ requestId: state, text: 'Do not automatically resend' });
      const batch = f.service.startBatch(f.db.must('bindings', 'coordinator'))!;
      if (state === 'decision') f.service.topic(f.identities.coordinator, { title: 'Saved decision', content: '' });
      else f.db.put('deliveries', {
        id: `batch:${batch.id}`, batchId: batch.id, kind: 'wake', sessionId: 'coordinator',
        messageId: null, requestId: null, text: 'Original', attachments: [], supplement: null,
        answerFreeform: null, state, result: null, error: null, createdAt: f.service.now(), roleEpoch: 1,
      });
      assert.equal(f.service.recoverOrphanBatch(batch.id), false);
      f.service.recover();
      await f.runtime.wake();
      assert.equal(wakes(f).length, 0);
      assert.notEqual(f.db.must('work', batch.workIds[0]!).state, 'pending');
    } finally { f.close(); }
  }
});

test('confirmed rejected wakes retry after bounded backoff without another native event or user request', async () => {
  await Promise.all([false, true].map(async rejectAgain => {
    const f = fixture();
    try {
      const input = f.service.accept({ requestId: 'one', text: 'Original' });
      f.promptResult({ ok: false });
      await f.runtime.wake();
      assert.equal(wakes(f).length, 1);
      assert.equal(f.db.must('work', input.work.id).state, 'pending');
      assert.equal(f.db.must('work', input.work.id).retryAfter, f.service.now() + 1000);
      if (!rejectAgain) f.promptResult({ ok: true, messageId: 'retry-receipt' });
      f.advance(1000);
      await new Promise(resolve => setTimeout(resolve, 1100));
      await f.runtime.settled();
      assert.equal(wakes(f).length, 2);
      assert.equal(f.db.must('work', input.work.id).attempts, 2);
      assert.equal(f.db.must('work', input.work.id).state, rejectAgain ? 'failed' : 'leased');
      f.advance(1000);
      await new Promise(resolve => setTimeout(resolve, 1100));
      assert.equal(wakes(f).length, 2);
    } finally { f.close(); }
  }));
});

test('an unknown wake outcome never receives the rejection retry timer', async t => {
  const f = fixture(); t.after(() => f.close());
  const input = f.service.accept({ requestId: 'one', text: 'Uncertain original' });
  f.fail(new Error('Lost receipt'));
  await f.runtime.wake();
  f.fail(null);
  f.advance(1000);
  await new Promise(resolve => setTimeout(resolve, 1100));
  await f.runtime.settled();
  assert.equal(wakes(f).length, 1);
  assert.equal(f.db.must('work', input.work.id).state, 'failed');
  assert.equal(f.db.must('work', input.work.id).retryAfter, 0);
});

test('a retry becoming due during another send wakes once and does not poll a busy carrier', async () => {
  for (const busy of [false, true]) {
    const f = fixture();
    try {
      const input = f.service.accept({ requestId: 'one', text: 'Original' });
      f.db.put('work', { ...input.work, id: 'memory-work', role: 'memory', kind: 'memory' });
      let sends = 0;
      f.onPrompt(async () => {
        sends++;
        if (sends === 1) f.promptResult({ ok: false });
        else {
          f.promptResult({ ok: true, messageId: `receipt-${sends}` });
          if (sends === 2) {
            f.advance(1001);
            if (busy) f.metas.get('coordinator')!.status = 'running';
          }
        }
      });
      await f.runtime.wake();
      await new Promise(resolve => setTimeout(resolve, 50));
      await f.runtime.settled();
      assert.equal(f.db.must('work', input.work.id).retryAfter, 0);
      assert.equal(wakes(f).length, busy ? 1 : 2);
      const observed = f.calls.length;
      await new Promise(resolve => setTimeout(resolve, 50));
      await f.runtime.settled();
      assert.equal(f.calls.length, observed, 'an expired backoff must not become readiness polling');
      if (busy) {
        f.metas.get('coordinator')!.status = 'idle';
        await f.runtime.wake('coordinator');
        assert.equal(wakes(f).length, 2);
      }
      assert.equal(f.db.must('work', input.work.id).attempts, 2);
      assert.equal(f.db.must('work', input.work.id).state, 'leased');
    } finally { f.close(); }
  }
});
