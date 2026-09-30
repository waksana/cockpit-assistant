import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Database } from '../src/database.ts';
import { BusinessError } from '../src/errors.ts';
import { MemoryEngine } from '../src/memory.ts';
import type { Memory, Message, Topic, Work } from '../src/types.ts';

function fixture(t: TestContext) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const engine = new MemoryEngine(db);
  const topic = (id: string): Topic => {
    const value: Topic = { id, title: id, content: '', color: '#336699', sessionId: null,
      archived: false, version: 1, dirtyThrough: 0, memoryThrough: 0 };
    db.transaction(() => db.put('topics', value));
    return value;
  };
  const message = (topicId: string, raw = 'Original evidence'): Message => db.transaction(() => {
    const sequence = db.next('messageSequence');
    const value: Message = { id: `message-${sequence}`, kind: 'user', raw, attachments: [], version: 1, topicId,
      assignmentVersion: 1, assignmentReason: 'Initial classification', sessionId: null,
      nativeEventId: null, nativeMessageId: null, nativeParentId: null, correlation: 'unknown',
      historical: false, sequence, createdAt: sequence };
    db.put('messages', value);
    const current = db.must('topics', topicId);
    current.dirtyThrough = sequence;
    db.put('topics', current);
    return value;
  });
  const schedule = (id = 'topic', kind: 'memory' | 'handoff' = 'memory') =>
    db.transaction(() => engine.schedule(id, kind));
  const commit = (work: Work, kind: Memory['kind'] = 'confirmed') =>
    db.transaction(() => engine.commit(work, [{ kind, text: 'Derived evidence', sources: work.sources }]));
  topic('topic');
  return { db, engine, topic, message, schedule, commit };
}

const code = (expected: string) => (error: unknown): boolean =>
  error instanceof BusinessError && error.code === expected;

test('empty topics do not schedule; duplicate pending and leased snapshots are reused', t => {
  const f = fixture(t);
  assert.equal(f.schedule(), null);
  assert.equal(f.schedule('topic', 'handoff'), null);
  const source = f.message('topic');
  const first = f.schedule()!;
  assert.deepEqual(first.sources, [{ messageId: source.id, version: 1, assignmentVersion: 1 }]);
  assert.equal(f.schedule()!.id, first.id);
  f.db.transaction(() => f.db.put('work', { ...first, state: 'leased', epoch: 1, token: 'lease' }));
  assert.equal(f.schedule()!.id, first.id);
  const handoff = f.schedule('topic', 'handoff')!;
  assert.equal(f.schedule('topic', 'handoff')!.id, handoff.id);
  assert.notEqual(handoff.id, first.id);
  assert.equal(f.db.list('work').items.length, 2);
});

test('commits preserve mixed evidence kinds and progress independent per-topic versions', t => {
  const f = fixture(t);
  f.message('topic');
  const first = f.schedule()!;
  const result = f.db.transaction(() => f.engine.commit(first, [
    { kind: 'confirmed', text: 'Explicitly confirmed', sources: first.sources },
    { kind: 'reported', text: 'Reported by a reception', sources: first.sources },
    { kind: 'inferred', text: 'Only an inference', sources: first.sources },
  ]));
  assert.equal(result.version, 1);
  assert.deepEqual(result.entries.map(entry => entry.kind), ['confirmed', 'reported', 'inferred']);
  assert.equal(f.db.must('work', first.id).state, 'done');
  assert.equal(f.schedule(), null);
  const newer = f.message('topic');
  const second = f.schedule()!;
  assert.deepEqual(second.sources.map(source => source.messageId), [newer.id]);
  assert.equal(f.commit(second).version, 2);
  assert.deepEqual(f.engine.list('topic').items.map(item => item.version), [1, 1, 1, 2]);
  assert.equal(f.db.must('topics', 'topic').memoryThrough, newer.sequence);
  assert.equal(f.db.must('topics', 'topic').version, 3);
  f.topic('other');
  f.message('other');
  assert.equal(f.commit(f.schedule('other')!).version, 1);
});

test('new sources arriving during pending work remain dirty and outside the immutable snapshot', t => {
  const f = fixture(t);
  const first = f.message('topic');
  const work = f.schedule()!;
  const newer = f.message('topic');
  f.commit(work);
  const topic = f.db.must('topics', 'topic');
  assert.equal(topic.memoryThrough, first.sequence);
  assert.equal(topic.dirtyThrough, newer.sequence);
  assert.equal(work.through, first.sequence);
  assert.deepEqual(f.db.must('work', work.id).sources, work.sources);
  assert.deepEqual(f.schedule()!.sources.map(source => source.messageId), [newer.id]);
});

