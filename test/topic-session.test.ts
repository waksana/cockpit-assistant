import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import type { McpInvocationMeta } from '@waksana/cockpit-module-sdk/backend';
import { Database } from '../src/database.ts';
import { BusinessError } from '../src/errors.ts';
import { routes } from '../src/http.ts';
import { Runtime } from '../src/runtime.ts';
import { activateRolesSchema, createTopicSessionSchema } from '../src/schema.ts';
import { AssistantService } from '../src/service.ts';
import { createTopicSession } from '../src/topic-session.ts';
import { fixture, proof } from './fixtures.ts';

function setup(path = ':memory:') {
  const f = fixture(path);
  const accepted = f.service.accept({ requestId: 'input', text: 'Start a new project in /synthetic/project' });
  const work = f.service.claim(f.identities.coordinator, 'coordinator', 1, accepted.work.id)!;
  const input = { ...proof(work, 'creation'), cwd: '/synthetic/project',
    reason: 'User provided /synthetic/project; current receptions belong to other projects' };
  // Native role readiness is covered by Runtime tests; retain its exact trusted identity checks here.
  f.runtime.authorize = async (identity, role, epoch) => { f.service.authorize(identity, role, epoch); };
  const runtime: Pick<Runtime, 'authorize' | 'create' | 'observe'> = {
    authorize: f.runtime.authorize.bind(f.runtime),
    create: f.runtime.create.bind(f.runtime),
    observe: f.runtime.observe.bind(f.runtime),
  };
  f.metas.set('new-synthetic', { sessionId: 'new-synthetic', title: 'Ordinary project', cwd: input.cwd, loaded: true,
    status: 'idle', lastActivity: 0, ask: null });
  return { ...f, input, runtime, actualRuntime: f.runtime,
    create: (value: unknown = input, identity: McpInvocationMeta = f.identities.coordinator) =>
      createTopicSession(f.service, runtime, identity, value),
    creates: () => f.calls.filter(call => call.name === 'session/new') };
}

