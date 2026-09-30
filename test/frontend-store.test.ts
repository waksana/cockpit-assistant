import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { createStore, readPublications } from '../frontend/store.ts';
import { conversationItems } from '../frontend/timeline.ts';
import type { Readiness, TimelineItem } from '../src/ui-types.ts';
import { hostState } from './frontend-host.ts';

const ready: Readiness = { canSend: true, roles: ['coordinator' as const].map(role => ({
  role, sessionId: role, modelId: 'test', cwd: '/test',
  status: 'ready', detail: null,
})), receptions: [{ id: 'reception', label: '接待者', availability: 'loaded' }] };
const item = (sequence: number, topicId = 'a'): TimelineItem => ({
  id: `m${sequence}`, sequence, snapshotRevision: sequence, type: 'message', text: `message ${sequence}`, messageId: `m${sequence}`,
  topicId, createdAt: sequence * 1000, diagnostic: null, clarifications: [], deliveryIssues: [],
  topicTitle: topicId, speaker: 'assistant', sessionId: 'reception', question: null, attachments: [],
});
const frame = (record: TimelineItem) =>
  `id: ${record.snapshotRevision}\nevent: publication\ndata: ${JSON.stringify(record)}\n\n`;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};
async function fixture(handler?: (path: string, init?: RequestInit) => Promise<Response> | Response | undefined) {
  const requests: { path: string; init?: RequestInit }[] = [];
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const errors: unknown[] = [];
  const controller = new AbortController();
  const host = await hostState();
  const inputs = new Map<string, unknown>();
  const store = await host.activate(context => createStore({
    state: context.state,
    signal: controller.signal, report: error => errors.push(error),
    request: async (path, init) => {
      requests.push({ path, init });
      if (path === '/messages') {
        const input = JSON.parse(String(init?.body));
        inputs.set(input.requestId, input);
      }
      const custom = handler?.(path, init);
      if (custom) return custom;
      if (path === '/state') return Response.json({
        protocolVersion: 4, timelineProtocol: 'foreground-message-snapshots-v1', legacyTimelinePath: '/legacy/timeline',
      });
      if (path === '/readiness') return Response.json(ready);
      if (path.startsWith('/timeline/stream')) return new Response(new ReadableStream<Uint8Array>({
        start(stream) { streams.push(stream); },
      }));
      if (path.startsWith('/timeline?after=')) {
        const cursor = Number(new URL(path, 'http://fixture').searchParams.get('after'));
        return Response.json({ items: [], before: null, watermark: cursor, cursor, hasMore: false });
      }
      if (path.startsWith('/timeline')) return Response.json({
        items: [item(10)], before: 10, watermark: 10, hasMore: false,
      });
      if (path.startsWith('/inputs/')) {
        const requestId = path.split('/').at(-1)!;
        return Response.json({ requestId, input: inputs.get(requestId), message: { id: `saved-${requestId}` },
          topicMessages: [], hasMore: { topicMessages: false } });
      }
      return Response.json({});
    },
  }));
  const dispose = store.dispose;
  store.dispose = () => { dispose(); host.stop(); };
  return { store, requests, streams, errors, controller };
}