test('out-of-order batches never advance coverage beyond an unfinished earlier source', t => {
  const f = fixture(t);
  for (let i = 0; i < 203; i++) f.message('topic');
  const first = f.schedule()!;
  const second = f.schedule()!;
  assert.equal(first.sources.length, 200);
  assert.equal(second.sources.length, 3);
  f.commit(second);
  assert.equal(f.db.must('topics', 'topic').memoryThrough, 0);
  f.commit(first);
  assert.equal(f.db.must('topics', 'topic').memoryThrough, 203);
  assert.equal(f.schedule(), null);
  assert.equal(f.engine.list('topic').items.length, 2);
});

test('one explicit schedule automatically drains only its original bounded wave', t => {
  for (const kind of ['memory', 'handoff'] as const) {
    const f = fixture(t);
    for (let i = 0; i < 203; i++) f.message('topic');
    const initial = f.schedule('topic', kind)!;
    const newer = f.message('topic');
    const processed: string[] = [];
    let batches = 0;
    for (;;) {
      const pending = f.db.find('work', work => work.kind === kind && work.state === 'pending')[0];
      if (!pending) break;
      assert.ok(++batches <= 2, 'Completion must not start another handoff cycle');
      const leased: Work = { ...pending, state: 'leased', epoch: 1, token: `lease-${batches}`, leaseUntil: 1000 };
      f.db.transaction(() => f.db.put('work', leased));
      assert.ok(leased.sources.length <= 200);
      processed.push(...leased.sources.map(source => source.messageId));
      f.commit(leased);
    }
    assert.equal(initial.sources.length, 200);
    assert.equal(batches, 2);
    assert.equal(processed.length, 203);
    assert.equal(new Set(processed).size, 203);
    assert.ok(!processed.includes(newer.id));
    assert.equal(f.db.must('topics', 'topic').dirtyThrough, 204);
    assert.equal(f.db.must('topics', 'topic').memoryThrough, kind === 'memory' ? 203 : 0);
    assert.equal(f.db.find('work', work => work.state === 'pending' || work.state === 'leased').length, 0);
    const extended = f.schedule('topic', kind)!;
    assert.deepEqual(extended.sources.map(source => source.messageId), [newer.id]);
    f.commit(extended);
    assert.equal(f.db.find('work', work => work.state === 'pending').length, 0);
  }
});

test('an explicit schedule can extend an active cycle cutoff without overlapping batches', t => {
  const f = fixture(t);
  for (let i = 0; i < 203; i++) f.message('topic');
  const first = f.schedule()!;
  const newer = f.message('topic');
  const extended = f.schedule()!;
  assert.equal(extended.sources.length, 4);
  assert.equal(extended.through, newer.sequence);
  f.commit(first);
  assert.equal(f.db.must('topics', 'topic').memoryThrough, 200);
  assert.equal(f.db.find('work', work => work.state === 'pending').length, 1);
  f.commit(extended);
  assert.equal(f.db.must('topics', 'topic').memoryThrough, 204);
  assert.equal(f.db.find('work', work => work.state === 'pending').length, 0);
});

test('continuation creation and coverage roll back together with the caller transaction', t => {
  const f = fixture(t);
  for (let i = 0; i < 203; i++) f.message('topic');
  const first = f.schedule()!;
  assert.throws(() => f.db.transaction(() => {
    f.engine.commit(first, []);
    assert.equal(f.db.find('work', work => work.state === 'pending').length, 1);
    throw new Error('Caller operation failed');
  }), /Caller operation failed/);
  assert.equal(f.db.list('work').items.length, 1);
  assert.equal(f.db.must('work', first.id).state, 'pending');
  assert.equal(f.db.must('topics', 'topic').memoryThrough, 0);
  f.commit(first);
  const next = f.db.find('work', work => work.state === 'pending')[0]!;
  assert.equal(next.sources.length, 3);
  assert.equal(f.db.must('topics', 'topic').memoryThrough, 200);
});

test('handoff sources also progress in bounded slices without covering ordinary memory', t => {
  const f = fixture(t);
  for (let i = 0; i < 203; i++) f.message('topic');
  const first = f.schedule('topic', 'handoff')!;
  assert.equal(first.sources.length, 200);
  assert.equal(first.through, 200);
  f.commit(first);
  const second = f.schedule('topic', 'handoff')!;
  assert.equal(second.sources.length, 3);
  assert.equal(second.through, 203);
  assert.deepEqual(second.sources.map(source => source.messageId), ['message-201', 'message-202', 'message-203']);
  assert.equal(f.schedule('topic', 'handoff')!.id, second.id);
  f.commit(second);
  assert.equal(f.db.must('topics', 'topic').memoryThrough, 0);
  assert.equal(f.db.must('topics', 'topic').dirtyThrough, 203);
  const ordinary = f.schedule()!;
  assert.equal(ordinary.sources.length, 200);
  assert.equal(ordinary.through, 200);
  const subsequentHandoff = f.schedule('topic', 'handoff')!;
  assert.equal(subsequentHandoff.sources.length, 200);
  assert.equal(subsequentHandoff.through, 200);
});

