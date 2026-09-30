import type { McpInvocationMeta, ModuleHostApi, ModuleHostIntent, ModuleHostIntentBody,
  ModuleHostIntentResult, NativeChatEvent, PublicSessionMeta } from '@waksana/cockpit-module-sdk/backend';
import { Database } from '../src/database.ts';
import { AssistantService } from '../src/service.ts';
import { Runtime } from '../src/runtime.ts';
import { nativeAccess } from '../src/native.ts';
import type { Topic } from '../src/types.ts';
import type { NativeAttachment } from '../src/attachments.ts';

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
export function fixture(path = ':memory:') {
  const db = new Database(path);
  let now = 1_000_000, prompts = 0, creations = 0;
  const service = new AssistantService(db, () => now, { defaultCwd: '/synthetic' });
  const metas = new Map<string, PublicSessionMeta>();
  for (const id of ['s1','s2','coordinator']) metas.set(id, {
    sessionId: id, cwd: '/synthetic', title: id, loaded: true, status: 'idle', ask: null,
    lastActivity: 0, currentModelId: 'synthetic', rolesNeedReload: false,
    activity: { processing: false, hasActiveWork: false, abortable: false, sampledAt: now,
      queue: { pendingCount: 0, steeringCount: 0, inFlightSteeringCount: 0 },
      tasks: { activeAgents: 0, activeShells: 0, unknown: 0 }, mcp: { pendingConnectionCount: 0 } },
    roles: id === 'coordinator' ? [{ moduleId: 'assistant', roleId: 'coordinator', moduleName: 'Assistant', name: 'coordinator' }] : [],
    appliedRoles: id === 'coordinator' ? [{ moduleId: 'assistant', roleId: 'coordinator', moduleName: 'Assistant', name: 'coordinator' }] : [],
  });
  const calls: { name: string; body: unknown }[] = [], errors: unknown[] = [];
  const history = new Map<string, NativeChatEvent[]>(), sourceReceipts = new Map<string, string>();
  const failures = new Map<string, Error>();
  const roleEvidence = new Map<string, NonNullable<PublicSessionMeta['roles']>>();
  let onPrompt: ((sessionId: string) => Promise<void>) | null = null;
  let onGet: ((sessionId: string) => Promise<void>) | null = null;
  let onLoad: ((sessionId: string) => Promise<void>) | null = null;
  let onCreate: (() => Promise<void>) | null = null;
  const promptResults = new Map<string, { ok: boolean; queued?: boolean; messageId?: string }>();
  let answerResult = true;
  const host: ModuleHostApi = {
    promptReceiptVersion: 1, resourcePreparationVersion: 1, askResponseVersion: 1, chatReadVersion: 1,
    roleAssignmentVersion: 1, sessionDirectoryVersion: 1, sessionLoadVersion: 1,
    async call<Name extends ModuleHostIntent>(name: Name, body: ModuleHostIntentBody<Name>): Promise<ModuleHostIntentResult<Name>> {
      calls.push({ name, body });
      const sessionId = 'sessionId' in body ? body.sessionId : '';
      if (name === 'prompt' && onPrompt) await onPrompt(sessionId);
      if (name === 'session/get' && onGet) await onGet(sessionId);
      if (name === 'session/load' && onLoad) await onLoad(sessionId);
      if (name === 'session/new' && onCreate) await onCreate();
      const failure = failures.get(name);
      if (failure) throw failure;
      let result: unknown;
      switch (name) {
        case 'session/directory': result = { sessions: [...metas.values()] }; break;
        case 'session/get': result = { meta: metas.get(sessionId) ?? null }; break;
        case 'roles/readiness': {
          const meta = metas.get(sessionId);
          result = { sessionId, ready: !!meta?.loaded && !meta.rolesNeedReload,
            loaded: meta?.loaded ?? false, reasons: [], rolesNeedReload: meta?.rolesNeedReload ?? false,
            roles: roleEvidence.get(sessionId) ?? meta?.roles ?? [],
            appliedRoles: roleEvidence.get(sessionId) ?? meta?.appliedRoles ?? [] };
          break;
        }
        case 'session/resources-prepare': result = { sessionId, ok: true, tools: 'initialized', skills: [],
          mcpServers: [{ name: 'assistant', effect: 'unchanged', enabled: true, status: 'connected', tools: [] }] }; break;
        case 'session/new': {
          const id = `created-${++creations}`;
          result = { sessionId: id };
          const roles = 'roles' in body && body.roles ? body.roles.map(role => ({ ...role, moduleName: 'Assistant', name: role.roleId })) : [];
          metas.set(id, { ...structuredClone(metas.get('s1')!), sessionId: id, title: id,
            cwd: 'cwd' in body ? body.cwd : '/synthetic', roles, appliedRoles: roles });
          break;
        }
        case 'session/load': {
          const meta = metas.get(sessionId);
          if (!meta) throw new Error('Original native session is missing');
          meta.loaded = true; meta.status = 'idle';
          result = { ok: true, sessionId }; break;
        }
        case 'prompt': {
          result = promptResults.get(sessionId) ?? { ok: true, messageId: `receipt-${++prompts}`, queued: metas.get(sessionId)?.status === 'running' };
          if (sessionId === 'coordinator' && 'text' in body) {
            const source = JSON.parse(body.text.slice(body.text.indexOf('\n') + 1)) as { messageId: string };
            const receipt = (result as { messageId?: string }).messageId;
            if (receipt) {
              sourceReceipts.set(source.messageId, receipt);
              const events = history.get(sessionId) ?? [];
              events.push({ id: `envelope:${receipt}`, type: 'user.message',
                data: { messageId: receipt, interactionId: `interaction:${receipt}`, content: 'Not the envelope identity' } });
              history.set(sessionId, events);
            }
          }
          break;
        }
        case 'respondAsk':
          result = { ok: answerResult };
          if (answerResult) metas.get(sessionId)!.ask = null;
          break;
        case 'session/chat': {
          const events = (history.get(sessionId) ?? []).slice(-64);
          result = { sessionId, source: 'source' in body ? body.source : 'live',
            direction: 'direction' in body ? body.direction : 'backward', events,
            cursor: 'synthetic-cursor', liveCursor: 'synthetic-live', cursorStatus: 'ok', hasMore: false,
            read: { rpc: 1, events: events.length } };
          break;
        }
        default: throw new Error(`Unexpected public Host call ${name}`);
      }
      return result as ModuleHostIntentResult<Name>;
    },
  };
  const native = nativeAccess(host), runtime = new Runtime(service, native, error => errors.push(error), () => {});
  return { db, service, runtime, native, metas, calls, history, sourceReceipts, errors, roleEvidence,
    advance(ms: number) { now += ms; },
    fail(name: string, error: Error | null) { if (error) failures.set(name, error); else failures.delete(name); },
    promptResult(sessionId: string, value: { ok: boolean; queued?: boolean; messageId?: string }) { promptResults.set(sessionId, value); },
    answerResult(ok: boolean) { answerResult = ok; },
    onPrompt(fn: typeof onPrompt) { onPrompt = fn; },
    onGet(fn: typeof onGet) { onGet = fn; },
    onLoad(fn: typeof onLoad) { onLoad = fn; },
    onCreate(fn: typeof onCreate) { onCreate = fn; },
    async event(sessionId: string, event: NativeChatEvent) { runtime.noteEvent(sessionId, event); await runtime.wake(sessionId); },
    close() { runtime.stop(); db.close(); },
  };
}
export function topic(f: ReturnType<typeof fixture>, id = 'topic', sessionId: string | null = 's1'): Topic {
  const value: Topic = { id, title: id, content: 'Synthetic topic', archived: false, version: 1, sessionId,
    mappingState: sessionId ? 'bound' : 'unbound', mappingError: null, creationReceipt: null };
  f.db.put('topics', value); return value;
}
let toolSequence = 0;
export function toolIdentity(f: ReturnType<typeof fixture>, messageId: string,
  toolCallId = `tool-${++toolSequence}`, receipt = f.sourceReceipts.get(messageId)!): McpInvocationMeta {
  const events = f.history.get('coordinator') ?? [];
  events.push({ id: `tool-envelope:${toolCallId}`, type: 'assistant.message',
    data: { interactionId: `interaction:${receipt}`, toolRequests: [{ toolCallId, name: 'assistant_complete' }] } });
  f.history.set('coordinator', events);
  return { sessionId: 'coordinator', runtimeSessionId: 'coordinator', subagent: false, toolCallId };
}
export function stageDelivery(f: ReturnType<typeof fixture>, id = 'input', topicIds = ['topic'], attachments: NativeAttachment[] = []) {
  const message = f.service.accept({ requestId: id, text: 'Original compound input', attachments }).message;
  for (const topicId of topicIds) if (!f.db.get('topics', topicId)) topic(f, topicId);
  return f.service.complete({ messageId: message.id, items: topicIds.map(topicId => ({ topicId, prompt: `Faithful ${topicId} prompt` })) });
}
