import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { Inbox, checkpointInput, resolveInput } from '../src/inbox.ts';

const caller = { sessionId: 'front', toolCallId: 'tool' };
function fixture(path = ':memory:') {
  const store = new Store(path), inbox = new Inbox(store, () => false);
  const pointer = (id: string, sessionId = 'source', kind: 'ask' | 'reply' = 'reply') => {
    store.enqueuePointer(sessionId, id, kind, kind === 'reply' ? { eventId: `event-${id}`, timestamp: 1 } : undefined);
    return store.inbox().find(item => item.native_id === id)!;
  };
  const read = () => inbox.returned(caller, store.inbox())!;
  const report = (receiptId: string, readIds: string[], extra = {}) => inbox.checkpoint(caller, checkpointInput.parse({
    receiptId, sessionId: 'source', readIds, complete: true,
    position: { query: { source: 'persisted', direction: 'backward' }, nextQuery: null, boundaryEventId: 'event-a' },
    ...extra,
  }));
  const resolve = (receiptId: string, disposition = 'silent') => inbox.resolve(caller, resolveInput.parse({ receiptId, disposition }));
  return { store, inbox, pointer, read, report, resolve, close: () => store.close() };
}

test('pointer reads contain no source body and repeat their receipt without handling', t => {
  const f = fixture(); t.after(f.close);
  f.pointer('a'); f.pointer('ask', 'source', 'ask');
  const first = f.read();
  assert.equal(f.read().id, first.id);
  assert.equal(f.store.inbox().length, 2);
  assert.ok(f.store.inbox().every(item => item.text === '' && item.question === null && item.attachments.length === 0));
  assert.equal(first.disposition, 'unresolved');
  assert.equal(f.inbox.pending(caller.sessionId, 0).items.length, 1);
});

test('incomplete multi-page reads cannot acknowledge or handle an interval', t => {
  const f = fixture(); t.after(f.close);
  const a = f.pointer('a'), receipt = f.read();
  assert.throws(() => f.resolve(receipt.id), { code: 'READ_INCOMPLETE' });
  assert.throws(() => f.report(receipt.id, [a.id], { complete: false }), { code: 'READ_INCOMPLETE' });
  const saved = f.report(receipt.id, [], { complete: false, position: {
    query: { source: 'persisted', direction: 'backward' },
    nextQuery: { source: 'persisted', direction: 'backward', cursor: 'opaque-older' }, boundaryEventId: null,
  } });
  assert.equal(saved.checkpointState, 'not-advanced');
  assert.throws(() => f.resolve(receipt.id), { code: 'READ_INCOMPLETE' });
  const recovered = new Inbox(f.store, () => false).pending(caller.sessionId, 0).items[0]!;
  assert.equal(recovered.progress[0]!.position!.nextQuery!.cursor, 'opaque-older');
  f.report(receipt.id, [a.id]);
  assert.equal(f.store.inbox().length, 1, 'Reading and handling remain separate');
  f.resolve(receipt.id);
  assert.equal(f.store.inbox().length, 0);
});

test('concurrent new pointers survive older exact-range handling and duplicate callbacks', t => {
  const f = fixture(); t.after(f.close);
  const a = f.pointer('a'), receipt = f.read();
  f.pointer('later'); f.report(receipt.id, [a.id]);
  const result = f.resolve(receipt.id, 'notified');
  assert.equal(result.disposition, 'reported-notified');
  assert.equal(result.userDeliveryVerified, false);
  assert.equal(result.chatReadVerified, false);
  assert.deepEqual(f.store.inbox().map(item => item.native_id), ['later']);
  f.store.enqueuePointer('source', 'a', 'reply', { eventId: 'event-a', timestamp: 1 });
  assert.deepEqual(f.store.inbox().map(item => item.native_id), ['later']);
  assert.equal(f.resolve(receipt.id, 'notified').decidedAt, result.decidedAt);
  assert.throws(() => f.resolve(receipt.id), { code: 'DECISION_CONFLICT' });
});

test('late older read reports cannot replace a newer completed checkpoint', t => {
  const f = fixture(); t.after(f.close);
  const a = f.pointer('a'), older = f.read();
  const b = f.pointer('b'), newer = f.read();
  assert.equal(f.report(newer.id, [a.id, b.id]).checkpointState, 'advanced');
  assert.equal(f.report(older.id, [a.id]).checkpointState, 'stale-base');
  f.pointer('c');
  assert.equal(f.read().sources[0]!.checkpoint!.receiptId, newer.id);
  f.resolve(older.id);
  assert.deepEqual(f.store.inbox().map(item => item.native_id), ['b', 'c']);
});

