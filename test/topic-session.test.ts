import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, stageDelivery, topic, toolIdentity } from './fixtures.ts';
import { creationOptions, roleScope, organizerTools } from '../src/topic-session.ts';
import { AssistantService } from '../src/service.ts';

test('default worker creation truly applies cwd, persistent worker role and native tool scope', async () => {
  const f = fixture();
  try {
    topic(f, 'new-worker', null);
    const input = stageDelivery(f, 'new', ['new-worker']); await f.runtime.wake();
    const call = f.calls.find(c => c.name === 'session/new')!;
    assert.deepEqual(call.body, { cwd: '/synthetic', roles: [{ moduleId: 'assistant', roleId: 'worker' }],
      toolScope: roleScope('worker') });
    const row = f.db.topicMessages(input.message.id)[0]!;
    assert.equal(row.state, 'accepted');
    const meta = f.metas.get(row.sessionId!)!;
    assert.equal(meta.cwd, '/synthetic'); assert.equal(meta.appliedRoles![0]!.roleId, 'worker');
    assert.deepEqual(meta.toolScope, roleScope('worker'));
  } finally { f.close(); }
});
test('configured worker cwd/roles/scope are persistent creation values, not ignored temporary switches', () => {
  const f = fixture();
  try {
    const config = { defaultCwd: '/legacy-default', worker: { cwd: '/worker-project',
      roles: [{ moduleId: 'other', roleId: 'specialist' }], toolScope: { builtins: ['view', 'bash', 'ask_user'],
        mcpServers: [{ name: 'research', tools: ['search'] }] } } };
    const service = new AssistantService(f.db, Date.now, config);
    assert.deepEqual(creationOptions(service, f.native.host, 'worker'), {
      cwd: '/worker-project', roles: [...config.worker.roles, { moduleId: 'assistant', roleId: 'worker' }],
      toolScope: config.worker.toolScope });
    for (const worker of [{ roles: [{ moduleId: 'assistant', roleId: 'coordinator' }] },
      { roles: [{ moduleId: 'assistant', roleId: 'organizer' }] }])
      assert.throws(() => new AssistantService(f.db, Date.now, { worker }));
    for (const worker of [{ skills: ['research-skill'] }, { mcpServers: [{ name: 'research', tools: ['search'] }] }]) {
      assert.throws(() => new AssistantService(f.db, Date.now, { worker }), /Unsupported persistent worker/);
    }
    assert.throws(() => creationOptions(new AssistantService(f.db, Date.now, { worker: {
      toolScope: { builtins: ['view'], mcpServers: [{ name: 'cockpit', tools: ['cockpit_send_prompt'] }] } } }),
      f.native.host, 'worker'), { code: 'WORKER_SCOPE' });
  } finally { f.close(); }
});
test('old mapped worker ID, history, roles and config are untouched by routing', async () => {
  const f = fixture();
  try {
    topic(f); const old = structuredClone(f.metas.get('s1'));
    stageDelivery(f); await f.runtime.wake();
    assert.deepEqual(f.metas.get('s1'), old);
    assert.equal(f.calls.some(c => ['session/new', 'session/resources-prepare'].includes(c.name)), false);
    const scope = (await f.runtime.status('topic'))[0]!.toolScope!;
    assert.equal(scope.configured, null); assert.equal(scope.applied, null);
    assert.deepEqual(scope.tools, [{ name: 'bash' }, { name: 'ask_user' }]);
  } finally { f.close(); }
});
test('unknown native worker creation retains failure receipt and is never automatically repeated', async () => {
  const f = fixture();
  try {
    topic(f, 'new', null); const input = stageDelivery(f, 'new-worker', ['new']);
    f.fail('session/new', new Error('Native acknowledgement lost'));
    await f.runtime.wake(); await f.runtime.start();
    assert.equal(f.calls.filter(c => c.name === 'session/new').length, 1);
    assert.equal(f.db.must('topics', 'new').mappingState, 'unknown');
    assert.equal(f.db.topicMessages(input.message.id)[0]!.state, 'unknown');
  } finally { f.close(); }
});
test('explicit human mapping adopts only eligible real sources; foreground and organizer are never workers', async () => {
  const f = fixture();
  try {
    const input = await f.runtime.acceptReady({ requestId: 'adopt', text: 'Map this topic to s1' });
    const mapped = await f.runtime.topic(toolIdentity(f, input.message.id), { title: 'Adopted', sessionId: 's1' });
    assert.equal(f.service.managed('s1'), true);
    assert.equal(mapped.sessionId, 's1');
    await assert.rejects(f.runtime.topic(toolIdentity(f, input.message.id), { title: 'Bad', sessionId: 'coordinator' }),
      { code: 'MAPPING_TARGET' });
    await assert.rejects(f.runtime.topic(toolIdentity(f, input.message.id), { title: 'Bad', sessionId: 'missing' }),
      { code: 'MAPPING_TARGET' });
  } finally { f.close(); }
});
test('explicit organizer adoption reads only human-selected candidate history and never dispatches', async () => {
  const f = fixture();
  try {
    const native = await f.runtime.create({ requestId: 'organizer-create', role: 'organizer', cwd: '/synthetic' });
    const actual = native.sessionId!;
    const organizer = f.metas.get(actual)!; f.metas.delete(actual); organizer.sessionId = 'organizer'; f.metas.set('organizer', organizer);
    const root = (await f.runtime.organizerInput('organizer', {
      requestId: 'organize', text: 'Adopt selected s1', historySessionIds: ['s1'] }))!;
    f.history.get('organizer')!.push({ id: 'organizer-tool', type: 'assistant.message',
      data: { interactionId: `interaction:${root.receipt}`, toolRequests: [{ toolCallId: 'organize-topic' }] } });
    const identity = { sessionId: 'organizer', runtimeSessionId: 'organizer', subagent: false, toolCallId: 'organize-topic' };
    const authorized = await f.runtime.authorize(identity);
    assert.equal((await f.runtime.history(authorized, 's1')).sessionId, 's1');
    await assert.rejects(f.runtime.history(authorized, 's2'), { code: 'HISTORY_SCOPE' });
    await f.runtime.topic(identity, { title: 'Imported', sessionId: 's1' });
    await assert.rejects(f.runtime.dispatch(identity, { items: [{ topicId: f.db.list('topics').items[0]!.id, prompt: 'Do work' }] }),
      { code: 'HUMAN_REQUIRED' });
    assert.equal(f.calls.filter(c => c.name === 'prompt').length, 1);
    assert.deepEqual(organizerTools, ['assistant_topics', 'assistant_topic', 'assistant_sessions', 'assistant_history']);
    assert.deepEqual(organizer.toolScope, { builtins: [], mcpServers: [{ name: 'assistant', tools: organizerTools }] });
  } finally { f.close(); }
});
test('manual organizer preparation is usable but bare native input cannot authorize selected-history access', async () => {
  const f = fixture();
  try {
    const operation = await f.runtime.create({ requestId: 'manual-role', cwd: '/synthetic', role: 'organizer' });
    const id = operation.sessionId!;
    const meta = f.metas.get(id)!; f.metas.delete(id); meta.sessionId = 'organizer'; f.metas.set('organizer', meta);
    const prepared = await f.runtime.bind({ requestId: 'manual-prepare', role: 'organizer', sessionId: 'organizer' });
    assert.equal(prepared.state, 'accepted');
    assert.deepEqual((f.calls.find(call => call.name === 'session/resources-prepare')!.body as { mcpServers: unknown }).mcpServers,
      [{ name: 'assistant', tools: organizerTools }]);
    assert.equal((await f.runtime.readiness()).roles[0]!.sessionId, 'coordinator');
    f.history.set('organizer', [
      { id: 'bare-human-looking', type: 'user.message', data: { name: 'user', messageId: 'bare', interactionId: 'bare-interaction' } },
      { id: 'bare-call', type: 'assistant.message', data: { interactionId: 'bare-interaction', toolRequests: [{ toolCallId: 'bare-tool' }] } },
    ]);
    await assert.rejects(f.runtime.authorize({ sessionId: 'organizer', runtimeSessionId: 'organizer',
      subagent: false, toolCallId: 'bare-tool' }), { code: 'TOOL_PROVENANCE' });
    const input = { requestId: 'kickoff', text: 'Inspect selected s1 only', historySessionIds: ['s1'] };
    const root = (await f.runtime.organizerInput('organizer', input))!;
    f.metas.get('organizer')!.status = 'running';
    assert.equal((await f.runtime.organizerInput('organizer', input))!.id, root.id);
    assert.equal(f.calls.filter(call => call.name === 'prompt').length, 1);
  } finally { f.close(); }
});