test('ordinary creation uses the native default, observes, leaves work pending decision, and replays stale proof', async () => {
  const f = setup();
  try {
    const receipt = await f.create();
    assert.equal(receipt.state, 'accepted');
    assert.deepEqual(f.creates().map(call => call.body), [{ cwd: f.input.cwd }]);
    assert.equal(f.db.must('receptions', 'new-synthetic').enabled, true);
    assert.equal(f.db.must('work', f.input.workId).state, 'leased');
    assert.equal(f.db.find('deliveries', () => true).length, 0);
    assert.ok(f.service.version > f.input.stateVersion);
    f.advance(300_001);
    assert.deepEqual(await f.create(), receipt);
    assert.equal(f.creates().length, 1);
    await assert.rejects(f.create({ ...f.input, cwd: '/different' }), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(f.create({ ...f.input, requestId: 'new-request' }), { code: 'WORK_CREATE_RESERVED' });
    const fresh = f.service.claim(f.identities.coordinator, 'coordinator', 1, f.input.workId)!;
    f.service.decide(f.identities.coordinator, { ...proof(fresh, 'route'),
      topic: { title: 'Project', independent: true }, reason: 'New project requested',
      action: { kind: 'route', sessionIds: ['new-synthetic'], routeVersion: 0 } });
    assert.equal(f.db.must('work', f.input.workId).state, 'done');
  } finally { f.close(); }
});

test('concurrent identical and different request IDs cannot multiply the native effect', async () => {
  const f = setup();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const nativeCreate = f.runtime.create;
  f.runtime.create = async input => { await gate; return nativeCreate(input); };
  try {
    const first = f.create();
    await Promise.resolve();
    const pending = await f.create();
    assert.equal(pending.state, 'calling');
    await assert.rejects(f.create({ ...f.input, requestId: 'competing' }), { code: 'WORK_CREATE_RESERVED' });
    release();
    const completed = await first;
    assert.equal(completed.state, 'accepted');
    assert.deepEqual(await f.create(), completed);
    assert.equal(f.creates().length, 1);
  } finally { release(); f.close(); }
});

test('uncertain native effects retain their original receipt and never recreate', async () => {
  const f = setup();
  try {
    f.fail(new Error('Acknowledgement lost'));
    const receipt = await f.create();
    assert.equal(receipt.state, 'unknown');
    assert.match(JSON.stringify(receipt.result), /Acknowledgement lost/);
    f.fail(null);
    assert.deepEqual(await f.create(), receipt);
    f.service.recover();
    f.db.put('bindings', { ...f.db.must('bindings', 'coordinator'), ready: true });
    assert.deepEqual(await f.create(), receipt);
    assert.equal(f.calls.filter(call => call.name === 'session/get').length, 0);
    await assert.rejects(f.create({ ...f.input, requestId: 'retry-unknown' }), { code: 'WORK_CREATE_RESERVED' });
    assert.equal(f.creates().length, 1);
  } finally { f.close(); }
});

test('partial native created IDs survive errors and observation failures never erase creation', async () => {
  for (const partial of [null, 'createdId', 'sessionId'] as const) {
    const f = setup();
    try {
      if (partial) f.fail(Object.assign(new Error('Created but later native step failed'), { [partial]: 'new-synthetic' }));
      f.runtime.observe = async () => { throw new Error('Metadata unavailable'); };
      const receipt = await f.create();
      assert.equal(receipt.state, partial ? 'unknown' : 'accepted');
      assert.match(JSON.stringify(receipt.result), /"createdId":"new-synthetic"/);
      assert.match(JSON.stringify(receipt.result), /Metadata unavailable/);
      assert.deepEqual(await f.create(), receipt);
      f.fail(null);
      f.runtime.observe = f.actualRuntime.observe.bind(f.actualRuntime);
      f.advance(1001);
      const recovered = await f.create();
      assert.equal(recovered.state, partial ? 'unknown' : 'accepted');
      assert.deepEqual((recovered.result as { observation: unknown }).observation,
        { state: 'observed', eligible: true, attempts: 2, nextAttemptAt: 0 });
      assert.deepEqual(f.calls.filter(call => call.name === 'session/get').map(call => call.body),
        [{ sessionId: 'new-synthetic' }]);
      assert.deepEqual(f.db.must('operations', `topic-create-request:${f.input.requestId}`),
        { ...recovered, id: `topic-create-request:${f.input.requestId}` });
      assert.deepEqual(await f.create(), recovered);
      assert.equal(f.db.must('work', f.input.workId).state, 'leased');
      assert.equal(f.db.find('deliveries', () => true).length, 0);
      await assert.rejects(f.create({ ...f.input, requestId: 'recreate' }), { code: 'WORK_CREATE_RESERVED' });
      assert.equal(f.creates().length, 1);
    } finally { f.close(); }
  }
});

test('concurrent observation recovery shares one read of the original created ID', async () => {
  const f = setup();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const observing = new Promise<void>(resolve => { started = resolve; });
  try {
    f.runtime.observe = async () => { throw new Error('Metadata unavailable'); };
    await f.create();
    f.advance(1001);
    const observed: string[] = [];
    f.runtime.observe = async sessionId => {
      observed.push(sessionId);
      started();
      await gate;
      await f.actualRuntime.observe(sessionId);
    };
    const first = f.create();
    await observing;
    const second = f.create();
    await assert.rejects(f.create({ ...f.input, requestId: 'different' }), { code: 'WORK_CREATE_RESERVED' });
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    assert.deepEqual(observed, ['new-synthetic']);
    assert.equal(f.creates().length, 1);
    assert.deepEqual((a.result as { observation: unknown }).observation,
      { state: 'observed', eligible: true, attempts: 2, nextAttemptAt: 0 });
  } finally { release(); f.close(); }
});

test('runtime deadline observes the original created ID without coordinator replay or another input', async () => {
  const f = setup();
  try {
    let fail = true;
    f.onGet(async id => {
      if (id === 'new-synthetic' && fail) throw new Error('Temporary metadata failure');
    });
    await f.create();
    assert.equal(f.db.get('receptions', 'new-synthetic'), undefined);
    await f.actualRuntime.wake();
    fail = false;
    f.advance(1001);
    await new Promise(resolve => setTimeout(resolve, 1100));
    await f.actualRuntime.settled();
    assert.equal(f.db.must('receptions', 'new-synthetic').enabled, true);
    const receipt = f.db.must('operations', `topic-create:${f.input.workId}`);
    assert.deepEqual((receipt.result as { observation: unknown }).observation,
      { state: 'observed', eligible: true, attempts: 2, nextAttemptAt: 0 });
    assert.equal(f.creates().length, 1);
    assert.equal(f.db.must('work', f.input.workId).state, 'leased');
    assert.equal(f.db.find('deliveries', d => d.kind !== 'wake').length, 0);
  } finally { f.close(); }
});

test('created-session observation is bounded without fabricating eligibility or a second creation', async () => {
  const f = setup();
  try {
    f.onGet(async id => {
      if (id === 'new-synthetic') throw new Error('Persistent metadata failure');
    });
    await f.create();
    await f.actualRuntime.wake();
    f.advance(1001); await f.actualRuntime.wake();
    f.advance(2001); await f.actualRuntime.wake();
    f.advance(100_000); await f.actualRuntime.wake();
    await f.create();
    const observation = (f.db.must('operations', `topic-create:${f.input.workId}`).result as {
      observation: { state: string; attempts: number; nextAttemptAt: number };
    }).observation;
    assert.equal(observation.state, 'failed');
    assert.equal(observation.attempts, 3);
    assert.equal(observation.nextAttemptAt, 0);
    assert.equal(f.db.get('receptions', 'new-synthetic'), undefined);
    assert.equal(f.creates().length, 1);
  } finally { f.close(); }
});

test('restart hydrates incomplete topic receipts from durable native identity across reauthorization', async () => {
  for (const topicState of ['calling', 'unknown'] as const) {
    for (const nativeState of ['accepted', 'unknown'] as const) {
      const path = `test/.topic-session-${randomUUID()}.db`;
      const f = setup(path);
      let originalClosed = false;
      let db: Database | undefined;
      let runtime: Runtime | undefined;
      try {
        if (nativeState === 'unknown') {
          f.fail(Object.assign(new Error('Partial native acknowledgement'), { createdId: 'new-synthetic' }));
        }
        f.runtime.observe = async () => { throw new Error('Metadata unavailable'); };
        const receipt = await f.create();
        const result = receipt.result as Record<string, unknown>;
        for (const id of [receipt.id, `topic-create-request:${f.input.requestId}`]) {
          f.db.put('operations', { ...receipt, id, state: topicState,
            result: { requestId: f.input.requestId, workId: f.input.workId, cwd: f.input.cwd,
              reason: f.input.reason, nativeOperationId: result.nativeOperationId,
              replayFingerprint: result.replayFingerprint, createdId: null,
              observation: 'not_started', retryAllowed: false } });
        }
        f.fail(null);
        f.close();
        originalClosed = true;
        db = new Database(path);
        const service = new AssistantService(db, () => 1_001_000);
        service.recover();
        db.put('bindings', { ...db.must('bindings', 'coordinator'), ready: true, epoch: 2 });
        runtime = new Runtime(service, f.native, () => {}, () => {});
        const observed: string[] = [];
        const recoveryRuntime: Pick<Runtime, 'authorize' | 'create' | 'observe'> = {
          async authorize(identity, role, epoch) { service.authorize(identity, role, epoch); },
          async create() { assert.fail('Recovery must never create another session'); },
          async observe(sessionId) { observed.push(sessionId); await runtime!.observe(sessionId); },
        };
        const recover = (input = { ...f.input, epoch: 2 }) =>
          createTopicSession(service, recoveryRuntime, f.identities.coordinator, input);
        await assert.rejects(recover(f.input), { code: 'STALE_ROLE' });
        await assert.rejects(recover({ ...f.input, epoch: 2, cwd: '/changed' }), { code: 'IDEMPOTENCY_CONFLICT' });
        await assert.rejects(recover({ ...f.input, epoch: 2, token: 'changed' }), { code: 'IDEMPOTENCY_CONFLICT' });
        const recovered = await recover();
        assert.equal(recovered.state, nativeState);
        assert.equal((recovered.result as { createdId: string }).createdId, 'new-synthetic');
        assert.deepEqual((recovered.result as { observation: unknown }).observation,
          { state: 'observed', eligible: true, attempts: 1, nextAttemptAt: 0 });
        assert.deepEqual(await recover(), recovered);
        assert.deepEqual(observed, ['new-synthetic']);
        assert.equal(db.must('receptions', 'new-synthetic').enabled, true);
        assert.equal(db.must('work', f.input.workId).state, 'leased');
        assert.equal(db.find('deliveries', () => true).length, 0);
        assert.equal(f.creates().length, 1);
        await assert.rejects(recover({ ...f.input, epoch: 2, requestId: 'replacement' }), { code: 'WORK_CREATE_RESERVED' });
      } finally {
        if (!originalClosed) f.close();
        runtime?.stop();
        db?.close();
        for (const suffix of ['', '-shm', '-wal']) rmSync(`${path}${suffix}`, { force: true });
      }
    }
  }
});

test('pre-effect rejection alone permits a corrected explicit choice while preserving original replay', async () => {
  const f = setup();
  const nativeCreate = f.runtime.create;
  try {
    f.runtime.create = async () => { throw new BusinessError('UNRESOLVED_CREATE', 'Inspect an earlier creation'); };
    const rejected = await f.create();
    assert.equal(rejected.state, 'rejected');
    assert.equal(f.creates().length, 0);
    f.runtime.create = nativeCreate;
    assert.equal((await f.create({ ...f.input, requestId: 'corrected' })).state, 'accepted');
    assert.deepEqual(await f.create(), rejected);
    assert.equal(f.creates().length, 1);
  } finally { f.close(); }
});

test('historical anchors, stale work and foreign or internal callers fail before native effects', async () => {
  const cases: [string, (f: ReturnType<typeof setup>) => void, Partial<McpInvocationMeta>, string][] = [
    ['anchor', f => {
      const work = f.db.must('work', f.input.workId);
      const message = f.db.must('messages', work.messageId!);
      f.db.put('messages', { ...message, replyTo: 'original-native-anchor' });
    }, {}, 'ANCHOR_MISMATCH'],
    ['stale lease', f => f.advance(300_001), {}, 'STALE_LEASE'],
    ['stale state', f => { f.service.changed(); }, {}, 'STALE_STATE'],
    ['foreign', () => {}, { sessionId: 'foreign', runtimeSessionId: 'foreign' }, 'STALE_ROLE'],
    ['memory', () => {}, { sessionId: 'memory', runtimeSessionId: 'memory' }, 'STALE_ROLE'],
    ['subagent', () => {}, { subagent: true }, 'MAIN_ONLY'],
    ['runtime mismatch', () => {}, { runtimeSessionId: 'foreign' }, 'MAIN_ONLY'],
    ['epoch', f => { f.db.put('bindings', { ...f.db.must('bindings', 'coordinator'), epoch: 2 }); }, {}, 'STALE_ROLE'],
    ['native output', f => {
      f.db.put('work', { ...f.db.must('work', f.input.workId), kind: 'output' });
    }, {}, 'WORK_KIND'],
  ];
  for (const [label, change, identity, code] of cases) {
    const f = setup();
    try {
      change(f);
      await assert.rejects(f.create(f.input, { ...f.identities.coordinator, ...identity }), { code }, label);
      assert.equal(f.creates().length, 0, label);
      assert.equal(f.db.get('operations', `topic-create:${f.input.workId}`), undefined, label);
    } finally { f.close(); }
  }
});

test('unrelated pending questions and matching option text do not hijack new-topic creation', async () => {
  const f = setup();
  try {
    f.service.syncQuestions('s1', [{ requestId: 'ask', question: 'Which example sentence?',
      choices: ['Start a new project in /synthetic/project'], allowFreeform: false }], true);
    const fresh = f.service.claim(f.identities.coordinator, 'coordinator', 1, f.input.workId)!;
    Object.assign(f.input, proof(fresh, f.input.requestId));
    assert.equal((await f.create()).state, 'accepted');
    assert.equal(f.creates().length, 1);
  } finally { f.close(); }
});

test('identity authorization is still required to replay an accepted operation', async () => {
  const f = setup();
  try {
    await f.create();
    await assert.rejects(f.create(f.input, f.identities.memory), { code: 'STALE_ROLE' });
    await assert.rejects(f.create(f.input, { ...f.identities.coordinator, subagent: true }), { code: 'MAIN_ONLY' });
    f.db.put('bindings', { ...f.db.must('bindings', 'coordinator'), epoch: 2 });
    await assert.rejects(f.create(), { code: 'STALE_ROLE' });
    assert.equal(f.creates().length, 1);
  } finally { f.close(); }
});

test('recovering an interrupted intent never resubmits it and role carriers are not observed as receptions', async () => {
  for (const field of ['roles', 'appliedRoles'] as const) {
    const f = setup();
    try {
      const meta = f.metas.get('new-synthetic')!;
      f.metas.set('new-synthetic', { ...meta, [field]: [
        { moduleId: 'assistant', roleId: 'memory', moduleName: 'Assistant', name: 'memory' },
      ] });
      const receipt = await f.create();
      assert.equal(receipt.state, 'accepted');
      assert.equal(f.db.get('receptions', 'new-synthetic'), undefined);
      assert.match(JSON.stringify(receipt.result), /"eligible":false/);
      assert.deepEqual(await f.create(), receipt);
    } finally { f.close(); }
  }
  const f = setup();
  try {
    const receipt = await f.create();
    for (const key of [receipt.id, `topic-create-request:${f.input.requestId}`]) {
      f.db.put('operations', { ...f.db.must('operations', key), state: 'calling' });
    }
    f.service.recover();
    f.db.put('bindings', { ...f.db.must('bindings', 'coordinator'), ready: true });
    assert.equal((await f.create()).state, 'unknown');
    await assert.rejects(f.create({ ...f.input, requestId: 'after-restart' }), { code: 'WORK_CREATE_RESERVED' });
    assert.equal(f.creates().length, 1);
  } finally { f.close(); }
});

test('schemas require absolute cwd, explicit evidence and unique role activation bindings', () => {
  const f = setup();
  try {
    for (const change of [{ cwd: 'relative' }, { cwd: '~' }, { reason: '   ' }, { role: 'coordinator' }, { modelId: 'override' }]) {
      assert.equal(createTopicSessionSchema.safeParse({ ...f.input, ...change }).success, false);
    }
    const binding = { role: 'coordinator', sessionId: 's1', epoch: 1 };
    assert.equal(activateRolesSchema.safeParse({ requestId: 'activate', bindings: [binding] }).success, true);
    for (const bindings of [[], [binding, binding], [{ ...binding, epoch: 0 }], [binding, binding, binding]]) {
      assert.equal(activateRolesSchema.safeParse({ requestId: 'activate', bindings }).success, false);
    }
  } finally { f.close(); }
});

test('MCP dispatch exposes creation and its durable work receipt without automatic routing', async () => {
  const f = setup();
  try {
    f.actualRuntime.wake = async () => {};
    const api = routes(f.service, f.actualRuntime);
    const mcp = api.find(route => route.path === '/mcp')!;
    const call = async (name: string, args: unknown) => {
      const response = await mcp.handler({ params: {}, query: {}, headers: {},
        signal: new AbortController().signal,
        body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args,
          _meta: { 'cockpit/invocation': f.identities.coordinator } } } });
      const body = response.body as { result: { isError: boolean; content: { text: string }[] } };
      assert.equal(body.result.isError, false);
      return JSON.parse(body.result.content[0]!.text) as Record<string, unknown>;
    };
    assert.equal((await call('assistant_create_session', f.input)).state, 'accepted');
    const result = await call('assistant_read', { role: 'coordinator', epoch: 1,
      resource: 'receipts', workId: f.input.workId });
    assert.equal((result.sessionCreation as { state: string }).state, 'accepted');
    assert.equal(result.state, 'leased');
    assert.equal(f.db.find('deliveries', () => true).length, 0);
  } finally { f.close(); }
});

test('role activation endpoint forwards only validated exact bindings', async () => {
  const f = setup();
  try {
    f.actualRuntime.wake = async () => {};
    const received: unknown[] = [];
    const runtime = Object.assign(f.actualRuntime, {
      async activateRoles(value: unknown) { received.push(value); return { accepted: true }; },
    });
    const route = routes(f.service, runtime).find(item => item.path === '/roles/activate' && item.method === 'POST')!;
    const body = { requestId: 'activate', bindings: [{ role: 'coordinator', sessionId: 'coordinator', epoch: 1 }] };
    const request = { params: {}, query: {}, headers: {}, signal: new AbortController().signal, body };
    assert.deepEqual((await route.handler(request)).body, { accepted: true });
    assert.deepEqual(received, [body]);
    const rejected = await route.handler({ ...request, body: { ...body, bindings: [...body.bindings, ...body.bindings] } });
    assert.equal(rejected.status, 400);
    assert.equal(received.length, 1);
  } finally { f.close(); }
});
