import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownedProcesses, survivingProcesses, terminateProcesses } from './native-restart-processes.mjs';
import { assertPassiveModuleRead, isRecordedReminder } from './native-evidence-check.mjs';

const hostTools = ['cockpit_new_session', 'cockpit_get_session', 'cockpit_reload_session',
  'cockpit_send_prompt', 'cockpit_respond_ask', 'cockpit_read_session_text'];
const assistantTools = ['assistant_topics', 'assistant_topic', 'assistant_search', 'assistant_foreground',
  'assistant_inbox', 'assistant_checkpoint', 'assistant_resolve'];
const scope = { builtins: [], mcpServers: [
  { name: 'assistant', tools: assistantTools }, { name: 'cockpit', tools: hostTools },
] };
const queryBase = { source: 'persisted', direction: 'backward', limit: 2, max_bytes: 8192, scan_pages: 1 };
const sleep = ms => new Promise(done => setTimeout(done, ms));
const step = (raw, args, check = () => {}, allowError = false) => ({ raw, args, check, allowError });

export function sessionMeta(value, sessionId) {
  assert.ok(value?.meta && value.meta.sessionId === sessionId, 'session/get must return the requested {meta}');
  return value.meta;
}

export function offeredToolNames(input, allowed) {
  const names = (input.tools ?? []).map(tool => tool.function.name);
  assert.equal(names.length, allowed.length, `Unexpected actual native tool set: ${names.join(', ')}`);
  const normalized = names.map(name => {
    const matches = allowed.filter(raw => name === raw || name.endsWith(`-${raw}`) || name.endsWith(`_${raw}`));
    assert.equal(matches.length, 1, `Unexpected native tool: ${name}`);
    return matches[0];
  });
  assert.deepEqual(normalized.sort(), [...allowed].sort(), 'Actual native tools must match the complete allowlist');
  return names;
}

export function chatTextFailureCode(value) {
  assert.equal(typeof value, 'string', 'Expected the public MCP backend error envelope');
  const match = /^Error: cockpit intent "session\/chat\/text" failed: HTTP 409: (\{.*\})$/s.exec(value);
  assert.ok(match, `Not a public text-position conflict: ${value}`);
  const body = JSON.parse(match[1]);
  assert.equal(typeof body.error, 'string');
  const code = /^(TEXT_[A-Z_]+): /.exec(body.error)?.[1];
  assert.ok(code, `No public text-position error identifier: ${value}`);
  return code;
}

function toolResult(input, expectedToolCallId) {
  const message = input.messages.findLast(item => item.role === 'tool');
  assert.ok(message, 'Expected a genuine native MCP tool result');
  assert.equal(message.tool_call_id, expectedToolCallId, 'Never misattribute a prior tool result or compaction request');
  let value = message.content, isError = false;
  if (Array.isArray(value)) value = value.map(part => part.text ?? '').join('\n');
  try { value = JSON.parse(value); } catch { /* Native lifecycle results may be descriptive. */ }
  if (value && typeof value === 'object' && Array.isArray(value.content)) {
    isError = value.isError === true;
    value = value.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    try { value = JSON.parse(value); } catch { /* Keep the exact public error or result text. */ }
  }
  // Some native providers render the MCP envelope as plain text.
  if (typeof value === 'string' && /^MCP server '(?:cockpit|assistant)': /.test(value)) {
    isError = true;
    value = value.replace(/^MCP server '(?:cockpit|assistant)': /, '');
    try { value = JSON.parse(value); } catch { /* Host semantic failures use descriptive text. */ }
  }
  if (typeof value === 'string' && value.startsWith('Error:')) isError = true;
  return { value, isError };
}