test('source and direction are retained; only real live bootstrap can switch to forward', t => {
  const f = fixture(); t.after(f.close);
  const a = f.pointer('a'), receipt = f.read();
  assert.throws(() => f.report(receipt.id, [a.id], { position: {
    query: { source: 'persisted', direction: 'backward' },
    nextQuery: { source: 'persisted', direction: 'forward', cursor: 'not-a-forward-cursor' }, boundaryEventId: 'a',
  } }), { code: 'CHECKPOINT_QUERY' });
  assert.throws(() => f.report(receipt.id, [a.id], { position: {
    query: { source: 'persisted', direction: 'backward' },
    nextQuery: { source: 'live', direction: 'backward', cursor: 'different-source' }, boundaryEventId: 'a',
  } }), { code: 'CHECKPOINT_QUERY' });
  const valid = f.report(receipt.id, [a.id], { position: {
    query: { source: 'live', direction: 'backward', bootstrap: true },
    nextQuery: { source: 'live', direction: 'forward', cursor: 'actual-host-live-cursor' }, boundaryEventId: 'a',
  } });
  assert.equal(valid.checkpointState, 'advanced');
  assert.equal(valid.chatReadVerified, false, 'The service records a report, not token certification');
});

test('checkpoint revisions fence stale bases even when the same receipt advances twice', t => {
  const f = fixture(); t.after(f.close);
  const a = f.pointer('a'), first = f.read();
  const initial = f.report(first.id, [a.id]);
  f.pointer('b'); const stale = f.read();
  const advanced = f.report(first.id, [a.id], {
    expectedCheckpointVersion: initial.checkpoint!.version,
    position: { query: { source: 'persisted', direction: 'backward' }, nextQuery: null, boundaryEventId: 'event-3' },
  });
  assert.equal(advanced.checkpointState, 'advanced');
  assert.notEqual(advanced.checkpoint!.version, initial.checkpoint!.version);
  assert.equal(f.report(stale.id, stale.inboxIds, {
    position: { query: { source: 'persisted', direction: 'backward' }, nextQuery: null, boundaryEventId: 'event-2' },
  }).checkpointState, 'stale-base');
  f.pointer('c');
  assert.equal(f.read().sources[0]!.checkpoint!.position.boundaryEventId, 'event-3');
});

test('repeated identical reports do not invent another checkpoint revision', t => {
  const f = fixture(); t.after(f.close);
  const a = f.pointer('a'), receipt = f.read();
  const first = f.report(receipt.id, [a.id]), replay = f.report(receipt.id, [a.id]);
  assert.equal(replay.checkpointState, 'unchanged');
  assert.equal(replay.checkpoint!.version, first.checkpoint!.version);
});

test('cursor gaps stay explicit and require deliberate reconstruction', t => {
  const f = fixture(); t.after(f.close);
  const a = f.pointer('a'), receipt = f.read();
  f.report(receipt.id, [], { complete: false, gap: 'Host cursor expired after rewind' });
  assert.throws(() => f.report(receipt.id, [a.id]), { code: 'READ_GAP' });
  assert.throws(() => f.resolve(receipt.id), { code: 'READ_INCOMPLETE' });
  assert.equal(f.report(receipt.id, [a.id], { reset: true }).checkpointState, 'advanced');
});

test('initial recent windows cannot claim checkpoint-relative coverage and completed reads do not regress', t => {
  const f = fixture(); t.after(f.close);
  const a = f.pointer('a'), receipt = f.read();
  assert.throws(() => f.report(receipt.id, [a.id], { position: {
    query: { source: 'persisted', direction: 'backward' }, nextQuery: null,
    boundaryEventId: 'a', coverage: 'since-checkpoint',
  } }), { code: 'CHECKPOINT_BOUNDARY' });
  f.report(receipt.id, [a.id]);
  assert.throws(() => f.report(receipt.id, [], { complete: false }), { code: 'READ_COMPLETE' });
});

test('Host since and checkpoint tokens survive interrupted reads without advancing or handling', t => {
  const f = fixture(); t.after(f.close);
  const a = f.pointer('a'), baseline = f.read();
  f.report(baseline.id, [a.id], { position: {
    query: { source: 'persisted', direction: 'backward' }, nextQuery: null,
    boundaryEventId: null, hostCheckpoint: 'host-baseline',
  } });
  f.resolve(baseline.id);
  const b = f.pointer('b'), receipt = f.read();
  const query = { source: 'persisted', direction: 'backward', since: 'host-baseline',
    limit: 16, max_bytes: 8192, scan_pages: 4 };
  const nextQuery = { ...query, cursor: 'x'.repeat(32768) };
  f.report(receipt.id, [], { complete: false, position: {
    query, nextQuery, boundaryEventId: null, coverage: 'since-checkpoint',
  } });
  const recovered = new Inbox(f.store, () => false).pending(caller.sessionId, 0).items[0]!;
  assert.deepEqual(recovered.progress[0]!.position!.nextQuery, nextQuery);
  assert.equal(recovered.sources[0]!.checkpoint!.position.hostCheckpoint, 'host-baseline');
  assert.throws(() => f.resolve(receipt.id), { code: 'READ_INCOMPLETE' });
  const result = f.report(receipt.id, [b.id], { position: {
    query: nextQuery, nextQuery: null, boundaryEventId: 'event-b',
    hostCheckpoint: 'host-next', coverage: 'since-checkpoint',
  } });
  assert.equal(result.checkpoint!.position.hostCheckpoint, 'host-next');
  assert.equal(f.store.inbox().length, 1, 'A Host checkpoint does not report user-facing handling');
  f.resolve(receipt.id);
});

