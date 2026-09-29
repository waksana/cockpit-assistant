import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, proof } from './fixtures.ts';
import { Database } from '../src/database.ts';
import { AssistantService, questionKey } from '../src/service.ts';
import { Runtime } from '../src/runtime.ts';

const attachments = [{ type: 'file' as const, path: '/synthetic/upload', displayName: 'original' }];
function route(f: ReturnType<typeof fixture>, targets = ['s1'], requestId = 'input', question?: string) {
  const input = f.service.accept({ requestId, text: question ? 'Please explain first' : '', attachments: question ? [] : attachments });
  const work = f.service.claim(f.identities.coordinator, 'coordinator', 1, input.work.id)!;
  f.service.decide(f.identities.coordinator, { ...proof(work), topic: { title: requestId, independent: true },
    reason: 'Synthetic deliberate target selection', action: { kind: 'route', sessionIds: targets, routeVersion: 0,
      ...(question ? { answerQuestionId: question } : {}) } });
  return { input, delivery: f.db.find('deliveries', d => d.messageId === input.message.id)[0]! };
}
const prompts = (f: ReturnType<typeof fixture>, sessionId = 's1') =>
  f.calls.filter(call => call.name === 'prompt' && (call.body as { sessionId: string }).sessionId === sessionId);

test('unloaded reception is loaded by exact ID before immutable attachment-only enqueue', async () => {
  const f = fixture();
  try {
    f.metas.get('s1')!.loaded = false;
    f.metas.get('s2')!.loaded = false;
    const { delivery } = route(f);
    await f.runtime.wake('s1');
    assert.deepEqual(f.calls.filter(call => call.name === 'session/load').map(call => call.body), [{ sessionId: 's1' }]);
    assert.deepEqual(prompts(f)[0]!.body, { sessionId: 's1', mode: 'enqueue', text: '', attachments });
    assert.ok(f.calls.findIndex(c => c.name === 'session/load') < f.calls.findIndex(c => c.name === 'prompt'));
    assert.equal(f.db.must('deliveries', delivery.id).state, 'accepted');
    const operationId = f.db.must('deliveries', delivery.id).preparation!.loadOperationId!;
    assert.equal(f.db.must('operations', operationId).state, 'accepted');
    assert.equal(f.metas.get('s2')!.loaded, false, 'unselected directory entries are not loaded');
  } finally { f.close(); }
});

test('loaded busy reception enqueues without load, reload, interruption or resource changes', async () => {
  const f = fixture();
  try {
    f.metas.get('s1')!.status = 'running';
    route(f);
    await f.runtime.wake();
    assert.equal(prompts(f).length, 1);
    assert.equal((prompts(f)[0]!.body as { mode: string }).mode, 'enqueue');
    assert.equal(f.calls.some(c => ['session/load', 'session/new', 'session/reload', 'session/resources-prepare'].includes(c.name)), false);
  } finally { f.close(); }
});

test('concurrent wakes and two inputs share the loaded identity but each sends once', async () => {
  const f = fixture();
  let release!: () => void;
  try {
    f.metas.get('s1')!.loaded = false;
    route(f, ['s1'], 'first');
    route(f, ['s1'], 'second');
    f.onLoad(async () => new Promise<void>(resolve => { release = resolve; }));
    const running = f.runtime.wake();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    const concurrent = f.runtime.wake('s1');
    release();
    await Promise.all([running, concurrent]);
    assert.equal(f.calls.filter(c => c.name === 'session/load').length, 1);
    assert.equal(prompts(f).length, 2);
    assert.ok(f.db.find('deliveries', d => d.kind === 'prompt').every(d => d.state === 'accepted'));
  } finally { f.close(); }
});

test('load acknowledgment loss is separate from send uncertainty and reads state before continuing', async () => {
  const f = fixture();
  try {
    const { delivery } = route(f);
    f.metas.get('s1')!.loaded = false;
    f.onLoad(async () => { f.metas.get('s1')!.loaded = true; throw new Error('Lost load response'); });
    await f.runtime.wake();
    assert.equal(f.db.must('deliveries', delivery.id).state, 'pending');
    assert.equal(prompts(f).length, 0);
    assert.equal(f.db.find('operations', o => o.id.startsWith('delivery-load:'))[0]!.state, 'unknown');
    f.advance(1000);
    await f.runtime.wake();
    assert.equal(prompts(f).length, 1);
    assert.equal(f.calls.filter(c => c.name === 'session/load').length, 1);
  } finally { f.close(); }
});

