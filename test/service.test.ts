import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, proof } from './fixtures.ts';
import { questionKey } from '../src/service.ts';

test('input is durable and idempotent; changed request body conflicts', () => {
  const f = fixture();
  try {
    const one = f.service.accept({ requestId: 'one', text: 'Hello' });
    assert.deepEqual(f.service.accept({ requestId: 'one', text: 'Hello' }), one);
    assert.equal(f.db.list('messages').items.length, 1);
    assert.throws(() => f.service.accept({ requestId: 'one', text: 'Changed' }), /different input/);
  } finally { f.close(); }
});

test('route commits inbox decision and frozen delivery atomically; late epoch cannot submit', () => {
  const f = fixture();
  try {
    const input = f.service.accept({ requestId: 'one', text: 'Build this' });
    const work = f.service.claim(f.identities.coordinator, 'coordinator', 1, input.work.id)!;
    f.service.decide(f.identities.coordinator, { ...proof(work),
      topic: { title: 'Build', independent: true }, reason: 'New user goal',
      action: { kind: 'route', sessionIds: ['s1'], routeVersion: 0 },
    });
    assert.equal(f.db.list('deliveries').items[0]?.sessionId, 's1');
    assert.equal(f.db.must('work', work.id).state, 'done');
    const old = f.db.must('bindings', 'coordinator');
    f.db.put('bindings', { ...old, epoch: 2 });
    assert.throws(() => f.service.decide(f.identities.coordinator, { ...proof(work),
      topic: { title: 'Build', independent: true }, reason: 'New user goal',
      action: { kind: 'route', sessionIds: ['s1'], routeVersion: 0 },
    }), /current role epoch/);
  } finally { f.close(); }
});

test('historically accepted reply stays at its source after handoff; new replyTo is rejected', () => {
  const f = fixture();
  try {
    f.db.put('topics', { id: 'topic', title: 'T', domain: null, relatedTo: [], pinned: false,
      archived: false, independent: true, version: 1, dirtyThrough: 0, memoryThrough: 0 });
    const output = f.db.transaction(() => f.service.addMessage({ kind: 'reply', raw: 'Old proposal', sessionId: 's1', topicId: 'topic' }));
    f.db.put('anchors', { id: output.id, messageId: output.id, sessionId: 's1', kind: 'comment', requestId: null });
    f.db.put('routes', { id: 'topic', sessionIds: ['s2'], version: 2, evidence: 'Explicit handoff' });
    assert.throws(() => f.service.accept({ requestId: 'comment', text: 'Change paragraph two', replyTo: output.id }),
      /Unrecognized key/);
    const input = f.service.accept({ requestId: 'comment', text: 'Change paragraph two' });
    f.db.put('messages', { ...input.message, replyTo: output.id });
    let work = f.service.claim(f.identities.coordinator, 'coordinator', 1, input.work.id)!;
    assert.throws(() => f.service.decide(f.identities.coordinator, { ...proof(work),
      topic: { id: 'topic' }, reason: 'Same topic', action: { kind: 'route', sessionIds: ['s2'], routeVersion: 2 },
    }), /original native target/);
    assert.equal(f.db.list('deliveries').items.length, 0);
    work = f.service.claim(f.identities.coordinator, 'coordinator', 1, input.work.id)!;
    f.service.decide(f.identities.coordinator, { ...proof(work),
      topic: { id: 'topic' }, reason: 'Anchored comment', action: { kind: 'route', sessionIds: ['s1'], routeVersion: 2 },
    });
    assert.equal(f.db.list('deliveries').items[0]?.sessionId, 's1');
    assert.deepEqual(f.db.must('routes', 'topic').sessionIds, ['s2']);
  } finally { f.close(); }
});

test('context can choose among multiple asks without literal uniqueness and preserves choice constraints', () => {
  const f = fixture();
  try {
    f.db.transaction(() => {
      f.service.syncQuestions('s1', [{ requestId: 'q1', question: 'Proceed?', choices: ['Yes', 'No'], allowFreeform: false }], true);
      f.service.syncQuestions('s2', [{ requestId: 'q2', question: 'Proceed?', choices: ['Yes', 'No'], allowFreeform: false }], true);
    });
    const input = f.service.accept({ requestId: 'answer', text: 'Yes' });
    const work = f.service.claim(f.identities.coordinator, 'coordinator', 1, input.work.id)!;
    f.service.decide(f.identities.coordinator, { ...proof(work),
      topic: { title: 'Approval', independent: true }, reason: 'Approval',
      action: { kind: 'route', sessionIds: ['s1'], routeVersion: 0, answerQuestionId: questionKey('s1', 'q1') },
    });
    assert.equal(f.db.list('deliveries').items[0]!.answerFreeform, false);
    const bad = f.service.accept({ requestId: 'freeform', text: 'Yes' });
    f.service.correct(bad.message.id, 'Sure thing', 1, 'Invalid choice must also fail at decision time');
    const badWork = f.service.claim(f.identities.coordinator, 'coordinator', 1, `message:${bad.message.id}:2`)!;
    assert.throws(() => f.service.decide(f.identities.coordinator, { ...proof(badWork),
      topic: { title: 'Approval', independent: true }, reason: 'Approval',
      action: { kind: 'route', sessionIds: ['s2'], routeVersion: 0, answerQuestionId: questionKey('s2', 'q2') },
    }), /exactly match/);
  } finally { f.close(); }
});

