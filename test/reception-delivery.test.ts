import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, stageDelivery } from './fixtures.ts';
import { questionKey } from '../src/service.ts';

const attachments = [{ type: 'file' as const, path: '/synthetic/upload', displayName: 'original' }];
const prompts = (f: ReturnType<typeof fixture>, sessionId = 's1') =>
  f.calls.filter(call => call.name === 'prompt' && (call.body as { sessionId: string }).sessionId === sessionId);

test('unloaded reception loads the exact ID and receives only its frozen split prompt with attachments', async () => {
  const f = fixture();
  try {
    f.metas.get('s1')!.loaded = false;
    f.metas.get('s2')!.loaded = false;
    const delivery = stageDelivery(f, { attachments });
    await f.runtime.wake('s1');
    assert.deepEqual(f.calls.filter(c => c.name === 'session/load').map(c => c.body), [{ sessionId: 's1' }]);
    assert.deepEqual(prompts(f)[0]!.body, { sessionId: 's1', mode: 'enqueue', text: delivery.text, attachments });
    assert.equal(f.db.must('deliveries', delivery.id).state, 'accepted');
    assert.equal(f.metas.get('s2')!.loaded, false);
    assert.equal(f.calls.some(c => c.name === 'session/new'), false);
  } finally { f.close(); }
});

test('busy reception enqueues without reload, replacement, cancellation or resource changes', async () => {
  const f = fixture();
  try {
    f.metas.get('s1')!.status = 'running';
    stageDelivery(f);
    await f.runtime.wake();
    assert.equal(prompts(f).length, 1);
    assert.equal((prompts(f)[0]!.body as { mode: string }).mode, 'enqueue');
    assert.equal(f.calls.some(c => ['session/load', 'session/new', 'session/reload', 'session/resources-prepare'].includes(c.name)), false);
  } finally { f.close(); }
});

test('concurrent runtime wakes serialize pending effects and preserve each frozen attachment copy', async () => {
  const f = fixture();
  let release!: () => void;
  try {
    f.metas.get('s1')!.loaded = false;
    stageDelivery(f, { id: 'first', attachments });
    stageDelivery(f, { id: 'second', attachments, text: 'A different split' });
    f.onLoad(async () => new Promise<void>(resolve => { release = resolve; }));
    const running = f.runtime.wake();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    const concurrent = f.runtime.wake('s1');
    release();
    await Promise.all([running, concurrent]);
    assert.equal(f.calls.filter(c => c.name === 'session/load').length, 1);
    assert.equal(prompts(f).length, 2);
    assert.deepEqual(prompts(f).map(c => (c.body as { attachments: unknown }).attachments), [attachments, attachments]);
  } finally { f.close(); }
});

test('lost load acknowledgement reads the exact session before continuing without duplicate load or send', async () => {
  const f = fixture();
  try {
    const delivery = stageDelivery(f);
    f.metas.get('s1')!.loaded = false;
    f.onLoad(async () => { f.metas.get('s1')!.loaded = true; throw new Error('Lost load response'); });
    await f.runtime.wake();
    assert.equal(f.db.must('deliveries', delivery.id).state, 'pending');
    assert.equal(prompts(f).length, 0);
    f.advance(1000);
    await f.runtime.wake();
    assert.equal(prompts(f).length, 1);
    assert.equal(f.calls.filter(c => c.name === 'session/load').length, 1);
  } finally { f.close(); }
});

test('bounded preparation failure gives visible feedback without reopening whole completed input', async () => {
  const f = fixture();
  try {
    const failed = stageDelivery(f, { id: 'failed' });
    stageDelivery(f, { id: 'accepted', sessionId: 's2' });
    f.metas.get('s1')!.closing = true;
    await f.runtime.wake();
    await f.runtime.wake();
    assert.equal(f.db.must('deliveries', failed.id).preparation!.attempts, 1);
    f.advance(1000); await f.runtime.wake();
    f.advance(2000); await f.runtime.wake();
    assert.equal(f.db.must('deliveries', failed.id).state, 'rejected');
    assert.equal(f.db.must('work', `message:${failed.messageId}:1`).state, 'done');
    assert.equal(prompts(f, 's2').length, 1);
    assert.equal(prompts(f).length, 0);
    assert.ok(f.db.find('publications', p => p.messageId === failed.messageId && p.type === 'status').length);
  } finally { f.close(); }
});