test('stale source rejection rolls back the whole caller transaction without partial entries', t => {
  const f = fixture(t);
  const original = f.message('topic');
  const changed = f.message('topic');
  const work = f.schedule()!;
  f.db.transaction(() => f.db.put('messages', { ...changed, version: 2 }));
  assert.throws(() => f.db.transaction(() => {
    f.db.setMeta('caller-change', true);
    f.engine.commit(work, [
      { kind: 'confirmed', text: 'Valid first entry', sources: [work.sources[0]!] },
      { kind: 'inferred', text: 'Stale second entry', sources: [work.sources[1]!] },
    ]);
  }), code('STALE_SOURCE'));
  assert.equal(f.db.meta('caller-change', false), false);
  assert.equal(f.engine.list('topic').items.length, 0);
  assert.equal(f.db.must('topics', 'topic').version, 1);
  assert.equal(f.db.must('topics', 'topic').memoryThrough, 0);
  assert.equal(f.db.must('work', work.id).state, 'pending');
  assert.deepEqual(f.db.must('messages', original.id), original);
});

test('even an unused stale work source prevents advancing the watermark', t => {
  const f = fixture(t);
  f.message('topic');
  const changed = f.message('topic');
  const work = f.schedule()!;
  f.db.transaction(() => f.db.put('messages', { ...changed, assignmentVersion: 2 }));
  assert.throws(() => f.db.transaction(() => f.engine.commit(work, [
    { kind: 'confirmed', text: 'Uses only unchanged source', sources: [work.sources[0]!] },
  ])), code('STALE_SOURCE'));
  assert.equal(f.engine.list('topic').items.length, 0);
});

test('entry refs must be exact snapshot members even when other current topic evidence exists', t => {
  const f = fixture(t);
  f.message('topic');
  const work = f.schedule()!;
  const newer = f.message('topic');
  for (const source of [
    { messageId: newer.id, version: 1, assignmentVersion: 1 },
    { ...work.sources[0]!, version: 2 },
    { ...work.sources[0]!, assignmentVersion: 2 },
  ]) {
    assert.throws(() => f.db.transaction(() => f.engine.commit(work, [
      { kind: 'confirmed', text: 'Valid first', sources: work.sources },
      { kind: 'reported', text: 'Not in snapshot', sources: [source] },
    ])), code('SOURCE_MISMATCH'));
  }
  assert.equal(f.engine.list('topic').items.length, 0);
  assert.equal(f.commit(work).version, 1);
  assert.throws(() => f.commit(work), code('STALE_WORK'));
});

test('handoff summaries are separate from ordinary memories and do not switch foreground', t => {
  const f = fixture(t);
  const source = f.message('topic');
  f.db.transaction(() => f.db.setMeta('foregroundTopic', 'other-foreground'));
  const handoff = f.schedule('topic', 'handoff')!;
  const result = f.commit(handoff, 'reported');
  assert.equal(result.kind, 'handoff');
  assert.equal(f.engine.list('topic').items.length, 0);
  assert.equal(f.db.must('topics', 'topic').memoryThrough, 0);
  assert.equal(f.db.must('topics', 'topic').dirtyThrough, source.sequence);
  assert.equal(f.db.meta('foregroundTopic', ''), 'other-foreground');
  assert.equal(f.commit(f.schedule()!).version, 1);
  assert.equal(f.schedule(), null);
  assert.ok(f.schedule('topic', 'handoff'));
  f.db.transaction(() => f.engine.invalidate(source.id, 'Corrected evidence'));
  const invalidated = f.db.must('work', handoff.id).result as typeof result;
  assert.equal(invalidated.entries[0]!.valid, false);
  assert.equal(invalidated.entries[0]!.correction, 'Corrected evidence');
});

