import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import type { ModuleRequest, ModuleRoute } from '@waksana/cockpit-module-sdk/backend';
import { routes } from '../src/http.ts';
import { fixture, proof } from './fixtures.ts';
import type { InputReceipt, Readiness, TimelineItem, TimelinePage } from '../src/ui-types.ts';
import type { Publication } from '../src/types.ts';

function setup() {
  const f = fixture();
  let wakes = 0;
  f.runtime.wake = async () => { wakes++; };
  const api = routes(f.service, f.runtime);
  const request = async (method: ModuleRoute['method'], path: string,
    extra: Partial<ModuleRequest> = {}) => {
    const route = api.find(item => item.method === method && item.path === path)!;
    return route.handler({ params: {}, query: {}, headers: {}, body: undefined,
      signal: new AbortController().signal, ...extra });
  };
  return { ...f, request, wakes: () => wakes };
}

test('readiness excludes disabled history before bounding the active reception window', async () => {
  const f = setup();
  try {
    const original = f.db.must('receptions', 's1');
    for (const reception of f.db.list('receptions').items) {
      f.db.put('receptions', { ...reception, enabled: false });
    }
    for (let index = 0; index < 110; index++) {
      f.db.put('receptions', { ...original, id: `old-${index}`, enabled: false });
    }
    f.db.put('receptions', { ...original, id: 'active-late' });
    f.metas.set('active-late', { ...f.metas.get('s1')!, sessionId: 'active-late' });
    const result = await f.runtime.readiness();
    assert.equal(result.canSend, true);
    assert.deepEqual(result.receptions.map(entry => entry.id), ['active-late']);
    assert.equal(result.receptions[0]?.availability, 'loaded');
    assert.equal(f.calls.some(call => JSON.stringify(call).includes('old-')), false);
  } finally { f.close(); }
});

test('timeline uses exclusive sequence windows and a global watermark, including sparse sequences', async () => {
  const f = setup();
  try {
    for (const sequence of [2, 4, 8, 20, 30]) f.service.publish({ sequence, type: 'status', text: String(sequence) });
    const get = async (query: Record<string, unknown>) =>
      (await f.request('GET', '/timeline', { query })).body as TimelinePage;
    const latest = await get({ limit: 2 });
    assert.deepEqual(latest.items.map(item => item.sequence), [20, 30]);
    assert.equal(latest.before, 20);
    assert.equal(latest.watermark, 30);
    assert.equal(latest.hasMore, true);
    const older = await get({ before: latest.before, limit: 2 });
    assert.deepEqual(older.items.map(item => item.sequence), [4, 8]);
    assert.equal(older.watermark, 30);
    assert.equal((await get({ before: 2 })).before, null);
    const forward = await get({ after: 4, limit: 2 });
    assert.deepEqual(forward.items.map(item => item.sequence), [8, 20]);
    assert.equal(forward.cursor, 20);
    assert.equal(forward.hasMore, true);
    assert.equal((await get({ after: 100 })).cursor, 100);
    for (const query of [{ before: 0, after: 0 }, { before: '-1' }, { after: '9007199254740993' },
      { limit: 101 }, { limit: 0 }, { arbitrary: true }]) {
      assert.equal((await f.request('GET', '/timeline', { query })).status, 400);
    }
    assert.equal(f.calls.length, 0);
    assert.equal(f.wakes(), 0);
  } finally { f.close(); }
});

test('timeline exact lookup and stream enrich questions without changing plain publication APIs', async () => {
  const f = setup();
  const controller = new AbortController();
  try {
    f.service.syncQuestions('s1', [{ requestId: 'ask-1', question: 'Choose', choices: ['A', 'B'], allowFreeform: false }], true);
    const question = f.db.list('questions').items[0]!;
    const message = f.db.must('messages', question.messageId);
    const work = f.service.claim(f.identities.coordinator, 'coordinator', 1)!;
    const publication = f.service.decide(f.identities.coordinator, { ...proof(work),
      topic: { title: 'Question topic', independent: true },
      reason: 'Publish the question', action: { kind: 'publish' } }) as Publication;
    const exact = async () => (await f.request('GET', '/timeline/items/:sequence',
      { params: { sequence: String(publication.sequence) } })).body as TimelineItem;
    const item = await exact();
    assert.equal(item.topicTitle, 'Question topic');
    assert.equal(item.speaker, 'assistant');
    assert.equal(item.sessionId, 's1');
    assert.deepEqual(item.question, { state: 'pending', choices: ['A', 'B'], allowFreeform: false });
    question.state = 'answered';
    f.db.put('questions', question);
    assert.equal((await exact()).question?.state, 'answered');
    const response = await f.request('GET', '/timeline/stream', {
      query: { after: 0 }, headers: { 'last-event-id': String(publication.sequence - 1) }, signal: controller.signal,
    });
    assert.ok(response.body instanceof Readable);
    const iterator = response.body[Symbol.asyncIterator]();
    try {
      const frame = String((await iterator.next()).value);
      assert.match(frame, new RegExp(`^id: ${publication.sequence}\\nevent: publication\\n`));
      assert.match(frame, /"topicTitle":"Question topic"/);
      assert.match(frame, /"state":"answered"/);
    } finally { controller.abort(); await iterator.return?.(); }
    const plain = (await f.request('GET', '/history')).body as { items: Record<string, unknown>[] };
    assert.ok(plain.items.every(entry => !('speaker' in entry)));
    const status = f.service.publish({ type: 'status', messageId: message.id, text: 'No topic at publication' });
    const oldStatus = (await f.request('GET', '/timeline/items/:sequence',
      { params: { sequence: String(status.sequence) } })).body as TimelineItem;
    assert.equal(oldStatus.topicId, null);
    assert.equal(oldStatus.topicTitle, null);
    assert.equal((await f.request('GET', '/timeline/items/:sequence', { params: { sequence: '999' } })).status, 404);
    assert.equal(f.calls.length, 0);
  } finally { controller.abort(); f.close(); }
});

