import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { createStore, readPublications } from '../frontend/store.ts';
import type { Readiness, TimelineItem } from '../src/ui-types.ts';

const ready: Readiness = { canSend: true, roles: ['coordinator', 'memory'].map(role => ({
  role: role as 'coordinator' | 'memory', sessionId: role, epoch: 1, modelId: 'test', cwd: '/test',
  status: 'ready', detail: null,
})), receptions: [{ id: 'reception', label: '接待者', kind: 'reception', enabled: true,
  evidence: 'fixture', availability: 'loaded', cursor: null, cursorSource: 'live', cursorDirection: 'forward',
  baseline: true, gap: null, generation: 1, version: 1 }] };
const item = (sequence: number, topicId = 'a'): TimelineItem => ({
  id: `p${sequence}`, sequence, type: 'message', text: `message ${sequence}`, messageId: `m${sequence}`,
  topicId, anchorId: `anchor${sequence}`, sources: [], createdAt: sequence * 1000,
  topicTitle: topicId, speaker: 'assistant', sessionId: 'reception', question: null,
});
const frame = (record: TimelineItem) =>
  `id: ${record.sequence}\nevent: publication\ndata: ${JSON.stringify(record)}\n\n`;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};
function fixture(handler?: (path: string, init?: RequestInit) => Promise<Response> | Response | undefined) {
  const requests: { path: string; init?: RequestInit }[] = [];
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const errors: unknown[] = [];
  const controller = new AbortController();
  const store = createStore({
    signal: controller.signal, report: error => errors.push(error),
    request: async (path, init) => {
      requests.push({ path, init });
      const custom = handler?.(path, init);
      if (custom) return custom;
      if (path === '/readiness') return Response.json(ready);
      if (path.startsWith('/timeline/stream')) return new Response(new ReadableStream<Uint8Array>({
        start(stream) { streams.push(stream); },
      }));
      if (path.startsWith('/timeline')) return Response.json({
        items: [item(10)], before: 10, watermark: 10, hasMore: false,
      });
      return Response.json({});
    },
  });
  return { store, requests, streams, errors, controller };
}

test('opening reads bounded tail and fresh readiness; closing aborts stream without clearing draft', async () => {
  const f = fixture();
  try {
    f.store.open(); await turn();
    assert.equal(f.store.getSnapshot().stream, 'connected');
    assert.ok(f.requests.some(request => request.path === '/timeline?limit=50'));
    assert.ok(f.requests.some(request => request.path === '/timeline/stream?after=10'));
    f.store.edit('保留草稿');
    f.store.close();
    assert.equal(f.store.getSnapshot().draft.text, '保留草稿');
    f.store.open(); await turn();
    assert.equal(f.requests.filter(request => request.path === '/readiness').length, 2);
    assert.equal(f.store.getSnapshot().draft.text, '保留草稿');
    assert.equal(f.requests.some(request => request.init?.method === 'POST'), false);
  } finally { f.store.dispose(); }
});

test('late read from a closed opening cannot replace current timeline or readiness', async () => {
  const pending = deferred<Response>();
  let first = true;
  const f = fixture(path => {
    if (path === '/timeline?limit=50' && first) { first = false; return pending.promise; }
  });
  try {
    f.store.open(); await turn();
    f.store.close(); f.store.open(); await turn();
    pending.resolve(Response.json({ items: [item(1)], watermark: 1, before: 1, hasMore: false }));
    await turn();
    assert.equal(f.store.getSnapshot().items[0]?.sequence, 10);
  } finally { f.store.dispose(); }
});

test('not-ready roles never post input and leave editing available', async () => {
  const f = fixture(path => path === '/readiness' ? Response.json({ ...ready, canSend: false }) : undefined);
  try {
    f.store.open(); await turn(); f.store.edit('draft');
    await f.store.send();
    assert.equal(f.store.getSnapshot().draft.text, 'draft');
    assert.equal(f.requests.some(request => request.path === '/messages'), false);
  } finally { f.store.dispose(); }
});

