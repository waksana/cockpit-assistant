import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import type { McpInvocationMeta, ModuleRequest, ModuleRoute } from '@waksana/cockpit-module-sdk/backend';
import { routes } from '../src/http.ts';
import { BusinessError } from '../src/errors.ts';
import { fingerprint } from '../src/database.ts';
import { fixture, proof } from './fixtures.ts';
import type { Delivery, Topic } from '../src/types.ts';

function setup(realWake = false) {
  const f = fixture();
  const wakes: (string | undefined)[] = [];
  if (!realWake) f.runtime.wake = async (sessionId?: string) => { wakes.push(sessionId); };
  const api = routes(f.service, f.runtime);
  const request = async (method: ModuleRoute['method'], path: string, body?: unknown,
    extra: Partial<ModuleRequest> = {}) => {
    const route = api.find(candidate => candidate.method === method && candidate.path === path);
    assert.ok(route, `${method} ${path} exists`);
    return route.handler({ params: {}, query: {}, headers: {}, body, signal: new AbortController().signal, ...extra });
  };
  const rpc = (method: string, params?: unknown, extra: Partial<ModuleRequest> = {}) =>
    request('POST', '/mcp', { jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }, extra);
  const tool = (name: string, args: unknown, identity: McpInvocationMeta = f.identities.coordinator) =>
    rpc('tools/call', { name, arguments: args, _meta: { 'cockpit/invocation': identity } });
  return { ...f, wakes, request, rpc, tool };
}
function topic(f: ReturnType<typeof fixture>, id: string): Topic {
  const value: Topic = { id, title: id, domain: null, relatedTo: [], pinned: false,
    archived: false, independent: true, version: 1, dirtyThrough: 0, memoryThrough: 0 };
  f.db.put('topics', value);
  return value;
}
function rpcResult(response: Awaited<ReturnType<ReturnType<typeof setup>['rpc']>>) {
  return response.body as { result: { isError: boolean; content: { type: string; text: string }[] };
    error?: { code: number; message: string } };
}
function toolData<T>(response: Awaited<ReturnType<ReturnType<typeof setup>['tool']>>): T {
  const result = rpcResult(response).result;
  assert.equal(result.isError, false, JSON.stringify(result));
  return JSON.parse(result.content[0]!.text) as T;
}

test('maximum-length client IDs still permit explicit uncertain creation resolution', async () => {
  const f = setup();
  try {
    const requestId = 'x'.repeat(200);
    f.fail(new Error('Native creation acknowledgment lost'));
    await assert.rejects(f.request('POST', '/sessions', { requestId, cwd: '/synthetic' }));
    const operationId = `create:${requestId}`;
    assert.equal(f.db.must('operations', operationId).state, 'unknown');
    const response = await f.request('POST', '/operations/:id/resolve', {
      requestId: 'resolve', state: 'cancelled', evidence: 'Operator inspected native state and abandoned this operation',
    }, { params: { id: operationId } });
    assert.equal(response.status, undefined);
    assert.equal(f.db.must('operations', operationId).state, 'cancelled');
  } finally { f.close(); }
});

test('completed role receipts remain readable without replaying work after epoch replacement', async () => {
  const f = setup();
  try {
    const input = f.service.accept({ requestId: 'one', text: 'Goal' });
    const work = f.service.claim(f.identities.coordinator, 'coordinator', 1, input.work.id)!;
    const result = f.service.decide(f.identities.coordinator, { ...proof(work),
      topic: { title: 'T', independent: true }, reason: 'Ambiguous', action: { kind: 'clarify', text: 'Which goal?' } });
    f.db.put('bindings', { ...f.db.must('bindings', 'coordinator'), epoch: 2 });
    const receipt = toolData<{ state: string; result: unknown }>(await f.tool('assistant_read', {
      role: 'coordinator', epoch: 2, resource: 'receipts', workId: work.id,
    }));
    assert.equal(receipt.state, 'done');
    assert.deepEqual(receipt.result, result);
    assert.equal(rpcResult(await f.tool('assistant_read', {
      role: 'memory', epoch: 1, resource: 'receipts', workId: work.id,
    }, f.identities.memory)).result.isError, true);
  } finally { f.close(); }
});