test('closing and metadata transitions have bounded durable recovery, then one semantic follow-up', async () => {
  for (const closing of [true, false]) {
    const f = fixture();
    try {
      const { input, delivery } = route(f);
      if (closing) f.metas.get('s1')!.closing = true;
      else f.onGet(async id => { if (id === 's1') throw Object.assign(new Error('Transition'), { code: 'SESSION_TRANSITION' }); });
      await f.runtime.wake();
      assert.equal(f.db.must('deliveries', delivery.id).state, 'pending');
      await f.runtime.wake();
      assert.equal(f.db.must('deliveries', delivery.id).preparation!.attempts, 1, 'unrelated wakes do not spin');
      f.advance(1000); await f.runtime.wake();
      f.advance(2000); await f.runtime.wake();
      assert.equal(f.db.must('deliveries', delivery.id).state, 'rejected');
      assert.equal(f.db.must('work', input.work.id).state, 'pending');
      assert.equal(prompts(f).length, 0);
      assert.equal(f.calls.filter(c => c.name === 'session/load').length, 0);
      const fresh = f.service.claim(f.identities.coordinator, 'coordinator', 1, input.work.id)!;
      const topicId = f.db.must('messages', input.message.id).topicId!;
      f.service.decide(f.identities.coordinator, { ...proof(fresh, 'reconsider'), topic: { id: topicId },
        reason: 'Deliberate single reconsideration', action: { kind: 'route', sessionIds: ['s1'], routeVersion: 1 } });
      await f.runtime.wake();
      f.advance(1000); await f.runtime.wake();
      f.advance(2000); await f.runtime.wake();
      assert.equal(f.db.must('work', input.work.id).state, 'done', 'no automatic semantic retry loop');
      assert.equal(f.db.find('deliveries', d => d.messageId === input.message.id).length, 2);
    } finally { f.close(); }
  }
});

test('closing resolves on a scheduled wake without coordinator re-deciding or user resubmission', async () => {
  const f = fixture();
  try {
    const { input, delivery } = route(f);
    f.metas.get('s1')!.closing = true;
    await f.runtime.wake();
    f.metas.get('s1')!.closing = false;
    f.advance(1000);
    // Let the existing runtime timer, rather than a user/API wake, resume preparation.
    await new Promise(resolve => setTimeout(resolve, 1100));
    await f.runtime.settled();
    assert.equal(f.db.must('deliveries', delivery.id).state, 'accepted');
    assert.equal(f.db.must('work', input.work.id).state, 'done');
    assert.equal(prompts(f).length, 1);
  } finally { f.close(); }
});

test('a transient reception read during startup does not strand the durable outbox or other targets', async () => {
  const f = fixture();
  try {
    const { delivery } = route(f);
    f.onGet(async id => {
      if (id === 's1') throw Object.assign(new Error('Native identity transition'), { code: 'SESSION_TRANSITION' });
    });
    await f.runtime.start();
    assert.equal(f.db.must('deliveries', delivery.id).state, 'pending');
    assert.ok(f.errors.length > 0, 'observation errors are reported, not silently ignored');
    f.onGet(null);
    f.advance(1000);
    await f.runtime.wake();
    assert.equal(f.db.must('deliveries', delivery.id).state, 'accepted');
    assert.equal(prompts(f).length, 1);
  } finally { f.close(); }
});

test('deleted, forbidden and newly internal targets never create substitutes or send', async () => {
  for (const scenario of ['deleted', 'forbidden', 'internal-after-load'] as const) {
    const f = fixture();
    try {
      const { input, delivery } = route(f);
      f.metas.get('s1')!.loaded = false;
      if (scenario === 'deleted') f.metas.delete('s1');
      else f.onLoad(async () => {
        if (scenario === 'forbidden') throw Object.assign(new Error('Forbidden'), { code: 'FORBIDDEN' });
        f.metas.get('s1')!.roles = [{ moduleId: 'assistant', roleId: 'memory', name: 'Memory', moduleName: 'Assistant' }];
      });
      await f.runtime.wake();
      assert.equal(f.db.must('deliveries', delivery.id).state, 'rejected');
      assert.equal(f.db.must('work', input.work.id).state, 'pending');
      assert.equal(prompts(f).length, 0);
      assert.equal(f.calls.some(c => c.name === 'session/new'), false);
    } finally { f.close(); }
  }
});

test('partial multi-target recovery never repeats an accepted target and preserves attachment snapshots', async () => {
  const f = fixture();
  try {
    const { input } = route(f, ['s1', 's2']);
    f.metas.delete('s2');
    await f.runtime.wake();
    assert.equal(prompts(f).length, 1);
    const work = f.service.claim(f.identities.coordinator, 'coordinator', 1, input.work.id)!;
    assert.deepEqual((work.result as { recovery: { acceptedSessionIds: string[] } }).recovery.acceptedSessionIds, ['s1']);
    f.metas.set('s3', { ...f.metas.get('s1')!, sessionId: 's3' });
    await f.runtime.observe('s3');
    const fresh = f.service.claim(f.identities.coordinator, 'coordinator', 1, work.id)!;
    f.service.decide(f.identities.coordinator, { ...proof(fresh, 'new-target'),
      topic: { id: f.db.must('messages', input.message.id).topicId! }, reason: 'Replace only the failed recipient',
      action: { kind: 'route', sessionIds: ['s1', 's3'], routeVersion: 1 } });
    await f.runtime.wake();
    assert.equal(prompts(f).length, 1);
    assert.equal(prompts(f, 's3').length, 1);
    assert.deepEqual((prompts(f, 's3')[0]!.body as { attachments: unknown }).attachments, attachments);
  } finally { f.close(); }
});

