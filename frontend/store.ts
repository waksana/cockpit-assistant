import type { ModuleFrontendContext } from '@waksana/cockpit-module-sdk/frontend';
import { z } from 'zod';
import type { Readiness, TimelineItem } from '../src/ui-types.ts';
import type { Operation, Role } from '../src/types.ts';
import type { AssistantActions, SetupOperation, Snapshot } from './contracts.ts';
import { createInput } from './input.ts';
import { attachmentsSchema } from '../src/attachments.ts';
import { conversationItems, isConversationItem, mergeSnapshots } from './timeline.ts';
import { conversationProtocolSchema, legacyClarificationSchema } from './protocol.ts';

const sequence = z.number().int().nonnegative().safe();
const itemSchema = z.object({
  id: z.string().min(1), sequence: sequence.positive(), snapshotRevision: sequence.positive(),
  type: z.enum(['message', 'question']),
  messageId: z.string().min(1), topicId: z.string().nullable(), text: z.string(),
  createdAt: z.number().finite(),
  topicTitle: z.string().nullable(), speaker: z.enum(['user', 'assistant', 'system']),
  sessionId: z.string().nullable(),
  question: z.object({ state: z.enum(['pending', 'stale', 'answered', 'unknown']),
    stateVersion: sequence, requestId: z.string().min(1), choices: z.array(z.string()).optional(),
    allowFreeform: z.boolean().optional() }).nullable(),
  attachments: attachmentsSchema.default([]),
  clarifications: z.array(legacyClarificationSchema).default([]),
  diagnostic: z.string().nullable(),
  deliveryIssues: z.array(z.object({
    topicMessageId: z.string().min(1), state: z.enum(['rejected', 'unknown', 'cancelled']), detail: z.string().min(1),
  })).default([]),
}).refine(item => item.id === item.messageId, 'Message identity must match');
const pageSchema = z.object({ items: z.array(itemSchema), before: sequence.nullable(),
  hasMore: z.boolean(), watermark: sequence, cursor: sequence.optional() });
const operationSchema = z.object({ id: z.string(), fingerprint: z.string(),
  state: z.enum(['pending', 'calling', 'accepted', 'rejected', 'unknown', 'cancelled']),
  kind: z.enum(['create', 'load', 'bind', 'activate']), result: z.unknown() });
const operationState = (state: Operation['state']): SetupOperation['state'] =>
  state === 'accepted' ? 'accepted' : state === 'rejected' || state === 'cancelled' ? 'error'
    : state === 'pending' || state === 'calling' ? 'pending' : 'unknown';
const activationLabel = '加载内部角色会话';

class RequestFailure extends Error {
  constructor(message: string, readonly known: boolean) { super(message); }
}
const errorText = (error: unknown): string => error instanceof z.ZodError ? '返回的消息格式无法识别，请重新连接。'
  : error instanceof Error ? error.message : String(error);
const id = (): string => crypto.randomUUID();

/** A stream cursor advances only after the entire validated message snapshot is applied. */
export async function readPublications(response: Response, apply: (item: z.infer<typeof itemSchema>) => void,
  signal: AbortSignal): Promise<void> {
  if (!response.body) throw new Error('完整消息流没有响应正文');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let cancellation: Promise<void> | undefined;
  let cancellationError: unknown;
  const abort = () => {
    cancellation = reader.cancel().catch(error => { cancellationError = error; });
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 4_000_000) throw new Error('完整消息流记录超出限制');
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buffer);
        if (!boundary) break;
        const record = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const lines = record.split(/\r?\n/);
        const field = (name: string) => lines.filter(line => line.startsWith(`${name}:`))
          .map(line => line.slice(name.length + 1).replace(/^ /, ''));
        const event = field('event')[0];
        if (event === 'publication') {
          const item = itemSchema.parse(JSON.parse(field('data').join('\n')));
          if (field('id')[0] !== String(item.snapshotRevision)) throw new Error('消息流修订游标不一致');
          if (!signal.aborted) apply(item);
        } else if (event || field('data').length) {
          throw new Error(`消息流事件异常：${event ?? 'message'}`);
        }
      }
    }
    if (!signal.aborted) throw new Error('消息流已断开；将从已应用修订游标重新连接');
  } finally {
    signal.removeEventListener('abort', abort);
    await cancellation;
    await reader.cancel();
    reader.releaseLock();
    if (cancellationError) throw cancellationError;
  }
}