test('accepted anchored send preserves edits made after capture, including across close and reopen', async () => {
  const pending = deferred<Response>();
  const f = fixture(path => path === '/messages' ? pending.promise : undefined);
  try {
    f.store.open(); await turn(); f.store.reply(item(5, 'old-topic')); f.store.edit('old reply');
    const sending = f.store.send();
    f.store.close(); f.store.open(); f.store.edit('new draft'); await turn();
    pending.resolve(Response.json({ message: { id: 'saved' }, work: {} })); await sending;
    assert.equal(f.store.getSnapshot().draft.text, 'new draft');
    assert.equal(f.store.getSnapshot().submissions[0]?.state, 'accepted');
    const body = JSON.parse(String(f.requests.find(request => request.path === '/messages')?.init?.body));
    assert.equal(body.replyTo, 'anchor5');
    assert.equal(body.text, 'old reply');
    assert.equal(body.topicId, undefined);
  } finally { f.store.dispose(); }
});

test('network-unknown send keeps stable ID and text, blocks duplicate sends, and reconciles receipt', async () => {
  const f = fixture(path => {
    if (path === '/messages') return Promise.reject(new Error('connection lost'));
    if (path.startsWith('/inputs/')) return Response.json({
      requestId: path.split('/').at(-1), message: { id: 'saved' }, work: [], deliveries: [],
      hasMore: { work: false, deliveries: false },
    });
  });
  try {
    f.store.open(); await turn(); f.store.edit('important');
    await f.store.send();
    const original = f.store.getSnapshot().submissions[0]!;
    assert.equal(original.state, 'unknown');
    assert.equal(f.store.getSnapshot().draft.text, 'important');
    await f.store.send();
    assert.equal(f.requests.filter(request => request.path === '/messages').length, 1);
    await f.store.inspectInput(original.requestId);
    assert.equal(f.store.getSnapshot().submissions[0]?.requestId, original.requestId);
    assert.equal(f.store.getSnapshot().submissions[0]?.state, 'accepted');
    assert.equal(f.store.getSnapshot().draft.text, '');
  } finally { f.store.dispose(); }
});

test('known preflight rejection retries only the same logical ID without discarding draft', async () => {
  const f = fixture(path => path === '/messages'
    ? Response.json({ error: { code: 'ROLES_NOT_READY', message: 'changed' } }, { status: 409 }) : undefined);
  try {
    f.store.open(); await turn(); f.store.edit('retry after refresh');
    await f.store.send(); await f.store.send();
    const requests = f.requests.filter(request => request.path === '/messages');
    assert.equal(requests.length, 2);
    assert.equal(JSON.parse(String(requests[0]!.init!.body)).requestId,
      JSON.parse(String(requests[1]!.init!.body)).requestId);
    assert.equal(f.store.getSnapshot().draft.text, 'retry after refresh');
  } finally { f.store.dispose(); }
});

test('binding HTTP rejection with unknown durable receipt cannot be repeated as a new operation', async () => {
  const f = fixture(path => {
    if (path === '/roles/bind') return Response.json({ error: { code: 'ROLE_NOT_READY', message: 'preparation ran' } }, { status: 409 });
    if (path.startsWith('/operations/')) return Response.json({ id: decodeURIComponent(path.split('/').at(-1)!),
      state: 'unknown', fingerprint: 'x', result: null });
  });
  try {
    f.store.open(); await turn();
    await f.store.bind('coordinator', 'candidate', 'model', 1);
    assert.equal(f.store.getSnapshot().setup[0]?.state, 'unknown');
    await f.store.bind('coordinator', 'candidate', 'model', 1);
    assert.equal(f.requests.filter(request => request.path === '/roles/bind').length, 1);
  } finally { f.store.dispose(); }
});

test('fresh opening captures bound role epochs before activation; late completion preserves newer drafts', async () => {
  const pending = deferred<Response>();
  let readiness: Readiness = { ...ready, canSend: false,
    roles: ready.roles.map(role => ({ ...role, status: 'unloaded' })) };
  const f = fixture(path => {
    if (path === '/readiness') return Response.json(readiness);
    if (path === '/roles/activate') return pending.promise;
  });
  try {
    f.store.open(); await turn();
    const operation = f.store.getSnapshot().setup[0]!;
    assert.equal(operation.state, 'pending');
    const post = f.requests.find(request => request.path === '/roles/activate')!;
    assert.deepEqual(JSON.parse(String(post.init?.body)), { requestId: operation.requestId, bindings: [
      { role: 'coordinator', sessionId: 'coordinator', epoch: 1 },
      { role: 'memory', sessionId: 'memory', epoch: 1 },
    ] });
    f.store.close();
    assert.equal(post.init?.signal?.aborted, false);
    f.store.open(); f.store.edit('new draft'); f.store.reply(item(5, 'retained-topic')); await turn();
    assert.equal(f.store.getSnapshot().setup[0]?.requestId, operation.requestId);
    assert.equal(f.requests.filter(request => request.path === '/roles/activate').length, 1);
    readiness = ready;
    pending.resolve(Response.json({ id: operation.receiptId, fingerprint: 'x', state: 'accepted', result: { loaded: true } }));
    await turn();
    assert.equal(f.store.getSnapshot().setup[0]?.state, 'accepted');
    assert.equal(f.store.getSnapshot().readiness?.canSend, true);
    assert.equal(f.store.getSnapshot().draft.text, 'new draft');
    assert.equal(f.store.getSnapshot().draft.reply?.topicId, 'retained-topic');
  } finally { f.store.dispose(); }
});