test('unknown native prompt remains unknown across restart and blocks rerouting', async () => {
  const f = fixture();
  try {
    const { input, delivery } = route(f);
    f.fail(new Error('Native prompt acknowledgment lost'));
    await f.runtime.wake();
    assert.equal(f.db.must('deliveries', delivery.id).state, 'unknown');
    f.fail(null);
    f.service.recover();
    await f.runtime.wake();
    assert.equal(prompts(f).length, 1);
    assert.equal(f.db.must('work', input.work.id).state, 'done');
  } finally { f.close(); }
});

test('load stop/restart reuses persisted identity and does not confuse its operation with prompt intent', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'assistant-reception-'));
  const path = join(directory, 'assistant.sqlite');
  const f = fixture(path);
  try {
    const { delivery } = route(f);
    f.metas.get('s1')!.loaded = false;
    f.onLoad(async () => { f.runtime.stop(); });
    await f.runtime.wake();
    assert.equal(f.db.must('deliveries', delivery.id).state, 'pending');
    assert.equal(prompts(f).length, 0);
    f.close();
    const db = new Database(path);
    const service = new AssistantService(db, () => 1_001_000);
    const runtime = new Runtime(service, f.native, error => { throw error; }, () => {});
    try {
      service.recover();
      await runtime.wake();
      assert.equal(db.must('deliveries', delivery.id).state, 'accepted');
      assert.equal(prompts(f).length, 1);
      assert.equal(f.calls.filter(c => c.name === 'session/load').length, 1);
      service.recover();
      await runtime.wake();
      assert.equal(prompts(f).length, 1);
    } finally { runtime.stop(); db.close(); }
  } finally {
    f.runtime.stop();
    if (f.db.sql.isOpen) f.db.close();
    rmSync(directory, { recursive: true });
  }
});

test('load rechecks exact ask, supports unchanged freeform, and never answers replacements', async () => {
  for (const replacement of [false, true]) {
    const f = fixture();
    try {
      const ask = { requestId: 'original', question: 'What next?', choices: ['Proceed'], allowFreeform: true };
      f.service.syncQuestions('s1', [ask], true);
      f.metas.get('s1')!.ask = ask;
      const { delivery } = route(f, ['s1'], 'answer', questionKey('s1', 'original'));
      f.metas.get('s1')!.loaded = false;
      if (replacement) f.onLoad(async () => {
        f.metas.get('s1')!.ask = { ...ask, requestId: 'replacement' };
      });
      await f.runtime.wake('s1');
      assert.equal(f.db.must('deliveries', delivery.id).state, replacement ? 'rejected' : 'accepted');
      const answers = f.calls.filter(c => c.name === 'answer');
      assert.equal(answers.length, replacement ? 0 : 1);
      if (!replacement) assert.deepEqual(answers[0]!.body, {
        sessionId: 's1', requestId: 'original', answer: 'Please explain first', wasFreeform: true,
      });
      assert.equal(prompts(f).length, 0);
    } finally { f.close(); }
  }
});

test('newly loaded pending ask rejects ordinary attachment prompt without stripping or bypassing', async () => {
  const f = fixture();
  try {
    const { input, delivery } = route(f);
    f.metas.get('s1')!.loaded = false;
    f.onLoad(async () => { f.metas.get('s1')!.ask = {
      requestId: 'new', question: 'Proceed?', choices: ['Yes'], allowFreeform: false,
    }; });
    await f.runtime.wake();
    assert.equal(f.db.must('deliveries', delivery.id).state, 'rejected');
    assert.equal(f.db.must('work', input.work.id).state, 'pending');
    assert.deepEqual(f.db.must('deliveries', delivery.id).attachments, attachments);
    assert.equal(prompts(f).length, 0);
    assert.equal(f.calls.some(c => c.name === 'answer'), false);
  } finally { f.close(); }
});

test('corrected input never replaces the original pending delivery or enters automatic semantic replay', async () => {
  const f = fixture();
  try {
    const { input, delivery } = route(f);
    f.service.correct(input.message.id, 'new correction', 1, 'Explicit correction', []);
    f.metas.delete('s1');
    await f.runtime.wake();
    assert.deepEqual(f.db.must('deliveries', delivery.id).attachments, attachments);
    assert.equal(f.db.must('deliveries', delivery.id).text, '');
    assert.equal(f.db.must('work', input.work.id).state, 'done');
    assert.equal(f.db.find('work', w => w.messageId === input.message.id).length, 1);
  } finally { f.close(); }
});
