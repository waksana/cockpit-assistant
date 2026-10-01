import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Assistant, configInput } from '../src/core.ts';
import { Store } from '../src/store.ts';

assert.ok(process.argv[2], 'Supply the absolute path to a supported Host installation');
const { Engine, OfficialRuntime } = await import(pathToFileURL(join(resolve(process.argv[2]), 'packages/core/dist/index.js')).href);
const before = { ...process.env }, previousCwd = process.cwd();
const root = await mkdtemp(join(tmpdir(), 'assistant-native-response-'));
const dirs = {};
for (const name of ['home', 'copilot', 'cockpit', 'work', 'scratch', 'cache', 'config', 'run']) {
  dirs[name] = join(root, name);
  await mkdir(dirs[name], { mode: 0o700 });
}
const gate = () => {
  let open;
  const promise = new Promise(done => { open = done; });
  return { promise, open };
};
const queueStarted = gate(), queueRelease = gate(), steeringStarted = gate(), steeringRelease = gate();
let requests = 0;
const provider = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  const input = JSON.parse(body), ordinal = ++requests;
  if (ordinal === 1 || ordinal === 4) {
    assert.ok(input.tools.some(tool => tool.function.name === 'synthetic_probe'),
      JSON.stringify(input.tools.map(tool => tool.function.name)));
    (ordinal === 1 ? queueStarted : steeringStarted).open();
    await (ordinal === 1 ? queueRelease : steeringRelease).promise;
  }
  if (ordinal === 5) assert.match(JSON.stringify(input.messages), /Synthetic steering D/);
  const tool = ordinal === 1 || ordinal === 4;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = tool ? { role: 'assistant', content: 'Synthetic intermediate progress',
    tool_calls: [{ index: 0, id: `synthetic-tool-${ordinal}`, type: 'function',
      function: { name: 'synthetic_probe', arguments: '{}' } }] }
    : { role: 'assistant', content: ordinal === 2 ? 'Synthetic final A' : ordinal === 3 ? 'Synthetic final B' : 'Synthetic shared C/D reply' };
  for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }])
    response.write(`data: ${JSON.stringify({ id: `fixture-${ordinal}`, object: 'chat.completion.chunk',
      created: 1, model: 'gpt-4.1', choices: [{ index: 0, ...choice }] })}\n\n`);
  response.end('data: [DONE]\n\n');
});
let engine, assistant, store, clean = false;
try {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    HOME: dirs.home, USERPROFILE: dirs.home, COPILOT_HOME: dirs.copilot, COCKPIT_HOME: dirs.cockpit,
    XDG_CONFIG_HOME: dirs.config, XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.copilot,
    XDG_RUNTIME_DIR: dirs.run, TMPDIR: dirs.scratch, TMP: dirs.scratch, TEMP: dirs.scratch,
    PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', COPILOT_DISABLE_KEYTAR: '1',
    COPILOT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dirs.config, 'gitconfig'), COCKPIT_PORT: '0',
  });
  process.chdir(dirs.work);
  await new Promise(done => provider.listen(0, '127.0.0.1', done));
  const address = provider.address();
  assert.ok(address && typeof address !== 'string');
  const runtime = new OfficialRuntime({
    clientOptions: {
      baseDirectory: dirs.copilot, workingDirectory: dirs.work, builtinPluginDirectories: [],
      useLoggedInUser: false, enableRemoteSessions: false, logLevel: 'error',
      onListModels: () => [{ id: 'gpt-4.1', name: 'Synthetic GPT-4.1',
        capabilities: { supports: { vision: false, reasoningEffort: false },
          limits: { max_context_window_tokens: 128000 } } }],
    },
    sessionConfig: {
      tools: [{ name: 'synthetic_probe', description: 'Return a synthetic no-op result', defer: 'never',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        handler: async () => ({ textResultForLlm: 'Synthetic tool done', resultType: 'success' }) }],
      provider: { type: 'openai', wireApi: 'completions', baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'gpt-4.1' },
      configDirectory: dirs.copilot, enableFileHooks: false, enableHostGitOperations: false,
      enableSessionStore: false, enableSkills: false, skillDirectories: [], pluginDirectories: [],
      instructionDirectories: [], customAgents: [], enableManagedSettings: false,
      skipEmbeddingRetrieval: true, embeddingCacheStorage: 'in-memory', enableSessionTelemetry: false,
      remoteSession: 'off', enableExperimentalMode: true,
    },
  });
  engine = new Engine({ runtime, sessionDefaults: {
    read: async () => ({ modelId: 'gpt-4.1' }),
    write: async () => { throw new Error('The check must not change model defaults'); },
  } });
  const events = [], observations = [], notices = [], errors = [], business = [];
  let human = 'initial';
  const foreground = { sessionId: 'synthetic-foreground', loaded: true, rolesNeedReload: false, status: 'idle', ask: null,
    appliedRoles: [{ moduleId: 'assistant', roleId: 'coordinator' }],
    activity: { processing: false, hasActiveWork: false } };
  store = new Store(':memory:');
  assistant = new Assistant(store, {
    caller: async identity => ({ sessionId: foreground.sessionId, toolCallId: identity.toolCallId, role: 'coordinator',
      input: { sessionId: foreground.sessionId, messageId: human, interactionId: human, human: true,
        text: human, attachments: [], createdAt: Date.now() } }),
    session: id => id === foreground.sessionId ? Promise.resolve(foreground) : engine.getMeta(id),
    foreground: async () => foreground, observe() {},
    host: { async call(name, body) {
      assert.equal(name, 'prompt');
      if (body.sessionId === foreground.sessionId) {
        assert.equal(body.mode, 'enqueue');
        notices.push({ body, eventCount: events.length });
        foreground.status = 'running';
        return { ok: true, messageId: `notice-${notices.length}` };
      }
      assert.equal(body.mode, 'immediate');
      business.push(body);
      return engine.prompt(body.sessionId, body.text, body.mode);
    } },
  }, configInput.parse({ defaultCwd: dirs.work }), error => errors.push(error));
  engine.onNativeEvent(({ sessionId, event }) => {
    events.push(event);
    const pending = assistant.observe(sessionId, event);
    observations.push(pending);
    return pending;
  }, { types: ['user.message', 'assistant.turn_start', 'assistant.message', 'assistant.turn_end',
    'session.completion_receipt', 'assistant.idle', 'session.idle', 'abort', 'session.error'] });
  engine.onEvent(event => {
    if (!['session/patch', 'session/invalidated'].includes(event.type) || !('sessionId' in event)) return;
    const pending = assistant.observe(event.sessionId).then(() => assistant.notify());
    observations.push(pending);
    void pending.catch(error => errors.push(error));
  });
  const idle = async (sessionId, reply) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (events.some(event => event.data.content === reply)
        && (await engine.getMeta(sessionId)).status === 'idle') break;
      await new Promise(done => setTimeout(done, 50));
    }
    await Promise.all(observations);
    assert.ok(events.some(event => event.data.content === reply));
    assert.equal((await engine.getMeta(sessionId)).status, 'idle');
    await assistant.notify();
  };
  const register = async id => {
    const sessionId = await engine.newSession(dirs.work);
    store.saveTopic({ id, title: id, content: '', version: 1, archived: false, session_id: sessionId,
      mapping_state: 'bound', mapping_error: null, creation_receipt: null });
    return sessionId;
  };
  const dispatch = (topicId, prompt) => {
    human = prompt;
    return assistant.invoke('assistant_dispatch', { items: [{ topicId, prompt }] }, {
      sessionId: foreground.sessionId, runtimeSessionId: foreground.sessionId, subagent: false, toolCallId: prompt,
    });
  };
  await engine.start();
  const sessionId = await register('queued');
  await dispatch('queued', 'Synthetic request A');
  await queueStarted.promise;
  await engine.prompt(sessionId, 'Synthetic request B', 'enqueue');
  queueRelease.open();
  await idle(sessionId, 'Synthetic final B');
  assert.equal(requests, 3);
  const firstIdle = events.findIndex(event => event.type === 'session.idle');
  assert.ok(firstIdle > events.findIndex(event => event.data.content === 'Synthetic final B'));
  assert.equal(notices.length, 1);
  assert.ok(notices[0].eventCount > firstIdle, 'No notification before the source idle event');
  assert.deepEqual(store.inbox().map(item => item.text),
    ['Synthetic intermediate progress', 'Synthetic final A', 'Synthetic final B']);
  assert.ok(store.inbox().every(item => item.notice_state === 'notified'));
  await assistant.invoke('assistant_inbox', {}, { toolCallId: 'consume-queued' });
  console.log('Queued A/B: intermediate tool turn and final A remain silent until B finishes and source idles; one enqueue reminder.');

  const steering = await register('steered');
  foreground.status = 'idle';
  await dispatch('steered', 'Synthetic request C');
  await steeringStarted.promise;
  await dispatch('steered', 'Synthetic steering D');
  steeringRelease.open();
  await idle(steering, 'Synthetic shared C/D reply');
  assert.equal(requests, 5);
  assert.ok(events.some(event => event.type === 'user.message'
    && event.data.content === 'Synthetic steering D' && event.data.delivery === 'steering'));
  assert.equal(notices.length, 2);
  assert.equal(business.length, 3);
  assert.deepEqual(store.inbox().map(item => item.text), ['Synthetic intermediate progress', 'Synthetic shared C/D reply']);
  assert.ok(store.inbox().every(item => item.notice_state === 'notified'));
  await assistant.invoke('assistant_inbox', {}, { toolCallId: 'consume-steered' });
  for (const event of events.filter(event => event.type === 'assistant.message'
    && event.data.content === 'Synthetic shared C/D reply')) await assistant.observe(steering, event);
  foreground.status = 'idle';
  await assistant.notify();
  assert.equal(notices.length, 2);
  assert.deepEqual(errors, []);
  console.log('Immediate C/D: native steering is consumed within the tool loop, shared reply waits for idle, replay adds no reminder.');
  assistant.stop();
  await engine.stop(); engine = undefined; clean = true;
} finally {
  queueRelease.open(); steeringRelease.open(); assistant?.stop();
  try { if (engine) await engine.stop(); }
  finally {
    await new Promise(done => provider.close(done));
    store?.close();
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, before);
    if (clean) await rm(root, { recursive: true });
    else console.error(`Native check failed; retained only its isolated evidence at ${root}`);
  }
}