test('Host since tokens cannot become forward cursors or change across a continuation', t => {
  const f = fixture(); t.after(f.close);
  const a = f.pointer('a'), receipt = f.read();
  for (const position of [
    { query: { source: 'persisted', direction: 'forward', since: 'host-token' }, nextQuery: null },
    { query: { source: 'live', direction: 'backward', bootstrap: true, since: 'host-token' }, nextQuery: null },
    { query: { source: 'persisted', direction: 'backward', since: 'host-token' },
      nextQuery: { source: 'persisted', direction: 'backward', since: 'different-token', cursor: 'cursor' } },
  ]) assert.throws(() => f.report(receipt.id, [a.id], { position: { ...position, boundaryEventId: 'event-a' } }),
    { code: 'CHECKPOINT_QUERY' });
});

test('reopening the Assistant database preserves partial positions, CAS and pending handling', t => {
  const root = mkdtempSync(join(tmpdir(), 'assistant-position-reopen-'));
  const path = join(root, 'assistant.sqlite');
  let f = fixture(path);
  t.after(() => { f.close(); rmSync(root, { recursive: true }); });
  const a = f.pointer('a'), baseline = f.read();
  const saved = f.report(baseline.id, [a.id], { position: {
    query: { source: 'persisted', direction: 'backward' }, nextQuery: null,
    boundaryEventId: 'event-a', hostCheckpoint: 'opaque-caller-owned-baseline',
  } });
  f.resolve(baseline.id);
  const b = f.pointer('b'), receipt = f.read();
  const position = {
    query: { source: 'persisted', direction: 'backward', since: saved.checkpoint!.position.hostCheckpoint,
      limit: 4, max_bytes: 8192, scan_pages: 2 },
    nextQuery: { source: 'persisted', direction: 'backward', since: saved.checkpoint!.position.hostCheckpoint,
      cursor: 'opaque-partial-continuation', limit: 4, max_bytes: 8192, scan_pages: 2 },
    boundaryEventId: null, coverage: 'since-checkpoint',
  };
  f.report(receipt.id, [], { complete: false, position });
  f.close(); f = fixture(path);
  f.store.recover();
  const recovered = f.inbox.pending(caller.sessionId, 0).items[0]!;
  assert.equal(recovered.id, receipt.id);
  assert.deepEqual(recovered.progress[0]!.position, position);
  assert.deepEqual(recovered.sources[0]!.checkpoint, saved.checkpoint);
  assert.equal(recovered.disposition, 'unresolved');
  assert.throws(() => f.resolve(receipt.id), { code: 'READ_INCOMPLETE' });
  f.pointer('c');
  const stale = f.read();
  const completed = f.report(receipt.id, [b.id], {
    expectedCheckpointVersion: saved.checkpoint!.version,
    position: { query: position.nextQuery, nextQuery: null, hostCheckpoint: 'opaque-next-boundary',
      boundaryEventId: 'event-b', coverage: 'since-checkpoint' },
  });
  f.close(); f = fixture(path);
  assert.equal(f.read().id, stale.id);
  assert.equal(f.inbox.pending(caller.sessionId, 0).items.find(item => item.id === receipt.id)!.progress[0]!.complete, true);
  assert.equal(f.report(stale.id, stale.inboxIds, { position: {
    query: position.query, nextQuery: null, boundaryEventId: 'event-c', hostCheckpoint: 'older-report',
  } }).checkpointState, 'stale-base');
  f.resolve(receipt.id);
  assert.deepEqual(f.store.inbox().map(item => item.native_id), ['c']);
  assert.equal(f.read().sources[0]!.checkpoint!.version, completed.checkpoint!.version);
  assert.ok(f.store.inbox().every(item => item.text === '' && item.question === null && !item.attachments.length));
});