test('readiness rechecks both roles passively every time and inspect only reads the exact session', async () => {
  const f = setup();
  try {
    const ready = (await f.request('GET', '/readiness')).body as Readiness;
    assert.equal(ready.canSend, true);
    assert.deepEqual(ready.roles.map(role => role.status), ['ready', 'ready']);
    const firstCount = f.calls.length;
    const meta = f.metas.get('memory')!;
    f.metas.set('memory', { ...meta, loaded: false });
    const unavailable = (await f.request('GET', '/readiness')).body as Readiness;
    assert.equal(unavailable.canSend, false);
    assert.equal(unavailable.roles[1]!.status, 'unloaded');
    assert.equal(f.db.must('bindings', 'memory').ready, false);
    assert.ok(f.calls.length > firstCount);
    f.metas.set('s1', { ...f.metas.get('s1')!, loaded: false });
    f.metas.delete('s2');
    const freshReceptions = (await f.request('GET', '/readiness')).body as Readiness;
    assert.deepEqual(freshReceptions.receptions.map(item => item.availability), ['unloaded', 'missing']);
    assert.equal(f.db.must('receptions', 's1').availability, 'loaded');
    f.metas.set('s1', { ...f.metas.get('s1')!, loaded: true });
    f.calls.length = 0;
    const inspection = await f.request('GET', '/sessions/:id/inspect', { params: { id: 's1' } });
    assert.deepEqual(inspection.body, { sessionId: 's1', modelId: 'synthetic', cwd: '/synthetic',
      loaded: true, status: 'idle', rolesNeedReload: null });
    assert.deepEqual(f.calls, [{ name: 'session/get', body: { sessionId: 's1' } }]);
    assert.equal((await f.request('GET', '/sessions/:id/inspect', { params: { id: 'missing' } })).status, 404);
    assert.equal(f.wakes(), 0);
  } finally { f.close(); }
});

test('readiness distinguishes unbound, invalid and unknown without repairing sessions', async () => {
  const f = setup();
  try {
    f.db.sql.prepare('DELETE FROM bindings WHERE id=?').run('coordinator');
    f.metas.set('memory', { ...f.metas.get('memory')!, currentModelId: 'different' });
    const invalid = await f.runtime.readiness();
    assert.deepEqual(invalid.roles.map(role => role.status), ['unbound', 'invalid']);
    f.native.host.call = async () => { throw new Error('Host unavailable'); };
    const unknown = await f.runtime.readiness();
    assert.equal(unknown.roles[1]!.status, 'unknown');
    assert.ok(unknown.receptions.every(item => item.availability === 'unknown'));
    assert.equal(unknown.canSend, false);
    assert.ok(f.calls.every(call => call.name === 'session/get' || call.name === 'roles/readiness'));
    assert.equal(f.wakes(), 0);
  } finally { f.close(); }
});

test('readiness rejects replaced bindings even if their predecessors verified successfully', async () => {
  const f = setup();
  try {
    const call = f.native.host.call.bind(f.native.host);
    f.native.host.call = async (name, body) => {
      const result = await call(name, body);
      if (name === 'roles/readiness' && 'sessionId' in body && body.sessionId === 'memory') {
        f.db.put('bindings', { ...f.db.must('bindings', 'coordinator'), epoch: 2, ready: false });
      }
      return result;
    };
    const ready = await f.runtime.readiness();
    assert.equal(ready.canSend, false);
    assert.equal(ready.roles[0]!.epoch, 2);
    assert.equal(ready.roles[0]!.status, 'unknown');
    assert.equal(f.db.must('bindings', 'coordinator').ready, false);
    assert.equal(f.wakes(), 0);
  } finally { f.close(); }
});