test('module reads are bounded, replay publications durably, and never enumerate native sessions', async () => {
  const f = setup();
  try {
    f.db.transaction(() => {
      for (let i = 0; i < 3; i++) f.service.publish({ type: 'status', text: `Notice ${i}` });
    });
    const first = await f.request('GET', '/events', undefined, { query: { after: '0', limit: '2' } });
    const page = first.body as { items: { text: string }[]; cursor: number; hasMore: boolean };
    assert.equal(page.items.length, 2);
    assert.equal(page.hasMore, true);
    const second = await f.request('GET', '/events', undefined, { query: { after: page.cursor, limit: 2 } });
    assert.deepEqual((second.body as { items: { text: string }[] }).items.map(item => item.text), ['Notice 2']);
    assert.deepEqual((await f.request('GET', '/events', undefined, { query: { after: '0', limit: '2' } })).body, first.body);
    for (const path of ['/state', '/status', '/topics', '/history', '/publications', '/messages',
      '/receptions', '/questions', '/deliveries', '/operations', '/memories', '/roles', '/routes']) {
      assert.notEqual((await f.request('GET', path)).status, 400);
    }
    for (const query of [{ limit: '101' }, { after: '-1' }, { after: '9007199254740993' }, { space: 'other' }]) {
      assert.equal((await f.request('GET', '/messages', undefined, { query })).status, 400);
    }
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('SSE route resumes whole publications by numeric query or Last-Event-ID and forwards abort', async () => {
  const f = setup();
  try {
    f.db.transaction(() => {
      for (let i = 0; i < 4; i++) f.service.publish({ type: 'status', text: `Whole publication ${i}` });
    });
    for (const [query, headers, expectedId] of [
      [{}, {}, 1],
      [{ after: '1' }, {}, 2],
      [{}, { 'last-event-id': '2' }, 3],
      [{ after: '0' }, { 'last-event-id': '3' }, 4],
    ] satisfies [Record<string, unknown>, Record<string, string>, number][]) {
      const controller = new AbortController();
      const response = await f.request('GET', '/events/stream', undefined, { query, headers, signal: controller.signal });
      assert.equal(response.status, 200);
      assert.match(response.headers!['content-type']!, /^text\/event-stream/);
      assert.ok(response.body instanceof Readable);
      const stream = response.body;
      const iterator = stream[Symbol.asyncIterator]();
      try {
        const first = await iterator.next();
        assert.equal(first.done, false);
        const frame = String(first.value);
        assert.match(frame, new RegExp(`^id: ${expectedId}\\nevent: publication\\n`));
        assert.match(frame, new RegExp(`Whole publication ${expectedId - 1}`));
        controller.abort();
        await iterator.return?.();
        assert.equal(stream.destroyed, true);
      } finally {
        controller.abort();
        stream.destroy();
      }
    }
  } finally { f.close(); }
});

test('SSE rejects invalid cursors and unknown query keys before creating a stream', async () => {
  const f = setup();
  try {
    for (const extra of [
      { query: { after: '-1' } },
      { query: { after: '1.5' } },
      { query: { after: '9007199254740993' } },
      { query: { after: '1', metaKey: 'private' } },
      { headers: { 'last-event-id': 'NaN' } },
      { headers: { 'last-event-id': '-1' } },
      { headers: { 'last-event-id': ['1', '2'] } },
      { query: { after: 'invalid' }, headers: { 'last-event-id': '0' } },
    ]) {
      const response = await f.request('GET', '/events/stream', undefined, extra);
      assert.equal(response.status, 400);
      assert.match(response.headers!['content-type']!, /^application\/json/);
      assert.equal(response.body instanceof Readable, false);
    }
  } finally { f.close(); }
});

test('exact message version and assignment lookups expose recorded provenance, never arbitrary metadata', async () => {
  const f = setup();
  try {
    topic(f, 'a'); topic(f, 'b');
    const message = f.db.transaction(() => f.service.addMessage({ kind: 'reply', raw: 'Original source',
      topicId: 'a', sessionId: 's1', assignmentReason: 'Original assignment' }));
    f.service.correct(message.id, 'Corrected source', 1, 'User correction');
    f.db.transaction(() => f.service.classify(f.db.must('messages', message.id), { id: 'b' }, 'Moved by user'));
    const original = await f.request('GET', '/messages/:id/versions/:version', undefined,
      { params: { id: message.id, version: '1' } });
    assert.equal((original.body as { message: { raw: string } }).message.raw, 'Original source');
    assert.equal((original.body as { correction: unknown }).correction, null);
    const current = await f.request('GET', '/messages/:id/versions/:version', undefined,
      { params: { id: message.id, version: '2' } });
    assert.equal((current.body as { message: { raw: string } }).message.raw, 'Corrected source');
    assert.equal((current.body as { correction: { reason: string } }).correction.reason, 'User correction');
    const previousAssignment = await f.request('GET', '/messages/:id/assignments/:version', undefined,
      { params: { id: message.id, version: '0' } });
    assert.deepEqual(previousAssignment.body, {
      messageId: message.id, assignmentVersion: 0, topicId: 'a', reason: 'Original assignment',
    });
    const assignment = await f.request('GET', '/messages/:id/assignments/:version', undefined,
      { params: { id: message.id, version: '1' } });
    assert.deepEqual(assignment.body, {
      messageId: message.id, assignmentVersion: 1, topicId: 'b', reason: 'Moved by user',
    });
    for (const path of ['/messages/:id/versions/:version', '/messages/:id/assignments/:version']) {
      assert.equal((await f.request('GET', path, undefined, { params: { id: message.id, version: '99' } })).status, 404);
      assert.equal((await f.request('GET', path, undefined, { params: { id: 'missing', version: '1' } })).status, 404);
      assert.equal((await f.request('GET', path, undefined, { params: { id: message.id, version: '-1' } })).status, 400);
      assert.equal((await f.request('GET', path, undefined, {
        params: { id: message.id, version: '1' }, query: { metaKey: 'config' },
      })).status, 400);
    }
    assert.equal((await f.request('GET', '/messages/:id/versions/:version', undefined,
      { params: { id: message.id, version: '0' } })).status, 400);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('message acceptance is validated, durable and idempotent; no caller chooses a space', async () => {
  const f = setup();
  try {
    const body = { requestId: 'input', text: 'Do this' };
    const first = await f.request('POST', '/messages', body);
    assert.deepEqual((await f.request('POST', '/messages', body)).body, first.body);
    assert.equal(f.db.list('messages').items.length, 1);
    assert.equal((await f.request('POST', '/messages', { ...body, text: 'Changed' })).status, 409);
    assert.equal((await f.request('POST', '/messages', { ...body, spaceId: 'foreign' })).status, 400);
    assert.equal((await f.request('POST', '/messages', body, { query: { spaceId: 'foreign' } })).status, 400);
    assert.equal((await f.request('POST', '/messages', { text: 'No ID' })).status, 400);
    await Promise.resolve();
    assert.ok(f.wakes.length);
  } finally { f.close(); }
});

test('explicit native creation, enrollment and role binding call the runtime with strict input', async () => {
  const f = setup();
  try {
    const observed: { name: string; input: unknown }[] = [];
    f.runtime.create = async input => { observed.push({ name: 'create', input }); return { sessionId: 'new' }; };
    f.runtime.enroll = async input => { observed.push({ name: 'enroll', input }); return { enrolled: true }; };
    f.runtime.bind = async input => { observed.push({ name: 'bind', input }); return { epoch: 2 }; };
    assert.equal((await f.request('POST', '/sessions', { requestId: 'c', cwd: '/synthetic' })).status, undefined);
    await f.request('POST', '/enrollment', {
      requestId: 'e', sessionId: 's3', kind: 'reception', label: 'Three', evidence: 'Explicit selection',
    });
    await f.request('POST', '/roles/bind', { requestId: 'b', role: 'coordinator', sessionId: 'new',
      expectedEpoch: 1, definitionVersion: '1', expectedModelId: 'synthetic' });
    assert.deepEqual(observed.map(call => call.name), ['create', 'enroll', 'bind']);
    assert.equal((await f.request('POST', '/sessions', { cwd: '/synthetic' })).status, 400);
    assert.equal(observed.length, 3);
  } finally { f.close(); }
});

test('focus schedules prior dirty memory; handoff schedules distinct memory work without moving focus', async () => {
  const f = setup();
  try {
    topic(f, 'a'); topic(f, 'b');
    f.db.transaction(() => f.service.addMessage({ kind: 'user', raw: 'Source', topicId: 'a' }));
    f.db.setMeta('foregroundTopic', 'a');
    await f.request('POST', '/focus', { requestId: 'focus', topicId: 'b' });
    assert.equal(f.db.meta('foregroundTopic', null), 'b');
    assert.equal(f.db.find('work', item => item.role === 'memory' && item.kind === 'memory').length, 1);
    const value = { requestId: 'handoff', topicId: 'a', evidence: 'User requests handoff summary' };
    const result = await f.request('POST', '/handoff', value);
    assert.equal((result.body as { work: { kind: string } }).work.kind, 'handoff');
    assert.deepEqual((await f.request('POST', '/handoff', value)).body, result.body);
    assert.equal(f.db.meta('foregroundTopic', null), 'b');
  } finally { f.close(); }
});

test('configuration patch preserves omitted fields and topic CAS invalidates state snapshots', async () => {
  const f = setup();
  try {
    await f.request('PATCH', '/config', { requestId: 'config1', config: { riskEnabled: false, maxReceptions: 20 } });
    await f.request('PATCH', '/config', { requestId: 'config2', config: { riskCooldownMs: 7 } });
    assert.deepEqual(f.service.config, { riskEnabled: false, maxReceptions: 20, riskCooldownMs: 7 });
    assert.equal((await f.request('PATCH', '/config', { requestId: 'bad', config: { unknown: true } })).status, 400);
    topic(f, 'a');
    const before = f.service.version;
    const body = { requestId: 'topic', expectedVersion: 1, title: 'Renamed', domain: 'Work', pinned: true,
      archived: true, independent: false };
    const options = { params: { id: 'a' } };
    const changed = await f.request('PATCH', '/topics/:id', body, options);
    assert.equal((changed.body as Topic).version, 2);
    assert.ok(f.service.version > before);
    assert.deepEqual((await f.request('PATCH', '/topics/:id', body, options)).body, changed.body);
    assert.equal((await f.request('PATCH', '/topics/:id', { ...body, requestId: 'stale' }, options)).status, 409);
    assert.equal((await f.request('PATCH', '/topics/:id', { requestId: 'empty', expectedVersion: 2 }, options)).status, 400);
  } finally { f.close(); }
});

test('reception edits require evidence and CAS, advance reader generation and cannot enroll', async () => {
  const f = setup();
  try {
    const params = { params: { id: 's1' } };
    const disabled = await f.request('PATCH', '/receptions/:id', {
      requestId: 'off', expectedVersion: 1, enabled: false, evidence: 'User paused reception',
    }, params);
    assert.equal((disabled.body as { generation: number }).generation, 2);
    assert.equal((await f.request('PATCH', '/receptions/:id', {
      requestId: 'stale', expectedVersion: 1, label: 'Stale', evidence: 'Stale label',
    }, params)).status, 409);
    await f.request('PATCH', '/receptions/:id', {
      requestId: 'on', expectedVersion: 2, enabled: true, evidence: 'User re-enabled reception',
    }, params);
    assert.equal(f.db.must('receptions', 's1').generation, 3);
    assert.equal((await f.request('PATCH', '/receptions/:id', {
      requestId: 'new', expectedVersion: 1, enabled: true, evidence: 'No implicit enrollment',
    }, { params: { id: 'unknown' } })).status, 404);
    assert.equal(f.db.get('receptions', 'unknown'), undefined);
    assert.equal((await f.request('PATCH', '/receptions/:id', {
      requestId: 'missing-evidence', expectedVersion: 3, enabled: false,
    }, params)).status, 400);
  } finally { f.close(); }
});

test('explicit bounded recovery imports historical outputs and resumes from the captured live cursor', async () => {
  const f = setup();
  try {
    const reception = f.db.must('receptions', 's1');
    f.db.put('receptions', { ...reception, cursor: 'expired', gap: 'Native cursor expired' });
    const backwards: boolean[] = [];
    const read = f.native.read;
    f.native.read = async (sessionId, cursor, bootstrap, backward) => {
      backwards.push(backward === true);
      return read(sessionId, cursor, bootstrap, backward);
    };
    f.pages.push({
      events: [
        { id: 'start', type: 'assistant.turn_start', data: {} },
        { id: 'message', type: 'assistant.message', parentId: 'start',
          data: { content: 'Historical complete reply', messageId: 'native-message', toolRequests: [] } },
        { id: 'end', type: 'assistant.turn_end', parentId: 'message', data: {} },
      ],
      cursor: 'history-1', liveCursor: 'captured-live', cursorStatus: 'ok', hasMore: true,
    }, { events: [], cursor: 'history-2', cursorStatus: 'ok', hasMore: true });
    const body = { requestId: 'recover', maxPages: 2,
      acknowledgeGap: true, evidence: 'User acknowledges bounded history recovery and possible gaps' };
    const params = { params: { id: 's1' } };
    assert.equal((await f.request('POST', '/receptions/:id/recover', { ...body, acknowledgeGap: false }, params)).status, 400);
    const response = await f.request('POST', '/receptions/:id/recover', body, params);
    const result = response.body as { pages: number; olderHistoryRemaining: boolean; backwardCursor: string; liveCursor: string; warning: string };
    assert.equal(result.pages, 2);
    assert.equal(result.olderHistoryRemaining, true);
    assert.equal(result.backwardCursor, 'history-2');
    assert.equal(result.liveCursor, 'captured-live');
    assert.match(result.warning, /not proof of gap-free history/);
    assert.deepEqual(backwards, [true, true]);
    assert.equal(f.db.must('receptions', 's1').baseline, true);
    assert.equal(f.db.must('receptions', 's1').cursor, 'captured-live');
    assert.equal(f.db.must('receptions', 's1').generation, 2);
    assert.equal(f.db.list('messages').items[0]!.historical, true);
    assert.equal(f.db.find('publications', item => item.type === 'message').length, 0);
    await f.request('POST', '/receptions/:id/recover', body, params);
    assert.equal(backwards.length, 2);
    assert.equal((await f.request('POST', '/receptions/:id/recover', { ...body, maxPages: 3 }, params)).status, 409);
    assert.ok(f.wakes.includes('s1'));
    assert.equal(routes(f.service, f.runtime).some(route => route.path === '/resync'), false);
  } finally { f.close(); }
});

test('recovery requires explicit gap evidence and bounded pages; invalid bootstrap never resets the tail', async () => {
  const f = setup();
  try {
    const params = { params: { id: 's1' } };
    const body = { requestId: 'recover', maxPages: 1, acknowledgeGap: true, evidence: 'Explicit user acknowledgment' };
    for (const invalid of [
      { ...body, maxPages: 0 }, { ...body, maxPages: 11 }, { ...body, maxPages: 1.5 },
      { ...body, acknowledgeGap: false }, { ...body, evidence: '' },
      { ...body, sessionId: 'another' }, { maxPages: 1, acknowledgeGap: true, evidence: 'No request ID' },
    ]) assert.equal((await f.request('POST', '/receptions/:id/recover', invalid, params)).status, 400);
    assert.equal(f.calls.length, 0);
    const before = f.db.must('receptions', 's1');
    f.pages.push({ events: [], cursor: 'history', cursorStatus: 'ok', hasMore: false });
    assert.equal((await f.request('POST', '/receptions/:id/recover', body, params)).status, 409);
    assert.equal(f.db.must('receptions', 's1').cursor, before.cursor);
    assert.equal(f.db.must('receptions', 's1').generation, before.generation);
    f.runtime.recoverHistory = async () => { throw new Error('Unexpected history storage failure'); };
    await assert.rejects(f.request('POST', '/receptions/:id/recover', body, params), /Unexpected history storage failure/);
  } finally { f.close(); }
});

test('risk suppression requires a current signature and explicit confirmation without changing scope', async () => {
  const f = setup();
  try {
    const signature = fingerprint(['a', 'b']);
    f.db.put('risks', { id: 's1', signature, lastAt: f.service.now(), suppressed: false });
    const body = { requestId: 'risk', sessionId: 's1', signature, confirmed: true, evidence: 'User confirmed shared context' };
    assert.equal((await f.request('POST', '/risk/suppress', { ...body, confirmed: false })).status, 400);
    assert.equal((await f.request('POST', '/risk/suppress', { ...body, signature: 'old' })).status, 409);
    await f.request('POST', '/risk/suppress', body);
    assert.deepEqual(f.db.must('risks', 's1'), { id: 's1', signature, lastAt: f.service.now(), suppressed: true });
    assert.equal(f.db.list('routes').items.length, 0);
  } finally { f.close(); }
});

test('only unknown effects can be explicitly resolved; evidence is durable and no retry is scheduled', async () => {
  const f = setup();
  try {
    f.db.put('operations', { id: 'create:lost', fingerprint: 'original', state: 'unknown', result: { error: 'lost' } });
    const body = { requestId: 'resolution', target: 'operation', state: 'accepted', evidence: 'User located original native session' };
    const params = { params: { id: 'create:lost' } };
    assert.equal((await f.request('POST', '/effects/:id/resolve', { ...body, state: 'pending' }, params)).status, 400);
    await f.request('POST', '/effects/:id/resolve', body, params);
    const operation = f.db.must('operations', 'create:lost');
    assert.equal(operation.state, 'accepted');
    assert.equal(operation.fingerprint, 'original');
    assert.match(JSON.stringify(operation.result), /User located original/);
    assert.equal((await f.request('POST', '/effects/:id/resolve', { ...body, requestId: 'again' }, params)).status, 409);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('dedicated operation resolution audits create/bind uncertainty without creating or binding again', async () => {
  const f = setup(true);
  try {
    for (const state of ['accepted', 'rejected', 'cancelled'] as const) {
      for (const kind of ['create', 'bind']) {
        const operationId = `${kind}:${state}`;
        f.db.put('operations', { id: operationId, state: 'unknown', fingerprint: 'original',
          result: { warning: 'Native acknowledgment lost' } });
        const params = { params: { id: operationId } };
        const value = { requestId: operationId, state, evidence: 'User inspected actual native effects' };
        const first = await f.request('POST', '/operations/:id/resolve', value, params);
        assert.equal((first.body as { state: string }).state, state);
        assert.match(JSON.stringify(f.db.must('operations', operationId).result), /User inspected actual native effects/);
        assert.deepEqual((await f.request('POST', '/operations/:id/resolve', value, params)).body, first.body);
        assert.equal((await f.request('POST', '/operations/:id/resolve', {
          ...value, requestId: `again:${operationId}`,
        }, params)).status, 409);
      }
    }
    f.db.put('operations', { id: 'create:pending', state: 'calling', fingerprint: 'original', result: null });
    const params = { params: { id: 'create:pending' } };
    assert.equal((await f.request('POST', '/operations/:id/resolve', {
      requestId: 'calling', state: 'cancelled', evidence: 'Cannot resolve an active call',
    }, params)).status, 409);
    for (const value of [
      { requestId: 'pending', state: 'pending', evidence: 'Never retry' },
      { requestId: 'no-evidence', state: 'accepted' },
      { requestId: 'empty-evidence', state: 'accepted', evidence: '  ' },
      { requestId: 'wrong-target', state: 'accepted', evidence: 'No cross-table selection', target: 'delivery' },
    ]) assert.equal((await f.request('POST', '/operations/:id/resolve', value, params)).status, 400);
    await f.runtime.settled();
    assert.equal(f.calls.filter(call => call.name === 'session/new' || call.name === 'session/resources-prepare').length, 0);
  } finally { f.close(); }
});

test('explicit rejected wake retry creates one new logical delivery and preserves the original', async () => {
  const f = setup();
  try {
    const original: Delivery = {
      id: 'wake:rejected', kind: 'wake', messageId: null, sessionId: 'coordinator', requestId: null,
      text: 'Drain coordinator work for epoch 1', supplement: null, answerFreeform: null,
      state: 'rejected', result: { ok: false }, error: 'Native rejected wake', createdAt: 1, roleEpoch: 1,
    };
    f.db.put('deliveries', original);
    const params = { params: { id: original.id } };
    const value = { requestId: 'retry-one', evidence: 'User inspected rejection and explicitly requested another wake' };
    const response = await f.request('POST', '/effects/:id/retry', value, params);
    const retry = response.body as Delivery;
    assert.notEqual(retry.id, original.id);
    assert.equal(retry.state, 'pending');
    assert.equal(retry.kind, 'wake');
    assert.equal(retry.sessionId, original.sessionId);
    assert.equal(retry.roleEpoch, original.roleEpoch);
    assert.equal(retry.text, original.text);
    assert.deepEqual(retry.result, { retryOf: original.id, evidence: value.evidence, requestId: value.requestId });
    assert.equal(retry.error, null);
    assert.deepEqual(f.db.must('deliveries', original.id), original);
    assert.deepEqual((await f.request('POST', '/effects/:id/retry', value, params)).body, response.body);
    assert.equal(f.db.list('deliveries').items.length, 2);
    assert.equal((await f.request('POST', '/effects/:id/retry', {
      ...value, requestId: 'different-id',
    }, params)).status, 409);
    assert.equal((await f.request('POST', '/effects/:id/retry', {
      ...value, evidence: 'Different evidence under reused ID',
    }, params)).status, 409);
    assert.deepEqual((f.db.must('operations', 'http:retry:retry-one').result as Delivery).result, retry.result);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('wake retry rejects prompts, asks, non-rejections, stale bindings and missing evidence', async () => {
  const f = setup();
  try {
    const original: Delivery = {
      id: 'wake:source', kind: 'wake', messageId: null, sessionId: 'coordinator', requestId: null,
      text: 'Internal wake', supplement: null, answerFreeform: null, state: 'rejected', result: null,
      error: 'Rejected', createdAt: 1, roleEpoch: 1,
    };
    const params = { params: { id: original.id } };
    const value = { requestId: 'attempt', evidence: 'Explicit user request' };
    for (const changes of [
      { kind: 'prompt' }, { kind: 'ask' },
      { state: 'accepted' }, { state: 'unknown' }, { state: 'calling' }, { state: 'pending' }, { state: 'cancelled' },
      { roleEpoch: 2 }, { sessionId: 'retired-session' },
    ] satisfies Partial<Delivery>[]) {
      f.db.put('deliveries', { ...original, ...changes });
      assert.equal((await f.request('POST', '/effects/:id/retry', value, params)).status, 409);
      assert.equal(f.db.list('deliveries').items.length, 1);
    }
    f.db.put('deliveries', original);
    for (const invalid of [
      { requestId: 'no-evidence' }, { requestId: 'empty-evidence', evidence: ' ' },
      { evidence: 'No request ID' }, { ...value, sessionId: 'other' },
    ]) assert.equal((await f.request('POST', '/effects/:id/retry', invalid, params)).status, 400);
    const binding = f.db.must('bindings', 'coordinator');
    f.db.put('bindings', { ...binding, ready: false });
    assert.equal((await f.request('POST', '/effects/:id/retry', value, params)).status, 409);
    assert.equal(f.db.list('operations').items.length, 0);
    assert.deepEqual(f.db.must('deliveries', original.id), original);
    assert.equal(f.wakes.length, 0);
  } finally { f.close(); }
});

test('correction and reclassification preserve immutable original anchors and enforce both versions', async () => {
  const f = setup();
  try {
    topic(f, 'a'); topic(f, 'b');
    const message = f.db.transaction(() => f.service.addMessage({ kind: 'reply', raw: 'Original', topicId: 'a', sessionId: 's1' }));
    const anchor = { id: message.id, messageId: message.id, kind: 'comment' as const, sessionId: 's1', requestId: null };
    f.db.put('anchors', anchor);
    const params = { params: { id: message.id } };
    await f.request('POST', '/messages/:id/correct', {
      requestId: 'correction', expectedVersion: 1, text: 'Corrected', reason: 'User corrects content',
    }, params);
    const body = { requestId: 'classification', expectedVersion: 2, expectedAssignmentVersion: 0,
      topic: { id: 'b' }, reason: 'User corrects classification' };
    const response = await f.request('POST', '/messages/:id/reclassify', body, params);
    assert.notEqual(response.status, 409);
    assert.equal(f.db.must('messages', message.id).topicId, 'b');
    assert.deepEqual(f.db.must('anchors', message.id), anchor);
    assert.equal((await f.request('POST', '/messages/:id/reclassify', { ...body, requestId: 'stale' }, params)).status, 409);
    assert.equal((await f.request('POST', '/messages/:id/correct', {
      requestId: 'rewrite-anchor', expectedVersion: 2, text: 'No', reason: 'No', sessionId: 's2',
    }, params)).status, 400);
  } finally { f.close(); }
});

test('explicit role verification restores readiness and validates expected epoch', async () => {
  const f = setup();
  try {
    const binding = f.db.must('bindings', 'coordinator');
    f.db.put('bindings', { ...binding, ready: false });
    const before = await f.tool('assistant_read', { role: 'coordinator', epoch: 1, resource: 'topics' });
    assert.equal(rpcResult(before).result.isError, true);
    await f.request('POST', '/roles/verify', { requestId: 'verify', role: 'coordinator', expectedEpoch: 1 });
    assert.equal(f.db.must('bindings', 'coordinator').ready, true);
    assert.equal(rpcResult(await f.tool('assistant_read', { role: 'coordinator', epoch: 1, resource: 'topics' })).result.isError, false);
    assert.equal((await f.request('POST', '/roles/verify', {
      requestId: 'wrong-epoch', role: 'coordinator', expectedEpoch: 2,
    })).status, 409);
  } finally { f.close(); }
});

test('path-scoped role refresh restores false readiness only after native verification', async () => {
  const f = setup();
  try {
    const binding = f.db.must('bindings', 'coordinator');
    f.db.put('bindings', { ...binding, ready: false });
    const params = { params: { role: 'coordinator' } };
    const value = { requestId: 'refresh', expectedEpoch: 1 };
    assert.equal((await f.request('POST', '/roles/:role/refresh', {
      ...value, role: 'memory',
    }, params)).status, 400);
    await f.request('POST', '/roles/:role/refresh', value, params);
    assert.equal(f.db.must('bindings', 'coordinator').ready, true);
    assert.ok(f.calls.some(call => call.name === 'roles/readiness'));
    const calls = f.calls.length;
    await f.request('POST', '/roles/:role/refresh', value, params);
    assert.equal(f.calls.length, calls);
    assert.equal((await f.request('POST', '/roles/:role/refresh', {
      requestId: 'wrong-epoch', expectedEpoch: 2,
    }, params)).status, 409);
    f.db.put('bindings', { ...binding, ready: false });
    f.metas.get('coordinator')!.loaded = false;
    assert.equal((await f.request('POST', '/roles/:role/refresh', {
      requestId: 'unloaded', expectedEpoch: 1,
    }, params)).status, 409);
    assert.equal(f.db.must('bindings', 'coordinator').ready, false);
  } finally { f.close(); }
});

test('manual wake awaits completion, known errors become 4xx, unexpected failures propagate and are auditable', async () => {
  const f = setup();
  try {
    f.runtime.wake = async () => { throw new BusinessError('WAKE_BLOCKED', 'Cannot wake'); };
    assert.equal((await f.request('POST', '/wake', { requestId: 'known' })).status, 409);
    assert.equal(f.db.must('operations', 'http:wake:known').state, 'rejected');
    f.runtime.wake = async () => { throw new Error('Storage broken'); };
    await assert.rejects(f.request('POST', '/wake', { requestId: 'unknown' }), /Storage broken/);
    assert.equal(f.db.must('operations', 'http:wake:unknown').state, 'unknown');
    f.service.accept = () => { throw new Error('Read-only storage'); };
    await assert.rejects(f.request('POST', '/messages', { requestId: 'input', text: 'Hello' }), /Read-only storage/);
  } finally { f.close(); }
});

test('asynchronous wake rejection is reported rather than silently swallowed', async () => {
  const f = setup();
  try {
    f.runtime.wake = async () => { throw new Error('Background failure'); };
    await f.request('POST', '/messages', { requestId: 'input', text: 'Hello' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.errors.length, 1);
    assert.match(String(f.errors[0]), /Background failure/);
  } finally { f.close(); }
});

test('stateless MCP negotiates protocol and publishes detailed standard JSON schemas', async () => {
  const f = setup();
  try {
    const response = await f.rpc('initialize', {
      protocolVersion: '2025-06-18', clientInfo: { name: 'Test', version: '1' }, capabilities: {},
    });
    assert.match(response.headers!['content-type']!, /^application\/json/);
    const initialization = (response.body as { result: { protocolVersion: string; jsonSchemaDialect: string } }).result;
    assert.equal(initialization.protocolVersion, '2025-06-18');
    assert.equal(initialization.jsonSchemaDialect, 'https://json-schema.org/draft/2020-12/schema');
    const tools = ((await f.rpc('tools/list')).body as { result: { tools: { name: string;
      inputSchema: { additionalProperties: boolean; properties: Record<string, unknown> } }[] } }).result.tools;
    assert.equal(tools.length, 5);
    assert.ok(tools.find(tool => tool.name === 'assistant_decide')!.inputSchema.properties.action);
    assert.ok(tools.every(tool => tool.inputSchema.additionalProperties === false));
    assert.deepEqual((await f.rpc('ping')).body, { jsonrpc: '2.0', id: 1, result: {} });
    assert.equal((await f.request('POST', '/mcp', {
      jsonrpc: '2.0', method: 'notifications/initialized',
    })).status, 202);
    assert.equal((await f.rpc('ping', undefined, { headers: { 'mcp-protocol-version': '1900-01-01' } })).status, 400);
    assert.equal(rpcResult(await f.rpc('missing')).error?.code, -32601);
    assert.equal(rpcResult(await f.request('POST', '/mcp', [])).error?.code, -32600);
  } finally { f.close(); }
});

test('MCP trusts only validated public invocation metadata, current main binding and native readiness', async () => {
  const f = setup();
  try {
    const args = { role: 'coordinator', epoch: 1, resource: 'messages' };
    const missing = await f.rpc('tools/call', { name: 'assistant_read', arguments: {
      ...args, sessionId: 'coordinator', runtimeSessionId: 'coordinator', subagent: false,
    } });
    assert.equal(rpcResult(missing).result.isError, true);
    for (const identity of [
      { sessionId: 'outsider', runtimeSessionId: 'outsider', subagent: false },
      { sessionId: 'coordinator', runtimeSessionId: 'child', subagent: true },
      { sessionId: 'coordinator', runtimeSessionId: 'different', subagent: false },
    ]) assert.equal(rpcResult(await f.tool('assistant_read', args, identity)).result.isError, true);
    assert.equal(rpcResult(await f.tool('assistant_read', { ...args, epoch: 2 })).result.isError, true);
    f.metas.get('coordinator')!.currentModelId = 'changed';
    assert.equal(rpcResult(await f.tool('assistant_read', args)).result.isError, true);
    assert.equal(f.db.must('bindings', 'coordinator').ready, false);
  } finally { f.close(); }
});

test('synchronous guard rejects a binding replacement after asynchronous native authorization', async () => {
  const f = setup();
  try {
    f.runtime.authorize = async () => {
      const binding = f.db.must('bindings', 'coordinator');
      f.db.put('bindings', { ...binding, epoch: 2 });
    };
    const response = await f.tool('assistant_read', { role: 'coordinator', epoch: 1, resource: 'topics' });
    assert.equal(rpcResult(response).result.isError, true);
    assert.match(rpcResult(response).result.content[0]!.text, /STALE_ROLE/);
  } finally { f.close(); }
});

test('role work reads expose only the current role and active lease epoch', async () => {
  const f = setup();
  try {
    const input = f.service.accept({ requestId: 'own', text: 'Current lease' });
    const own = f.service.claim(f.identities.coordinator, 'coordinator', 1, input.work.id)!;
    f.db.put('work', { ...own, id: 'foreign-role', role: 'memory' });
    f.db.put('work', { ...own, id: 'foreign-epoch', epoch: 2 });
    f.db.put('work', { ...own, id: 'expired', leaseUntil: f.service.now() - 1 });
    f.db.put('work', { ...own, id: 'done', state: 'done' });
    f.db.put('work', { ...own, id: 'pending', state: 'pending', epoch: null, token: null });
    const args = { role: 'coordinator', epoch: 1, resource: 'work' };
    const response = toolData<{ items: { id: string }[] }>(await f.tool('assistant_read', args));
    assert.deepEqual(response.items.map(work => work.id), [own.id]);
    for (const workId of ['foreign-role', 'foreign-epoch', 'expired', 'done', 'pending']) {
      assert.equal(rpcResult(await f.tool('assistant_read', { ...args, workId })).result.isError, true);
    }
    const exact = toolData<{ items: { id: string }[] }>(await f.tool('assistant_read', { ...args, workId: own.id }));
    assert.deepEqual(exact.items.map(work => work.id), [own.id]);
  } finally { f.close(); }
});

test('memory reads require current leased work and reveal only its exact source scope', async () => {
  const f = setup();
  try {
    topic(f, 'a'); topic(f, 'b');
    const source = f.db.transaction(() => f.service.addMessage({ kind: 'user', raw: 'Allowed source', topicId: 'a' }));
    f.db.transaction(() => f.service.addMessage({ kind: 'user', raw: 'Private unrelated source', topicId: 'b' }));
    const scheduled = f.db.transaction(() => f.service.memory.schedule('a'))!;
    const args = { role: 'memory', epoch: 1, resource: 'messages' };
    assert.equal(rpcResult(await f.tool('assistant_read', args, f.identities.memory)).result.isError, true);
    assert.equal(rpcResult(await f.tool('assistant_read', { ...args, workId: scheduled.id }, f.identities.memory)).result.isError, true);
    const leased = f.service.claim(f.identities.memory, 'memory', 1, scheduled.id)!;
    const response = await f.tool('assistant_read', { ...args, workId: leased.id }, f.identities.memory);
    const page = toolData<{ items: { id: string }[] }>(response);
    assert.deepEqual(page.items.map(item => item.id), [source.id]);
    assert.equal(rpcResult(await f.tool('assistant_read', {
      ...args, resource: 'receptions', workId: leased.id,
    }, f.identities.memory)).result.isError, true);
    f.advance(300_001);
    assert.equal(rpcResult(await f.tool('assistant_read', { ...args, workId: leased.id }, f.identities.memory)).result.isError, true);
  } finally { f.close(); }
});

test('MCP claim/read/decide uses structured proof, and unexpected runtime errors never become successful RPC', async () => {
  const f = setup();
  try {
    const input = f.service.accept({ requestId: 'input', text: 'Need clarification' });
    const work = toolData<ReturnType<typeof f.service.claim>>(await f.tool('assistant_claim', {
      role: 'coordinator', epoch: 1, workId: input.work.id,
    }))!;
    const response = await f.tool('assistant_decide', { ...proof(work), topic: { title: 'Question', independent: true },
      reason: 'Need user details', action: { kind: 'clarify', text: 'Which target?' } });
    assert.equal(rpcResult(response).result.isError, false);
    assert.equal(f.db.must('work', work.id).state, 'done');
    f.runtime.authorize = async () => { throw new Error('Unexpected database fault'); };
    await assert.rejects(f.tool('assistant_read', { role: 'coordinator', epoch: 1, resource: 'topics' }), /Unexpected database fault/);
  } finally { f.close(); }
});

test('MCP memory commit enforces the role and exact lease source proof', async () => {
  const f = setup();
  try {
    topic(f, 'a');
    f.db.transaction(() => f.service.addMessage({ kind: 'user', raw: 'User confirms requirement', topicId: 'a' }));
    const pending = f.db.transaction(() => f.service.memory.schedule('a'))!;
    const work = toolData<ReturnType<typeof f.service.claim>>(await f.tool('assistant_claim', {
      role: 'memory', epoch: 1, workId: pending.id,
    }, f.identities.memory))!;
    const value = { ...proof(work, 'memory-result'),
      entries: [{ kind: 'confirmed', text: 'Requirement confirmed', sources: work.sources }] };
    assert.equal(rpcResult(await f.tool('assistant_remember', value)).result.isError, true);
    assert.equal(rpcResult(await f.tool('assistant_remember', value, f.identities.memory)).result.isError, false);
    assert.equal(f.db.list('memories').items[0]!.text, 'Requirement confirmed');
    assert.equal(rpcResult(await f.tool('assistant_remember', value, f.identities.memory)).result.isError, false);
    assert.equal(f.db.list('memories').items.length, 1);
    assert.equal(rpcResult(await f.tool('assistant_read', {
      role: 'memory', epoch: 1, resource: 'messages', workId: work.id,
    }, f.identities.memory)).result.isError, true);
  } finally { f.close(); }
});

test('MCP mutation responds while the native wake prompt is awaiting its own tool result', async () => {
  const f = setup(true);
  try {
    f.service.accept({ requestId: 'input', text: 'Need details' });
    let handled = false;
    f.onPrompt(async () => {
      if (handled) return;
      handled = true;
      const work = toolData<ReturnType<typeof f.service.claim>>(await f.tool('assistant_claim', { role: 'coordinator', epoch: 1 }))!;
      const response = await f.tool('assistant_decide', { ...proof(work), topic: { title: 'Details', independent: true },
        reason: 'Need details', action: { kind: 'clarify', text: 'What details?' } });
      assert.equal(rpcResult(response).result.isError, false);
    });
    await f.runtime.wake();
    assert.equal(handled, true);
    assert.equal(f.db.list('work').items[0]!.state, 'done');
  } finally { f.close(); }
});
