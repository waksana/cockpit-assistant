import type { ModuleFrontendContext } from '@waksana/cockpit-module-sdk/frontend';
import { z } from 'zod';
import type { InputReceipt, Readiness, SessionInspection, TimelineItem, TimelinePage } from '../src/ui-types.ts';
import type { Operation, Role } from '../src/types.ts';
import type { AssistantActions, SetupOperation, Snapshot, Submission } from './contracts.ts';

const sequence = z.number().int().nonnegative().safe();
const itemSchema = z.object({
  id: z.string(), sequence: sequence.positive(),
  type: z.enum(['message', 'question', 'status', 'correction', 'risk', 'clarification']),
  messageId: z.string().nullable(), topicId: z.string().nullable(), text: z.string(),
  anchorId: z.string().nullable(), createdAt: z.number().finite(),
  sources: z.array(z.object({ messageId: z.string(), version: sequence, assignmentVersion: sequence })),
  topicTitle: z.string().nullable(), speaker: z.enum(['user', 'assistant', 'system']),
  sessionId: z.string().nullable(),
  question: z.object({ state: z.enum(['pending', 'stale', 'answered', 'unknown']),
    choices: z.array(z.string()).optional(), allowFreeform: z.boolean().optional() }).nullable(),
});
const pageSchema = z.object({ items: z.array(itemSchema), before: sequence.nullable(),
  hasMore: z.boolean(), watermark: sequence, cursor: sequence.optional() });
const operationSchema = z.object({ id: z.string(), fingerprint: z.string(),
  state: z.enum(['pending', 'calling', 'accepted', 'rejected', 'unknown', 'cancelled']), result: z.unknown() });
const operationState = (state: Operation['state']): SetupOperation['state'] =>
  state === 'accepted' ? 'accepted' : state === 'rejected' || state === 'cancelled' ? 'error'
    : state === 'pending' || state === 'calling' ? 'pending' : 'unknown';
const activationLabel = '加载内部角色会话';

class RequestFailure extends Error {
  constructor(message: string, readonly known: boolean) { super(message); }
}
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const id = (): string => crypto.randomUUID();

/** A stream cursor advances only after the entire validated publication is applied. */
export async function readPublications(response: Response, apply: (item: TimelineItem) => void,
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
          if (field('id')[0] !== String(item.sequence)) throw new Error('消息流序号不一致');
          if (!signal.aborted) apply(item);
        } else if (event && event !== 'message') {
          throw new Error(`消息流事件异常：${event}`);
        }
      }
    }
    if (!signal.aborted) throw new Error('消息流已断开；将从已应用序号重新连接');
  } finally {
    signal.removeEventListener('abort', abort);
    await cancellation;
    await reader.cancel();
    reader.releaseLock();
    if (cancellationError) throw cancellationError;
  }
}

