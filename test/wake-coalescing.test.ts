import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, proof } from './fixtures.ts';
import { wakeOccupies } from '../src/service.ts';
import { BusinessError } from '../src/errors.ts';
import type { Role, Work } from '../src/types.ts';

const wakes = (f: ReturnType<typeof fixture>, role = 'coordinator') =>
  f.db.find('deliveries', d => d.kind === 'wake' && d.sessionId === role);
const sends = (f: ReturnType<typeof fixture>, role = 'coordinator') =>
  f.calls.filter(c => c.name === 'prompt' && (c.body as { sessionId: string }).sessionId === role);
function complete(f: ReturnType<typeof fixture>, work: Work, serial: number) {
  f.service.decide(f.identities.coordinator, { ...proof(work, `decision:${serial}`),
    topic: { title: `Topic ${serial}`, independent: true }, reason: 'Synthetic contextual decision',
    action: { kind: 'clarify', text: 'Which project is intended?' } });
}
function claim(f: ReturnType<typeof fixture>, wakeId: string, role: Role = 'coordinator') {
  return f.service.claim(f.identities[role], role, 1, undefined, wakeId);
}

test('many independent inputs, pending-set changes and active drain retain one effective role reminder', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 20; i++) {
      f.service.accept({ requestId: `input:${i}`, text: 'Same text is still a separate user input' });
      await f.runtime.wake();
    }
    assert.equal(wakes(f).length, 1);
    assert.equal(sends(f).length, 1);
    const wakeId = wakes(f)[0]!.id;
    const handled = new Set<string>();
    let serial = 0;
    let work: Work | null;
    while ((work = claim(f, wakeId))) {
      handled.add(work.id);
      complete(f, work, serial++);
      if (serial === 5) f.service.accept({ requestId: 'during-drain', text: 'New input during processing' });
      await f.runtime.wake();
      assert.equal(sends(f).length, 1);
    }
    assert.equal(handled.size, 21);
    assert.equal(f.db.find('work', w => w.role === 'coordinator' && w.state !== 'done').length, 0);
    f.service.accept({ requestId: 'after-drain', text: 'Next input' });
    await f.runtime.wake();
    assert.equal(sends(f).length, 2);
    assert.equal(wakes(f).filter(d => wakeOccupies(d, f.service.now())).length, 1);
  } finally { f.close(); }
});

test('pending and calling phases absorb arrivals; claim during native call survives its late receipt', async () => {
  const f = fixture();
  let release!: () => void;
  try {
    f.service.accept({ requestId: 'first', text: 'First' });
    f.onPrompt(async () => {
      if (!release) await new Promise<void>(resolve => { release = resolve; });
    });
    const running = f.runtime.wake();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    for (let i = 0; i < 10; i++) {
      f.service.accept({ requestId: `arrived:${i}`, text: 'Next' });
      void f.runtime.wake();
    }
    const wake = wakes(f)[0]!;
    assert.equal(wake.state, 'calling');
    let n = 0;
    let work: Work | null;
    while ((work = claim(f, wake.id))) complete(f, work, n++);
    assert.equal(n, 11);
    release(); await running;
    assert.notEqual(wakes(f)[0]!.wake!.drainedAt, null);
    assert.equal(sends(f).length, 1);
    f.onPrompt(null);
    f.service.accept({ requestId: 'next-round', text: 'After the receipt' });
    await f.runtime.wake();
    assert.equal(sends(f).length, 2);
  } finally { f.close(); }
});