test('unknown activation never retries on refresh or reopen; exact receipt remains inspectable', async () => {
  let inspectionState = 'unknown';
  const f = fixture((path, init) => {
    if (path === '/readiness') return Response.json({ ...ready, canSend: false,
      roles: ready.roles.map(role => ({ ...role, status: 'unloaded' })) });
    if (path === '/roles/activate') return Response.json({ id: `activate:${JSON.parse(String(init?.body)).requestId}`,
      state: 'unknown', fingerprint: 'x', result: { detail: 'Unconfirmed load' } });
    if (path.startsWith('/operations/')) return Response.json({ id: decodeURIComponent(path.split('/').at(-1)!),
      state: inspectionState, fingerprint: 'x', result: {} });
  });
  try {
    f.store.open(); await turn();
    const operation = f.store.getSnapshot().setup[0]!;
    assert.equal(operation.state, 'unknown');
    f.store.close(); f.store.open(); await turn();
    await f.store.refresh();
    await f.store.inspectOperation(operation.requestId);
    assert.equal(f.store.getSnapshot().setup[0]?.state, 'unknown');
    inspectionState = 'accepted';
    await f.store.inspectOperation(operation.requestId);
    assert.equal(f.store.getSnapshot().readiness?.canSend, false);
    f.store.close(); f.store.open(); await turn();
    assert.equal(f.requests.filter(request => request.path === '/roles/activate').length, 1);
    assert.ok(f.requests.some(request => decodeURIComponent(request.path) === `/operations/${operation.receiptId}`));
  } finally { f.store.dispose(); }
});

test('stale readiness cannot activate a former carrier and unknown/invalid roles are not repaired', async () => {
  const delayed = deferred<Response>();
  let checks = 0;
  const f = fixture(path => {
    if (path !== '/readiness') return;
    if (++checks === 1) return delayed.promise;
    return Response.json({ ...ready, canSend: false, roles: ready.roles.map((role, index) =>
      ({ ...role, status: index ? 'unknown' : 'invalid' })) });
  });
  try {
    f.store.open(); await turn();
    f.store.close(); f.store.open(); await turn();
    delayed.resolve(Response.json({ ...ready, canSend: false,
      roles: ready.roles.map(role => ({ ...role, status: 'unloaded' })) }));
    await turn();
    assert.equal(f.store.getSnapshot().readiness?.roles[0]?.status, 'invalid');
    assert.equal(f.requests.some(request => request.init?.method === 'POST'), false);
  } finally { f.store.dispose(); }
});

test('a confirmed carrier can be activated after a later unload without requiring the other role to be ready', async () => {
  const readiness: Readiness = { ...ready, canSend: false,
    roles: ready.roles.map((role, index) => ({ ...role, status: index ? 'invalid' : 'unloaded' })) };
  const f = fixture((path, init) => {
    if (path === '/readiness') return Response.json(readiness);
    if (path === '/roles/activate') {
      readiness.roles[0]!.status = 'ready';
      return Response.json({ id: `activate:${JSON.parse(String(init?.body)).requestId}`,
        fingerprint: 'x', state: 'accepted', result: {} });
    }
  });
  try {
    f.store.open(); await turn();
    assert.equal(f.store.getSnapshot().setup[0]?.state, 'accepted');
    assert.equal(f.store.getSnapshot().readiness?.roles[0]?.status, 'ready');
    f.store.close();
    readiness.roles[0]!.status = 'unloaded';
    f.store.open(); await turn();
    assert.equal(f.requests.filter(request => request.path === '/roles/activate').length, 2);
    assert.notEqual(f.store.getSnapshot().setup[0]?.requestId, f.store.getSnapshot().setup[1]?.requestId);
  } finally { f.store.dispose(); }
});