export function createStore(context: Pick<ModuleFrontendContext, 'request' | 'signal' | 'report'>): AssistantActions {
  let state: Snapshot = {
    open: false, items: [], hasOlder: false, loading: false, loadingOlder: false,
    stream: 'disconnected', error: null, readiness: null, checking: false, readinessError: null,
    draft: { text: '', reply: null, revision: 0 }, submissions: [], setup: [],
  };
  const listeners = new Set<() => void>();
  let disposed = false;
  let generation = 0;
  let readinessGeneration = 0;
  let lifetime: AbortController | null = null;
  let streamController: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let applied = 0;
  let backoff = 1000;
  const activationAttempts = new Map<string, Role[]>();
  const update = (patch: Partial<Snapshot>) => {
    if (disposed) return;
    state = { ...state, ...patch };
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
  const page = async (query: string, signal?: AbortSignal): Promise<TimelinePage> =>
    pageSchema.parse(await read(`/timeline${query}`, signal));
  const merge = (items: TimelineItem[]) => {
    const bySequence = new Map(state.items.map(item => [item.sequence, item]));
    for (const item of items) bySequence.set(item.sequence, item);
    return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
  };
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
      for (const item of result.items) {
        if (item.sequence <= applied) throw new Error('补读序号未前进');
        applied = item.sequence;
      }
      update({ items: merge(result.items) });
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
        if (!current(epoch) || signal.aborted || item.sequence <= applied) return;
        if (item.sequence !== applied + 1) throw new Error('消息乱序，正在从最后已应用序号补读');
        applied = item.sequence;
        backoff = 1000;
        update({ items: [...state.items, item] });
      }, signal);
    } catch (error) {
      if (!current(epoch) || signal.aborted) return;
      update({ stream: 'disconnected', error: errorText(error) });
      retryTimer = setTimeout(() => { retryTimer = null; void connect(epoch, true); }, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  };
  const refresh = async (activate = false) => {
    const epoch = generation;
    const check = ++readinessGeneration;
    update({ checking: true, readinessError: null });
    try {
      const result = await read<Readiness>('/readiness', lifetime?.signal);
      if (current(epoch) && check === readinessGeneration) {
        update({ readiness: result, checking: false });
        const bindings = result.roles.filter(role => role.sessionId !== null)
          .map(({ role, sessionId, epoch }) => ({ role, sessionId, epoch }))
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
          await operate('/roles/activate', 'activate', activationLabel, { bindings });
        }
      }
    } catch (error) {
      if (current(epoch) && check === readinessGeneration) {
        update({ checking: false, readiness: null, readinessError: errorText(error) });
      }
    }
  };
  const initialize = async (epoch: number, signal: AbortSignal) => {
    try {
      const result = await page('?limit=50', signal);
      if (!current(epoch)) return;
      applied = result.items.at(-1)?.sequence ?? result.watermark;
      update({ items: result.items, hasOlder: result.hasMore, loading: false, error: null });
      void connect(epoch, false);
    } catch (error) {
      if (current(epoch)) update({ loading: false, error: errorText(error) });
    }
  };
  const setSubmission = (requestId: string, patch: Partial<Submission>) =>
    update({ submissions: state.submissions.map(entry => entry.requestId === requestId ? { ...entry, ...patch } : entry) });
  const setOperation = (requestId: string, patch: Partial<SetupOperation>) =>
    update({ setup: state.setup.map(entry => entry.requestId === requestId ? { ...entry, ...patch } : entry) });
  const operate = async (path: string, prefix: string, label: string, value: Record<string, unknown>) => {
    if (state.setup.some(operation => operation.label === label
      && (operation.state === 'pending' || operation.state === 'unknown'))) return;
    const requestId = id();
    update({ setup: [...state.setup, { requestId, receiptId: `${prefix}:${requestId}`,
      label, state: 'pending', detail: '请求处理中；关闭窗口不代表撤销' }] });
    try {
      const result = await post<unknown>(path, { requestId, ...value });
      if (prefix === 'activate') {
        const receipt = operationSchema.parse(result);
        if (receipt.id !== `${prefix}:${requestId}`) throw new Error('加载回执编号不匹配；请检查原操作');
        setOperation(requestId, { state: operationState(receipt.state), result: receipt.result,
          detail: `加载回执：${receipt.state}；实际就绪状态以刷新检查为准，不会自动重试` });
      } else {
        const receipt = z.object({ state: z.string(), result: z.unknown() }).safeParse(result);
        const effectState = receipt.success ? receipt.data.state : 'accepted';
        setOperation(requestId, { state: effectState === 'accepted' ? 'accepted'
          : effectState === 'rejected' || effectState === 'cancelled' ? 'error' : 'unknown',
        detail: effectState === 'accepted' ? '已接受，请查看回执并刷新状态'
          : `回执状态：${effectState}，不会自动重试`, result });
      }
    } catch (error) {
      // A binding failure may follow successful resource preparation. HTTP 409 alone
      // does not establish that nothing happened; the durable receipt owns the effect.
      setOperation(requestId, { state: 'unknown', detail: errorText(error) });
      try {
        const receipt = operationSchema.parse(await read<Operation>(`/operations/${encodeURIComponent(`${prefix}:${requestId}`)}`, context.signal));
        if (receipt.id !== `${prefix}:${requestId}`) throw new Error('操作回执编号不匹配');
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
    getSnapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    open() {
      if (state.open || disposed) return;
      const epoch = ++generation;
      applied = 0;
      lifetime = new AbortController();
      update({ open: true, items: [], loading: true, hasOlder: false, error: null,
        loadingOlder: false, readiness: null, checking: true });
      void initialize(epoch, lifetime.signal);
      void refresh(true);
    },
    close() {
      ++generation;
      ++readinessGeneration;
      lifetime?.abort();
      stopStream();
      update({ open: false, checking: false, stream: 'disconnected' });
    },
    edit(text) { update({ draft: { ...state.draft, text, revision: state.draft.revision + 1 } }); },
    reply(item) { update({ draft: { ...state.draft, reply: item, revision: state.draft.revision + 1 } }); },
    async send() {
      const draft = state.draft;
      if (!draft.text.trim() || state.checking || !state.readiness?.canSend
        || state.submissions.some(entry => entry.state === 'pending' || entry.state === 'unknown')) return;
      const previous = state.submissions.find(entry => entry.revision === draft.revision && entry.state === 'error');
      const requestId = previous?.requestId ?? id();
      const submission: Submission = { requestId, revision: draft.revision, text: draft.text,
        ...(draft.reply?.anchorId ? { replyTo: draft.reply.anchorId } : {}),
        state: 'pending', detail: '正在保存输入；接受不代表会话已处理' };
      if (previous) setSubmission(requestId, submission);
      else update({ submissions: [...state.submissions, submission] });
      try {
        await post('/messages', { requestId, text: submission.text, ...(submission.replyTo ? { replyTo: submission.replyTo } : {}) });
        setSubmission(requestId, { state: 'accepted', detail: '输入已持久保存，等待编排和投递；尚不代表完成' });
        if (state.draft.revision === submission.revision) {
          update({ draft: { text: '', reply: null, revision: state.draft.revision + 1 } });
        }
      } catch (error) {
        setSubmission(requestId, { state: error instanceof RequestFailure && error.known ? 'error' : 'unknown',
          detail: errorText(error) });
        if (disposed) context.report(error);
      }
    },
    async inspectInput(requestId) {
      const submission = state.submissions.find(entry => entry.requestId === requestId);
      if (!submission) return;
      try {
        const receipt = await read<InputReceipt>(`/inputs/${encodeURIComponent(requestId)}`, context.signal);
        setSubmission(requestId, { state: 'accepted', receipt, detail: receipt.deliveries.length
          ? `输入已保存；投递：${receipt.deliveries.map(entry => entry.state).join('、')}（接受不代表完成）`
          : '输入已保存，仍在等待编排或澄清；未观察到投递' });
        if (state.draft.revision === submission.revision) {
          update({ draft: { text: '', reply: null, revision: state.draft.revision + 1 } });
        }
      } catch (error) {
        setSubmission(requestId, { detail: `回执暂不可确认：${errorText(error)}；保留原请求，不会重发` });
        if (disposed) context.report(error);
      }
    },
    async loadOlder() {
      if (!state.hasOlder || state.loadingOlder || !state.items.length) return;
      const epoch = generation;
      const before = state.items[0]!.sequence;
      update({ loadingOlder: true });
      try {
        const result = await page(`?before=${before}&limit=50`, lifetime?.signal);
        if (current(epoch)) update({ items: merge(result.items), hasOlder: result.hasMore, loadingOlder: false });
      } catch (error) {
        if (current(epoch)) update({ loadingOlder: false, error: errorText(error) });
      }
    },
    reconnect() {
      if (!state.open || state.loading) return;
      if (!state.items.length && applied === 0) {
        update({ loading: true, error: null });
        void initialize(generation, lifetime!.signal);
      } else void connect(generation, true);
    },
    refresh: () => refresh(),
    inspectSession: sessionId => read<SessionInspection>(`/sessions/${encodeURIComponent(sessionId)}/inspect`, lifetime?.signal),
    createSession: (cwd, role) => operate('/sessions', 'create', `创建${role ?? 'reception'}`, { cwd, ...(role ? { role } : {}) }),
    bind: (role, sessionId, expectedModelId, expectedEpoch) =>
      operate('/roles/bind', 'bind', `绑定${role}`, { role, sessionId, expectedModelId, expectedEpoch, definitionVersion: '1' }),
    enroll: (sessionId, label) => operate('/enrollment', 'enroll', '接入接待者',
      { sessionId, label, kind: 'reception', evidence: 'User explicitly selected this session in the Assistant setup interface.' }),
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
    dispose() { store.close(); disposed = true; listeners.clear(); },
  };
  return store;
}