test('corrections invalidate history and leased snapshots without modifying original evidence', t => {
  const f = fixture(t);
  const source = f.message('topic');
  f.commit(f.schedule()!);
  const pending = f.schedule('topic', 'handoff')!;
  f.db.transaction(() => {
    f.db.put('work', { ...pending, state: 'leased', epoch: 1, token: 'token' });
    f.engine.invalidate(source.id, 'User correction');
  });
  assert.deepEqual(f.db.must('messages', source.id), source);
  assert.equal(f.db.must('work', pending.id).state, 'invalidated');
  assert.equal(f.engine.list('topic').items[0]!.valid, false);
  assert.equal(f.engine.list('topic').items[0]!.correction, 'User correction');
  f.db.transaction(() => f.db.put('messages', { ...source, version: 2, raw: 'Corrected evidence' }));
  const revised = f.schedule()!;
  assert.equal(revised.sources[0]!.version, 2);
  assert.equal(f.commit(revised).version, 2);
  assert.deepEqual(f.engine.list('topic').items.map(item => item.valid), [false, true]);
});

test('reclassification rebuilds remaining sources and old-sequence arrivals in the destination', t => {
  const f = fixture(t);
  f.topic('destination');
  const moved = f.message('topic');
  const remaining = f.message('topic');
  const destinationSource = f.message('destination');
  f.commit(f.schedule()!);
  f.commit(f.schedule('destination')!);
  const pending = f.schedule('topic', 'handoff')!;
  f.db.transaction(() => {
    f.engine.invalidate(moved.id, 'Reclassified');
    f.db.put('messages', { ...moved, topicId: 'destination', assignmentVersion: 2 });
    const destination = f.db.must('topics', 'destination');
    destination.dirtyThrough = Math.max(destination.dirtyThrough, moved.sequence);
    f.db.put('topics', destination);
  });
  assert.equal(f.db.must('work', pending.id).state, 'invalidated');
  const oldTopic = f.schedule()!;
  assert.deepEqual(oldTopic.sources.map(source => source.messageId), [remaining.id]);
  const newTopic = f.schedule('destination')!;
  assert.deepEqual(newTopic.sources, [{ messageId: moved.id, version: 1, assignmentVersion: 2 }]);
  f.commit(oldTopic);
  f.commit(newTopic);
  assert.equal(f.db.must('topics', 'destination').memoryThrough, destinationSource.sequence);
  assert.deepEqual(f.engine.list('topic').items.map(item => item.valid), [false, true]);
  assert.equal(f.schedule(), null);
  assert.equal(f.schedule('destination'), null);
});

test('source topic changes and caller mutation of a snapshot cannot be committed', t => {
  const f = fixture(t);
  f.topic('other');
  const source = f.message('topic');
  const work = f.schedule()!;
  assert.throws(() => f.commit({ ...work, through: work.through + 1 }), code('STALE_WORK'));
  f.db.transaction(() => f.db.put('messages', { ...source, topicId: 'other' }));
  assert.throws(() => f.commit(work), code('STALE_SOURCE'));
  assert.equal(f.engine.list('topic').items.length, 0);
});

test('entry counts, evidence counts, and text lengths are bounded; empty results may cover evidence', t => {
  const f = fixture(t);
  f.message('topic');
  const work = f.schedule()!;
  const entry = { kind: 'confirmed' as const, text: 'Evidence', sources: work.sources };
  for (const entries of [
    Array.from({ length: 101 }, () => entry),
    [{ ...entry, sources: [] }],
    [{ ...entry, sources: Array.from({ length: 201 }, () => work.sources[0]!) }],
    [{ ...entry, text: 'x'.repeat(16_001) }],
    [{ ...entry, text: '   ' }],
  ]) {
    assert.throws(() => f.db.transaction(() => f.engine.commit(work, entries)), BusinessError);
  }
  assert.equal(f.db.must('work', work.id).state, 'pending');
  assert.equal(f.engine.list('topic').items.length, 0);
  const result = f.db.transaction(() => f.engine.commit(work, []));
  assert.deepEqual(result.entries, []);
  assert.equal(f.schedule(), null);
});

test('memory listing paginates physical rows without exposing other topics or scanning all history', t => {
  const f = fixture(t);
  f.topic('other');
  for (const topicId of ['other', 'topic', 'other', 'topic']) {
    f.message(topicId);
    f.commit(f.schedule(topicId)!);
  }
  const first = f.engine.list('topic', 0, 1);
  assert.deepEqual(first.items, []);
  assert.equal(first.cursor, 1);
  assert.equal(first.hasMore, true);
  const second = f.engine.list('topic', first.cursor, 1);
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0]!.topicId, 'topic');
  const last = f.engine.list('topic', second.cursor, 2);
  assert.equal(last.items.length, 1);
  assert.equal(last.cursor, 4);
  assert.equal(last.hasMore, false);
  assert.throws(() => f.engine.list('topic', 0, 201), code('PAGINATION'));
  assert.throws(() => f.engine.list('topic', -1), code('PAGINATION'));
});