test('background publication leaves foreground and output source unchanged', () => {
  const f = fixture();
  try {
    for (const id of ['a', 'b']) f.db.put('topics', { id, title: id, domain: null, relatedTo: [],
      pinned: false, archived: false, independent: true, version: 1, dirtyThrough: 0, memoryThrough: 0 });
    f.db.setMeta('foregroundTopic', 'a');
    const output = f.db.transaction(() => f.service.addMessage({ kind: 'reply', raw: 'Original', sessionId: 's2' }));
    f.db.transaction(() => f.service.addWork(output));
    const work = f.service.claim(f.identities.coordinator, 'coordinator', 1, `message:${output.id}:1`)!;
    f.service.decide(f.identities.coordinator, { ...proof(work), topic: { id: 'b' },
      reason: 'Background result', action: { kind: 'publish', text: 'Edited summary' } });
    assert.equal(f.db.meta('foregroundTopic', null), 'a');
    assert.equal(f.db.must('messages', output.id).raw, 'Original');
    assert.equal(f.db.list('publications').items[0]?.text, 'Edited summary');
    assert.equal(f.db.must('messages', output.id).sessionId, 's2');
    assert.equal(f.db.get('anchors', output.id), undefined);
    assert.equal(f.db.list('publications').items[0]?.anchorId, null);
  } finally { f.close(); }
});

test('risk notice matches publication and supplement, is rate limited, and never attaches to ask', () => {
  const f = fixture();
  try {
    const route = (key: string) => {
      const input = f.service.accept({ requestId: key, text: `Work on ${key}` });
      const work = f.service.claim(f.identities.coordinator, 'coordinator', 1, input.work.id)!;
      f.service.decide(f.identities.coordinator, { ...proof(work),
        topic: { title: key, independent: true }, reason: 'Independent goal',
        action: { kind: 'route', sessionIds: ['s1'], routeVersion: 0 } });
    };
    route('a'); route('b');
    const risk = f.db.find('publications', p => p.type === 'risk')[0]!;
    assert.ok(risk);
    assert.equal(f.db.list('deliveries').items[1]?.supplement, risk.text);
    const input = f.service.accept({ requestId: 'again', text: 'Continue b', topicId: risk.topicId! });
    const work = f.service.claim(f.identities.coordinator, 'coordinator', 1, input.work.id)!;
    f.service.decide(f.identities.coordinator, { ...proof(work), topic: { id: risk.topicId! },
      reason: 'Continue', action: { kind: 'route', sessionIds: ['s1'], routeVersion: 1 } });
    assert.equal(f.db.find('publications', p => p.type === 'risk').length, 1);
    f.db.transaction(() => f.service.syncQuestions('s1', [{ requestId: 'ask', question: 'Continue?', choices: ['Yes'], allowFreeform: false }], true));
    const q = f.db.must('questions', questionKey('s1', 'ask'));
    f.db.put('anchors', { id: q.messageId, messageId: q.messageId, sessionId: 's1', requestId: 'ask', kind: 'ask' });
    const answer = f.service.accept({ requestId: 'answer', text: 'Yes' });
    const answerWork = f.service.claim(f.identities.coordinator, 'coordinator', 1, answer.work.id)!;
    f.advance(900_000);
    const fresh = f.service.claim(f.identities.coordinator, 'coordinator', 1, answerWork.id)!;
    f.service.decide(f.identities.coordinator, { ...proof(fresh), topic: { id: risk.topicId! },
      reason: 'Context selects answer', action: { kind: 'route', sessionIds: ['s1'], routeVersion: 2, answerQuestionId: q.id } });
    const delivery = f.db.find('deliveries', d => d.kind === 'ask')[0]!;
    assert.equal(delivery.supplement, null);
    assert.equal(delivery.text, 'Yes');
  } finally { f.close(); }
});

