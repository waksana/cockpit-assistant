import { join } from 'node:path';
import type { ModuleBackend, ModuleBackendContext, ModuleRoute } from '@waksana/cockpit-module-sdk/backend';
import { Assistant, configInput } from './core.ts';
import { acquireLease } from './lease.ts';
import { requireFact } from './errors.ts';
import { mcp, coordinatorTools } from './mcp.ts';
import { NativeChat } from './native-chat.ts';
import { Store } from './store.ts';

export async function activate(context: ModuleBackendContext): Promise<ModuleBackend> {
  const host = context.host;
  requireFact(context.shutdownVersion === 1 && context.serviceReadyVersion === 1 && host.chatReadVersion === 1 && host.askResponseVersion === 1
    && host.roleAssignmentVersion === 1 && host.roleAvailabilityVersion === 1 && host.sessionLoadVersion === 1
    && host.promptReceiptVersion === 1 && host.toolScopeVersion === 1
    && host.promptOriginVersion === 1 && host.roleResourcePolicyVersion === 1,
  'HOST_CAPABILITY', 'Native Chat Assistant needs safe shutdown, prompt-origin observations, Host role compatibility and exclusive role resources');
  requireFact(!context.stopping.aborted && !context.signal.aborted, 'STOPPING', 'Assistant is stopping', 503);
  const config = configInput.parse(context.config), release = await acquireLease(context.dataRoot);
  if (context.stopping.aborted || context.signal.aborted) { release(); requireFact(false, 'STOPPING', 'Assistant is stopping', 503); }
  let store: Store;
  try { store = new Store(join(context.dataRoot, 'assistant.sqlite')); }
  catch (error) { release(); throw error; }
  const native = new NativeChat(host, store, config.foregroundSessionId, coordinatorTools);
  const assistant = new Assistant(store, native, config, error => context.report(error));
  let ready = false, stopped = false, disposed = false;
  const operations = new Set<Promise<unknown>>();
  function track<T>(run: () => T | Promise<T>): Promise<T> {
    requireFact(!stopped, 'STOPPING', 'Assistant is stopping', 503);
    const operation = Promise.resolve().then(() => {
      requireFact(!stopped, 'STOPPING', 'Assistant is stopping', 503);
      return run();
    });
    operations.add(operation);
    void operation.then(() => operations.delete(operation), () => operations.delete(operation));
    return operation;
  }
  const stop = () => {
    if (stopped) return;
    stopped = true; ready = false; assistant.stop(); native.close();
  };
  context.stopping.addEventListener('abort', stop, { once: true });
  context.signal.addEventListener('abort', stop, { once: true });
  const drain = async () => {
    stop();
    const results = await Promise.allSettled([...operations]);
    for (const result of results) if (result.status === 'rejected') context.report(result.reason);
  };
  const retired: ModuleRoute[] = (['GET', 'POST', 'PATCH'] as const).flatMap(method =>
    ['/:retired', '/:retired/*'].map(path => ({
    method, path, handler: () => ({ status: 410, body: {
      error: { code: 'NATIVE_CHAT_REQUIRED', message: 'Use native session Chat. The Assistant page and mirrored message protocol are retired.' },
      protocolVersion: 5, chat: '/intent/session/chat', input: '/intent/prompt',
    } }),
  })));
  const backend: ModuleBackend = {
    publicConfig: { protocolVersion: 5, conversation: 'native-session-chat', inbox: 'consume-on-read', frontend: false },
    routes: [
      mcp(assistant),
      { method: 'GET' as const, path: '/state', async handler() {
        const meta = await native.foreground();
        return { body: { protocolVersion: 5, conversation: 'native-session-chat', inbox: 'consume-on-read',
          foregroundSessionId: meta?.sessionId ?? null, foregroundWake: store.foregroundWake(), schemaVersion: 5 } };
      } },
      ...retired,
    ].map(route => ({ ...route, handler(request: Parameters<ModuleRoute['handler']>[0]) {
      requireFact(ready, 'NOT_READY', 'Assistant is not ready', 503);
      return track(() => route.handler(request));
    } })),
    async promptAccepted(event: Parameters<NativeChat['accepted']>[0]) {
      if (ready) await track(() => native.accepted(event));
    },
    async onReady() {
      if (stopped) return;
      store.recover(); ready = true;
      await track(() => assistant.notify());
    },
    events: { types: ['user.message', 'assistant.message', 'session.idle', 'session.error', 'abort'],
      handle(observation: Parameters<NonNullable<ModuleBackend['events']>['handle']>[0]) {
      if (ready) return track(() => assistant.observe(observation.sessionId, observation.event));
    } },
    controlEvents: { types: ['session/patch', 'session/invalidated'] as ('session/patch' | 'session/invalidated')[],
      handle(event: Parameters<NonNullable<ModuleBackend['controlEvents']>['handle']>[0]) {
        if (ready && 'sessionId' in event) return track(async () => {
          await assistant.observe(event.sessionId); await assistant.notify();
        });
      } },
    onStop: drain,
    async dispose() {
      await drain();
      if (disposed) return;
      disposed = true;
      context.stopping.removeEventListener('abort', stop); context.signal.removeEventListener('abort', stop);
      try { store.close(); } finally { release(); }
    },
  };
  return backend;
}
