import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The provider chooses synthetic actions; every advertised tool, MCP connection,
// tool result, Chat event and ask callback below belongs to the real native Host.
export async function runNativeCheck(mode = 'evidence') {
  if (mode === 'restart') {
    const { runNativeRestartCheck } = await import('./native-restart-check.mjs');
    return runNativeRestartCheck();
  }
  assert.ok(['evidence', 'response', 'session', 'connection'].includes(mode), 'Unknown native probe mode');
  assert.ok(process.argv[2], 'Supply an explicitly selected built Host root (never a running service URL)');
  const hostRoot = await realpath(resolve(process.argv[2]));
  const serverRoot = await realpath(resolve(process.argv[3] ?? hostRoot));
  const previousCwd = process.cwd(), before = { ...process.env };
  const root = join(previousCwd, `.native-${mode}-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  const dirs = {};
  for (const name of ['home', 'copilot', 'cockpit', 'work', 'scratch', 'cache', 'config', 'run']) {
    dirs[name] = join(root, name);
    await mkdir(dirs[name], { mode: 0o700 });
  }
  const errors = [], diagnostics = [], events = [], requests = [], calls = [], intents = [];
  const gates = new Map(), sourceCounts = new Map(), checkpoints = new Map();
  let engine, runtime, app, moduleHost, provider, foregroundId, sourceId, topicId, plan, clean = false;
  const hostTools = ['cockpit_new_session', 'cockpit_get_session', 'cockpit_reload_session',
    'cockpit_send_prompt', 'cockpit_respond_ask', 'cockpit_read_session_text'];
  const assistantTools = ['assistant_topics', 'assistant_topic', 'assistant_foreground',
    'assistant_inbox', 'assistant_checkpoint', 'assistant_resolve'];
  const scope = { builtins: [], mcpServers: [
    { name: 'assistant', tools: assistantTools }, { name: 'cockpit', tools: hostTools },
  ] };
  const gate = name => {
    if (!gates.has(name)) {
      let open;
      const promise = new Promise(done => { open = done; });
      gates.set(name, { promise, open });
    }
    return gates.get(name);
  };
  const wait = async (label, check) => {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (errors.length) throw errors[0];
      if (await check()) return;
      await new Promise(done => setTimeout(done, 40));
    }
    throw new Error(`Timed out: ${label}`);
  };
  const idle = async id => {
    let stableAt = 0;
    await wait(`native idle ${id}`, async () => {
      const meta = await engine.getMeta(id);
      const ready = meta?.loaded && meta.status === 'idle' && !!meta.activity
        && !meta.activity.processing && !meta.activity.hasActiveWork
        && !meta.activeOperations && !meta.loading && !meta.closing && !meta.cancelling;
      if (!ready) stableAt = 0;
      else stableAt ||= Date.now();
      return ready && Date.now() - stableAt >= 120;
    });
  };
  const sourceEvents = () => events.filter(row => row.sessionId === sourceId).map(row => row.event);
  const frontEvents = () => events.filter(row => row.sessionId === foregroundId).map(row => row.event);
  const result = input => {
    const message = input.messages.findLast(item => item.role === 'tool');
    assert.ok(message, 'The native provider request must contain the preceding MCP tool result');
    let value = message.content;
    if (Array.isArray(value)) value = value.map(part => part.text ?? '').join('\n');
    try { value = JSON.parse(value); } catch { /* Host lifecycle tools return descriptive text. */ }
    if (value && typeof value === 'object' && Array.isArray(value.content)) {
      assert.notEqual(value.isError, true, JSON.stringify(value));
      value = value.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      try { value = JSON.parse(value); } catch { /* Descriptive native result. */ }
    }
    return value;
  };
  const toolName = (input, raw) => {
    const names = input.tools.map(tool => tool.function.name);
    const matches = names.filter(name => name === raw || name.endsWith(`-${raw}`) || name.endsWith(`_${raw}`));
    assert.equal(matches.length, 1, `Expected one genuinely offered ${raw}: ${names.join(', ')}`);
    return matches[0];
  };
  const step = (raw, args, check = () => {}) => ({ raw, args, check });
  const front = async (name, steps, text = `FIXTURE_FRONT:${name}`, followUp) => {
    const current = { name, steps, index: 0, finished: false, followUp };
    plan = current;
    await api('prompt', { sessionId: foregroundId, text, mode: 'immediate' });
    await wait(`foreground plan ${name}`, () => current.finished);
    await idle(foregroundId);
  };
  let origin;
  const api = async (name, body) => {
    const response = await fetch(`${origin}/intent/${name}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const value = await response.json();
    assert.ok(response.ok, `${name}: ${JSON.stringify(value)}`);
    return value;
  };
  const readSteps = (disposition, expected, afterCheckpoint = []) => {
    let inbox, sourceCheckpoint, lastPage, pages = 0, checkpoint, fragments = 0, recovered = false;
    const seen = new Map(), incomplete = new Set(), query = { source: 'persisted', direction: 'backward' };
    const readPage = step('cockpit_read_session_text', () => {
      if (!pages && sourceCheckpoint?.position.hostCheckpoint) query.since = sourceCheckpoint.position.hostCheckpoint;
      return { session_id: sourceId, ...query, limit: 4, max_bytes: 8192, scan_pages: 2 };
    }, value => {
      assert.ok(++pages <= 20, 'Lightweight native Chat reads remain bounded');
      lastPage = value;
      assert.equal(value.view, 'text');
      assert.equal(value.sessionId, sourceId);
      assert.equal(value.order, 'newest-first');
      assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 8192, 'Whole lightweight JSON fits its UTF-8 budget');
      assert.ok(value.read.pages <= 2 && value.read.events <= 32);
      for (const message of value.messages) {
        assert.ok(sourceEvents().some(event => event.id === message.eventId),
          'Lightweight text preserves the actual native event identity');
        assert.equal(message.offset, seen.get(message.eventId)?.length ?? 0,
          'Fragments are reassembled without gaps or replay');
        seen.set(message.eventId, (seen.get(message.eventId) ?? '') + message.content);
        if (message.nextOffset !== null) {
          assert.equal(message.nextOffset, seen.get(message.eventId).length);
          incomplete.add(message.eventId); fragments++;
        } else {
          assert.equal(seen.get(message.eventId).length, message.totalCharacters);
          assert.equal(seen.get(message.eventId),
            sourceEvents().find(event => event.id === message.eventId).data.content);
          incomplete.delete(message.eventId);
        }
      }
      checkpoint ??= value.checkpoint;
      const missing = ![...seen.values()].includes(expected) || inbox.items.some(item =>
        item.source?.eventId && !seen.has(item.source.eventId));
      if (query.since ? value.hasMore || !value.checkpoint : missing || !checkpoint) {
        assert.ok(value.hasMore && value.cursor, 'Continue with the same since and exact Host cursor, never event IDs');
        const actualQuery = { ...query, limit: 4, max_bytes: 8192, scan_pages: 2 };
        query.cursor = value.cursor;
        const continuation = [];
        if (incomplete.size) {
          const recoverNow = !recovered, nextQuery = { ...actualQuery, cursor: value.cursor };
          continuation.push(step('assistant_checkpoint', {
            receiptId: inbox.receipt.id, sessionId: sourceId, readIds: [], complete: false,
            position: { query: actualQuery, nextQuery,
              boundaryEventId: [...seen.keys()].filter(id => !incomplete.has(id)).at(-1) ?? null,
              coverage: query.since ? 'since-checkpoint' : 'recent-window' },
          }, partial => {
            assert.equal(partial.checkpointState, 'not-advanced');
            assert.deepEqual(partial.receipt.progress.find(item => item.sessionId === sourceId).readIds, []);
            assert.equal(partial.checkpoint?.position.hostCheckpoint, sourceCheckpoint?.position.hostCheckpoint);
            assert.equal(partial.chatReadVerified, false);
            if (recoverNow) for (const key of Object.keys(query)) delete query[key];
          }));
          if (recoverNow) {
            recovered = true;
            continuation.push(step('assistant_inbox', {}, recoveredInbox => {
              assert.equal(recoveredInbox.receipt.id, inbox.receipt.id);
              const progress = recoveredInbox.receipt.progress.find(item => item.sessionId === sourceId);
              assert.equal(progress.complete, false);
              assert.deepEqual(progress.readIds, []);
              assert.deepEqual(progress.position.nextQuery, nextQuery,
                'Recover the exact recorded Host continuation, including the unchanged since checkpoint');
              Object.assign(query, progress.position.nextQuery);
              assert.equal(query.since, sourceCheckpoint?.position.hostCheckpoint);
              if (sourceCheckpoint) assert.notEqual(query.since, sourceCheckpoint.version,
                'The Host since token is not the local Assistant checkpoint CAS version');
            }));
          }
        }
        plan.steps.splice(plan.index, 0, ...continuation, readPage);
      } else {
        assert.equal(missing, false, 'Every returned inbox pointer was read from the actual Host Chat range');
        assert.equal(incomplete.size, 0, 'Consume every fragment before advancing the actual Host checkpoint');
        if (query.since) {
          assert.equal(value.hasMore, false);
          assert.ok(value.checkpoint);
          assert.notEqual(value.checkpoint, query.since);
        }
        if (expected.length > 8192) assert.ok(fragments > 0 && pages > 1, 'Large text uses genuine bounded fragments');
      }
    });
    return [
      step('assistant_inbox', {}, value => {
        inbox = value;
        assert.equal(value.consumed, false);
        assert.ok(value.receipt?.id && value.items.length);
        assert.deepEqual(Object.keys(value.receipt).sort(),
          ['decidedAt', 'disposition', 'id', 'inboxIds', 'owner', 'progress', 'readAt', 'sources']);
        assert.deepEqual(value.receipt.inboxIds, value.items.map(item => item.id));
        sourceCheckpoint = value.receipt.sources.find(source => source.sessionId === sourceId).checkpoint;
        assert.equal(sourceCheckpoint?.position.hostCheckpoint, checkpoints.get(sourceId),
          'Incremental reads recover the actual previously recorded Host checkpoint from Assistant');
        assert.ok(value.items.every(item => item.sessionId === sourceId
          && ['text', 'content', 'question', 'choices', 'attachments'].every(key => !(key in item))));
      }),
      step('cockpit_get_session', () => ({ session_id: sourceId, response_format: 'json' }), value => {
        assert.equal(value.sessionId, sourceId);
        if (value.loaded) assert.ok(value.activity);
      }),
      readPage,
      step('assistant_checkpoint', () => {
        const actualQuery = { ...query, limit: 4, max_bytes: 8192, scan_pages: 2 };
        return { receiptId: inbox.receipt.id, sessionId: sourceId, readIds: inbox.items.map(item => item.id),
          expectedCheckpointVersion: sourceCheckpoint?.version ?? null,
          position: { query: actualQuery, nextQuery: lastPage.hasMore
            ? { ...actualQuery, cursor: lastPage.cursor } : null,
          hostCheckpoint: checkpoint, boundaryEventId: [...seen.keys()].at(-1) ?? null,
          coverage: query.since ? 'since-checkpoint' : 'recent-window' }, complete: true };
      }, value => {
        assert.equal(value.basis, 'agent-reported-reading');
        assert.equal(value.chatReadVerified, false);
        assert.equal(value.checkpointState, 'advanced');
        assert.equal(value.checkpoint.position.hostCheckpoint, checkpoint);
        checkpoints.set(sourceId, checkpoint);
      }),
      ...afterCheckpoint,
      step('assistant_resolve', () => ({ receiptId: inbox.receipt.id, disposition }), value => {
        assert.deepEqual(value.inboxIds, inbox.receipt.inboxIds);
        assert.equal(value.disposition, disposition === 'silent' ? 'silent' : 'reported-notified');
        assert.equal(value.basis, 'agent-reported-handling');
        assert.equal(value.userDeliveryVerified, false);
        assert.notEqual(value.chatReadVerified, true);
      }),
    ];
  };
  const promptStep = (text, mode = 'immediate', check) => step('cockpit_send_prompt',
    () => ({ session_id: sourceId, text, mode }), check);
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, {
      HOME: dirs.home, USERPROFILE: dirs.home, COPILOT_HOME: dirs.copilot, COCKPIT_HOME: dirs.cockpit,
      XDG_CONFIG_HOME: dirs.config, XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.copilot,
      XDG_RUNTIME_DIR: dirs.run, TMPDIR: dirs.scratch, TMP: dirs.scratch, TEMP: dirs.scratch,
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C.UTF-8', COPILOT_DISABLE_KEYTAR: '1',
      COPILOT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', TSX_DISABLE_CACHE: '1',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dirs.config, 'gitconfig'),
      NODE_OPTIONS: '--max-old-space-size=2048 --disable-wasm-trap-handler',
      COCKPIT_NO_BOOT: '1', COCKPIT_SERVE_WEB: '0', LOG_LEVEL: 'error',
      npm_config_update_notifier: 'false',
    });
    // Reserve a free explicit loopback port before importing the Host transport.
    const reservation = createServer();
    await new Promise(done => reservation.listen(0, '127.0.0.1', done));
    const port = reservation.address().port;
    await new Promise(done => reservation.close(done));
    origin = `http://127.0.0.1:${port}`;
    process.env.COCKPIT_PORT = String(port); process.env.COCKPIT_URL = origin;
    const mcpConfiguration = { mcpServers: { cockpit: {
      type: 'local', command: process.execPath, args: [join(serverRoot, 'apps/mcp/dist/index.js')],
      tools: hostTools, env: { ...process.env },
    } } };
    await writeFile(join(dirs.copilot, 'mcp-config.json'), JSON.stringify(mcpConfiguration));
    const { Engine, OfficialRuntime } = await import(pathToFileURL(join(hostRoot, 'packages/core/dist/index.js')).href);
    assert.equal(typeof Engine.prototype.getSessionToolScope, 'function',
      'The selected built Host lacks immutable tool scopes; select a supported artifact, not a mocked scope');
    assert.equal(typeof Engine.prototype.chatText, 'function',
      'The selected built Host lacks the confirmed public lightweight Chat implementation');
    const manifest = JSON.parse(await readFile(join(previousCwd, 'cockpit.module.json'), 'utf8'));
    const declared = manifest.roles.find(role => role.id === 'coordinator').mcpServers.assistant.tools;
    if (mode === 'connection') assert.ok(assistantTools.every(tool => declared.includes(tool)));
    else assert.deepEqual(declared, assistantTools,
      'Build the final support-only Assistant manifest before running integration');
    const transport = await import(pathToFileURL(join(serverRoot, 'apps/server/dist/index.js')).href);
    const { ModuleHost } = await import(pathToFileURL(join(serverRoot, 'apps/server/dist/module-host.js')).href);
    const { installLocalModule } = await import(pathToFileURL(join(serverRoot, 'apps/server/dist/module-install.js')).href);
    const [pack] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts',
      '--pack-destination', root], { cwd: previousCwd, encoding: 'utf8' }));
    await installLocalModule(join(root, pack.filename), { trustLocalCode: true, enable: true, hostRoot: dirs.cockpit });
    provider = createServer(async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        requests.push(input);
        assert.ok(requests.length <= 100, 'Bound deterministic provider work');
        const lastUser = JSON.stringify(input.messages.filter(message => message.role === 'user').at(-1));
        const source = /FIXTURE_SOURCE:([A-Za-z-]+)/.exec(lastUser)?.[1];
        let raw, args, content = '';
        if (source) {
          const count = (sourceCounts.get(source) ?? 0) + 1;
          sourceCounts.set(source, count);
          if (['A', 'C'].includes(source) && count === 1) {
            gate(`${source}:started`).open();
            await gate(`${source}:release`).promise;
            raw = 'cockpit_get_session'; args = { session_id: sourceId, response_format: 'json' };
            content = 'Synthetic intermediate progress';
          } else if (source === 'ask' && count === 1) {
            raw = 'ask_user'; args = { question: 'Synthetic choice?', choices: ['yes', 'no'], allowFreeform: false };
          } else {
            if (source === 'D') assert.match(JSON.stringify(input.messages), /FIXTURE_SOURCE:C/);
            if (source === 'ask') assert.match(JSON.stringify(result(input)), /yes/,
              'The genuine native ask callback receives the exact selected answer');
            content = `Synthetic final ${source}${source === 'large' ? ` ${'中文🙂'.repeat(4000)}` : ''}`;
          }
        } else {
          assert.ok(plan && !plan.finished, `Unexpected native foreground wake: ${lastUser}`);
          if (plan.index) {
            const previous = plan.steps[plan.index - 1], value = result(input);
            calls.push({ plan: plan.name, raw: previous.raw, value });
            await previous.check(value);
          }
          if (plan.index < plan.steps.length) {
            const next = plan.steps[plan.index++];
            raw = next.raw; args = typeof next.args === 'function' ? await next.args() : next.args;
          } else {
            plan.finished = true;
            content = `Synthetic foreground ${plan.name}`;
            if (plan.followUp) plan = plan.followUp;
          }
        }
        const name = raw ? toolName(input, raw) : undefined;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const delta = { role: 'assistant', content, ...(name ? { tool_calls: [{ index: 0,
          id: `fixture-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : {}) };
        for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason: name ? 'tool_calls' : 'stop' }])
          response.write(`data: ${JSON.stringify({ id: `fixture-${requests.length}`, object: 'chat.completion.chunk',
            created: 1, model: 'gpt-4.1', choices: [{ index: 0, ...choice }] })}\n\n`);
        response.end('data: [DONE]\n\n');
      } catch (error) {
        errors.push(error);
        response.writeHead(500); response.end('Synthetic provider assertion failed');
      }
    });
    await new Promise(done => provider.listen(0, '127.0.0.1', done));
    runtime = new OfficialRuntime({
      clientOptions: { baseDirectory: dirs.copilot, workingDirectory: dirs.work, builtinPluginDirectories: [],
        useLoggedInUser: false, enableRemoteSessions: false, logLevel: 'error',
        onListModels: () => [{ id: 'gpt-4.1', name: 'Synthetic local model',
          capabilities: { supports: { vision: false, reasoningEffort: false }, limits: { max_context_window_tokens: 128000 } } }] },
      sessionConfig: {
        provider: { type: 'openai', wireApi: 'completions',
          baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, modelId: 'gpt-4.1' },
        configDirectory: dirs.copilot, enableFileHooks: false, enableHostGitOperations: false,
        enableSessionStore: false, enableSkills: false, skillDirectories: [], pluginDirectories: [],
        instructionDirectories: [], customAgents: [], enableManagedSettings: false,
        skipEmbeddingRetrieval: true, embeddingCacheStorage: 'in-memory', enableSessionTelemetry: false,
        remoteSession: 'off', enableExperimentalMode: true,
      },
    });
    engine = new Engine({ runtime, sessionDefaults: { read: async () => ({ modelId: 'gpt-4.1' }),
      write: async () => { throw new Error('Fixture cannot change default model'); } } });
    app = transport.app;
    moduleHost = new ModuleHost({ hostRoot: dirs.cockpit, observer: engine, origin,
      host: { call: async (name, body) => {
        if (name === 'prompt') {
          assert.equal(body.sessionId, foregroundId, 'The module only wakes the explicitly selected foreground');
          assert.equal(body.mode, 'enqueue');
          const source = await engine.getMeta(sourceId);
          assert.ok(source.ask || source.status === 'idle' && source.activity
            && !source.activity.processing && !source.activity.hasActiveWork,
          'A module reminder requires native source idle or an actual pending ask');
        }
        intents.push({ name, body });
        return transport.callModuleIntent(name, body);
      } }, report: (_id, error) => {
        // Observation racing an explicit native unload/reload has no stable metadata.
        if (error.code === 'SESSION_TRANSITION') diagnostics.push(String(error));
        else errors.push(error);
      } });
    transport.setTestDependencies({ engine, moduleHost });
    await moduleHost.register(app);
    assert.deepEqual(moduleHost.bootstrap().errors, []);
    assert.equal(moduleHost.bootstrap().active.length, 1);
    engine.setRoleProvider(moduleHost.roles);
    engine.onNativeEvent(row => events.push(row));
    process.chdir(dirs.work);
    await engine.start();
    await app.listen({ host: '127.0.0.1', port });
    moduleHost.ready();
    assert.equal((await fetch(`${origin}/health`)).ok, true);
    foregroundId = (await api('session/new', { cwd: dirs.work,
      roles: [{ moduleId: 'assistant', roleId: 'coordinator' }], toolScope: scope })).sessionId;
    await api('session/tools-initialize', { sessionId: foregroundId });
    const offered = await api('session/tool-scope', { sessionId: foregroundId });
    assert.deepEqual(offered.configured, scope);
    assert.ok(offered.tools?.length, 'Read actual initialized native tools, not declared role names');
    const connections = await api('mcp/session', { sessionId: foregroundId });
    for (const name of ['cockpit', 'assistant'])
      assert.ok(connections.servers.some(server => server.name === name && server.status === 'connected'),
        `Actual native MCP connection missing: ${JSON.stringify(connections)}`);
    await writeFile(join(root, 'verified-configuration.json'), JSON.stringify({ scope, offered, connections,
      mcp: { mcpServers: { cockpit: { ...mcpConfiguration.mcpServers.cockpit, env: {
        HOME: dirs.home, COPILOT_HOME: dirs.copilot, COCKPIT_HOME: dirs.cockpit,
        COCKPIT_PORT: String(port), COCKPIT_URL: origin,
      } } } } }, null, 2));
    await front('setup', [
      step('cockpit_new_session', { cwd: dirs.work, tool_scope: { builtins: ['ask_user'],
        mcpServers: [{ name: 'cockpit', tools: ['cockpit_get_session'] }] } }, value => {
        sourceId = /Created session ([0-9a-f-]{36})/.exec(String(value))?.[1];
        assert.ok(sourceId, JSON.stringify(value));
      }),
      step('assistant_topic', () => ({ title: 'Synthetic ordinary source', sessionId: sourceId }), value => {
        assert.equal(value.sessionId, sourceId); topicId = value.topicId;
      }),
      step('assistant_foreground', {}, value => assert.equal(value.foregroundSessionId, null)),
      step('assistant_topics', {}, value => assert.ok(value.items.some(item => item.topicId === topicId))),
    ]);
    assert.deepEqual((await engine.getMeta(sourceId)).roles, []);
    assert.ok(requests[0].tools.every(tool => {
      const name = tool.function.name;
      return [...hostTools, ...assistantTools].some(raw => name.endsWith(`-${raw}`) || name === raw);
    }), 'Immutable foreground scope excludes builtins and unrestricted Host intents');
    for (const raw of [...hostTools, ...assistantTools]) toolName(requests[0], raw);
    console.log('PASS: ordinary Assistant role + configured stdio cockpit; actual native connected tools match immutable allowlists.');
    if (mode === 'connection') {
      await front('direct-queued', [
        promptStep('FIXTURE_SOURCE:A', 'immediate', () => gate('A:started').promise),
        promptStep('FIXTURE_SOURCE:B', 'enqueue', () => gate('A:release').open()),
      ]);
      await wait('direct queued B', () => sourceEvents().some(event => event.data.content === 'Synthetic final B'));
      await idle(sourceId);
      await front('direct-steered', [
        promptStep('FIXTURE_SOURCE:C', 'immediate', () => gate('C:started').promise),
        promptStep('FIXTURE_SOURCE:D', 'immediate', () => gate('C:release').open()),
      ]);
      await wait('direct steered D', () => sourceEvents().some(event => event.data.content === 'Synthetic final D'));
      await idle(sourceId);
      let question;
      await front('direct-ask', [
        promptStep('FIXTURE_SOURCE:ask', 'immediate', () => wait('real native pending ask',
          async () => !!(await engine.getMeta(sourceId))?.ask)),
        step('cockpit_get_session', () => ({ session_id: sourceId, response_format: 'json' }), value => {
          question = value.ask; assert.equal(question.question, 'Synthetic choice?');
        }),
        step('cockpit_respond_ask', () => ({ session_id: sourceId, request_id: question.requestId,
          answer: 'yes', was_freeform: false }), value =>
          assert.equal(value, `Answered ask ${question.requestId} on ${sourceId}.`)),
      ]);
      await wait('direct answered ask', () => sourceEvents().some(event => event.data.content === 'Synthetic final ask'));
      await idle(sourceId);
      await front('direct-lightweight', [
        step('cockpit_read_session_text', () => ({ session_id: sourceId, limit: 4, max_bytes: 8192, scan_pages: 2 }),
          value => {
            assert.equal(value.view, 'text');
            assert.ok(value.messages.some(message => message.content === 'Synthetic final ask'));
            assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 8192);
          }),
      ]);
      console.log('PASS connection-only: real create/register, queued/steered Host prompts, exact ask callback and lightweight Chat. Inbox resolution is not covered in this mode.');
    } else if (mode === 'response') {
      await front('select-response-foreground', [step('assistant_foreground', { sessionId: foregroundId })]);
      const queuedRead = { name: 'queued-read', steps: readSteps('silent', 'Synthetic final B'),
        index: 0, finished: false };
      let previousNotices = intents.filter(item => item.name === 'prompt').length;
      await front('queued', [
        promptStep('FIXTURE_SOURCE:A', 'immediate', () => gate('A:started').promise),
        promptStep('FIXTURE_SOURCE:B', 'enqueue', () => gate('A:release').open()),
      ], undefined, queuedRead);
      await wait('queued final B', () => sourceEvents().some(event => event.data.content === 'Synthetic final B'));
      await wait('queued idle reminder read', () => queuedRead.finished);
      await idle(foregroundId);
      await idle(sourceId);
      assert.equal(intents.filter(item => item.name === 'prompt').length, previousNotices + 1);
      assert.equal(sourceCounts.get('A'), 2); assert.equal(sourceCounts.get('B'), 1);
      const firstIdle = sourceEvents().findIndex(event => event.type === 'session.idle');
      assert.ok(firstIdle > sourceEvents().findIndex(event => event.data.content === 'Synthetic final B'));
      const steeredRead = { name: 'steered-read', steps: readSteps('notified', 'Synthetic final D'),
        index: 0, finished: false };
      previousNotices = intents.filter(item => item.name === 'prompt').length;
      await front('steered', [
        promptStep('FIXTURE_SOURCE:C', 'immediate', () => gate('C:started').promise),
        promptStep('FIXTURE_SOURCE:D', 'immediate', () => gate('C:release').open()),
      ], undefined, steeredRead);
      await wait('steered final D', () => sourceEvents().some(event => event.data.content === 'Synthetic final D'));
      await wait('steered idle reminder read', () => steeredRead.finished);
      await idle(foregroundId);
      await idle(sourceId);
      assert.equal(intents.filter(item => item.name === 'prompt').length, previousNotices + 1);
      assert.ok(sourceEvents().some(event => event.type === 'user.message'
        && event.data.content === 'FIXTURE_SOURCE:D' && event.data.delivery === 'steering'));
      console.log('PASS: direct Host queued A/B and immediate C/D steering; one reminder after each native source idle, exact Chat and handling reports.');
    } else {
      await front('initial-send', [promptStep('FIXTURE_SOURCE:initial')]);
      await wait('initial source reply', () => sourceEvents().some(event => event.data.content === 'Synthetic final initial'));
      await idle(sourceId);
      await front('initial-read', readSteps('silent', 'Synthetic final initial'));
      if (mode === 'session') {
        await api('session/unload', { sessionId: sourceId });
        assert.equal((await engine.getMeta(sourceId)).loaded, false);
        await front('source-reload', [
          step('cockpit_reload_session', () => ({ session_id: sourceId })),
          step('cockpit_get_session', () => ({ session_id: sourceId, response_format: 'json' }), value => {
            assert.equal(value.sessionId, sourceId); assert.equal(value.loaded, true);
          }),
          promptStep('FIXTURE_SOURCE:resumed'),
        ]);
        await wait('resumed source', () => sourceEvents().some(event => event.data.content === 'Synthetic final resumed'));
        await idle(sourceId);
        await api('session/unload', { sessionId: sourceId });
        await front('resumed-read', readSteps('notified', 'Synthetic final resumed'));
        assert.equal((await engine.getMeta(sourceId)).loaded, false,
          'Persisted lightweight since reads do not load the source session');
        await front('select-cold-foreground', [
          step('assistant_foreground', { sessionId: foregroundId }),
        ]);
        await api('session/unload', { sessionId: foregroundId });
        assert.equal((await engine.getMeta(foregroundId)).loaded, false);
        plan = { name: 'cold-foreground', steps: readSteps('silent', 'Synthetic final cold'),
          index: 0, finished: false };
        await api('prompt', { sessionId: sourceId, text: 'FIXTURE_SOURCE:cold', mode: 'immediate' });
        await wait('original cold foreground resumed by native wake', () => plan.finished);
        await idle(foregroundId); await idle(sourceId);
        assert.equal((await engine.getMeta(foregroundId)).sessionId, foregroundId);
        assert.deepEqual((await api('session/tool-scope', { sessionId: foregroundId })).configured, scope);
        assert.ok(intents.some(item => item.name === 'session/load' && item.body.sessionId === foregroundId));
        assert.equal(calls.filter(item => item.raw === 'cockpit_new_session').length, 1);
        console.log('PASS: Host source reload and automatic cold foreground wake preserve both original IDs, binding and immutable scope.');
      } else {
        await front('foreground-selection', [
          step('assistant_foreground', { sessionId: foregroundId }, value => assert.equal(value.foregroundSessionId, foregroundId)),
          step('assistant_foreground', {}, value => assert.equal(value.foregroundSessionId, foregroundId)),
        ]);
        const previousNotices = intents.filter(item => item.name === 'prompt').length;
        plan = { name: 'idle-pointer', steps: readSteps('notified', 'Synthetic final complete'), index: 0, finished: false };
        await api('prompt', { sessionId: sourceId, text: 'FIXTURE_SOURCE:complete', mode: 'immediate' });
        await wait('real idle pointer wake', () => plan.finished);
        await idle(foregroundId); await idle(sourceId);
        assert.equal(intents.filter(item => item.name === 'prompt').length, previousNotices + 1);
        plan = { name: 'large-lightweight', steps: readSteps('silent', `Synthetic final large ${'中文🙂'.repeat(4000)}`),
          index: 0, finished: false };
        await api('prompt', { sessionId: sourceId, text: 'FIXTURE_SOURCE:large', mode: 'immediate' });
        await wait('incremental large text fully reassembled', () => plan.finished);
        await idle(foregroundId); await idle(sourceId);
        const later = { name: 'later-arrival', steps: [
          ...readSteps('silent', 'Synthetic final later'),
          step('assistant_inbox', { peek: true }, value => assert.equal(value.count, 0)),
        ], index: 0, finished: false };
        plan = { name: 'exact-range-before-arrival', steps: [
          ...readSteps('silent', 'Synthetic final boundary', [
            promptStep('FIXTURE_SOURCE:later', 'immediate', async () => {
              await wait('new source arrival after old checkpoint',
                () => sourceEvents().some(event => event.data.content === 'Synthetic final later'));
              await idle(sourceId);
            }),
          ]),
          step('assistant_inbox', { peek: true }, value => assert.equal(value.count, 1,
            'Resolving the old exact receipt preserves the new unread source pointer')),
        ], index: 0, finished: false, followUp: later };
        await api('prompt', { sessionId: sourceId, text: 'FIXTURE_SOURCE:boundary', mode: 'immediate' });
        await wait('new arrival independently read and resolved', () => later.finished);
        await idle(foregroundId); await idle(sourceId);
        let askInbox, question;
        plan = { name: 'native-ask', index: 0, finished: false, steps: [
          step('assistant_inbox', {}, value => {
            askInbox = value;
            assert.ok(value.items.some(item => item.type === 'ask' && item.questionRequestId));
            assert.ok(value.items.every(item =>
              ['text', 'content', 'question', 'choices'].every(key => !(key in item))));
          }),
          step('cockpit_get_session', () => ({ session_id: sourceId, response_format: 'json' }), value => {
            question = value.ask;
            assert.equal(question.question, 'Synthetic choice?');
            assert.ok(askInbox.items.some(item => item.questionRequestId === question.requestId));
          }),
          step('assistant_checkpoint', () => ({ receiptId: askInbox.receipt.id, sessionId: sourceId,
            readIds: askInbox.items.map(item => item.id), position: null, complete: true })),
          step('assistant_resolve', () => ({ receiptId: askInbox.receipt.id, disposition: 'silent' })),
          step('assistant_foreground', { sessionId: null }),
          step('cockpit_respond_ask', () => ({ session_id: sourceId, request_id: question.requestId,
            answer: 'yes', was_freeform: false }), value => {
            assert.equal(value, `Answered ask ${question.requestId} on ${sourceId}.`);
          }),
        ] };
        await api('prompt', { sessionId: sourceId, text: 'FIXTURE_SOURCE:ask', mode: 'immediate' });
        await wait('exact ask callback', () => plan.finished);
        await idle(foregroundId);
        await wait('native answered reply', () => sourceEvents().some(event => event.data.content === 'Synthetic final ask'));
        await idle(sourceId);
        assert.equal((await engine.getMeta(sourceId)).ask, null);
        console.log('PASS: idle pointer → Host lightweight Chat/since → complete UTF-8-bounded fragments → agent handling report; new arrivals survive old resolution; real ask_user → exact Host respondAsk.');
      }
    }
    assert.ok(frontEvents().some(event => event.type === 'assistant.message'));
    assert.ok(!intents.some(item => ['session/new', 'respondAsk'].includes(item.name)),
      'Assistant itself never creates business sessions or proxies answers');
    assert.ok(!intents.some(item => ['session/chat', 'session/chat/text'].includes(item.name)),
      'Assistant records pointers/checkpoints only; the native agent reads Host Chat directly');
    assert.deepEqual(errors, []);
    console.log(`PASS ${mode}: ${requests.length} deterministic provider requests; ${calls.length} actual MCP calls.`);
    if (diagnostics.length) console.log(`Observed ${diagnostics.length} expected SESSION_TRANSITION diagnostics during explicit cold lifecycle operations.`);
    console.log(`Verified scope: ${JSON.stringify(scope)}`);
    console.log('Synthetic policy only: no claim about natural-language judgement or user-visible notification delivery.');
    await moduleHost.stop();
    await engine.stop(); engine = undefined;
    await app.close(); app = undefined;
    clean = true;
  } catch (error) {
    errors.push(error); throw error;
  } finally {
    for (const value of gates.values()) value.open();
    try {
      if (moduleHost) await moduleHost.stop();
      if (engine) {
        await Promise.allSettled([foregroundId, sourceId].filter(Boolean).map(id => engine.cancel(id)));
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          const states = await Promise.all([foregroundId, sourceId].filter(Boolean).map(id => engine.getMeta(id)));
          if (states.every(meta => !meta?.loaded || meta.activity && !meta.activity.processing && !meta.activity.hasActiveWork)) break;
          await new Promise(done => setTimeout(done, 50));
        }
        await engine.stop();
      }
      if (app) await app.close();
    } finally {
      if (provider) {
        provider.closeAllConnections();
        await new Promise(done => provider.close(done));
      }
      process.chdir(previousCwd);
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, before);
      if (clean) {
        // The installer seals its exact owned package directories read-only.
        const writable = async path => {
          await chmod(path, 0o700);
          for (const entry of await readdir(path, { withFileTypes: true }))
            if (entry.isDirectory()) await writable(join(path, entry.name));
        };
        await writable(root);
        await rm(root, { recursive: true });
      } else {
        await writeFile(join(root, 'fixture-evidence.json'), JSON.stringify({
          errors: errors.map(error => error.stack ?? String(error)), diagnostics, foregroundId, sourceId, scope, calls, intents, events, requests,
        }, null, 2));
        console.error(`Failed synthetic evidence retained at ${root}`);
      }
    }
  }
}

if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runNativeCheck(process.argv[4] ?? 'evidence');