test('subagents, stale snapshot and invalid routes cannot commit partial state', () => {
  const f = fixture();
  try {
    assert.throws(() => f.service.claim({ sessionId: 'coordinator', runtimeSessionId: 'child', subagent: true }, 'coordinator', 1), /Internal agents/);
    const input = f.service.accept({ requestId: 'one', text: 'Work' });
    const work = f.service.claim(f.identities.coordinator, 'coordinator', 1, input.work.id)!;
    f.service.changed();
    assert.throws(() => f.service.decide(f.identities.coordinator, { ...proof(work),
      topic: { title: 'T', independent: true }, reason: 'New', action: { kind: 'route', sessionIds: ['s1'], routeVersion: 0 } }), /state changed/);
    assert.equal(f.db.list('topics').items.length, 0);
  } finally { f.close(); }
});

test('correcting an unprocessed input replaces its work without replaying delivered inputs', () => {
  const f = fixture();
  try {
    const input = f.service.accept({ requestId: 'one', text: 'Incorrect' });
    f.service.correct(input.message.id, 'Corrected', 1, 'User correction');
    assert.equal(f.db.must('work', input.work.id).state, 'invalidated');
    const work = f.service.claim(f.identities.coordinator, 'coordinator', 1)!;
    assert.equal(work.inputVersion, 2);
    f.service.decide(f.identities.coordinator, { ...proof(work), topic: { title: 'T', independent: true },
      reason: 'Corrected goal', action: { kind: 'route', sessionIds: ['s1'], routeVersion: 0 } });
    f.service.correct(input.message.id, 'Later correction', 2, 'Record correction only');
    assert.equal(f.service.claim(f.identities.coordinator, 'coordinator', 1), null);
    assert.equal(f.db.list('deliveries').items.length, 1);
  } finally { f.close(); }
});

test('corrected sources resume the previously requested memory cycle without another topic switch', () => {
  const f = fixture();
  try {
    for (const id of ['a', 'b']) f.db.put('topics', { id, title: id, domain: null, relatedTo: [],
      pinned: false, archived: false, independent: true, version: 1, dirtyThrough: 0, memoryThrough: 0 });
    const messages = f.db.transaction(() => Array.from({ length: 201 }, (_, i) =>
      f.service.addMessage({ kind: 'reply', raw: `Result ${i}`, topicId: 'a', sessionId: 's1' })));
    f.db.setMeta('foregroundTopic', 'a');
    f.db.transaction(() => f.service.switchTopic('b'));
    const first = f.service.claim(f.identities.memory, 'memory', 1)!;
    f.service.correct(messages[0]!.id, 'Corrected result', 1, 'Source correction');
    assert.equal(f.db.must('work', first.id).state, 'invalidated');
    const replacement = f.service.claim(f.identities.memory, 'memory', 1)!;
    assert.equal(replacement.sources[0]!.version, 2);
    f.service.remember(f.identities.memory, { ...proof(replacement), entries: [] });
    const last = f.service.claim(f.identities.memory, 'memory', 1)!;
    f.service.remember(f.identities.memory, { ...proof(last), entries: [] });
    assert.equal(f.db.must('topics', 'a').memoryThrough, messages[200]!.sequence);
  } finally { f.close(); }
});

test('handoff and anchored exposure do not erase shared native topic context', () => {
  const f = fixture();
  try {
    const submit = (requestId: string, topic: { id: string } | { title: string; independent: boolean },
      sessionId: string, routeVersion: number) => {
      const input = f.service.accept({ requestId, text: `Request ${requestId}` });
      const work = f.service.claim(f.identities.coordinator, 'coordinator', 1, input.work.id)!;
      f.service.decide(f.identities.coordinator, { ...proof(work), topic, reason: 'Explicit routing',
        action: { kind: 'route', sessionIds: [sessionId], routeVersion } });
      return f.db.must('messages', input.message.id).topicId!;
    };
    const a = submit('a', { title: 'A', independent: true }, 's1', 0);
    submit('handoff', { id: a }, 's2', 1);
    submit('b', { title: 'B', independent: true }, 's1', 0);
    const risk = f.db.find('publications', p => p.type === 'risk')[0]!;
    assert.ok(risk);
    assert.match(risk.text, /A \/ B|B \/ A/);
    assert.equal(f.db.list('deliveries').items.at(-1)!.supplement, risk.text);
    assert.equal(f.db.find('exposures', item => item.sessionId === 's1').length, 2);
  } finally { f.close(); }
});