test('empty claim/new input races are atomic and stale drain cannot release the next reminder', async () => {
  const f = fixture();
  try {
    f.service.accept({ requestId: 'first', text: 'First' });
    await f.runtime.wake();
    const first = wakes(f)[0]!.id;
    complete(f, claim(f, first)!, 0);
    f.service.accept({ requestId: 'before-empty', text: 'Arrives before empty claim' });
    complete(f, claim(f, first)!, 1);
    assert.equal(claim(f, first), null);
    f.service.accept({ requestId: 'after-empty', text: 'Arrives after empty claim' });
    await f.runtime.wake();
    const second = wakes(f)[1]!.id;
    assert.throws(() => claim(f, first), { code: 'STALE_WAKE' });
    complete(f, claim(f, second)!, 2);
    assert.equal(claim(f, first), null, 'late duplicate empty claim only touches its original delivery');
    assert.equal(f.db.must('deliveries', second).wake!.drainedAt, null);
    assert.equal(claim(f, second), null);
    assert.equal(sends(f).length, 2);
  } finally { f.close(); }
});

test('coordinator and memory wake independently and memory drains real extraction work', async () => {
  const f = fixture();
  try {
    const input = f.service.accept({ requestId: 'source', text: 'Synthetic sourced fact' });
    const work = f.service.claim(f.identities.coordinator, 'coordinator', 1, input.work.id)!;
    f.service.decide(f.identities.coordinator, { ...proof(work), topic: { title: 'Source', independent: true },
      reason: 'Group source', action: { kind: 'clarify', text: 'Which project?' } });
    const topic = f.db.must('messages', input.message.id).topicId!;
    f.db.transaction(() => f.service.memory.schedule(topic));
    f.service.accept({ requestId: 'new', text: 'New coordinator work' });
    await f.runtime.wake();
    assert.equal(sends(f).length, 1);
    assert.equal(sends(f, 'memory').length, 1);
    const memoryWake = wakes(f, 'memory')[0]!.id;
    const memory = claim(f, memoryWake, 'memory')!;
    f.service.remember(f.identities.memory, { ...proof(memory, 'remember'), entries: [] });
    assert.equal(claim(f, memoryWake, 'memory'), null);
    assert.equal(f.db.must('work', memory.id).state, 'done');
    assert.equal(wakes(f)[0]!.wake!.claimedAt, null);
    assert.throws(() => claim(f, memoryWake), { code: 'STALE_WAKE' });
  } finally { f.close(); }
});

test('an unconsumed accepted or unknown wake remains occupied across restart, time and new work', async () => {
  for (const uncertain of [false, true]) {
    const f = fixture();
    try {
      f.service.accept({ requestId: 'first', text: 'First' });
      if (uncertain) f.fail(new Error('Lost wake receipt'));
      await f.runtime.wake();
      f.fail(null);
      f.service.recover();
      f.db.put('bindings', { ...f.db.must('bindings', 'coordinator'), ready: true });
      f.advance(900_000);
      f.service.accept({ requestId: 'next', text: 'Next' });
      await f.runtime.wake();
      assert.equal(sends(f).length, 1);
      assert.equal(wakes(f)[0]!.state, uncertain ? 'unknown' : 'accepted');
      // Explicit receipt-backed role consumption is distinct from native acceptance.
      const id = wakes(f)[0]!.id;
      let n = 0;
      let work: Work | null;
      while ((work = claim(f, id))) complete(f, work, n++);
      f.service.accept({ requestId: 'after-evidence', text: 'Later input' });
      await f.runtime.wake();
      assert.equal(sends(f).length, 2);
      assert.equal(f.db.must('deliveries', id).state, uncertain ? 'unknown' : 'accepted');
    } finally { f.close(); }
  }
});

test('expired computational drain schedules only one follow-up and preserves outstanding work', async () => {
  const f = fixture();
  try {
    const input = f.service.accept({ requestId: 'first', text: 'First' });
    await f.runtime.wake();
    claim(f, wakes(f)[0]!.id);
    f.advance(300_001);
    await f.runtime.wake();
    assert.equal(sends(f).length, 2);
    assert.equal(f.db.must('work', input.work.id).state, 'leased');
    for (let i = 0; i < 5; i++) {
      f.advance(300_001);
      f.service.accept({ requestId: `extra:${i}`, text: 'More' });
      await f.runtime.wake();
    }
    assert.equal(sends(f).length, 2, 'unconsumed follow-up cannot expire into more native queued prompts');
  } finally { f.close(); }
});

