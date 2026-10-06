import { join } from 'node:path';
import type { ModuleBackend, ModuleBackendContext, ModuleRoute } from '@waksana/cockpit-module-sdk/backend';
import { Assistant, configInput } from './core.ts';
import { acquireLease } from './lease.ts';
import { requireFact } from './errors.ts';
import { mcp } from './mcp.ts';
import { NativeChat } from './native-chat.ts';
import { RecentSessions } from './recent.ts';
import { RecentStore } from './recent-store.ts';
import { Store } from './store.ts';

export async function activate(context: ModuleBackendContext): Promise<ModuleBackend> {
  const host = context.host;
  requireFact(context.shutdownVersion === 1 && context.serviceReadyVersion === 1
    && host.sessionLoadVersion === 1 && host.promptReceiptVersion === 1
    && host.roleAssignmentVersion === 1 && host.roleAvailabilityVersion === 1
    && host.sessionDirectoryVersion === 1 && host.chatReadVersion === 1,
  'HOST_CAPABILITY', 'Assistant needs safe shutdown, role assignment/availability, session directory, Chat reads, exact load and prompt receipts');
  requireFact(!context.stopping.aborted && !context.signal.aborted, 'STOPPING', 'Assistant is stopping', 503);
  const config = configInput.parse(context.config), release = await acquireLease(context.dataRoot);
  if (context.stopping.aborted || context.signal.aborted) { release(); requireFact(false, 'STOPPING', 'Assistant is stopping', 503); }
  let store: Store;
  try { store = new Store(join(context.dataRoot, 'assistant.sqlite')); }
  catch (error) { release(); throw error; }
  let recentStore: RecentStore;
  try { recentStore = new RecentStore(join(context.dataRoot, 'recent.sqlite')); }
  catch (error) { store.close(); release(); throw error; }
  const recent = new RecentSessions(host, recentStore, { onError: error => context.report(error) });
  const native = new NativeChat(host, store, config.foregroundSessionId);
  const assistant = new Assistant(store, native, config, error => context.report(error), recent);
  let ready = false, stopped = false, disposed = false;
  let recentStopped: Promise<void> | undefined;
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
    recentStopped = recent.stop();
  };
  context.stopping.addEventListener('abort', stop, { once: true });
  context.signal.addEventListener('abort', stop, { once: true });
  const drain = async () => {
    stop();
    const results = await Promise.allSettled([...operations, recentStopped]);
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
    publicConfig: { protocolVersion: 5, conversation: 'native-session-chat', inbox: 'locations-and-handling', frontend: false },
    routes: [
      mcp(assistant),
      { method: 'GET' as const, path: '/state', async handler() {
        return { body: { protocolVersion: 5, conversation: 'native-session-chat', inbox: 'locations-and-handling',
          health: await assistant.health(), schemaVersion: 5, recent: recent.health() } };
      } },
      ...retired,
    ].map(route => ({ ...route, handler(request: Parameters<ModuleRoute['handler']>[0]) {
      requireFact(ready, 'NOT_READY', 'Assistant is not ready', 503);
      return track(() => route.handler(request));
    } })),
    roleAssignments: {
      availability: (selection, signal) => track(() => native.availability(selection, signal)),
      permit: (assignment, signal) => track(() => native.permit(assignment, signal)),
      saved: (notification, signal) => native.saved(notification, signal),
    },
    async onReady() {
      if (stopped) return;
      store.recover(); ready = true; recent.start();
      await track(() => assistant.notify());
    },
    events: { types: ['user.message', 'assistant.message', 'session.idle', 'session.error', 'abort'],
      handle(observation: Parameters<NonNullable<ModuleBackend['events']>['handle']>[0]) {
      if (ready) {
        const event = observation.event;
        if (!event.agentId && !event.parentToolCallId && !event.data.agentId && !event.data.parentToolCallId
          && (!event.ephemeral || !['user.message', 'assistant.message'].includes(event.type)))
          recent.invalidate(observation.sessionId, 'dirty');
        return track(async () => {
          await assistant.observe(observation.sessionId, observation.event);
          if (!store.managed(observation.sessionId)) await assistant.notify();
        });
      }
    } },
    controlEvents: { types: ['session/patch', 'session/invalidated', 'session/added', 'session/removed', 'chat/invalidated'],
      handle(event: Parameters<NonNullable<ModuleBackend['controlEvents']>['handle']>[0]) {
        const sessionId = event.type === 'session/added' ? event.session.sessionId : 'sessionId' in event ? event.sessionId : null;
        if (ready && sessionId) {
          const ownerChanged = event.type === 'session/patch'
            ? event.roles !== undefined || event.appliedRoles !== undefined || event.rolesNeedReload !== undefined
            : event.type === 'session/added' || event.type === 'session/removed'
              || event.type === 'session/invalidated' && (!event.resources || event.resources.includes('identity')
                || event.resources.includes('instructions'));
          if (ownerChanged) native.invalidateForeground();
          // Cache reads themselves can change native activity; only content/identity changes dirty the cache.
          const cacheChanged = event.type === 'session/patch'
            ? event.title !== undefined || event.cwd !== undefined || event.lastActivity !== undefined
            : event.type !== 'session/invalidated' || !event.resources || event.resources.includes('identity');
          if (cacheChanged) recent.invalidate(sessionId, event.type === 'session/removed' ? 'delete'
            : event.type === 'chat/invalidated' ? 'reset' : 'dirty');
          const lifecycleChanged = event.type === 'session/patch'
            ? ownerChanged || cacheChanged || event.loaded !== undefined || event.status !== undefined
              || event.loading !== undefined || event.closing !== undefined || event.ask !== undefined
              || event.queue !== undefined
            : event.type !== 'session/invalidated' || !event.resources
              || event.resources.some(resource => ['identity', 'instructions', 'control', 'controls', 'queue'].includes(resource));
          // Failed reads also clear controls. Invalidate stale evidence without scheduling another read.
          if (!lifecycleChanged && event.type === 'session/patch'
            && (event.activity === null || event.controls !== undefined)) assistant.invalidateObservation(sessionId);
          if (lifecycleChanged) {
            if (!cacheChanged) recent.resumeDeferred(sessionId);
            return track(async () => {
              await assistant.observe(sessionId);
              if (!store.managed(sessionId)) await assistant.notify();
            });
          }
        }
      } },
    onStop: drain,
    async dispose() {
      await drain();
      if (disposed) return;
      disposed = true;
      context.stopping.removeEventListener('abort', stop); context.signal.removeEventListener('abort', stop);
      try { recentStore.close(); } finally {
        try { store.close(); } finally { release(); }
      }
    },
  };
  return backend;
}