test('preparation deadline resumes a known pre-send failure without another user request', async () => {
  const f = fixture();
  try {
    stageDelivery(f);
    f.metas.get('s1')!.closing = true;
    await f.runtime.wake();
    f.metas.get('s1')!.closing = false;
    f.advance(1000);
    await new Promise(resolve => setTimeout(resolve, 1100));
    await f.runtime.settled();
    assert.equal(prompts(f).length, 1);
    assert.equal(f.db.must('deliveries', 'delivery').state, 'accepted');
  } finally { f.close(); }
});

test('missing or newly internal targets never get replacements or ordinary prompts', async () => {
  for (const internal of [false, true]) {
    const f = fixture();
    try {
      stageDelivery(f);
      if (internal) f.metas.get('s1')!.roles = [
        { moduleId: 'assistant', roleId: 'memory', moduleName: 'Assistant', name: 'Memory' },
      ];
      else f.metas.delete('s1');
      await f.runtime.wake('s1');
      assert.ok(['rejected', 'cancelled'].includes(f.db.must('deliveries', 'delivery').state));
      assert.equal(prompts(f).length, 0);
      assert.equal(f.calls.some(c => c.name === 'session/new'), false);
    } finally { f.close(); }
  }
});

test('native ask uses only its original request and enforces original answer constraints', async () => {
  for (const replacement of [false, true]) {
    const f = fixture();
    try {
      const ask = { requestId: 'original', question: 'Proceed?', choices: ['Yes'], allowFreeform: false };
      f.service.syncQuestions('s1', [ask], true);
      const q = f.db.must('questions', questionKey('s1', ask.requestId));
      const output = f.db.get('work', `message:${q.messageId}:1`);
      if (output) f.db.put('work', { ...output, state: 'done' });
      f.metas.get('s1')!.ask = replacement ? { ...ask, requestId: 'replacement' } : ask;
      stageDelivery(f, { kind: 'ask', text: 'Yes', requestId: ask.requestId, answerFreeform: false });
      await f.runtime.wake();
      assert.equal(f.calls.filter(c => c.name === 'answer').length, replacement ? 0 : 1);
      assert.equal(prompts(f).length, 0);
      assert.equal(f.db.must('deliveries', 'delivery').state, replacement ? 'rejected' : 'accepted');
      assert.equal(f.db.must('questions', q.id).state, replacement ? 'stale' : 'answered');
    } finally { f.close(); }
  }
});

test('a newly discovered pending ask rejects a frozen ordinary prompt rather than implicitly answering', async () => {
  const f = fixture();
  try {
    stageDelivery(f);
    f.metas.get('s1')!.ask = { requestId: 'new', question: 'Proceed?', choices: ['Yes'] };
    await f.runtime.wake();
    assert.equal(f.db.must('deliveries', 'delivery').state, 'rejected');
    assert.match(f.db.must('deliveries', 'delivery').error!, /native question is pending/);
    assert.equal(prompts(f).length, 0);
    assert.equal(f.calls.filter(c => c.name === 'answer').length, 0);
  } finally { f.close(); }
});

test('unknown answer outcome is not retried or converted to an ordinary prompt', async () => {
  const f = fixture();
  try {
    const ask = { requestId: 'q', question: 'Proceed?', choices: ['Yes'], allowFreeform: false };
    f.service.syncQuestions('s1', [ask], true);
    f.metas.get('s1')!.ask = ask;
    stageDelivery(f, { kind: 'ask', text: 'Yes', requestId: ask.requestId, answerFreeform: false });
    f.fail(new Error('Lost answer acknowledgement'));
    await f.runtime.wake();
    f.fail(null);
    await f.runtime.wake();
    assert.equal(f.db.must('deliveries', 'delivery').state, 'unknown');
    assert.equal(f.calls.filter(c => c.name === 'answer').length, 1);
    assert.equal(prompts(f).length, 0);
  } finally { f.close(); }
});

test('already-sent ordinary Chat input cannot be dispatched again, including to an unbound topic', async () => {
  const f = fixture();
  try {
    const delivery = stageDelivery(f, { sessionId: '' });
    const source = f.db.must('messages', delivery.messageId!);
    f.db.put('messages', { ...source, sessionId: 's1', nativeEventId: 'already-sent' });
    await f.runtime.wake();
    assert.equal(f.db.must('deliveries', delivery.id).state, 'rejected');
    assert.match(f.db.must('deliveries', delivery.id).error!, /already sent/);
    assert.equal(f.calls.some(call => ['prompt', 'answer', 'session/new'].includes(call.name)), false);
  } finally { f.close(); }
});