test('new epoch cannot be drained by old-session claims and unrelated native queue entries are untouched', async () => {
  const f = fixture();
  try {
    f.service.accept({ requestId: 'first', text: 'First' });
    await f.runtime.wake();
    const oldId = wakes(f)[0]!.id;
    f.metas.set('replacement', { ...f.metas.get('coordinator')!, sessionId: 'replacement' });
    await f.runtime.bind({ requestId: 'replace', role: 'coordinator', sessionId: 'replacement',
      expectedEpoch: 1, expectedModelId: 'synthetic', definitionVersion: '1' });
    await f.runtime.wake();
    assert.equal(sends(f, 'replacement').length, 1);
    assert.throws(() => claim(f, oldId), { code: 'STALE_ROLE' });
    assert.throws(() => f.service.claim({ sessionId: 'replacement', runtimeSessionId: 'replacement', subagent: false },
      'coordinator', 2, undefined, oldId), { code: 'STALE_WAKE' });
    assert.equal(f.calls.some(call => /queue|cancel|abort|remove/.test(call.name)), false);
  } finally { f.close(); }
});

test('claims unrelated to a wake do not release accepted queued notifications', async () => {
  const f = fixture();
  try {
    const input = f.service.accept({ requestId: 'first', text: 'First' });
    await f.runtime.wake();
    complete(f, f.service.claim(f.identities.coordinator, 'coordinator', 1, input.work.id)!, 0);
    assert.equal(f.service.claim(f.identities.coordinator, 'coordinator', 1), null);
    f.service.accept({ requestId: 'next', text: 'Next' });
    await f.runtime.wake();
    assert.equal(sends(f).length, 1);
    assert.equal(wakes(f)[0]!.wake!.claimedAt, null);
  } finally { f.close(); }
});

test('known pre-call transition retains one pending wake and its deadline resumes without another input', async () => {
  const f = fixture();
  try {
    f.metas.get('coordinator')!.closing = true;
    f.service.accept({ requestId: 'first', text: 'First' });
    await f.runtime.wake();
    for (let i = 0; i < 8; i++) {
      f.service.accept({ requestId: `waiting:${i}`, text: 'More work while preparing' });
      await f.runtime.wake();
    }
    assert.equal(wakes(f).length, 1);
    assert.equal(wakes(f)[0]!.state, 'pending');
    assert.equal(sends(f).length, 0);
    f.metas.get('coordinator')!.closing = false;
    f.advance(1001);
    await new Promise(resolve => setTimeout(resolve, 1100));
    await f.runtime.settled();
    assert.equal(sends(f).length, 1);
    assert.equal(wakes(f)[0]!.state, 'accepted');
    assert.equal(f.db.find('work', w => w.role === 'coordinator').length, 9);
  } finally { f.close(); }
});

test('transient readiness after metadata recovers the same pending wake on its deadline', async () => {
  const f = fixture();
  try {
    let calls = 0;
    f.onReadiness(async id => {
      if (id === 'coordinator' && calls++ === 0)
        throw new BusinessError('SESSION_TRANSITION', 'Synthetic transient native readiness');
    });
    f.service.accept({ requestId: 'first', text: 'First' });
    await f.runtime.wake();
    const pending = wakes(f)[0]!;
    assert.equal(pending.state, 'pending');
    assert.equal(pending.preparation!.attempts, 1);
    assert.equal(f.db.must('bindings', 'coordinator').ready, false);
    f.advance(1001);
    await new Promise(resolve => setTimeout(resolve, 1100));
    await f.runtime.settled();
    assert.equal(wakes(f).length, 1);
    assert.equal(wakes(f)[0]!.state, 'accepted');
    assert.equal(f.db.must('bindings', 'coordinator').ready, true);
    assert.equal(sends(f).length, 1);
  } finally { f.close(); }
});