// No position decoding or native file reads. The controller holds synthetic
// expectations; the real Assistant database holds the consumer's opaque position.
export async function runNativeRestartCheck(options = {}) {
  assert.ok(options.hostRoot ?? process.argv[2], 'Supply a verified, built Host root, never a service URL');
  const hostRoot = await realpath(resolve(options.hostRoot ?? process.argv[2]));
  const serverArgument = process.argv[3]?.startsWith('--') ? undefined : process.argv[3];
  const serverRoot = await realpath(resolve(options.serverRoot ?? serverArgument ?? hostRoot));
  const legacyRoot = options.legacyRoot ? await realpath(resolve(options.legacyRoot)) : null;
  const moduleRoot = process.cwd(), root = join(moduleRoot, `.native-restart-${randomUUID()}`);
  const manifest = JSON.parse(await readFile(join(moduleRoot, 'cockpit.module.json'), 'utf8'));
  assert.deepEqual(manifest.roles.find(role => role.id === 'coordinator').mcpServers.assistant.tools, assistantTools);
  await mkdir(root, { mode: 0o700 });
  const dirs = {};
  for (const name of ['home', 'copilot', 'cockpit', 'work', 'scratch', 'cache', 'config', 'run']) {
    dirs[name] = join(root, name);
    await mkdir(dirs[name], { mode: 0o700 });
  }
  const env = {
    HOME: dirs.home, USERPROFILE: dirs.home, COPILOT_HOME: dirs.copilot, COCKPIT_HOME: dirs.cockpit,
    XDG_CONFIG_HOME: dirs.config, XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.copilot,
    XDG_RUNTIME_DIR: dirs.run, TMPDIR: dirs.scratch, TMP: dirs.scratch, TEMP: dirs.scratch,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C.UTF-8', COPILOT_DISABLE_KEYTAR: '1',
    COPILOT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', TSX_DISABLE_CACHE: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dirs.config, 'gitconfig'),
    NODE_OPTIONS: '--max-old-space-size=2048 --disable-wasm-trap-handler',
    COCKPIT_NO_BOOT: '1', COCKPIT_SERVE_WEB: '0', LOG_LEVEL: 'error', npm_config_update_notifier: 'false',
  };
  const evidence = { controllerPid: process.pid, hostRoot, serverRoot, legacyRoot, dirs, scope,
    hosts: [], calls: [], events: [], moduleIntents: [], diagnostics: [], recoveries: [], checks: [] };
  const failures = [], replies = new Map();
  let child, childExit, origin, provider, plan, foregroundId, sourceId, clean = false, requestCount = 0;
  const wait = async (label, predicate, timeout = 60000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (failures.length) throw failures[0];
      if (await predicate()) return;
      await sleep(40);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const api = async (name, body) => {
    const response = await fetch(`${origin}/intent/${name}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000) });
    const value = await response.json();
    assert.ok(response.ok, `${name}: ${JSON.stringify(value)}`);
    return value;
  };
  const idle = async id => {
    let stable = 0;
    await wait(`native idle ${id}`, async () => {
      const meta = sessionMeta(await api('session/get', { sessionId: id }), id);
      const ready = meta.loaded && meta.status === 'idle' && !!meta.activity && !meta.activity.processing
        && !meta.activity.hasActiveWork && !meta.activeOperations && !meta.loading && !meta.closing && !meta.cancelling;
      if (!ready) stable = 0;
      else stable ||= Date.now();
      return ready && Date.now() - stable >= 120;
    });
  };
  const front = async (name, steps) => {
    await idle(foregroundId);
    const current = { name, steps, index: 0, finished: false, trigger: `RESTART_FRONT:${name}` };
    plan = current;
    await api('prompt', { sessionId: foregroundId, text: current.trigger, mode: 'immediate' });
    await wait(`foreground ${name}`, () => current.finished, 120000);
    await idle(foregroundId);
  };
  const sendSource = label => step('cockpit_send_prompt', () => ({
    session_id: sourceId, text: `RESTART_SOURCE:${label}`, mode: 'immediate',
  }), async () => {
    await wait(`source final ${label}`, () => evidence.events.some(row => row.sessionId === sourceId
      && row.event.type === 'assistant.message' && row.event.data.content === replies.get(label)));
    await idle(sourceId);
  });
  const pointerOnly = inbox => {
    assert.equal(inbox.consumed, false);
    assert.ok(inbox.receipt?.id && inbox.items.length);
    for (const item of inbox.items) {
      assert.equal(item.sessionId, sourceId);
      for (const key of ['text', 'content', 'question', 'choices', 'attachments']) assert.ok(!(key in item));
    }
  };
  const startHost = async (selectedRoot, selectedServer, archive) => {
    assert.ok(!child, 'Only one Host/native runtime at a time');
    let ready;
    const processChild = fork(fileURLToPath(new URL('./native-restart-host.mjs', import.meta.url)), [],
      { cwd: moduleRoot, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child = processChild;
    const record = { pid: processChild.pid, hostRoot: selectedRoot, serverRoot: selectedServer, output: '' };
    evidence.hosts.push(record);
    for (const stream of [processChild.stdout, processChild.stderr])
      stream.on('data', data => { record.output = (record.output + data.toString()).slice(-32000); });
    processChild.on('error', error => failures.push(error));
    childExit = new Promise(done => processChild.once('exit', (code, signal) => {
      Object.assign(record, { code, signal, exited: true });
      if (!record.stopping) failures.push(new Error(`Host ${record.pid} exited unexpectedly: ${code}/${signal}\n${record.output}`));
      done({ code, signal });
    }));
    processChild.on('message', message => {
      if (message.type === 'ready') {
        ready = message;
        record.origin = message.origin;
        record.configuration = message.configuration;
      }
      else if (message.type === 'failure') failures.push(new Error(message.error));
      else if (message.type === 'native-event') evidence.events.push(message.row);
      else if (message.type === 'module-intent') {
        evidence.moduleIntents.push(message);
        try {
          assertPassiveModuleRead(message.name, message.body);
          if (['prompt', 'session/load'].includes(message.name))
            assert.equal(message.body.sessionId, foregroundId,
              'Only reminder delivery may wake or load the saved coordinator, never the cached source');
          if (message.name === 'prompt') assert.equal(message.body.mode, 'enqueue');
        } catch (error) { failures.push(error); }
      }
      else if (message.type === 'diagnostic') evidence.diagnostics.push(message.error);
      else if (message.type === 'stopped') record.stopped = true;
    });
    processChild.send({ hostRoot: selectedRoot, serverRoot: selectedServer, dirs, moduleArchive: archive,
      hostTools, providerUrl: `http://127.0.0.1:${provider.address().port}/v1` });
    await wait('new Host child ready', () => ready);
    assert.notEqual(ready.pid, process.pid);
    origin = ready.origin;
    assert.equal((await fetch(`${origin}/health`)).ok, true);
  };
  let stoppingHost;
  const stopHost = () => stoppingHost ??= (async () => {
    if (!child) return;
    const record = evidence.hosts.at(-1), oldOrigin = record.origin;
    const owned = ownedProcesses(record.pid);
    record.stopping = true;
    if (child.connected) child.send({ type: 'stop' });
    let timer;
    const result = await Promise.race([childExit, new Promise(done => { timer = setTimeout(() => done(null), 20000); })]);
    clearTimeout(timer);
    if (!result) {
      terminateProcesses([...owned, ...ownedProcesses(record.pid)]);
      await childExit;
      child = undefined;
      throw new Error(`Host ${record.pid} failed graceful complete OS exit; restart evidence is invalid`);
    }
    child = undefined;
    const survivors = survivingProcesses(owned);
    if (survivors.length) {
      terminateProcesses(survivors);
      throw new Error(`Host exited with surviving fixture descendants: ${survivors.map(item => item.pid)}`);
    }
    assert.equal(result.code, 0, record.output);
    assert.equal(record.stopped, true, 'Wait for native cleanup AND the actual Host OS exit');
    assert.throws(() => process.kill(record.pid, 0), { code: 'ESRCH' });
    if (oldOrigin) await assert.rejects(fetch(`${oldOrigin}/health`, { signal: AbortSignal.timeout(2000) }));
  })().finally(() => { stoppingHost = undefined; });
  let interruptDeadline;
  const interrupt = signal => {
    failures.push(new Error(`Restart fixture interrupted by ${signal}`));
    process.exitCode = 1;
    const owned = child ? ownedProcesses(child.pid) : [];
    interruptDeadline ??= setTimeout(() => {
      terminateProcesses([...owned, ...(child ? ownedProcesses(child.pid) : [])]);
      process.exit(signal === 'SIGINT' ? 130 : 143);
    }, 25000);
    provider?.closeAllConnections();
    void stopHost().catch(error => failures.push(error));
  };
  const onSigint = () => interrupt('SIGINT'), onSigterm = () => interrupt('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  const restart = async () => {
    await writeFile(join(root, 'controller-state.json'), JSON.stringify({
      foregroundId, sourceId, expectedReplies: [...replies], hostPids: evidence.hosts.map(item => item.pid),
    }, null, 2));
    const providerPort = provider.address().port;
    await stopHost();
    assert.equal(provider.address().port, providerPort, 'The controller-owned provider survives complete Host exit');
    await startHost(hostRoot, serverRoot);
    assert.notEqual(evidence.hosts.at(-1).pid, evidence.hosts.at(-2).pid);
    assert.equal(sessionMeta(await api('session/get', { sessionId: sourceId }), sourceId).loaded, false);
    await api('session/reload', { sessionId: foregroundId });
    await idle(foregroundId);
    await api('session/tools-initialize', { sessionId: foregroundId });
    const coordinator = sessionMeta(await api('session/get', { sessionId: foregroundId }), foregroundId);
    for (const field of ['roles', 'appliedRoles'])
      assert.ok(coordinator[field]?.some(role => role.moduleId === 'assistant' && role.roleId === 'coordinator'),
        'Complete Host restart preserves the saved and applied coordinator owner');
    assert.deepEqual((await api('session/tool-scope', { sessionId: foregroundId })).configured, scope);
    const connections = await api('mcp/session', { sessionId: foregroundId });
    for (const name of ['cockpit', 'assistant'])
      assert.ok(connections.servers.some(server => server.name === name && server.status === 'connected'));
  };
  const range = (checkpoint, expected) => ({
    query: { ...queryBase, ...(checkpoint ? { since: checkpoint.position.hostCheckpoint } : {}) },
    checkpoint, expected, seen: new Map(), incomplete: new Set(), pages: 0, fragments: 0, replay: false,
  });
  const readRange = (state, pauseOnFragment = false) => {
    const read = step('cockpit_read_session_text', () => {
      assert.equal(state.query.since, state.checkpoint?.position.hostCheckpoint,
        'Keep even an imported legacy since token byte-for-byte unchanged through this range');
      return { session_id: sourceId, ...state.query };
    }, (value, isError) => {
      assert.ok(++state.pages <= 120, 'Bound the entire deterministic read, including explicit replay');
      if (isError) {
        const code = chatTextFailureCode(value);
        assert.ok(['TEXT_CURSOR_EXPIRED', 'TEXT_PAGE_CHANGED'].includes(code),
          `Not a supported same-since recovery error: ${JSON.stringify(value)}`);
        assert.ok(state.query.cursor && !state.replay,
          `No automatic baseline reset or repeated retry: ${JSON.stringify(value)}`);
        evidence.recoveries.push({ query: { ...state.query }, error: value,
          recovery: state.query.since ? 'same-original-since' : 'explicit-original-history-reselection' });
        if (code === 'TEXT_PAGE_CHANGED') {
          state.seen.clear();
          state.incomplete.clear();
        }
        // Reselect the original traversal if it had no checkpoint; otherwise
        // replay the SAME since. Expected contents still gate completion.
        delete state.query.cursor;
        state.replay = true;
        plan.steps.splice(plan.index, 0, read);
        return;
      }
      assert.equal(value.view, 'text');
      assert.equal(value.sessionId, sourceId);
      assert.equal(value.order, 'newest-first');
      assert.ok(Buffer.byteLength(JSON.stringify(value)) <= queryBase.max_bytes);
      assert.ok(value.read.pages <= queryBase.scan_pages && value.read.events <= 16);
      state.lastQuery = { ...state.query };
      state.lastPage = value;
      for (const message of value.messages) {
        const existing = state.seen.get(message.eventId) ?? '';
        assert.ok(message.offset <= existing.length, 'No missing UTF-16 fragment prefix');
        const end = message.offset + message.content.length;
        assert.equal(existing.slice(message.offset, Math.min(end, existing.length)),
          message.content.slice(0, Math.max(0, existing.length - message.offset)), 'Replay overlap must match exactly');
        const text = existing + message.content.slice(Math.max(0, existing.length - message.offset));
        state.seen.set(message.eventId, text);
        if (message.nextOffset !== null) {
          assert.equal(message.nextOffset, end);
          state.incomplete.add(message.eventId);
          state.fragments++;
        } else {
          assert.equal(text.length, message.totalCharacters);
          state.incomplete.delete(message.eventId);
        }
      }
      if (value.checkpoint) state.deliveredCheckpoint = value.checkpoint;
      if (value.hasMore) {
        assert.ok(value.cursor);
        state.query.cursor = value.cursor;
      }
      if (pauseOnFragment && state.incomplete.size) return;
      const missing = state.expected.some(text => ![...state.seen.values()].includes(text));
      if (state.query.since ? value.hasMore || !value.checkpoint : missing || !state.deliveredCheckpoint) {
        assert.ok(value.hasMore && value.cursor, 'Required unread content must not disappear behind an empty success');
        plan.steps.splice(plan.index, 0, read);
      } else {
        assert.equal(missing, false, 'All pre/post restart messages were delivered');
        assert.equal(state.incomplete.size, 0);
        if (state.query.since) assert.equal(value.hasMore, false);
        state.complete = true;
      }
    }, true);
    return read;
  };
  const recordPosition = (state, complete) => step('assistant_checkpoint', () => ({
    receiptId: state.inbox.receipt.id, sessionId: sourceId,
    readIds: complete ? state.inbox.items.map(item => item.id) : [], complete,
    ...(complete ? { expectedCheckpointVersion: state.checkpoint?.version ?? null } : {}),
    position: { query: state.lastQuery, nextQuery: state.lastPage.hasMore ? { ...state.query } : null,
      boundaryEventId: [...state.seen.keys()].filter(id => !state.incomplete.has(id)).at(-1) ?? null,
      ...(complete ? { hostCheckpoint: state.deliveredCheckpoint } : {}),
      coverage: state.checkpoint ? 'since-checkpoint' : 'recent-window' },
  }), value => {
    assert.equal(value.chatReadVerified, false);
    assert.equal(value.checkpointState, complete ? 'advanced' : 'not-advanced');
    if (complete) {
      assert.equal(state.complete, true);
      assert.equal(value.checkpoint.position.hostCheckpoint, state.deliveredCheckpoint);
      state.savedCheckpoint = value.checkpoint;
    } else {
      assert.deepEqual(value.receipt.progress.find(item => item.sessionId === sourceId).readIds, []);
      assert.equal(value.checkpoint.position.hostCheckpoint, state.checkpoint.position.hostCheckpoint);
      state.savedProgress = value.receipt.progress.find(item => item.sessionId === sourceId);
    }
  });
  const inboxStep = state => step('assistant_inbox', {}, value => {
    pointerOnly(value);
    state.inbox = value;
    assert.deepEqual(value.receipt.sources.find(item => item.sessionId === sourceId).checkpoint, state.checkpoint ?? null);
  });
  const resolveStep = state => step('assistant_resolve',
    () => ({ receiptId: state.inbox.receipt.id, disposition: 'silent' }), value => {
      assert.deepEqual(value.inboxIds, state.inbox.receipt.inboxIds);
      assert.equal(value.disposition, 'silent');
      assert.equal(value.userDeliveryVerified, false);
      assert.notEqual(value.chatReadVerified, true);
    });
  try {
    const [pack] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root],
      { cwd: moduleRoot, env, encoding: 'utf8' }));
    provider = createServer(async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        assert.ok(++requestCount <= 250, 'Bound native provider work');
        const requestNumber = requestCount;
        const lastUser = JSON.stringify(input.messages.filter(message => message.role === 'user').at(-1));
        const source = /RESTART_SOURCE:([a-z0-9-]+)/.exec(lastUser)?.[1];
        const names = offeredToolNames(input, source ? [] : [...hostTools, ...assistantTools]);
        let raw, args, content = '';
        if (input.tool_choice === 'none') {
          content = 'Synthetic context summary; verification state remains in the fixture controller and native history.';
        } else if (source) {
          assert.ok(replies.has(source), `Unexpected synthetic source ${source}`);
          content = replies.get(source);
        } else if (isRecordedReminder(lastUser, evidence.moduleIntents, foregroundId)
          && (!plan || plan.finished || !plan.started
            && !lastUser.includes(JSON.stringify(plan.trigger).slice(1, -1)))) {
          // Leave unread receipts and partial positions untouched. This neutral
          // completion is not a business-success or notification-delivery claim.
          content = 'Synthetic reminder received; no handling report made.';
        } else {
          assert.ok(plan && !plan.finished, `Unexpected foreground wake ${lastUser}`);
          if (!plan.started) {
            assert.ok(lastUser.includes(JSON.stringify(plan.trigger).slice(1, -1)),
              'A delayed automatic reminder cannot execute the next explicit restart plan');
            plan.started = true;
          }
          if (plan.index) {
            const previous = plan.steps[plan.index - 1], result = toolResult(input, previous.toolCallId);
            evidence.calls.push({ plan: plan.name, raw: previous.raw, args: previous.actualArgs, ...result });
            assert.ok(previous.allowError || !result.isError, JSON.stringify(result.value));
            await previous.check(result.value, result.isError);
          }
          if (plan.index < plan.steps.length) {
            const next = plan.steps[plan.index++];
            raw = next.raw;
            args = typeof next.args === 'function' ? await next.args() : next.args;
            next.actualArgs = structuredClone(args);
            next.toolCallId = `restart-${requestNumber}`;
          } else {
            plan.finished = true;
            content = `Synthetic foreground ${plan.name}`;
          }
        }
        if (!source) {
          const actual = [...names].sort();
          evidence.foregroundTools ??= actual;
          assert.deepEqual(actual, evidence.foregroundTools,
            'The exact offered foreground tool names remain unchanged across complete Host restart');
        }
        const name = raw && names.find(offered => offered === raw || offered.endsWith(`-${raw}`) || offered.endsWith(`_${raw}`));
        assert.ok(!raw || name, `Tool was not genuinely offered: ${raw}`);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const delta = { role: 'assistant', content, ...(name ? { tool_calls: [{ index: 0,
          id: `restart-${requestNumber}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : {}) };
        for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason: name ? 'tool_calls' : 'stop' }])
          response.write(`data: ${JSON.stringify({ id: `restart-${requestNumber}`, object: 'chat.completion.chunk',
            created: 1, model: 'gpt-4.1', choices: [{ index: 0, ...choice }] })}\n\n`);
        response.end('data: [DONE]\n\n');
      } catch (error) {
        failures.push(error);
        response.writeHead(500);
        response.end('Synthetic restart provider assertion failed');
      }
    });
    await new Promise(done => provider.listen(0, '127.0.0.1', done));
    evidence.providerPort = provider.address().port;
    await startHost(legacyRoot ?? hostRoot, legacyRoot ?? serverRoot, join(root, pack.filename));
    foregroundId = (await api('session/new', { cwd: dirs.work,
      roles: [{ moduleId: 'assistant', roleId: 'coordinator' }], toolScope: scope })).sessionId;
    await idle(foregroundId);
    await api('session/tools-initialize', { sessionId: foregroundId });
    assert.deepEqual((await api('session/tool-scope', { sessionId: foregroundId })).configured, scope);
    await front('setup', [
      step('cockpit_new_session', { cwd: dirs.work, tool_scope: { builtins: [], mcpServers: [] } }, value => {
        sourceId = /Created session ([0-9a-f-]{36})/.exec(String(value))?.[1];
        assert.ok(sourceId);
      }),
      step('assistant_topic', () => ({ title: 'Process restart source', sessionId: sourceId })),
      step('assistant_topics', {}, value => assert.ok(value.items.some(item => item.sessionId === sourceId))),
      step('assistant_foreground', {}, value => assert.equal(value.foregroundSessionId, foregroundId)),
    ]);
    replies.set('baseline', 'Synthetic restart baseline 中文🙂');
    await front('baseline-send', [sendSource('baseline')]);
    const baseline = range(null, [replies.get('baseline')]);
    await front('baseline-read', [inboxStep(baseline), readRange(baseline), recordPosition(baseline, true), resolveStep(baseline)]);
    assert.equal(baseline.savedCheckpoint.position.hostCheckpoint.startsWith('ct2.'), !legacyRoot,
      'Use genuine positions emitted by the explicitly selected release');
    const expected = [];
    for (const phase of ['before', 'after']) {
      if (phase === 'after') await restart();
      const labels = Array.from({ length: 4 }, (_, index) => `${phase}-${index}`);
      for (const label of labels) {
        replies.set(label, `Synthetic restart ${label} 中文🙂`);
        expected.push(`RESTART_SOURCE:${label}`, replies.get(label));
      }
      await front(`${phase}-restart-updates`, [
        step('cockpit_reload_session', () => ({ session_id: sourceId })), ...labels.map(sendSource),
      ]);
    }
    await api('session/unload', { sessionId: sourceId });
    const updates = range(baseline.savedCheckpoint, expected);
    replies.set('later', 'Synthetic concurrent arrival after old read');
    await front('cross-process-unread-range', [
      inboxStep(updates), readRange(updates), recordPosition(updates, true),
      step('cockpit_get_session', () => ({ session_id: sourceId, response_format: 'json' }),
        value => assert.equal(value.loaded, false, 'Passive persisted multipage reads never load the source')),
      sendSource('later'), resolveStep(updates),
      step('assistant_inbox', {}, value => {
        assert.ok(value.items.length, 'Old exact receipt resolution preserves concurrent arrivals');
        assert.ok(value.items.every(item => !updates.inbox.receipt.inboxIds.includes(item.id)));
      }),
    ]);
    assert.ok(updates.pages > 1);
    assert.ok(updates.savedCheckpoint.position.hostCheckpoint.startsWith('ct2.'));
    evidence.checks.push('complete Host OS restart; saved Assistant checkpoint; pre/post multipage updates; old ack/new arrival');
    const later = range(updates.savedCheckpoint, [replies.get('later')]);
    await front('later-read', [inboxStep(later), readRange(later), recordPosition(later, true), resolveStep(later)]);
    replies.set('giant', `Synthetic giant ${'中文🙂'.repeat(2500)}`);
    await front('giant-send', [sendSource('giant')]);
    await api('session/unload', { sessionId: sourceId });
    const giant = range(later.savedCheckpoint, [replies.get('giant')]);
    await front('giant-partial', [inboxStep(giant), readRange(giant, true), recordPosition(giant, false)]);
    assert.ok(giant.incomplete.size);
    if (options.changePartialPage) {
      replies.set('partial-arrival', 'Synthetic arrival changing the interrupted native page');
      giant.expected.push(replies.get('partial-arrival'));
      await front('change-partial-page', [sendSource('partial-arrival')]);
      await api('session/unload', { sessionId: sourceId });
    }
    await restart();
    await front('giant-recover', [
      step('assistant_inbox', {}, value => {
        pointerOnly(value);
        const receipt = value.receipt.id === giant.inbox.receipt.id ? value.receipt
          : value.pendingDecisions.items.find(item => item.id === giant.inbox.receipt.id);
        assert.ok(receipt, 'Recover the original partial receipt even when a new arrival changed the current inbox range');
        assert.deepEqual(receipt.sources, giant.inbox.receipt.sources);
        const progress = receipt.progress.find(item => item.sessionId === sourceId);
        assert.deepEqual(progress, giant.savedProgress, 'Actual SQLite progress survives complete Host process exit');
        assert.equal(progress.complete, false);
        assert.deepEqual(progress.readIds, []);
        giant.query = { ...progress.position.nextQuery };
      }),
      readRange(giant), recordPosition(giant, true), resolveStep(giant),
      step('cockpit_get_session', () => ({ session_id: sourceId, response_format: 'json' }),
        value => assert.equal(value.loaded, false, 'Passive persisted continuation never loads the source')),
    ]);
    assert.ok(giant.fragments > 1);
    if (options.changePartialPage) assert.ok(evidence.recoveries.some(item =>
      chatTextFailureCode(item.error) === 'TEXT_PAGE_CHANGED'), 'This variant must actually exercise changed-page recovery');
    if (options.changePartialPage) {
      let arrivalInbox;
      await front('partial-arrival-report', [
        step('assistant_inbox', {}, value => {
          pointerOnly(value);
          arrivalInbox = value;
          assert.ok(value.items.every(item => item.source?.eventId && giant.seen.has(item.source.eventId)),
            'The replay actually delivered every additional pointer before its separate handling report');
          assert.deepEqual(value.receipt.sources.find(item => item.sessionId === sourceId).checkpoint, giant.savedCheckpoint);
        }),
        step('assistant_checkpoint', () => ({ receiptId: arrivalInbox.receipt.id, sessionId: sourceId,
          readIds: arrivalInbox.items.map(item => item.id), complete: true,
          expectedCheckpointVersion: giant.savedCheckpoint.version, position: giant.savedCheckpoint.position }), value => {
          assert.notEqual(value.checkpointState, 'not-advanced');
          assert.equal(value.checkpoint.position.hostCheckpoint, giant.savedCheckpoint.position.hostCheckpoint);
          giant.savedCheckpoint = value.checkpoint;
        }),
        step('assistant_resolve', () => ({ receiptId: arrivalInbox.receipt.id, disposition: 'silent' }),
          value => assert.deepEqual(value.inboxIds, arrivalInbox.receipt.inboxIds)),
      ]);
    }
    evidence.ranges = { updates: { pages: updates.pages, expectedMessages: updates.expected.length },
      giant: { pages: giant.pages, fragments: giant.fragments, replay: giant.replay } };
    evidence.checks.push(`persisted partial progress and unread Inbox; unloaded source; Unicode continuation; ${evidence.recoveries.length} explicit recovery replay(s)`);
    replies.set('gap', 'Synthetic pending pointer must survive a genuine history gap');
    await front('gap-send', [sendSource('gap')]);
    const gap = range(giant.savedCheckpoint, []);
    await front('gap-receipt', [inboxStep(gap)]);
    const baselineUser = evidence.events.find(row => row.sessionId === sourceId && row.event.type === 'user.message'
      && row.event.data.content === 'RESTART_SOURCE:baseline');
    assert.ok(baselineUser?.event.id, 'Use an actual observed native user message, not a constructed seek UUID');
    const rewind = await api('session/rewind', { sessionId: sourceId, toMsgId: baselineUser.event.id, rollbackFiles: false });
    assert.equal(rewind.result.outcome, 'success', JSON.stringify(rewind));
    assert.ok(rewind.result.eventsRemoved > 0);
    await front('real-history-gap', [
      step('cockpit_read_session_text', () => ({ session_id: sourceId, ...gap.query }), (value, isError) => {
        assert.equal(isError, true, 'Deleted checkpoint anchor must not produce a success-shaped empty range');
        assert.ok(['TEXT_CHECKPOINT_MISSING', 'TEXT_CHECKPOINT_CHANGED'].includes(chatTextFailureCode(value)),
          'Only a genuine missing/changed checkpoint anchor establishes this history-gap case');
        gap.error = typeof value === 'string' ? value : JSON.stringify(value);
        assert.ok(gap.error.length);
      }, true),
      step('assistant_checkpoint', () => ({ receiptId: gap.inbox.receipt.id, sessionId: sourceId,
        readIds: [], complete: false, gap: gap.error.slice(0, 1000),
        position: { query: gap.query, nextQuery: null, boundaryEventId: null, coverage: 'since-checkpoint' } }), value => {
        assert.equal(value.checkpointState, 'not-advanced');
        assert.equal(value.checkpoint.position.hostCheckpoint, giant.savedCheckpoint.position.hostCheckpoint);
      }),
      step('assistant_resolve', () => ({ receiptId: gap.inbox.receipt.id, disposition: 'silent' }),
        (value, isError) => {
          assert.equal(isError, true, 'A genuine gap cannot acknowledge unread pointers');
          assert.equal(value.error.code, 'READ_INCOMPLETE');
        }, true),
      step('assistant_inbox', {}, value => {
        assert.deepEqual(value.receipt.inboxIds, gap.inbox.receipt.inboxIds);
        assert.equal(value.receipt.disposition, 'unresolved');
      }),
    ]);
    evidence.checks.push('real public rewind produces explicit history gap; no baseline reset, checkpoint advance or unread acknowledgement');
    if (legacyRoot) evidence.checks.push('original legacy artifact token submitted opaque across Host upgrade; native history revalidated');
    await wait('automatic recent-cache persisted raw Chat read',
      () => evidence.moduleIntents.some(item => item.name === 'session/chat'));
    assert.ok(evidence.moduleIntents.some(item => item.name === 'session/directory'));
    assert.ok(evidence.calls.some(item => item.raw === 'cockpit_read_session_text'),
      'Context and restart fragments still come from direct native-agent Host Chat text reads');
    assert.ok(evidence.moduleIntents.some(item => item.name === 'prompt'),
      'Role-derived automatic reminders remain enabled while unread ranges survive restart');
    assert.deepEqual(failures, []);
    await stopHost();
    for (const { name, body } of evidence.moduleIntents) assertPassiveModuleRead(name, body);
    assert.deepEqual(failures, []);
    clean = true;
    console.log(`PASS restart: ${evidence.hosts.length} exited Host OS processes; ${requestCount} provider requests; ${evidence.calls.length} actual MCP calls.`);
    console.log(`Coverage: ${evidence.checks.join('; ')}.`);
    console.log(`Legacy artifact coverage: ${legacyRoot ? 'included' : 'NOT RUN (supply --legacy-host with the verified old artifact)'}.`);
    console.log('Synthetic provider decisions only; no natural-language or user notification delivery claim.');
  } catch (error) {
    failures.push(error);
    throw error;
  } finally {
    try { await stopHost(); } finally {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      clearTimeout(interruptDeadline);
      if (provider) {
        provider.closeAllConnections();
        await new Promise(done => provider.close(done));
      }
      evidence.failures = failures.map(error => error.stack ?? String(error));
      evidence.foregroundId = foregroundId;
      evidence.sourceId = sourceId;
      evidence.requestCount = requestCount;
      if (!clean || options.keepEvidence) {
        await writeFile(join(root, 'fixture-evidence.json'), JSON.stringify(evidence, null, 2));
        console.log(`Synthetic restart evidence retained at ${root}`);
      } else {
        const writable = async path => {
          await chmod(path, 0o700);
          for (const entry of await readdir(path, { withFileTypes: true }))
            if (entry.isDirectory()) await writable(join(path, entry.name));
        };
        await writable(root);
        await rm(root, { recursive: true });
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), legacyIndex = args.indexOf('--legacy-host');
  if (legacyIndex >= 0) assert.ok(args[legacyIndex + 1] && !args[legacyIndex + 1].startsWith('--'),
    '--legacy-host requires the verified old artifact directory; legacy tokens are never fabricated');
  await runNativeRestartCheck({ hostRoot: args[0], serverRoot: args[1]?.startsWith('--') ? args[0] : args[1],
    legacyRoot: legacyIndex < 0 ? undefined : args[legacyIndex + 1], keepEvidence: args.includes('--keep-evidence'),
    changePartialPage: args.includes('--change-partial-page') });
}
