import type { McpInvocationMeta, ModuleHostApi, ModuleHostIntent, ModuleHostIntentBody, ModuleHostIntentResult, PublicSessionMeta } from '@waksana/cockpit-module-sdk/backend';
import { Database } from '../src/database.ts';
import { AssistantService } from '../src/service.ts';
import { Runtime } from '../src/runtime.ts';
import type { HistoryPage, NativeAccess } from '../src/runtime.ts';
import type { Delivery, Role, Topic } from '../src/types.ts';

export function fixture(path = ':memory:') {
  const db = new Database(path);
  let now = 1_000_000;
  const service = new AssistantService(db, () => now);
  const identities: Record<Role, McpInvocationMeta> = {
    coordinator: { sessionId: 'coordinator', runtimeSessionId: 'coordinator', subagent: false },
    memory: { sessionId: 'memory', runtimeSessionId: 'memory', subagent: false },
  };
  db.transaction(() => {
    for (const role of ['coordinator', 'memory'] as const) db.put('bindings', {
      id: role, sessionId: role, epoch: 1, definitionVersion: '2', modelId: 'synthetic',
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
    activity: { processing: false, hasActiveWork: false, abortable: false, sampledAt: now,
      queue: { pendingCount: 0, steeringCount: 0, inFlightSteeringCount: 0 },
      tasks: { activeAgents: 0, activeShells: 0, unknown: 0 }, mcp: { pendingConnectionCount: 0 } },
    ...(id === 'coordinator' || id === 'memory' ? {
      roles: [{ moduleId: 'assistant', roleId: id, moduleName: 'Assistant', name: id }],
      appliedRoles: [{ moduleId: 'assistant', roleId: id, moduleName: 'Assistant', name: id }],
    } : {}),
  });
  const calls: { name: string; body: unknown }[] = [];
  let failure: Error | null = null;
  let onPrompt: (() => Promise<void>) | null = null;
  let onLoad: ((sessionId: string) => Promise<void>) | null = null;
  let onGet: ((sessionId: string) => Promise<void>) | null = null;
  let onReadiness: ((sessionId: string) => Promise<void>) | null = null;
  let creations = 0;
  let prompts = 0;
  let promptResult: { ok: boolean; queued?: boolean; messageId?: string } | null = null;
  const host: ModuleHostApi & { promptReceiptVersion: 1 } = {
    promptReceiptVersion: 1,
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
          if (onLoad) await onLoad(sessionId);
          if (failure) throw failure;
          const meta = metas.get(sessionId);
          if (!meta) throw new Error('Synthetic session does not exist');
          meta.loaded = true;
          result = { sessionId, ok: true };
          break;
        }
        case 'session/get':
          if (onGet) await onGet(sessionId);
          result = { meta: metas.get(sessionId) ?? null }; break;
        case 'roles/readiness':
          if (onReadiness) await onReadiness(sessionId);
          result = {
          sessionId, ready: true, loaded: true, reasons: [], rolesNeedReload: false,
          roles: [{ moduleId: 'assistant', roleId: sessionId, moduleName: 'Assistant', name: sessionId }],
          appliedRoles: metas.get(sessionId)?.appliedRoles
            ?? [{ moduleId: 'assistant', roleId: sessionId, moduleName: 'Assistant', name: sessionId }],
        }; break;
        case 'session/resources-prepare': result = { sessionId, ok: true, tools: 'initialized', skills: [],
          mcpServers: [{ name: 'assistant', effect: 'unchanged', enabled: true, status: 'connected',
            tools: ['assistant_topics', 'assistant_topic', 'assistant_map', 'assistant_sessions',
              'assistant_history', 'assistant_dispatch', 'assistant_attribute', 'assistant_clarify',
              'assistant_memory_read', 'assistant_memory_claim', 'assistant_remember'] }] }; break;
        case 'session/new':
          if (failure) throw failure;
          result = { sessionId: `new-synthetic${creations++ ? `-${creations}` : ''}` };
          metas.set((result as { sessionId: string }).sessionId, {
            ...structuredClone(metas.get('s1')!), sessionId: (result as { sessionId: string }).sessionId,
            cwd: 'cwd' in body ? body.cwd! : '/synthetic', roles: [], appliedRoles: [],
          });
          break;
        case 'prompt':
          if (onPrompt) await onPrompt();
          if (failure) throw failure;
          result = promptResult ?? { ok: true, queued: false, messageId: `native-prompt-${++prompts}` };
          break;
        case 'session/rename': result = { ok: true }; break;
        case 'respondAsk':
          if (failure) throw failure;
          result = { ok: true }; break;
        case 'session/chat': {
          const page = ('types' in body && body.types?.length === 2 ? controlPages.get(sessionId)?.shift() : pages.shift())
            ?? { events: [], cursor: '', liveCursor: '', cursorStatus: 'ok', hasMore: false };
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
  const controlPages = new Map<string, HistoryPage[]>();
  const native: NativeAccess = {
    host,
    async read(sessionId, cursor, bootstrap, backward = false, all = false) {
      calls.push({ name: 'chat', body: { sessionId, cursor, bootstrap, ...(all ? { all } : {}), ...(backward ? { backward } : {}) } });
      return (all ? controlPages.get(sessionId)?.shift() : pages.shift())
        ?? { events: [], cursor: cursor ?? '', liveCursor: '', cursorStatus: 'ok', hasMore: false };
    },
    async answer(sessionId, requestId, answer, wasFreeform) {
      calls.push({ name: 'answer', body: { sessionId, requestId, answer, wasFreeform } });
      if (failure) throw failure;
      return { accepted: true, result: { ok: true } };
    },
  };
  const errors: unknown[] = [];
  const runtime = new Runtime(service, native, error => errors.push(error), () => {});
  return { db, service, runtime, native, identities, metas, calls, pages, controlPages, errors,
    advance(ms: number) { now += ms; },
    fail(error: Error | null) { failure = error; },
    promptResult(result: { ok: boolean; queued?: boolean; messageId?: string }) { promptResult = result; },
    onPrompt(fn: (() => Promise<void>) | null) { onPrompt = fn; },
    onReadiness(fn: ((sessionId: string) => Promise<void>) | null) { onReadiness = fn; },
    onLoad(fn: ((sessionId: string) => Promise<void>) | null) { onLoad = fn; },
    onGet(fn: ((sessionId: string) => Promise<void>) | null) { onGet = fn; },
    close() { runtime.stop(); db.close(); },
  };
}

export function proof(work: NonNullable<ReturnType<AssistantService['claim']>>, requestId = `decide:${work.id}`) {
  return { requestId, workId: work.id, epoch: work.epoch!, token: work.token!,
    inputVersion: work.inputVersion, stateVersion: work.stateVersion };
}

export function topic(f: ReturnType<typeof fixture>, id = 'topic', sessionId: string | null = 's1'): Topic {
  const value: Topic = { id, title: id, content: 'Synthetic topic', color: '#336699', sessionId,
    archived: false, version: 1, dirtyThrough: 0, memoryThrough: 0 };
  f.db.put('topics', value);
  return value;
}

let toolSequence = 0;
/** Synthetic native identity evidence, using the published receipt/tool-call contract. */
export function toolIdentity(f: ReturnType<typeof fixture>, role: Role = 'coordinator',
  toolCallId = `tool-${++toolSequence}`): McpInvocationMeta & { toolCallId: string } {
  const batch = f.service.activeBatch(role)!;
  const delivery = f.db.must('deliveries', `batch:${batch.id}`);
  const receipt = delivery.nativeMessageId!;
  const interactionId = `interaction:${receipt}`;
  const pages = f.controlPages.get(batch.sessionId) ?? [];
  pages.push({ cursor: `after:${toolCallId}`, cursorStatus: 'ok', hasMore: false, events: [
    { id: `root:${receipt}`, type: 'user.message', data: { messageId: receipt, interactionId, content: 'Do not persist body' } },
    { id: `message:${toolCallId}`, type: 'assistant.message',
      data: { interactionId, toolRequests: [{ toolCallId, name: 'synthetic', arguments: { secret: 'Do not persist arguments' } }] } },
  ] });
  f.controlPages.set(batch.sessionId, pages);
  return { ...f.identities[role], toolCallId };
}

/** Freeze an outbox item directly to keep delivery tests independent of semantic decisions. */
export function stageDelivery(f: ReturnType<typeof fixture>, options: Partial<Delivery> = {}): Delivery {
  const id = options.id ?? 'delivery';
  const input = f.service.accept({ requestId: `input:${id}`, text: 'Original compound user input',
    attachments: options.attachments ?? [] });
  f.db.put('work', { ...input.work, state: 'done' });
  const topicId = options.topicId ?? `topic:${id}`;
  if (!f.db.get('topics', topicId)) topic(f, topicId, options.sessionId === '' ? null : options.sessionId ?? 's1');
  const delivery: Delivery = { id, kind: 'prompt', topicId, messageId: input.message.id,
    messageIds: [input.message.id], sessionId: 's1', requestId: null, text: 'Relevant split prompt',
    attachments: [], supplement: null, answerFreeform: null, state: 'pending', result: null,
    error: null, createdAt: f.service.now(), roleEpoch: null, ...options };
  f.db.put('deliveries', delivery);
  return delivery;
}
