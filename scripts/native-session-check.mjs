import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Assistant, configInput } from '../src/core.ts';
import { Store } from '../src/store.ts';

// Use a supplied, already-built Host; never connect to its running service.
assert.ok(process.argv[2], 'Supply the absolute path to a supported Host installation');
const hostRoot = resolve(process.argv[2]);
const { Engine, OfficialRuntime } = await import(pathToFileURL(join(hostRoot, 'packages/core/dist/index.js')).href);
const before = { ...process.env }, previousCwd = process.cwd();
const root = await mkdtemp(join(tmpdir(), 'assistant-native-session-'));
const dirs = {};
for (const name of ['home', 'copilot', 'cockpit', 'work', 'scratch', 'cache', 'config', 'run']) {
  dirs[name] = join(root, name);
  await mkdir(dirs[name], { mode: 0o700 });
}
const requests = [];
const provider = createServer(async (request, response) => {
  let text = '';
  for await (const chunk of request) text += chunk;
  requests.push(JSON.parse(text));
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const choice of [
    { delta: { role: 'assistant', content: 'Synthetic ordinary session response' }, finish_reason: null },
    { delta: {}, finish_reason: 'stop' },
  ]) response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk',
    created: 1, model: 'gpt-4.1', choices: [{ index: 0, ...choice }] })}\n\n`);
  response.end('data: [DONE]\n\n');
});
let engine, clean = false;
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
  const replies = new Set();
  engine.onNativeEvent(({ sessionId, event }) => {
    if (event.type === 'assistant.message' && event.data.content === 'Synthetic ordinary session response') replies.add(sessionId);
  }, { types: ['assistant.message'] });
  await engine.start();
  console.log('Isolated native runtime and loopback-only synthetic provider started');
  for (const legacy of [false, true]) {
    const store = new Store(':memory:'), calls = [], errors = [];
    const foreground = { sessionId: 'synthetic-foreground', loaded: true, rolesNeedReload: false,
      appliedRoles: [{ moduleId: 'assistant', roleId: 'coordinator' }] };
    const assistant = new Assistant(store, {
      caller: async identity => ({ sessionId: foreground.sessionId, toolCallId: identity.toolCallId,
        role: 'coordinator', input: { sessionId: foreground.sessionId, messageId: 'synthetic-input',
          interactionId: 'synthetic-interaction', human: true, createdAt: Date.now(),
          text: 'Synthetic no-tool request', attachments: [] } }),
      session: id => id === foreground.sessionId ? Promise.resolve(foreground) : engine.getMeta(id),
      foreground: async () => foreground, validateForeground: async () => {}, observe() {},
      host: { async call(name, body) {
        calls.push({ name, body });
        if (name === 'session/new') {
          assert.deepEqual(body, { cwd: dirs.work });
          const sessionId = await engine.newSession(body.cwd);
          await engine.initializeSessionTools(sessionId);
          const scope = await engine.getSessionToolScope(sessionId);
          assert.equal(scope.configured, null);
          assert.equal(scope.applied, null);
          assert.ok(scope.tools?.length, 'Ordinary native tools must initialize without an injected scope');
          return { sessionId };
        }
        if (name === 'prompt') return engine.prompt(body.sessionId, body.text, body.mode);
        throw new Error(`Unexpected native operation ${name}`);
      } },
    }, configInput.parse({ defaultCwd: dirs.work, ...(legacy ? { worker: {
      cwd: dirs.work, roles: [{ moduleId: 'assistant', roleId: 'worker' }],
      toolScope: { builtins: ['view', 'grep', 'glob', 'bash', 'apply_patch', 'ask_user', 'skill'], mcpServers: [] },
    } } : {}) }), error => errors.push(error));
    try {
      const identity = { sessionId: foreground.sessionId, runtimeSessionId: foreground.sessionId, subagent: false, toolCallId: 'create-topic' };
      const topic = await assistant.invoke('assistant_topic', { title: 'Synthetic topic' }, identity);
      const input = { items: [{ topicId: topic.topicId, prompt: 'Synthetic no-tool request' }] };
      const [delivery] = await assistant.invoke('assistant_dispatch', input, { ...identity, toolCallId: 'dispatch' });
      assert.deepEqual(errors, []);
      assert.equal(delivery.state, 'accepted');
      assert.ok(delivery.native_message_id);
      assert.equal(store.topic(topic.topicId).session_id, delivery.session_id);
      const limit = Date.now() + 20000;
      while (Date.now() < limit) {
        const meta = await engine.getMeta(delivery.session_id);
        if (replies.has(delivery.session_id) && meta?.activity && !meta.activity.hasActiveWork && !meta.activity.processing) break;
        await new Promise(done => setTimeout(done, 50));
      }
      assert.ok(replies.has(delivery.session_id), 'First real native prompt must produce the synthetic reply');
      assert.deepEqual((await engine.getMeta(delivery.session_id)).roles, []);
      await assistant.invoke('assistant_dispatch', input, { ...identity, toolCallId: 'replay' });
      assert.deepEqual(calls.map(call => call.name), ['session/new', 'prompt']);
      console.log(`${legacy ? 'Legacy preset' : 'Default'}: ordinary creation, tool readiness, binding, first native reply and no duplicate send`);
    } finally { assistant.stop(); store.close(); }
  }
  assert.equal(requests.length, 2, 'No hidden model requests or retries');
  await engine.stop(); engine = undefined; clean = true;
} finally {
  try { if (engine) await engine.stop(); }
  finally {
    await new Promise(done => provider.close(done));
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, before);
    if (clean) await rm(root, { recursive: true });
    else console.error(`Native check failed; retained only its isolated evidence at ${root}`);
  }
}
