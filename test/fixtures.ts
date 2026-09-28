import type { McpInvocationMeta, ModuleHostApi, ModuleHostIntent, ModuleHostIntentBody, ModuleHostIntentResult, PublicSessionMeta } from '@waksana/cockpit-module-sdk/backend';
import { Database } from '../src/database.ts';
import { AssistantService } from '../src/service.ts';
import { Runtime } from '../src/runtime.ts';
import type { HistoryPage, NativeAccess } from '../src/runtime.ts';
import type { Role } from '../src/types.ts';

export function fixture() {
  const db = new Database(':memory:');
  let now = 1_000_000;
  const service = new AssistantService(db, () => now);
  const identities: Record<Role, McpInvocationMeta> = {
    coordinator: { sessionId: 'coordinator', runtimeSessionId: 'coordinator', subagent: false },
    memory: { sessionId: 'memory', runtimeSessionId: 'memory', subagent: false },
  };
  db.transaction(() => {
    for (const role of ['coordinator', 'memory'] as const) db.put('bindings', {
      id: role, sessionId: role, epoch: 1, definitionVersion: '1', modelId: 'synthetic',
      cwd: '/synthetic', ready: true, evidence: {},
    });
    for (const id of ['s1', 's2']) db.put('receptions', {
      id, label: id, kind: 'reception', enabled: true, evidence: 'Explicit synthetic enrollment',
      availability: 'loaded', cursor: '', cursorSource: 'live', cursorDirection: 'forward',
      baseline: true, gap: null, generation: 1, version: 1,
    });
  });
  const metas = new Map<string, PublicSessionMeta>();
  for (const id of ['s1', 's2', 'coordinator', 'memory']) metas.set(id, {
    sessionId: id, cwd: '/synthetic', title: id, loaded: true, status: 'idle',
    ask: null, lastActivity: 0, currentModelId: 'synthetic',
    ...(id === 'coordinator' || id === 'memory' ? {
      roles: [{ moduleId: 'assistant', roleId: id, moduleName: 'Assistant', name: id }],
      appliedRoles: [{ moduleId: 'assistant', roleId: id, moduleName: 'Assistant', name: id }],
    } : {}),
  });
  const calls: { name: string; body: unknown }[] = [];
  let failure: Error | null = null;
  let onPrompt: (() => Promise<void>) | null = null;
  const host: ModuleHostApi = {
    resourcePreparationVersion: 1,
    askResponseVersion: 1,
    chatReadVersion: 1,
    roleAssignmentVersion: 1,
    sessionDirectoryVersion: 1,
    sessionLoadVersion: 1,
    async call<Name extends ModuleHostIntent>(name: Name, body: ModuleHostIntentBody<Name>): Promise<ModuleHostIntentResult<Name>> {
      calls.push({ name, body });
      const sessionId = 'sessionId' in body ? body.sessionId : '';
      let result: unknown;
      switch (name) {
        case 'session/directory': result = { sessions: [...metas.values()] }; break;
        case 'session/load': {
          if (failure) throw failure;
          const meta = metas.get(sessionId);
          if (!meta) throw new Error('Synthetic session does not exist');
          meta.loaded = true;
          result = { sessionId, ok: true };
          break;
        }
        case 'session/get': result = { meta: metas.get(sessionId) ?? null }; break;
        case 'roles/readiness': result = {
          sessionId, ready: true, loaded: true, reasons: [], rolesNeedReload: false,
          roles: [{ moduleId: 'assistant', roleId: sessionId, moduleName: 'Assistant', name: sessionId }],
          appliedRoles: metas.get(sessionId)?.appliedRoles
            ?? [{ moduleId: 'assistant', roleId: sessionId, moduleName: 'Assistant', name: sessionId }],
        }; break;
        case 'session/resources-prepare': result = { sessionId, ok: true, tools: 'initialized', skills: [],
          mcpServers: [{ name: 'assistant', effect: 'unchanged', enabled: true, status: 'connected',
            tools: ['assistant_read', 'assistant_claim', 'assistant_decide', 'assistant_remember', 'assistant_create_session'] }] }; break;
        case 'session/new':
          if (failure) throw failure;
          result = { sessionId: 'new-synthetic' }; break;
        case 'prompt':
          if (onPrompt) await onPrompt();
          if (failure) throw failure;
          result = { ok: true, queued: true }; break;
        case 'session/rename': result = { ok: true }; break;
        case 'respondAsk':
          if (failure) throw failure;
          result = { ok: true }; break;
        case 'session/chat': {
          const page = pages.shift() ?? { events: [], cursor: '', liveCursor: '', cursorStatus: 'ok', hasMore: false };
          result = { ...page, sessionId, source: 'live', direction: 'direction' in body ? body.direction : 'forward',
            read: { rpc: 1, events: page.events.length } };
          break;
        }
        default: throw new Error(`Unexpected synthetic host call: ${name}`);
      }
      return result as ModuleHostIntentResult<Name>;
    },
  };
  const pages: HistoryPage[] = [];
  const native: NativeAccess = {
    host,
    async read(sessionId, cursor, bootstrap) {
      calls.push({ name: 'chat', body: { sessionId, cursor, bootstrap } });
      return pages.shift() ?? { events: [], cursor: cursor ?? '', liveCursor: '', cursorStatus: 'ok', hasMore: false };
    },
    async answer(sessionId, requestId, answer, wasFreeform) {
      calls.push({ name: 'answer', body: { sessionId, requestId, answer, wasFreeform } });
      if (failure) throw failure;
      return { accepted: true, result: { ok: true } };
    },
  };
  const errors: unknown[] = [];
  const runtime = new Runtime(service, native, error => errors.push(error), () => {});
  return { db, service, runtime, native, identities, metas, calls, pages, errors,
    advance(ms: number) { now += ms; },
    fail(error: Error | null) { failure = error; },
    onPrompt(fn: (() => Promise<void>) | null) { onPrompt = fn; },
    close() { runtime.stop(); db.close(); },
  };
}

export function proof(work: NonNullable<ReturnType<AssistantService['claim']>>, requestId = `decide:${work.id}`) {
  return { requestId, workId: work.id, epoch: work.epoch!, token: work.token!,
    inputVersion: work.inputVersion, stateVersion: work.stateVersion };
}