test('opening reads bounded tail and fresh readiness; closing aborts stream without clearing draft', async () => {
  const f = await fixture();
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

test('foreground protocol discovery gates reads and sending rather than silently consuming an old aggregation feed', async () => {
  const gate = deferred<Response>();
  const f = await fixture(path => path === '/state' ? gate.promise : undefined);
  try {
    f.store.open(); await turn();
    f.store.edit('保留尚未发送的输入');
    assert.equal(f.requests.some(request => request.path.startsWith('/timeline')), false);
    assert.equal(f.requests.some(request => request.path === '/readiness'), false);
    await f.store.send();
    assert.equal(f.requests.some(request => request.path === '/messages'), false);
    gate.resolve(Response.json({ protocolVersion: 3, timelineProtocol: 'message-snapshots-v1' }));
    await turn();
    assert.equal(f.store.getSnapshot().protocolReady, false);
    assert.equal(f.store.getSnapshot().checking, false);
    assert.match(f.store.getSnapshot().error!, /协议不兼容/);
    assert.equal(f.store.getSnapshot().draft.text, '保留尚未发送的输入');
    assert.equal(f.requests.some(request => request.path.startsWith('/timeline')), false);
  } finally { f.store.dispose(); }
});

test('failed protocol revalidation revokes prior readiness and blocks new input', async () => {
  let protocolReads = 0;
  const revalidation = deferred<Response>();
  const f = await fixture(path => {
    if (path === '/state' && ++protocolReads > 1) return revalidation.promise;
    if (path === '/timeline?limit=50') return Response.json(
      { error: { code: 'UNAVAILABLE', message: 'Synthetic initial history unavailable' } }, { status: 503 });
  });
  try {
    f.store.open(); await turn(); f.store.edit('保留原草稿');
    assert.equal(f.store.getSnapshot().protocolReady, true);
    assert.equal(f.store.getSnapshot().draft.submittable, true);
    f.store.reconnect();
    assert.equal(f.store.getSnapshot().protocolReady, false);
    assert.equal(f.store.getSnapshot().readiness, null);
    assert.equal(f.store.getSnapshot().draft.submittable, false);
    revalidation.resolve(Response.json({ protocolVersion: 3, timelineProtocol: 'message-snapshots-v1' }));
    await turn();
    assert.match(f.store.getSnapshot().error!, /协议不兼容/);
    assert.equal(f.store.getSnapshot().protocolReady, false);
    assert.equal(f.store.getSnapshot().checking, false);
    await f.store.send();
    assert.equal(f.requests.some(request => request.path === '/messages'), false);
    assert.equal(f.store.getSnapshot().draft.text, '保留原草稿');
  } finally { f.store.dispose(); }
});

test('a late readiness response cannot activate a carrier during new protocol validation', async () => {
  const oldReadiness = deferred<Response>(), newProtocol = deferred<Response>();
  let protocolReads = 0;
  const f = await fixture(path => {
    if (path === '/state' && ++protocolReads > 1) return newProtocol.promise;
    if (path === '/readiness') return oldReadiness.promise;
    if (path === '/timeline?limit=50') return Response.json(
      { error: { code: 'UNAVAILABLE', message: 'Synthetic initial history unavailable' } }, { status: 503 });
  });
  try {
    f.store.open(); await turn();
    f.store.reconnect();
    oldReadiness.resolve(Response.json({ ...ready, canSend: false,
      roles: ready.roles.map(role => ({ ...role, status: 'unloaded' })) }));
    await turn();
    assert.equal(f.store.getSnapshot().readiness, null);
    assert.equal(f.store.getSnapshot().protocolReady, false);
    assert.equal(f.requests.some(request => request.path === '/roles/activate'), false);
    newProtocol.resolve(Response.json({ protocolVersion: 3 }));
    await turn();
    assert.equal(f.requests.some(request => request.init?.method === 'POST'), false);
  } finally { f.store.dispose(); }
});

test('legacy history is explicitly read-only and keeps the current conversation draft', async () => {
  const legacy = { ...item(1), text: '旧版后台原文', clarifications: [{
    id: 'legacy-question', question: '之前的分类澄清', choices: [], allowFreeform: true,
    createdAt: 1, answer: null, answeredAt: null, requestId: null,
  }] };
  const f = await fixture(path => path === '/legacy/timeline?limit=50'
    ? Response.json({ items: [legacy], before: 1, watermark: 1, hasMore: false }) : undefined);
  try {
    f.store.open(); await turn();
    f.store.edit('当前对话草稿');
    f.store.showLegacy(true); await turn();
    assert.equal(f.store.getSnapshot().view, 'legacy');
    assert.equal(f.store.getSnapshot().items[0]!.text, '旧版后台原文');
    assert.equal(f.store.getSnapshot().draft.submittable, false);
    const streamCount = f.streams.length;
    f.store.reconnect();
    await f.store.send();
    assert.equal(f.streams.length, streamCount);
    assert.equal(f.requests.some(request => request.path.includes('/clarifications/')), false);
    assert.equal(f.requests.some(request => request.init?.method === 'POST'), false);
    f.store.showLegacy(false); await turn();
    assert.equal(f.store.getSnapshot().view, 'conversation');
    assert.equal(f.store.getSnapshot().draft.text, '当前对话草稿');
    assert.equal(f.store.getSnapshot().items[0]!.id, 'm10');
    assert.equal(f.store.getSnapshot().draft.submittable, true);
  } finally { f.store.dispose(); }
});

test('delivery failures survive both initial timeline validation and subsequent SSE snapshots', async () => {
  const rejected = { topicMessageId: 'outgoing-1', state: 'rejected' as const, detail: '目标会话已不存在' };
  const original = { ...item(10), speaker: 'user' as const, deliveryIssues: [rejected] };
  const f = await fixture(path => path === '/timeline?limit=50'
    ? Response.json({ items: [original], before: 10, watermark: 10, hasMore: false }) : undefined);
  try {
    f.store.open(); await turn();
    assert.deepEqual(f.store.getSnapshot().items[0]!.deliveryIssues, [rejected]);
    const unknown = { topicMessageId: 'outgoing-2', state: 'unknown' as const, detail: '投递回执无法确认' };
    f.streams[0]!.enqueue(new TextEncoder().encode(frame({
      ...original, snapshotRevision: 11, deliveryIssues: [unknown],
    })));
    await turn();
    assert.deepEqual(f.store.getSnapshot().items[0]!.deliveryIssues, [unknown]);
    assert.equal(f.store.getSnapshot().items[0]!.text, original.text);
    assert.equal(f.store.getSnapshot().items.length, 1);
  } finally { f.store.dispose(); }
});

test('late read from a closed opening cannot replace current timeline or readiness', async () => {
  const pending = deferred<Response>();
  let first = true;
  const f = await fixture(path => {
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
  const f = await fixture(path => path === '/readiness' ? Response.json({ ...ready, canSend: false }) : undefined);
  try {
    f.store.open(); await turn(); f.store.edit('draft');
    await f.store.send();
    assert.equal(f.store.getSnapshot().draft.text, 'draft');
    assert.equal(f.requests.some(request => request.path === '/messages'), false);
  } finally { f.store.dispose(); }
});

test('ordinary input omits replyTo and preserves newer edits across page navigation', async () => {
  const pending = deferred<Response>();
  const f = await fixture(path => path === '/messages' ? pending.promise : undefined);
  try {
    f.store.open(); await turn(); f.store.edit('old reply');
    const sending = f.store.send();
    f.store.close(); f.store.open(); f.store.edit('new draft'); await turn();
    pending.resolve(Response.json({ message: { id: 'saved' } })); await sending;
    assert.equal(f.store.getSnapshot().draft.text, 'new draft');
    assert.equal(f.store.getSnapshot().submissions[0]?.state, 'accepted');
    const body = JSON.parse(String(f.requests.find(request => request.path === '/messages')?.init?.body));
    assert.equal(Object.hasOwn(body, 'replyTo'), false);
    assert.equal(body.text, 'old reply');
    assert.equal(body.topicId, undefined);
  } finally { f.store.dispose(); }
});

test('input receipt inspection exposes topic-message delivery failures without resending input', async () => {
  let input: Record<string, unknown>;
  let failed = false;
  const f = await fixture((path, init) => {
    if (path === '/messages') input = JSON.parse(String(init?.body));
    if (path.startsWith('/inputs/')) return Response.json({
      requestId: input.requestId, input, message: { id: 'saved' },
      topicMessages: [failed
        ? { state: 'rejected', error: 'The selected session no longer exists' }
        : { state: 'calling', error: 'The selected session is closing' }],
    });
  });
  try {
    f.store.open(); await turn(); f.store.edit('Original');
    await f.store.send();
    const submission = f.store.getSnapshot().submissions[0]!;
    assert.equal(submission.state, 'accepted', 'input persistence is distinct from native delivery');
    assert.match(submission.detail, /closing/);
    failed = true;
    await f.store.inspectInput(submission.requestId);
    assert.match(f.store.getSnapshot().submissions[0]!.detail, /no longer exists/);
    assert.equal(f.requests.filter(request => request.path === '/messages').length, 1);
  } finally { f.store.dispose(); }
});

test('a displayed choice-only question does not bind new natural input or disable its attachments', async () => {
  const question = { ...item(10), type: 'question', question: {
    state: 'pending', stateVersion: 1, choices: ['Proceed', 'Wait'], allowFreeform: false,
  } };
  const f = await fixture(path => path === '/timeline?limit=50'
    ? Response.json({ items: [question], before: 10, watermark: 10, hasMore: false }) : undefined);
  try {
    f.store.open(); await turn();
    f.store.edit('I am asking about a different topic.');
    assert.equal(f.store.getSnapshot().draft.submittable, true);
    assert.equal(f.store.getSnapshot().draft.capabilities.attachments, true);
    assert.equal(f.store.getSnapshot().draft.askContext, undefined);
    await f.store.send();
    const body = JSON.parse(String(f.requests.find(request => request.path === '/messages')?.init?.body));
    assert.equal(body.text, 'I am asking about a different topic.');
    assert.equal(Object.hasOwn(body, 'replyTo'), false);
  } finally { f.store.dispose(); }
});

test('uncertain sends recover automatically while preserving newer draft edits, never reposting', async t => {
  const f = await fixture(path => path === '/messages' ? Promise.reject(new Error('connection lost')) : undefined);
  try {
    f.store.open(); await turn(); f.store.edit('captured');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await f.store.send();
    f.store.edit('newer draft');
    assert.equal(f.store.getSnapshot().draft.unconfirmed, true);
    t.mock.timers.tick(1500); await turn();
    assert.equal(f.store.getSnapshot().draft.unconfirmed, false);
    assert.equal(f.store.getSnapshot().draft.text, 'newer draft');
    assert.equal(f.store.getSnapshot().submissions[0]?.state, 'accepted');
    assert.equal(f.requests.filter(request => request.path === '/messages').length, 1);
  } finally { f.store.dispose(); }
});

test('automatic draft recovery pauses when closed and resumes on reopening', async t => {
  const f = await fixture(path => path === '/messages' ? Promise.reject(new Error('connection lost')) : undefined);
  try {
    f.store.open(); await turn(); f.store.edit('preserved');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await f.store.send();
    f.store.close();
    t.mock.timers.tick(30_000); await turn();
    assert.equal(f.requests.filter(request => request.path.startsWith('/inputs/')).length, 0);
    f.store.open(); await turn();
    t.mock.timers.tick(1500); await turn();
    assert.equal(f.store.getSnapshot().draft.text, '');
    assert.equal(f.store.getSnapshot().draft.unconfirmed, false);
    assert.equal(f.requests.filter(request => request.path === '/messages').length, 1);
  } finally { f.store.dispose(); }
});

test('network-unknown send keeps stable ID and text, blocks duplicate sends, and reconciles receipt', async () => {
  const f = await fixture(path => {
    if (path === '/messages') return Promise.reject(new Error('connection lost'));
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

test('known rejection preserves draft and only explicit new submission creates a new logical ID', async () => {
  const f = await fixture(path => path === '/messages'
    ? Response.json({ error: { code: 'ROLES_NOT_READY', message: 'changed' } }, { status: 409 }) : undefined);
  try {
    f.store.open(); await turn(); f.store.edit('retry after refresh');
    await f.store.send(); await f.store.send();
    const requests = f.requests.filter(request => request.path === '/messages');
    assert.equal(requests.length, 2);
    assert.notEqual(JSON.parse(String(requests[0]!.init!.body)).requestId,
      JSON.parse(String(requests[1]!.init!.body)).requestId);
    assert.equal(f.store.getSnapshot().draft.text, 'retry after refresh');
  } finally { f.store.dispose(); }
});

test('a successful POST cannot ACK without a receipt matching the entire immutable input', async () => {
  for (const field of ['missing-input', 'requestId', 'text', 'attachments', 'replyTo', 'topicId']) {
    let captured!: Record<string, unknown>;
    const f = await fixture((path, init) => {
      if (path === '/messages') { captured = JSON.parse(String(init?.body)); return Response.json({ accepted: true }); }
      if (!path.startsWith('/inputs/')) return;
      const input = { ...captured };
      if (field === 'attachments') input.attachments = [{ type: 'file', path: '/not-the-captured-file' }];
      else if (field !== 'missing-input') input[field] = 'different';
      return Response.json({ requestId: captured.requestId,
        ...(field === 'missing-input' ? {} : { input }), message: { id: 'saved' }, topicMessages: [] });
    });
    try {
      f.store.open(); await turn();
      f.store.edit('must survive');
      await f.store.send();
      assert.equal(f.store.getSnapshot().submissions[0]?.state, 'unknown', field);
      assert.equal(f.store.getSnapshot().draft.text, 'must survive', field);
      await f.store.inspectInput(String(captured.requestId));
      await f.store.send();
      assert.equal(f.requests.filter(request => request.path === '/messages').length, 1, field);
    } finally { f.store.dispose(); }
  }
});

test('activation HTTP rejection with unknown durable receipt cannot be repeated as a new operation', async () => {
  const f = await fixture(path => {
    if (path === '/readiness') return Response.json({ ...ready, canSend: false,
      roles: ready.roles.map(role => ({ ...role, status: 'unloaded' })) });
    if (path === '/roles/activate') return Response.json({ error: { code: 'ROLE_NOT_READY', message: 'preparation ran' } }, { status: 409 });
    if (path.startsWith('/operations/')) return Response.json({ id: decodeURIComponent(path.split('/').at(-1)!),
      state: 'unknown', kind: 'activate', fingerprint: 'x', result: null });
  });
  try {
    f.store.open(); await turn();
    assert.equal(f.store.getSnapshot().setup[0]?.state, 'unknown');
    f.store.close(); f.store.open(); await turn();
    assert.equal(f.requests.filter(request => request.path === '/roles/activate').length, 1);
  } finally { f.store.dispose(); }
});

test('fresh opening captures the bound session before activation; late completion preserves newer drafts', async () => {
  const pending = deferred<Response>();
  let readiness: Readiness = { ...ready, canSend: false,
    roles: ready.roles.map(role => ({ ...role, status: 'unloaded' })) };
  const f = await fixture(path => {
    if (path === '/readiness') return Response.json(readiness);
    if (path === '/roles/activate') return pending.promise;
  });
  try {
    f.store.open(); await turn();
    const operation = f.store.getSnapshot().setup[0]!;
    assert.equal(operation.state, 'pending');
    const post = f.requests.find(request => request.path === '/roles/activate')!;
    assert.deepEqual(JSON.parse(String(post.init?.body)), { requestId: operation.requestId, bindings: [
      { role: 'coordinator', sessionId: 'coordinator' },
    ] });
    f.store.close();
    assert.equal(post.init?.signal?.aborted, false);
    f.store.open(); f.store.edit('new draft'); await turn();
    assert.equal(f.store.getSnapshot().setup[0]?.requestId, operation.requestId);
    assert.equal(f.requests.filter(request => request.path === '/roles/activate').length, 1);
    readiness = ready;
    pending.resolve(Response.json({ id: operation.receiptId, kind: 'activate', fingerprint: 'x', state: 'accepted', result: { loaded: true } }));
    await turn();
    assert.equal(f.store.getSnapshot().setup[0]?.state, 'accepted');
    assert.equal(f.store.getSnapshot().readiness?.canSend, true);
    assert.equal(f.store.getSnapshot().draft.text, 'new draft');
  } finally { f.store.dispose(); }
});

test('unknown activation never retries on refresh or reopen; exact receipt remains inspectable', async () => {
  let inspectionState = 'unknown';
  const f = await fixture((path, init) => {
    if (path === '/readiness') return Response.json({ ...ready, canSend: false,
      roles: ready.roles.map(role => ({ ...role, status: 'unloaded' })) });
    if (path === '/roles/activate') return Response.json({ id: `activate:${JSON.parse(String(init?.body)).requestId}`,
      state: 'unknown', kind: 'activate', fingerprint: 'x', result: { detail: 'Unconfirmed load' } });
    if (path.startsWith('/operations/')) return Response.json({ id: decodeURIComponent(path.split('/').at(-1)!),
      state: inspectionState, kind: 'activate', fingerprint: 'x', result: {} });
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
  const f = await fixture(path => {
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

test('the coordinator can be activated after a later unload without a memory carrier', async () => {
  const readiness: Readiness = { ...ready, canSend: false,
    roles: ready.roles.map(role => ({ ...role, status: 'unloaded' })) };
  const f = await fixture((path, init) => {
    if (path === '/readiness') return Response.json(readiness);
    if (path === '/roles/activate') {
      readiness.roles[0]!.status = 'ready';
      return Response.json({ id: `activate:${JSON.parse(String(init?.body)).requestId}`,
        kind: 'activate', fingerprint: 'x', state: 'accepted', result: {} });
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
    const f = await fixture(path => {
      if (path === '/readiness') return Response.json({ ...ready, canSend: false,
        roles: ready.roles.map(role => ({ ...role, status: 'unloaded' })) });
      if (path === '/roles/activate') return malformed
        ? Response.json({ id: 'wrong-id', kind: 'activate', fingerprint: 'x', state: 'accepted', result: {} })
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
  const f = await fixture(path => path === '/readiness' ? Response.json({ ...ready, receptions: [] }) : undefined);
  try {
    f.store.open(); await turn(); f.store.edit('automatic observation');
    await f.store.send();
    assert.equal(f.requests.filter(request => request.path === '/messages').length, 1);
  } finally { f.store.dispose(); }
});

test('SSE deduplicates applied publications and older pages merge without losing newly arrived messages', async () => {
  const older = deferred<Response>();
  const f = await fixture(path => {
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

test('sparse SSE revisions update old messages in place and reconnect reads by revision, not sequence', async () => {
  const updated = { ...item(10), snapshotRevision: 30, text: 'Updated original' };
  const f = await fixture(path => path === '/timeline?after=30&limit=100'
    ? Response.json({ items: [item(11), { ...updated, snapshotRevision: 50, topicTitle: 'Assigned' }]
      .map((entry, index) => ({ ...entry, snapshotRevision: index ? 50 : 40 })),
    watermark: 55, before: 11, hasMore: false, cursor: 50 }) : undefined);
  try {
    f.store.open(); await turn();
    f.streams[0]!.enqueue(new TextEncoder().encode(frame(updated) + frame(item(10)))); await turn();
    assert.deepEqual(f.store.getSnapshot().items.map(entry => entry.sequence), [10]);
    assert.equal(f.store.getSnapshot().items[0]!.text, updated.text);
    assert.equal(f.store.getSnapshot().stream, 'connected');
    f.store.reconnect(); await turn();
    assert.deepEqual(f.store.getSnapshot().items.map(entry => entry.sequence), [10, 11]);
    assert.equal(f.store.getSnapshot().items[0]!.topicTitle, 'Assigned');
    assert.ok(f.requests.some(request => request.path === '/timeline/stream?after=55'));
  } finally { f.store.dispose(); }
});

test('opening uses the global watermark even when the final display item has an older revision', async () => {
  const f = await fixture(path => path === '/timeline?limit=50'
    ? Response.json({ items: [{ ...item(9), snapshotRevision: 70 }, item(10)],
      watermark: 90, before: 9, hasMore: false }) : undefined);
  try {
    f.store.open(); await turn();
    const request = f.requests.find(request => request.path === '/timeline/stream?after=90');
    assert.equal(new Headers(request?.init?.headers).get('last-event-id'), '90');
    f.streams[0]!.enqueue(new TextEncoder().encode(frame({ ...item(9), snapshotRevision: 100, text: 'Latest' })));
    await turn();
    assert.deepEqual(f.store.getSnapshot().items.map(entry => entry.sequence), [9, 10]);
    assert.equal(f.store.getSnapshot().items[0]!.text, 'Latest');
  } finally { f.store.dispose(); }
});

test('an updated older message cannot move the history cursor or let stale history replace its snapshot', async () => {
  const pending = deferred<Response>();
  const f = await fixture(path => {
    if (path === '/timeline?limit=50') return Response.json({
      items: [item(10)], watermark: 10, before: 10, hasMore: true,
    });
    if (path === '/timeline?before=10&limit=50') return pending.promise;
  });
  try {
    f.store.open(); await turn();
    const changed = { ...item(8), snapshotRevision: 30, text: 'Fresh source', topicTitle: 'Fresh attribution',
      question: { state: 'answered' as const, stateVersion: 2, requestId: 'ask-8' } };
    f.streams[0]!.enqueue(new TextEncoder().encode(frame(changed)));
    await turn();
    const loading = f.store.loadOlder();
    assert.ok(f.requests.some(request => request.path === '/timeline?before=10&limit=50'));
    pending.resolve(Response.json({ items: [item(8), item(9)], watermark: 10, before: 8, hasMore: false }));
    await loading;
    assert.deepEqual(f.store.getSnapshot().items.map(entry => entry.sequence), [8, 9, 10]);
    assert.equal(f.store.getSnapshot().items[0]!.text, changed.text);
    assert.equal(f.store.getSnapshot().items[0]!.question?.state, 'answered');
    f.store.reconnect(); await turn();
    assert.ok(f.requests.some(request => request.path === '/timeline?after=30&limit=100'));
  } finally { f.store.dispose(); }
});

test('invalid catch-up ordering cannot partially apply a page or advance the retry cursor', async () => {
  let invalid = true;
  const f = await fixture(path => path === '/timeline?after=10&limit=100' ? Response.json({
    items: invalid ? [{ ...item(11), snapshotRevision: 30 }, { ...item(12), snapshotRevision: 20 }] : [],
    watermark: invalid ? 30 : 10, before: invalid ? 11 : null, hasMore: false, cursor: invalid ? 20 : 10,
  }) : undefined);
  try {
    f.store.open(); await turn();
    f.store.reconnect(); await turn();
    assert.equal(f.store.getSnapshot().stream, 'disconnected');
    assert.match(f.store.getSnapshot().error!, /修订游标/);
    assert.deepEqual(f.store.getSnapshot().items.map(entry => entry.sequence), [10]);
    invalid = false;
    f.store.reconnect(); await turn();
    assert.equal(f.requests.filter(request => request.path === '/timeline?after=10&limit=100').length, 2);
    assert.equal(f.store.getSnapshot().stream, 'connected');
  } finally { f.store.dispose(); }
});

test('malformed snapshot revisions and mismatched identities are explicit stream errors without applying', async () => {
  for (const malformed of [
    { ...item(1), snapshotRevision: undefined }, { ...item(1), messageId: 'different' },
    { ...item(1), type: 'correction' },
  ]) {
    let applied = false;
    await assert.rejects(readPublications(new Response(
      `id: 1\nevent: publication\ndata: ${JSON.stringify(malformed)}\n\n`),
    () => { applied = true; }, new AbortController().signal));
    assert.equal(applied, false);
  }
  for (const body of ['event: message\ndata: unexpected\n\n', 'data: unexpected\n\n']) {
    await assert.rejects(readPublications(new Response(body), () => {}, new AbortController().signal), /事件异常/);
  }
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
    () => {}, new AbortController().signal), /修订游标/);
});

const systemItem = (sequence: number): TimelineItem => ({
  ...item(sequence), speaker: 'system', text: 'Native wake accepted',
});

test('system-only tail and intervening history pages advance raw cursors to earlier conversation', async () => {
  const f = await fixture(path => {
    if (path === '/timeline?limit=50') return Response.json({
      items: [systemItem(10)], watermark: 10, before: 10, hasMore: true,
    });
    if (path === '/timeline?before=10&limit=50') return Response.json({
      items: [systemItem(8), systemItem(9)], watermark: 10, before: 8, hasMore: true,
    });
    if (path === '/timeline?before=8&limit=50') return Response.json({
      items: [item(7)], watermark: 10, before: 7, hasMore: true,
    });
    if (path === '/timeline?before=7&limit=50') return Response.json({
      items: [systemItem(5), systemItem(6)], watermark: 10, before: 5, hasMore: true,
    });
    if (path === '/timeline?before=5&limit=50') return Response.json({
      items: [item(4)], watermark: 10, before: 4, hasMore: false,
    });
  });
  try {
    f.store.open(); await turn();
    assert.equal(f.store.getSnapshot().loading, false);
    assert.deepEqual(conversationItems(f.store.getSnapshot().items).map(entry => entry.sequence), [7]);
    assert.ok(f.requests.some(request => request.path === '/timeline/stream?after=10'));
    await f.store.loadOlder();
    assert.deepEqual(conversationItems(f.store.getSnapshot().items).map(entry => entry.sequence), [4, 7]);
    assert.deepEqual(f.store.getSnapshot().items.map(entry => entry.sequence), [4, 5, 6, 7, 8, 9, 10]);
    assert.equal(f.store.getSnapshot().hasOlder, false);
  } finally { f.store.dispose(); }
});

test('hidden SSE and catch-up publications advance the cursor without becoming conversation', async () => {
  const f = await fixture(path => {
    if (path === '/timeline?limit=50') return Response.json({
      items: [systemItem(10)], watermark: 10, before: 10, hasMore: false,
    });
    if (path === '/timeline?after=12&limit=100') return Response.json({
      items: [systemItem(13), systemItem(14)], watermark: 15, before: 13, hasMore: true, cursor: 14,
    });
    if (path === '/timeline?after=14&limit=100') return Response.json({
      items: [item(15)], watermark: 15, before: 15, hasMore: false, cursor: 15,
    });
  });
  try {
    f.store.open(); await turn();
    assert.deepEqual(conversationItems(f.store.getSnapshot().items), []);
    f.streams[0]!.enqueue(new TextEncoder().encode(frame(systemItem(11)) + frame(systemItem(12))));
    await turn();
    assert.deepEqual(conversationItems(f.store.getSnapshot().items), []);
    f.store.reconnect(); await turn();
    assert.ok(f.requests.some(request => request.path === '/timeline/stream?after=15'));
    f.streams[1]!.enqueue(new TextEncoder().encode(frame(item(15))));
    await turn();
    assert.deepEqual(conversationItems(f.store.getSnapshot().items).map(entry => entry.sequence), [15]);
    assert.deepEqual(f.store.getSnapshot().items.map(entry => entry.sequence), [10, 11, 12, 13, 14, 15]);
  } finally { f.store.dispose(); }
});

test('non-advancing system-only history is an explicit error, not an infinite paging loop', async () => {
  const f = await fixture(path => path.startsWith('/timeline?')
    ? Response.json({ items: [systemItem(10)], watermark: 10, before: 10, hasMore: true }) : undefined);
  try {
    f.store.open(); await turn();
    assert.match(f.store.getSnapshot().error!, /游标未前进/);
    assert.equal(f.store.getSnapshot().loading, false);
    assert.equal(f.requests.filter(request => request.path.startsWith('/timeline?')).length, 2);
  } finally { f.store.dispose(); }
});

test('Speech reference follows the corrected visible assistant text rather than hidden diagnostics', async () => {
  const original = item(10);
  const f = await fixture(path => path === '/timeline?limit=50'
    ? Response.json({ items: [original], watermark: 10, before: 10, hasMore: false }) : undefined);
  try {
    f.store.open(); await turn();
    assert.equal(f.store.getSnapshot().draft.referenceText, original.text);
    f.streams[0]!.enqueue(new TextEncoder().encode(frame({
      ...original, snapshotRevision: 11, text: 'Current user-facing answer',
    }) + frame(systemItem(12))));
    await turn();
    assert.equal(f.store.getSnapshot().draft.referenceText, 'Current user-facing answer');
  } finally { f.store.dispose(); }
});
