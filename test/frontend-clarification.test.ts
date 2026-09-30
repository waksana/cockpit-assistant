import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostState } from './frontend-host.ts';
import { createClarification, type Clarification, type ClarificationActions } from '../frontend/clarification.ts';

const question = (id: string, patch: Partial<Clarification> = {}): Clarification => ({
  id, question: '这里指的是哪一个项目？', choices: [], allowFreeform: true,
  createdAt: 1000, answer: null, answeredAt: null, requestId: null, ...patch,
});

async function fixture(initial = question('q1')) {
  const host = await hostState();
  const requests: { path: string; method: string; body: unknown }[] = [];
  let saved = initial;
  let loseResponse = false;
  let reject = false;
  let staleRead = false;
  let hold: Promise<void> | null = null;
  let client!: ClarificationActions;
  const activate = async (snapshot = saved) => {
    client = await host.activate(context => createClarification({
      ...context,
      request: async (path, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        requests.push({ path, method: init?.method ?? 'GET', body });
        if (init?.method === 'POST') {
          if (hold) await hold;
          if (reject) return Response.json({ error: { code: 'STALE_CLARIFICATION', message: '这个问题已经失效' } }, { status: 409 });
          saved = { ...saved, answer: body.answer, requestId: body.requestId, answeredAt: 2000 };
          if (loseResponse) throw new Error('response lost after saving');
        }
        return Response.json({ messageId: 'm1', clarification: staleRead && !init?.method ? initial : saved });
      },
    }, 'm1', snapshot, () => {}));
    return client;
  };
  await activate();
  return {
    host, requests, activate,
    get client() { return client; },
    get saved() { return saved; },
    loseResponse: () => { loseResponse = true; },
    reject: () => { reject = true; },
    staleRead: () => { staleRead = true; },
    hold: (value: Promise<void>) => { hold = value; },
    close: () => host.stop(),
  };
}

test('clarification submits to its original message, never the ordinary input route', async () => {
  const f = await fixture();
  try {
    f.client.edit('  指的是 Cockpit 项目  ');
    await f.client.submit();
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0]!.path, '/messages/m1/clarifications/q1');
    assert.equal(f.requests[0]!.method, 'POST');
    assert.deepEqual(Object.keys(f.requests[0]!.body as object).sort(), ['answer', 'requestId']);
    assert.equal(f.saved.answer, '  指的是 Cockpit 项目  ');
    assert.equal(f.client.question.answer, f.saved.answer);
    assert.equal(f.client.draft.getSnapshot().text, '');
    assert.equal(f.client.draft.getSnapshot().submittable, false);
    assert.equal(f.client.error, null);
  } finally { f.close(); }
});

test('a pending clarification submission cannot dispatch twice', async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    f.hold(new Promise<void>(resolve => { release = resolve; }));
    f.client.edit('Cockpit');
    const first = f.client.submit();
    await Promise.resolve();
    await f.client.submit();
    assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
    release();
    await first;
    assert.equal(f.saved.answer, 'Cockpit');
  } finally { f.close(); }
});

test('lost clarification acknowledgement is recovered by exact passive receipt, not resend', async () => {
  const f = await fixture();
  try {
    f.loseResponse();
    f.client.edit('原消息的补充');
    await f.client.submit();
    assert.equal(f.client.draft.getSnapshot().unconfirmed, true);
    assert.equal(f.client.draft.getSnapshot().text, '原消息的补充');
    assert.match(f.client.error!, /response lost/);
    f.host.stop();
    await f.activate();
    await f.client.inspect();
    assert.equal(f.client.draft.getSnapshot().unconfirmed, false);
    assert.equal(f.client.draft.getSnapshot().text, '');
    assert.equal(f.client.question.answer, '原消息的补充');
    assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
    assert.equal(f.requests.filter(request => request.method === 'GET').length, 1);
  } finally { f.close(); }
});

test('a rejected clarification remains editable and exposes its error', async () => {
  const f = await fixture();
  try {
    f.reject();
    f.client.edit('补充');
    await f.client.submit();
    assert.equal(f.client.draft.getSnapshot().unconfirmed, false);
    assert.equal(f.client.draft.getSnapshot().text, '补充');
    assert.equal(f.client.question.answer, null);
    assert.equal(f.client.error, '这个问题已经失效');
  } finally { f.close(); }
});

test('clarification choices preserve exact text and reject an unoffered answer', async () => {
  const f = await fixture(question('q1', { choices: ['项目 A ', '项目 B'], allowFreeform: false }));
  try {
    f.client.edit('项目 A');
    await f.client.submit();
    assert.equal(f.requests.length, 0);
    assert.match(f.client.error!, /请选择/);
    await f.client.choose('项目 A ');
    assert.equal(f.saved.answer, '项目 A ');
    assert.equal(f.requests.length, 1);
  } finally { f.close(); }
});

test('a stale pending snapshot cannot reopen an acknowledged clarification', async () => {
  const original = question('q1');
  const f = await fixture(original);
  try {
    f.client.edit('Cockpit');
    await f.client.submit();
    f.client.update(original);
    assert.equal(f.client.question.answer, 'Cockpit');
    assert.equal(f.client.draft.getSnapshot().editable, false);
    assert.throws(() => f.client.update(question('q2')), /不能切换目标/);
  } finally { f.close(); }
});

test('a restored completion checkpoint blocks stale pending cards until the saved answer is read', async () => {
  const original = question('q1');
  const f = await fixture(original);
  try {
    f.client.edit('已确认的补充');
    await f.client.submit();
    assert.equal(f.client.draft.getSnapshot().actionRevision, 1);
    f.host.stop();
    await f.activate(original);
    assert.equal(f.client.draft.getSnapshot().editable, false);
    assert.equal(f.client.draft.getSnapshot().submittable, false);
    assert.doesNotThrow(() => f.client.update(original));
    await f.client.submit();
    assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
    await f.client.inspect();
    assert.equal(f.requests.filter(request => request.method === 'GET').length, 1);
    assert.equal(f.client.question.answer, '已确认的补充');
    assert.equal(f.client.draft.getSnapshot().actionRevision, 1);
    assert.equal(f.client.draft.getSnapshot().editable, false);
  } finally { f.close(); }
});

test('a conflicting pending read cannot erase a persisted clarification completion', async () => {
  const original = question('q1');
  const f = await fixture(original);
  try {
    f.client.edit('已经提交');
    await f.client.submit();
    f.host.stop();
    f.staleRead();
    await f.activate(original);
    await f.client.inspect();
    assert.match(f.client.error!, /保留完成状态/);
    assert.equal(f.client.draft.getSnapshot().editable, false);
    assert.doesNotThrow(() => f.client.update(original));
    await f.client.submit();
    assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
    f.client.update(f.saved);
    assert.equal(f.client.question.answer, '已经提交');
  } finally { f.close(); }
});

test('an unsubmitted clarification draft remains editable after reload', async () => {
  const f = await fixture();
  try {
    f.client.edit('还没发送的草稿');
    f.host.stop();
    await f.activate();
    assert.equal(f.client.draft.getSnapshot().editable, true);
    assert.equal(f.client.draft.getSnapshot().actionRevision, 0);
    assert.equal(f.client.draft.getSnapshot().text, '还没发送的草稿');
    await f.client.inspect();
    assert.equal(f.requests.length, 0);
  } finally { f.close(); }
});