test('an explicit legacy-position gap survives database reopen without discarding pending pointers', t => {
  const root = mkdtempSync(join(tmpdir(), 'assistant-position-gap-'));
  const path = join(root, 'assistant.sqlite');
  let f = fixture(path);
  t.after(() => { f.close(); rmSync(root, { recursive: true }); });
  const a = f.pointer('a'), receipt = f.read();
  const position = { query: { source: 'persisted', direction: 'backward', cursor: 'legacy-opaque-token' },
    nextQuery: null, boundaryEventId: null };
  f.report(receipt.id, [], { complete: false, position, gap: 'Host rejected incompatible legacy position' });
  f.close(); f = fixture(path);
  f.store.recover();
  const recovered = f.inbox.pending(caller.sessionId, 0).items[0]!;
  assert.equal(recovered.progress[0]!.position!.query.cursor, 'legacy-opaque-token');
  assert.equal(recovered.progress[0]!.gap, 'Host rejected incompatible legacy position');
  assert.equal(f.store.inbox()[0]!.id, a.id);
  assert.throws(() => f.resolve(receipt.id), { code: 'READ_INCOMPLETE' });
  assert.throws(() => f.report(receipt.id, [a.id]), { code: 'READ_GAP' });
  assert.equal(f.store.inbox().length, 1);
});

test('explicit partial-cursor recovery retains the original since interval instead of a recent baseline', t => {
  const f = fixture(); t.after(f.close);
  const a = f.pointer('a'), baseline = f.read();
  const saved = f.report(baseline.id, [a.id], { position: {
    query: { source: 'persisted', direction: 'backward' }, nextQuery: null,
    boundaryEventId: 'event-a', hostCheckpoint: 'original-since',
  } });
  f.resolve(baseline.id);
  const b = f.pointer('b'), receipt = f.read();
  const query = { source: 'persisted', direction: 'backward', since: saved.checkpoint!.position.hostCheckpoint };
  f.report(receipt.id, [], { complete: false, gap: 'Native partial page changed', position: {
    query: { ...query, cursor: 'changed-page' }, nextQuery: null,
    boundaryEventId: null, coverage: 'since-checkpoint',
  } });
  const resumed = f.report(receipt.id, [], { complete: false, reset: true, position: {
    query, nextQuery: { ...query, cursor: 'new-actual-host-continuation' },
    boundaryEventId: null, coverage: 'since-checkpoint',
  } });
  assert.equal(resumed.checkpointState, 'not-advanced');
  assert.equal(resumed.checkpoint!.version, saved.checkpoint!.version);
  assert.equal(resumed.receipt.progress[0]!.position!.query.since, 'original-since');
  assert.equal(resumed.receipt.progress[0]!.position!.query.cursor, undefined);
  assert.throws(() => f.resolve(receipt.id), { code: 'READ_INCOMPLETE' });
  f.pointer('later');
  f.report(receipt.id, [b.id], { position: {
    query, nextQuery: null, boundaryEventId: 'event-b', hostCheckpoint: 'fully-read-next',
    coverage: 'since-checkpoint',
  } });
  f.resolve(receipt.id);
  assert.deepEqual(f.store.inbox().map(item => item.native_id), ['later']);
});

test('ask checkpoints do not turn request IDs into native Chat cursors', t => {
  const f = fixture(); t.after(f.close);
  const ask = f.pointer('request', 'source', 'ask'), receipt = f.read();
  const result = f.report(receipt.id, [ask.id], { position: null });
  assert.equal(result.checkpointState, 'not-advanced');
  f.resolve(receipt.id);
  assert.equal(f.store.inbox().length, 0);
});

test('foreign receipts and source IDs cannot acknowledge another pending range', t => {
  const f = fixture(); t.after(f.close);
  const a = f.pointer('a'), b = f.pointer('b', 'other'), receipt = f.read();
  assert.throws(() => f.report(receipt.id, [b.id]), { code: 'READ_IDS' });
  assert.throws(() => f.report(receipt.id, ['unknown']), { code: 'READ_IDS' });
  assert.throws(() => f.inbox.resolve({ ...caller, sessionId: 'other' },
    resolveInput.parse({ receiptId: receipt.id, disposition: 'silent' })), { code: 'READ_RECEIPT' });
  f.report(receipt.id, [a.id]);
  assert.throws(() => f.resolve(receipt.id), { code: 'READ_INCOMPLETE' });
});

test('old unresolved receipts with no remaining rows never crowd out actionable pending pages', t => {
  const f = fixture(); t.after(f.close);
  for (let i = 0; i < 55; i++) {
    const item = f.pointer(`old-${i}`); f.read(); f.store.removeResolved([item.id]);
  }
  f.pointer('current'); const receipt = f.read();
  assert.deepEqual(f.inbox.pending(caller.sessionId, 0).items.map(item => item.id), [receipt.id]);
});
