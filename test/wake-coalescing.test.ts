import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NativeChatEvent } from '@waksana/cockpit-module-sdk/backend';
import { fixture } from './fixtures.ts';

const sends = (f: ReturnType<typeof fixture>) =>
  f.calls.filter(c => c.name === 'prompt' && (c.body as { sessionId: string }).sessionId === 'coordinator');
const turn = (id: string): NativeChatEvent[] => [
  { id, type: 'user.message', data: {} },
  { id: `${id}-start`, parentId: id, type: 'assistant.turn_start', data: {} },
  { id: `${id}-message`, parentId: `${id}-start`, type: 'assistant.message', data: { toolRequests: [] } },
  { id: `${id}-end`, parentId: `${id}-message`, type: 'assistant.turn_end', data: {} },
];
function complete(f: ReturnType<typeof fixture>) {
  const batch = f.service.activeBatch()!;
  for (const workId of batch.workIds) f.db.put('work', { ...f.db.must('work', workId), state: 'done' });
}

test('coalesced batches contain source content and empty queues send nothing', async () => {
  const f = fixture();
  try {
    await f.runtime.wake();
    assert.equal(sends(f).length, 0);
    for (let i = 0; i < 20; i++) f.service.accept({ requestId: `input:${i}`, text: `User content ${i}` });
    await f.runtime.wake();
    assert.equal(sends(f).length, 1);
    const body = sends(f)[0]!.body as { text: string };
    assert.match(body.text, /User content 0/);
    assert.match(body.text, /User content 19/);
    assert.doesNotMatch(body.text, /wakeId|assistant_claim|token|lease/);
    await f.runtime.wake();
    assert.equal(sends(f).length, 1, 'native acceptance or idle alone never releases a batch');
    complete(f);
    await f.runtime.wake('coordinator');
    assert.equal(f.service.activeBatch(), undefined);
    assert.equal(sends(f).length, 1);
  } finally { f.close(); }
});

test('arrivals wait for durable batch decisions, then consume without a terminal event or empty wake', async () => {
  const f = fixture();
  try {
    f.service.accept({ requestId: 'first', text: 'First' });
    await f.runtime.wake();
    const first = f.service.activeBatch()!;
    for (let i = 0; i < 5; i++) {
      f.service.accept({ requestId: `during:${i}`, text: 'Later work' });
      await f.runtime.wake();
    }
    assert.equal(f.service.activeBatch()!.id, first.id);
    assert.equal(sends(f).length, 1);
    complete(f);
    await f.runtime.wake('coordinator');
    assert.equal(sends(f).length, 2);
    assert.notEqual(f.service.activeBatch()!.id, first.id);
    assert.equal(f.service.activeBatch()!.workIds.length, 5);
  } finally { f.close(); }
});

test('busy, queued, and unknown activity do not start a new batch against an old native turn', async () => {
  for (const state of ['busy', 'queued', 'unknown'] as const) {
    const f = fixture();
    try {
      f.service.accept({ requestId: 'first', text: 'First' });
      const meta = f.metas.get('coordinator')!;
      if (state === 'busy') meta.status = 'running';
      if (state === 'queued') meta.activity!.queue.pendingCount = 1;
      if (state === 'unknown') meta.activity = null;
      await f.runtime.wake();
      assert.equal(sends(f).length, 0);
      assert.equal(f.service.activeBatch(), undefined);
    } finally { f.close(); }
  }
});

test('tool turn completion, prose, unrelated end, and idle never finish the active native batch', async () => {
  const f = fixture();
  try {
    f.service.accept({ requestId: 'first', text: 'First' });
    await f.runtime.wake();
    const events = turn('native');
    events[2]!.data = { content: 'Done', toolRequests: [{}] };
    f.controlPages.set('coordinator', [{ events: [...events,
      { id: 'unrelated-end', type: 'assistant.turn_end', parentId: 'absent', data: {} }],
    cursor: 'after-tools', cursorStatus: 'ok', hasMore: false }]);
    f.service.accept({ requestId: 'next', text: 'Next' });
    await f.runtime.wake('coordinator');
    assert.equal(sends(f).length, 1);
    assert.ok(f.service.activeBatch());
  } finally { f.close(); }
});

test('rejected notifications do not permanently block later independent work', async () => {
  const f = fixture();
  try {
    f.service.accept({ requestId: 'first', text: 'First' });
    f.promptResult({ ok: false });
    await f.runtime.wake();
    assert.equal(sends(f).length, 1);
    f.promptResult({ ok: true });
    f.service.accept({ requestId: 'second', text: 'Second' });
    await f.runtime.wake();
    assert.equal(sends(f).length, 2);
    assert.match((sends(f)[1]!.body as { text: string }).text, /Second/);
  } finally { f.close(); }
});

test('uncertain native acceptance never blindly replays the original batch', async () => {
  const f = fixture();
  try {
    const first = f.service.accept({ requestId: 'first', text: 'Original uncertain content' });
    f.fail(new Error('Lost native receipt'));
    await f.runtime.wake();
    f.fail(null);
    f.service.accept({ requestId: 'second', text: 'Independent new content' });
    await f.runtime.wake();
    assert.equal(sends(f).length, 2);
    assert.doesNotMatch((sends(f)[1]!.body as { text: string }).text, /Original uncertain content/);
    assert.notEqual(f.db.must('work', first.work.id).state, 'pending');
  } finally { f.close(); }
});

test('unrelated roots never conclude a batch, while cursor gaps leave unknown evidence without replay', async () => {
  for (const gap of [false, true]) {
    const f = fixture();
    try {
      f.service.accept({ requestId: 'first', text: 'First' });
      await f.runtime.wake();
      const batch = f.service.activeBatch()!;
      f.controlPages.set('coordinator', [{ events: gap ? [] : [...turn('one'), ...turn('two')],
        cursor: gap ? null : 'cursor', cursorStatus: gap ? 'expired' : 'ok', hasMore: false }]);
      await f.runtime.wake('coordinator');
      assert.equal(f.db.must('batches', batch.id).state, gap ? 'unknown' : 'running');
      await f.runtime.wake();
      assert.equal(sends(f).length, 1);
    } finally { f.close(); }
  }
});

test('in-flight dispatch absorbs wake events without creating a second consumer', async () => {
  const f = fixture();
  let release!: () => void;
  try {
    f.service.accept({ requestId: 'first', text: 'First' });
    f.onPrompt(async () => new Promise<void>(resolve => { release = resolve; }));
    const running = f.runtime.wake();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    f.service.accept({ requestId: 'later', text: 'Later' });
    const concurrent = f.runtime.wake();
    release();
    await Promise.all([running, concurrent]);
    assert.equal(sends(f).length, 1);
    assert.equal(f.db.find('batches', b => b.state === 'running').length, 1);
  } finally { f.close(); }
});

test('an accepted queued wake retains its exact receipt and is neither quarantined nor resent', async () => {
  const f = fixture();
  try {
    f.service.accept({ requestId: 'race', text: 'Queued after a concurrent native turn' });
    f.promptResult({ ok: true, queued: true, messageId: 'queued-receipt' });
    await f.runtime.wake();
    assert.equal(sends(f).length, 1);
    assert.equal(f.db.list('batches').items[0]!.state, 'running');
    assert.equal(f.db.list('deliveries').items[0]!.state, 'accepted');
    await f.runtime.wake();
    assert.equal(sends(f).length, 1);
  } finally { f.close(); }
});