export function createStore(context: Pick<ModuleFrontendContext, 'request' | 'signal' | 'report' | 'state'>): AssistantActions {
  let notify = () => {};
  const input = createInput(context, () => notify());
  let state: Snapshot = {
    open: false, protocolReady: false, view: 'conversation', items: [], hasOlder: false, loading: false, loadingOlder: false,
    stream: 'disconnected', error: null, readiness: null, checking: false, readinessError: null,
    draft: input.reference.getSnapshot(),
    submissions: input.business().submissions, setup: [],
  };
  const listeners = new Set<() => void>();
  let disposed = false;
  notify = () => {
    if (disposed) return;
    const { submissions } = input.business();
    state = { ...state, draft: input.reference.getSnapshot(), submissions };
    for (const listener of listeners) listener();
  };
  let generation = 0;
  let readinessGeneration = 0;
  let lifetime: AbortController | null = null;
  let streamController: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let applied = 0;
  let historyBefore: number | null = null;
  let backoff = 1000;
  const activationAttempts = new Map<string, Role[]>();
  const update = (patch: Partial<Snapshot>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    input.update(state.open, state.protocolReady && state.view === 'conversation'
      && !!state.readiness?.canSend && !state.checking && !state.readinessError
      && !!state.readiness?.roles.some(entry => entry.role === 'coordinator' && entry.status === 'ready'),
    conversationItems(state.items));
    for (const listener of listeners) listener();
  };
  const current = (epoch: number) => !disposed && state.open && epoch === generation;
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await context.request(path, init);
    let body: unknown;
    try { body = await response.json(); }
    catch { throw new RequestFailure(`HTTP ${response.status} 返回了无法识别的结果`, false); }
    if (!response.ok) {
      const known = z.object({ error: z.object({ code: z.string(), message: z.string() }) }).safeParse(body);
      throw new RequestFailure(known.success ? `${known.data.error.code}: ${known.data.error.message}`
        : `HTTP ${response.status}：结果无法确认`, known.success && response.status < 500);
    }
    return body as T;
  };
  const read = <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal });
  const post = <T>(path: string, body: unknown) => request<T>(path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: context.signal,
  });
  const page = async (query: string, signal?: AbortSignal) =>
    pageSchema.parse(await read(`${state.view === 'legacy' ? '/legacy/timeline' : '/timeline'}${query}`, signal));
  const merge = (items: TimelineItem[]) => mergeSnapshots([...state.items, ...items]);
  const stopStream = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    streamController?.abort();
    streamController = null;
  };
  const catchUp = async (epoch: number, signal: AbortSignal) => {
    for (;;) {
      const result = await page(`?after=${applied}&limit=100`, signal);
      if (!current(epoch) || signal.aborted) return;
      if (!result.items.length && result.hasMore) throw new Error('补读游标未前进');
      let cursor = applied;
      for (const item of result.items) {
        if (item.snapshotRevision <= cursor || item.snapshotRevision > result.watermark)
          throw new Error('补读修订游标未前进');
        cursor = item.snapshotRevision;
      }
      if (result.cursor !== cursor || result.watermark < cursor) throw new Error('补读修订游标不一致');
      update({ items: merge(result.items) });
      applied = result.hasMore ? cursor : result.watermark;
      if (!result.hasMore) return;
    }
  };
  const connect = async (epoch: number, recover: boolean) => {
    stopStream();
    const controller = new AbortController();
    streamController = controller;
    const signal = controller.signal;
    update({ stream: 'connecting' });
    try {
      if (recover) await catchUp(epoch, signal);
      if (!current(epoch) || signal.aborted) return;
      const response = await context.request(`/timeline/stream?after=${applied}`, { signal,
        headers: { accept: 'text/event-stream', 'last-event-id': String(applied) } });
      if (!response.ok) throw new Error(`消息流 HTTP ${response.status}`);
      if (!current(epoch) || signal.aborted) { await response.body?.cancel(); return; }
      update({ stream: 'connected', error: null });
      await readPublications(response, item => {
        if (!current(epoch) || signal.aborted || item.snapshotRevision <= applied) return;
        update({ items: merge([item]) });
        applied = item.snapshotRevision;
        backoff = 1000;
      }, signal);
    } catch (error) {
      if (!current(epoch) || signal.aborted) return;
      update({ stream: 'disconnected', error: errorText(error) });
      retryTimer = setTimeout(() => { retryTimer = null; void connect(epoch, true); }, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  };
  const refresh = async (activate = false) => {
    if (!state.protocolReady || state.view !== 'conversation') return;
    const epoch = generation;
    const check = ++readinessGeneration;
    update({ checking: true, readinessError: null });
    try {
      const result = await read<Readiness>('/readiness', lifetime?.signal);
      if (current(epoch) && check === readinessGeneration) {
        update({ readiness: result, checking: false });
        const bindings = result.roles.filter(role => role.sessionId !== null)
          .map(({ role, sessionId }) => ({ role, sessionId }))
          .sort((a, b) => a.role.localeCompare(b.role));
        const key = JSON.stringify(bindings);
        const uncertain = state.setup.some(operation => operation.receiptId.startsWith('activate:')
          && (operation.state === 'pending' || operation.state === 'unknown'));
        const attemptedRoles = activationAttempts.get(key);
        if (!uncertain && attemptedRoles?.every(role =>
          result.roles.some(entry => entry.role === role && entry.status === 'ready'))) activationAttempts.delete(key);
        if (activate && !uncertain && !activationAttempts.has(key)
          && result.roles.some(role => role.sessionId !== null && role.status === 'unloaded')) {
          activationAttempts.set(key, result.roles.filter(role => role.sessionId !== null && role.status === 'unloaded')
            .map(role => role.role));
          await activateRoles(bindings);
        }
      }
    } catch (error) {
      if (current(epoch) && check === readinessGeneration) {
        update({ checking: false, readiness: null, readinessError: errorText(error) });
      }
    }
  };
  const initialize = async (epoch: number, signal: AbortSignal) => {
    if (!current(epoch) || signal.aborted) return;
    ++readinessGeneration;
    update({ protocolReady: false, readiness: null, readinessError: null,
      checking: state.view === 'conversation' });
    try {
      const protocol = await read<unknown>('/state', signal);
      if (!current(epoch) || signal.aborted) return;
      const supported = conversationProtocolSchema.safeParse(protocol);
      if (!supported.success) throw new Error('Assistant 会话协议不兼容；未发送消息，也未把旧版后台汇聚记录当成前台对话。');
      update({ protocolReady: true });
      if (state.view === 'conversation') void refresh(true);
      const result = await page('?limit=50', signal);
      if (!current(epoch)) return;
      if (result.items.some(item => item.snapshotRevision > result.watermark))
        throw new Error('消息快照超出修订水位');
      applied = result.watermark;
      historyBefore = result.before;
      update({ items: merge(result.items), hasOlder: result.hasMore, error: null });
      if (!result.items.some(isConversationItem) && result.hasMore) await older(epoch, signal);
      if (!current(epoch)) return;
      update({ loading: false });
      if (state.view === 'conversation') void connect(epoch, false);
    } catch (error) {
      if (current(epoch)) update({ loading: false, ...(!state.protocolReady ? { checking: false } : {}), error: errorText(error) });
    }
  };
  const older = async (epoch: number, signal: AbortSignal) => {
    while (current(epoch) && state.hasOlder) {
      const before = historyBefore;
      if (before === null) throw new Error('历史消息游标缺失');
      const result = await page(`?before=${before}&limit=50`, signal);
      if (!current(epoch) || signal.aborted) return;
      if ((!result.items.length && result.hasMore)
        || result.items.some(item => item.sequence >= before)
        || result.before !== (result.items[0]?.sequence ?? null)) throw new Error('历史消息游标未前进');
      update({ items: merge(result.items), hasOlder: result.hasMore });
      historyBefore = result.before;
      if (result.items.some(isConversationItem)) return;
    }
  };
  const setOperation = (requestId: string, patch: Partial<SetupOperation>) =>
    update({ setup: state.setup.map(entry => entry.requestId === requestId ? { ...entry, ...patch } : entry) });
  const activateRoles = async (bindings: { role: Role; sessionId: string | null }[]) => {
    if (state.setup.some(operation => operation.label === activationLabel
      && (operation.state === 'pending' || operation.state === 'unknown'))) return;
    const requestId = id();
    const receiptId = `activate:${requestId}`;
    update({ setup: [...state.setup, { requestId, receiptId,
      label: activationLabel, state: 'pending', detail: '请求处理中；离开页面不代表撤销' }] });
    try {
      const receipt = operationSchema.parse(await post<unknown>('/roles/activate', { requestId, bindings }));
      if (receipt.id !== receiptId) throw new Error('加载回执编号不匹配；请检查原操作');
      setOperation(requestId, { state: operationState(receipt.state), result: receipt.result,
        detail: `加载回执：${receipt.state}；实际就绪状态以刷新检查为准，不会自动重试` });
    } catch (error) {
      // Activation can fail after a carrier loads. HTTP rejection alone
      // does not establish that nothing happened; the durable receipt owns the effect.
      setOperation(requestId, { state: 'unknown', detail: errorText(error) });
      try {
        const receipt = operationSchema.parse(await read<Operation>(`/operations/${encodeURIComponent(receiptId)}`, context.signal));
        if (receipt.id !== receiptId) throw new Error('操作回执编号不匹配');
        setOperation(requestId, { state: operationState(receipt.state),
        result: receipt.result, detail: `${errorText(error)}；回执：${receipt.state}` });
      } catch (inspectionError) {
        const absent = inspectionError instanceof RequestFailure && inspectionError.known
          && inspectionError.message.startsWith('NOT_FOUND:');
        setOperation(requestId, { state: absent && error instanceof RequestFailure && error.known ? 'error' : 'unknown',
          detail: `${errorText(error)}；${errorText(inspectionError)}` });
      }
      if (disposed) context.report(error);
    }
    if (state.open && !disposed) await refresh();
  };
  const store: AssistantActions = {
    draft: input.reference,
    getSnapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    open() {
      if (state.open || disposed) return;
      const epoch = ++generation;
      applied = 0;
      lifetime = new AbortController();
      update({ open: true, protocolReady: false, items: [], loading: true, hasOlder: false, error: null,
        loadingOlder: false, readiness: null, checking: state.view === 'conversation' });
      void initialize(epoch, lifetime.signal);
    },
    close() {
      ++generation;
      ++readinessGeneration;
      lifetime?.abort();
      stopStream();
      update({ open: false, checking: false, stream: 'disconnected' });
      try { input.close(); }
      catch (error) { update({ error: errorText(error) }); context.report(error); }
    },
    edit(text) {
      try { input.edit(text); if (state.error) update({ error: null }); }
      catch (error) { update({ error: errorText(error) }); }
    },
    async send() {
      if (state.view === 'legacy') { update({ error: '旧版记录是只读归档，请返回当前对话后发送。' }); return; }
      try { update({ error: null }); await input.send(); }
      catch (error) { update({ error: errorText(error) }); if (disposed) context.report(error); }
    },
    async inspectInput(requestId) {
      try { await input.inspectInput(requestId); }
      catch (error) { update({ error: errorText(error) }); if (disposed) context.report(error); }
    },
    async loadOlder() {
      if (state.loading || !state.hasOlder || state.loadingOlder || !state.items.length) return;
      const epoch = generation;
      update({ loadingOlder: true });
      try {
        await older(epoch, lifetime!.signal);
        if (current(epoch)) update({ loadingOlder: false });
      } catch (error) {
        if (current(epoch)) update({ loadingOlder: false, error: errorText(error) });
      }
    },
    reconnect() {
      if (!state.open || state.loading || state.view === 'legacy') return;
      if (!state.items.length && applied === 0) {
        update({ loading: true, error: null });
        void initialize(generation, lifetime!.signal);
      } else void connect(generation, true);
    },
    async refresh() {
      for (const operation of state.setup.filter(entry => entry.state === 'unknown' || entry.state === 'pending')) {
        await store.inspectOperation(operation.requestId);
      }
      await refresh();
    },
    showLegacy(show) {
      if (!state.open || disposed || (state.view === 'legacy') === show) return;
      const epoch = ++generation;
      ++readinessGeneration;
      lifetime?.abort();
      stopStream();
      try { input.close(); }
      catch (error) { update({ error: errorText(error) }); context.report(error); return; }
      lifetime = new AbortController();
      applied = 0;
      historyBefore = null;
      update({ view: show ? 'legacy' : 'conversation', protocolReady: false, items: [],
        loading: true, hasOlder: false, loadingOlder: false, error: null,
        checking: !show, readiness: null, readinessError: null, stream: 'disconnected' });
      void initialize(epoch, lifetime.signal);
    },
    async inspectOperation(requestId) {
      const operation = state.setup.find(entry => entry.requestId === requestId);
      if (!operation) return null;
      try {
        const receipt = operationSchema.parse(await read<Operation>(`/operations/${encodeURIComponent(operation.receiptId)}`, context.signal));
        if (receipt.id !== operation.receiptId) throw new Error('操作回执编号不匹配');
        setOperation(requestId, { state: operationState(receipt.state),
        result: receipt.result, detail: `回执状态：${receipt.state}；不会自动重试` });
        if (state.open) await refresh();
        return receipt;
      } catch (error) {
        setOperation(requestId, { detail: `回执暂不可确认：${errorText(error)}；保留原请求` });
        if (disposed) context.report(error);
        return null;
      }
    },
    dispose() { input.dispose(); store.close(); disposed = true; listeners.clear(); },
  };
  return store;
}