test('new HTTP input requires both fresh roles, but identical durable replay ignores later readiness', async () => {
  const f = setup();
  try {
    const body = { requestId: 'input-one', text: 'Please help' };
    const first = await f.request('POST', '/messages', { body });
    assert.equal(first.status, undefined);
    assert.ok(f.calls.some(call => call.name === 'roles/readiness'
      && (call.body as { sessionId: string }).sessionId === 'memory'));
    f.metas.set('memory', { ...f.metas.get('memory')!, loaded: false });
    f.calls.length = 0;
    assert.deepEqual((await f.request('POST', '/messages', { body })).body, first.body);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.request('POST', '/messages', { body: { ...body, text: 'Different' } })).status, 409);
    const refused = await f.request('POST', '/messages', { body: { ...body, requestId: 'new-input' } });
    assert.equal(refused.status, 409);
    assert.equal(f.db.get('operations', 'input:new-input'), undefined);
    assert.equal(f.db.list('messages').items.length, 1);
    assert.equal(f.db.list('work').items.length, 1);
  } finally { f.close(); }
});

test('exact input receipts track current work and delivery without enqueueing or scanning host sessions', async () => {
  const f = setup();
  try {
    const input = f.service.accept({ requestId: 'durable-input', text: 'Hello' });
    const work = f.service.claim(f.identities.coordinator, 'coordinator', 1, input.work.id)!;
    f.service.decide(f.identities.coordinator, { ...proof(work), topic: { title: 'Greeting', independent: true },
      reason: 'Explicit destination', action: { kind: 'route', sessionIds: ['s1'], routeVersion: 0 } });
    const receipt = (await f.request('GET', '/inputs/:requestId',
      { params: { requestId: 'durable-input' } })).body as InputReceipt;
    assert.equal(receipt.message.id, input.message.id);
    assert.equal(receipt.work[0]!.state, 'done');
    assert.equal(receipt.deliveries.length, 1);
    assert.equal(receipt.deliveries[0]!.state, 'pending');
    assert.deepEqual(receipt.hasMore, { work: false, deliveries: false });
    assert.equal((await f.request('GET', '/inputs/:requestId', { params: { requestId: 'missing' } })).status, 404);
    const id = 'x'.repeat(512);
    f.db.put('operations', { id, fingerprint: 'test', state: 'unknown', result: { partial: true } });
    assert.deepEqual((await f.request('GET', '/operations/:id', { params: { id } })).body, f.db.must('operations', id));
    assert.equal((await f.request('GET', '/operations/:id', { params: { id: `${id}x` } })).status, 400);
    assert.equal((await f.request('GET', '/operations/:id', { params: { id: 'missing' } })).status, 404);
    assert.equal(f.calls.length, 0);
    assert.equal(f.wakes(), 0);
  } finally { f.close(); }
});

test('new input rejects a replacement during verification without creating a durable request', async () => {
  const f = setup();
  try {
    const call = f.native.host.call.bind(f.native.host);
    f.native.host.call = async (name, body) => {
      const result = await call(name, body);
      if (name === 'roles/readiness' && 'sessionId' in body && body.sessionId === 'memory') {
        f.db.put('bindings', { ...f.db.must('bindings', 'memory'), epoch: 2, ready: false });
      }
      return result;
    };
    const response = await f.request('POST', '/messages', { body: { requestId: 'raced', text: 'Do not store' } });
    assert.equal(response.status, 409);
    assert.equal(f.db.get('operations', 'input:raced'), undefined);
    assert.equal(f.db.list('messages').items.length, 0);
    assert.equal(f.db.list('work').items.length, 0);
    assert.equal(f.wakes(), 0);
  } finally { f.close(); }
});

test('UI receipt, timeline, and readiness reads remain bounded without full-table find scans', async () => {
  const f = setup();
  try {
    const input = f.service.accept({ requestId: 'bounded', text: 'Hello' });
    for (let i = 0; i < 110; i++) {
      f.db.put('receptions', { ...f.db.must('receptions', 's1'), id: `extra-${i}` });
      f.db.put('work', { ...input.work, id: `extra-work-${i}` });
      f.service.publish({ type: 'message', messageId: input.message.id, text: 'Hello' });
    }
    f.db.find = () => { throw new Error('Unexpected full-table scan'); };
    const readiness = (await f.request('GET', '/readiness')).body as Readiness;
    assert.equal(readiness.receptions.length, 100);
    assert.equal(readiness.canSend, true);
    const receipt = (await f.request('GET', '/inputs/:requestId',
      { params: { requestId: 'bounded' } })).body as InputReceipt;
    assert.equal(receipt.work.length, 100);
    assert.equal(receipt.hasMore.work, true);
    const page = (await f.request('GET', '/timeline')).body as TimelinePage;
    assert.equal(page.items.length, 50);
    assert.equal(page.items[0]!.speaker, 'user');
    assert.equal(page.hasMore, true);
    assert.equal(f.wakes(), 0);
  } finally { f.close(); }
});
