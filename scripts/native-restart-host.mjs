import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ownedProcesses, terminateProcesses } from './native-restart-processes.mjs';

// This is the entire Host process, not a restart of the native SDK child or reader.
// Only public Host imports, intents and native observations cross this boundary.
assert.ok(process.send, 'Run this fixture child through native-restart-check.mjs');
let engine, app, moduleHost, stopping = false, initialization = Promise.resolve();
const sessions = new Set();
const send = message => {
  if (process.connected) process.send(message, () => {});
};
async function stop() {
  if (stopping) return;
  stopping = true;
  const owned = ownedProcesses(process.pid);
  const deadline = setTimeout(() => {
    terminateProcesses([...owned, ...ownedProcesses(process.pid)]);
    process.exit(1);
  }, 15000);
  try {
    await initialization;
    await moduleHost?.stop();
    if (engine) {
      await Promise.allSettled([...sessions].map(id => engine.cancel(id)));
      const settledBy = Date.now() + 8000;
      while (Date.now() < settledBy) {
        const states = await Promise.all([...sessions].map(id => engine.getMeta(id)));
        if (states.every(meta => !meta?.loaded || meta.activity
          && !meta.activity.processing && !meta.activity.hasActiveWork)) break;
        await new Promise(done => setTimeout(done, 40));
      }
    }
    await engine?.stop();
    await app?.close();
    await new Promise(done => {
      if (process.connected) process.send({ type: 'stopped', pid: process.pid }, () => done());
      else done();
    });
  } catch (error) {
    send({ type: 'failure', error: error.stack ?? String(error) });
    process.exitCode = 1;
    terminateProcesses([...owned, ...ownedProcesses(process.pid)]);
  } finally {
    clearTimeout(deadline);
    if (process.connected) process.disconnect();
    process.exit(process.exitCode ?? 0);
  }
}

process.on('message', message => {
  if (message.type === 'stop') void stop();
});
process.once('message', configuration => { initialization = (async () => {
  try {
    const { hostRoot, serverRoot, dirs, providerUrl, moduleArchive, hostTools } = configuration;
    const reservation = createServer();
    await new Promise(done => reservation.listen(0, '127.0.0.1', done));
    const port = reservation.address().port;
    await new Promise(done => reservation.close(done));
    const origin = `http://127.0.0.1:${port}`;
    process.env.COCKPIT_PORT = String(port);
    process.env.COCKPIT_URL = origin;
    await writeFile(join(dirs.copilot, 'mcp-config.json'), JSON.stringify({ mcpServers: {
      cockpit: { type: 'local', command: process.execPath,
        args: [join(serverRoot, 'apps/mcp/dist/index.js')], tools: hostTools, env: { ...process.env } },
    } }));
    const { Engine, OfficialRuntime } = await import(pathToFileURL(join(hostRoot, 'packages/core/dist/index.js')));
    assert.equal(typeof Engine.prototype.chatText, 'function', 'Select a real Host with public lightweight Chat');
    assert.equal(typeof Engine.prototype.getSessionToolScope, 'function');
    const transport = await import(pathToFileURL(join(serverRoot, 'apps/server/dist/index.js')));
    const { ModuleHost } = await import(pathToFileURL(join(serverRoot, 'apps/server/dist/module-host.js')));
    if (moduleArchive) {
      const { installLocalModule } = await import(pathToFileURL(join(serverRoot, 'apps/server/dist/module-install.js')));
      await installLocalModule(moduleArchive, { trustLocalCode: true, enable: true, hostRoot: dirs.cockpit });
    }
    const runtime = new OfficialRuntime({
      clientOptions: { baseDirectory: dirs.copilot, workingDirectory: dirs.work, builtinPluginDirectories: [],
        useLoggedInUser: false, enableRemoteSessions: false, logLevel: 'error',
        onListModels: () => [{ id: 'gpt-4.1', name: 'Synthetic local model',
          capabilities: { supports: { vision: false, reasoningEffort: false },
            limits: { max_context_window_tokens: 128000 } } }] },
      sessionConfig: {
        provider: { type: 'openai', wireApi: 'completions', baseUrl: providerUrl, modelId: 'gpt-4.1' },
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
        send({ type: 'module-intent', name, body });
        assert.ok(!['session/chat/text', 'session/new', 'respondAsk'].includes(name),
          'Assistant must not proxy full text reads, create business sessions or proxy answers');
        if (name === 'session/chat') {
          assert.equal(body.source, 'persisted');
          assert.equal(body.direction, 'backward');
          assert.ok(body.max > 0 && body.max <= 16, 'Recent-cache reads are bounded passive native pages');
        }
        return transport.callModuleIntent(name, body);
      } },
      report: (_id, error) => send({ type: ['SESSION_TRANSITION', 'FOREGROUND_CHANGED'].includes(error.code) ? 'diagnostic' : 'failure',
        error: error.stack ?? error.error ?? String(error) }),
    });
    transport.setTestDependencies({ engine, moduleHost });
    await moduleHost.register(app);
    assert.deepEqual(moduleHost.bootstrap().errors, []);
    assert.equal(moduleHost.bootstrap().active.length, 1);
    engine.setRoleProvider(moduleHost.roles);
    engine.onNativeEvent(row => { sessions.add(row.sessionId); send({ type: 'native-event', row }); });
    process.chdir(dirs.work);
    await engine.start();
    await app.listen({ host: '127.0.0.1', port });
    moduleHost.ready();
    if (stopping) return;
    send({ type: 'ready', pid: process.pid, origin, hostRoot, serverRoot,
      // This reads fixture-owned configuration only, never native session storage.
      configuration: JSON.parse(await readFile(join(dirs.copilot, 'mcp-config.json'), 'utf8')) });
  } catch (error) {
    send({ type: 'failure', error: error.stack ?? String(error) });
    process.exitCode = 1;
    void stop();
  }
})(); });
process.once('disconnect', () => void stop());
process.once('SIGTERM', () => { process.exitCode = 1; void stop(); });
process.once('SIGINT', () => { process.exitCode = 1; void stop(); });