test('activation errors or malformed receipt IDs stay unknown when effect cannot be inspected', async () => {
  for (const malformed of [false, true]) {
    const f = fixture(path => {
      if (path === '/readiness') return Response.json({ ...ready, canSend: false,
        roles: ready.roles.map(role => ({ ...role, status: 'unloaded' })) });
      if (path === '/roles/activate') return malformed
        ? Response.json({ id: 'wrong-id', fingerprint: 'x', state: 'accepted', result: {} })
        : Promise.reject(new Error('network lost'));
      if (path.startsWith('/operations/')) return Response.json(
        { error: { code: 'NOT_FOUND', message: 'not known yet' } }, { status: 404 });
    });
    try {
      f.store.open(); await turn();
      assert.equal(f.store.getSnapshot().setup[0]?.state, 'unknown');
      f.store.close(); f.store.open(); await turn();
      assert.equal(f.requests.filter(request => request.path === '/roles/activate').length, 1);
    } finally { f.store.dispose(); }
  }
});

test('ready roles can submit with no separately enrolled receptions', async () => {
  const f = fixture(path => path === '/readiness' ? Response.json({ ...ready, receptions: [] }) : undefined);
  try {
    f.store.open(); await turn(); f.store.edit('automatic observation');
    await f.store.send();
    assert.equal(f.requests.filter(request => request.path === '/messages').length, 1);
  } finally { f.store.dispose(); }
});

test('SSE deduplicates applied publications and older pages merge without losing newly arrived messages', async () => {
  const older = deferred<Response>();
  const f = fixture(path => {
    if (path === '/timeline?limit=50') return Response.json({ items: [item(10)], watermark: 10, before: 10, hasMore: true });
    if (path.startsWith('/timeline?before')) return older.promise;
  });
  try {
    f.store.open(); await turn();
    const loading = f.store.loadOlder();
    f.streams[0]!.enqueue(new TextEncoder().encode(frame(item(10)) + frame(item(11, 'b')) + frame(item(12))));
    await turn();
    older.resolve(Response.json({ items: [item(8), item(9)], watermark: 12, before: 8, hasMore: true }));
    await loading;
    assert.deepEqual(f.store.getSnapshot().items.map(entry => entry.sequence), [8, 9, 10, 11, 12]);
    assert.equal(f.requests.filter(request => request.path === '/timeline?limit=50').length, 1);
  } finally { f.store.dispose(); }
});

test('out-of-order SSE never advances cursor and reconnect backfills from last applied sequence', async () => {
  const f = fixture(path => path === '/timeline?after=10&limit=100'
    ? Response.json({ items: [item(11), item(12)], watermark: 12, before: 11, hasMore: false, cursor: 12 }) : undefined);
  try {
    f.store.open(); await turn();
    f.streams[0]!.enqueue(new TextEncoder().encode(frame(item(12)))); await turn();
    assert.deepEqual(f.store.getSnapshot().items.map(entry => entry.sequence), [10]);
    assert.equal(f.store.getSnapshot().stream, 'disconnected');
    f.store.reconnect(); await turn();
    assert.deepEqual(f.store.getSnapshot().items.map(entry => entry.sequence), [10, 11, 12]);
    assert.ok(f.requests.some(request => request.path === '/timeline/stream?after=12'));
  } finally { f.store.dispose(); }
});

test('SSE validates chunked CRLF frames, reports stream errors and rejects mismatched IDs', async () => {
  const encoder = new TextEncoder();
  const chunks = frame(item(1)).replace(/\n/g, '\r\n');
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(chunks.slice(0, 33)));
      controller.enqueue(encoder.encode(chunks.slice(33)));
      controller.enqueue(encoder.encode('event: error\ndata: broken\n\n'));
      controller.close();
    },
  }));
  const seen: number[] = [];
  await assert.rejects(readPublications(response, entry => seen.push(entry.sequence), new AbortController().signal), /error/);
  assert.deepEqual(seen, [1]);
  await assert.rejects(readPublications(new Response(frame(item(1)).replace('id: 1', 'id: 2')),
    () => {}, new AbortController().signal), /序号/);
});
