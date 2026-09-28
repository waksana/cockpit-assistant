import { join } from 'node:path';
import type { ModuleBackend, ModuleBackendContext } from '@waksana/cockpit-module-sdk/backend';
import { Database } from './database.ts';
import { AssistantService } from './service.ts';
import { Runtime } from './runtime.ts';
import { routes } from './http.ts';
import { acquireLease } from './lease.ts';
import { nativeAccess } from './native.ts';
import { requireFact } from './errors.ts';
import { nativeTypes } from './ingestion.ts';
import { configSchema } from './schema.ts';

export async function activate(context: ModuleBackendContext): Promise<ModuleBackend> {
  requireFact(context.serviceReadyVersion === 1, 'HOST_CAPABILITY', 'Assistant requires serviceReadyVersion 1');
  const native = nativeAccess(context.host);
  const config = configSchema.parse(context.config);
  requireFact(!context.signal.aborted, 'STOPPING', 'Host is stopping');
  const release = await acquireLease(context.dataRoot);
  let db: Database;
  try {
    requireFact(!context.signal.aborted, 'STOPPING', 'Host stopped during activation');
    db = new Database(join(context.dataRoot, 'assistant.sqlite'));
  } catch (error) { release(); throw error; }
  const service = new AssistantService(db);
  try {
    db.transaction(() => {
      if (!db.meta<boolean>('configured', false)) {
        db.setMeta('config', config);
        db.setMeta('configured', true);
      }
    });
  } catch (error) { db.close(); release(); throw error; }
  let notified = 0;
  const runtime = new Runtime(service, native, error => context.report(error), () => {
    const cursor = db.meta('publicationSequence', 0);
    if (cursor === notified) return;
    context.publish({ type: 'publications-available', cursor });
    notified = cursor;
  });
  let ready = false;
  let disposed = false;
  const inFlight = new Set<Promise<unknown>>();
  const track = <T>(action: () => Promise<T>): Promise<T> => {
    const pending = action();
    inFlight.add(pending);
    void pending.then(() => inFlight.delete(pending), () => inFlight.delete(pending));
    return pending;
  };
  const local = new AbortController();
  const stop = (): void => {
    if (disposed) return;
    disposed = true;
    ready = false;
    local.abort();
    runtime.stop();
    void Promise.allSettled([...inFlight, runtime.settled()]).then(() => {
      try { db.close(); } finally { release(); }
    }).catch(error => context.report(error));
  };
  context.signal.addEventListener('abort', stop, { once: true });
  const wake = (sessionId: string): void => {
    if (!ready || disposed || !db.get('receptions', sessionId)?.enabled) return;
    void runtime.wake(sessionId).catch(error => context.report(error));
  };
  return {
    routes: routes(service, runtime).map(route => ({
      ...route,
      async handler(request) {
        requireFact(ready && !disposed, 'NOT_READY', 'Assistant service is not ready', 503);
        return track(async () => route.handler({ ...request, signal: AbortSignal.any([request.signal, local.signal]) }));
      },
    })),
    publicConfig: { backendOnly: true, protocolVersion: 1 },
    async onReady() {
      if (disposed || context.signal.aborted) return;
      ready = true;
      await track(() => runtime.start());
    },
    events: { types: nativeTypes, handle: observation => wake(observation.sessionId) },
    controlEvents: {
      types: ['session/invalidated', 'session/removed', 'session/added', 'chat/invalidated', 'session/patch'],
      handle(event) {
        if (event.type === 'session/added') wake(event.session.sessionId);
        else if ('sessionId' in event) {
          if (event.type === 'session/patch') {
            const relevant = ['ask', 'decisions', 'loaded', 'status', 'closing', 'currentModelId', 'rolesNeedReload'];
            if (!relevant.some(key => key in event)) return;
          }
          if (event.type === 'session/invalidated' && event.resources?.every(r => !['control', 'controls'].includes(r))) return;
          wake(event.sessionId);
        }
      },
    },
    dispose() {
      context.signal.removeEventListener('abort', stop);
      stop();
    },
  };
}
