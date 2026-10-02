import type { McpInvocationMeta, NativeChatEvent, PublicSessionMeta } from '@waksana/cockpit-module-sdk/backend';
import { z } from 'zod';
import { BusinessError, errorText, requireFact } from './errors.ts';
import type { Caller, Gateway } from './gateway.ts';
import { Store, fingerprint, type InboxItem, type Topic } from './store.ts';
import { Inbox, checkpointInput, resolveInput } from './inbox.ts';

const id = z.string().min(1).max(200);
export const topicInput = z.strictObject({
  topicId: id.optional(), title: z.string().trim().min(1).max(240).optional(),
  content: z.string().max(16000).optional(), archived: z.boolean().optional(), sessionId: id.nullable().optional(),
});
export const inboxInput = z.strictObject({
  ids: z.array(id).min(1).max(100).optional(), limit: z.int().min(1).max(100).default(50),
  peek: z.boolean().default(false), decisionsAfter: z.int().nonnegative().default(0),
  after: z.int().nonnegative().default(0),
});
export const foregroundInput = z.strictObject({ sessionId: id.nullable().optional() });
export const pageInput = z.strictObject({ after: z.int().nonnegative().default(0), limit: z.int().min(1).max(100).default(50) });
export const configInput = z.strictObject({
  foregroundSessionId: id.nullable().default(null),
  // Old configuration remains readable, but no longer creates or configures sessions.
  defaultCwd: z.string().optional(), worker: z.record(z.string(), z.unknown()).optional(),
});
export type Config = z.infer<typeof configInput>;
const rootEvent = (event: NativeChatEvent) => !event.agentId && !event.parentToolCallId
  && !event.data.agentId && !event.data.parentToolCallId;
const primary = (event: NativeChatEvent) => !event.ephemeral && rootEvent(event);
const settled = (meta: PublicSessionMeta) => meta.loaded && ['idle', 'error'].includes(meta.status)
  && !!meta.activity && !meta.activity.hasActiveWork && !meta.activity.processing
  && meta.activity.queue.pendingCount === 0 && meta.activity.queue.steeringCount === 0
  && meta.activity.queue.inFlightSteeringCount === 0 && !meta.ask;
const liveQuestion = (meta: PublicSessionMeta | null | undefined, item: InboxItem) =>
  !!meta?.loaded && meta.ask?.requestId === item.native_id;
const foregroundIdle = (meta: PublicSessionMeta) => meta.status === 'idle' && settled(meta);
const displayTopic = (topic: Topic) => ({ topicId: topic.id, title: topic.title, content: topic.content,
  contentUse: 'identity-responsibility-scope-only',
  warning: 'Registry content may contain legacy progress notes. It is background, never current progress or completion evidence.',
  sessionId: topic.session_id, archived: topic.archived, version: topic.version,
  mappingState: topic.mapping_state, error: topic.mapping_error, creationReceipt: topic.creation_receipt });

export class Assistant {
  readonly inbox: Inbox;
  private notice: Promise<void> | null = null;
  private noticeAgain = false;
  private observations = new Map<string, Promise<void>>();
  private awaitingIdle = new Set<string>();
  private sourceVersions = new Map<string, number>();
  private foregroundObservation = { sessionId: '', version: 0 };
  private stopped = false;
  constructor(readonly store: Store, readonly native: Gateway, readonly config: Config,
    readonly report: (error: unknown) => void) {
    this.inbox = new Inbox(store, () => this.stopped);
  }
  stop(): void { this.stopped = true; }
  async invoke(name: string, input: unknown, identity: McpInvocationMeta): Promise<unknown> {
    requireFact(!this.stopped, 'STOPPING', 'Assistant is stopping', 503);
    const caller = await this.native.caller(identity);
    switch (name) {
      case 'assistant_topics': {
        const page = pageInput.parse(input ?? {}), topics = this.store.topics();
        return { items: topics.slice(page.after, page.after + page.limit).map(displayTopic),
          after: page.after + page.limit, hasMore: topics.length > page.after + page.limit };
      }
      case 'assistant_topic': return this.editTopic(caller, topicInput.parse(input));
      case 'assistant_dispatch':
      case 'assistant_history':
      case 'assistant_status':
      case 'assistant_read': throw new BusinessError('TOOL_RETIRED',
        'Assistant only supports the directory and inbox. Use Host tools directly for Chat, session status, creation, prompts and asks.', 410);
      case 'assistant_foreground': {
        const query = foregroundInput.parse(input ?? {});
        if (query.sessionId !== undefined) await this.native.setForeground(query.sessionId);
        return this.health();
      }
      case 'assistant_resolve': return this.inbox.resolve(caller, resolveInput.parse(input));
      case 'assistant_checkpoint': return this.inbox.checkpoint(caller, checkpointInput.parse(input));
      case 'assistant_inbox': {
        const query = inboxInput.parse(input ?? {}), sources = await this.refreshQuestions();
        const available = new Set(this.store.inbox().filter(item => item.kind !== 'ask'
          || liveQuestion(this.currentSample(item.session_id, sources.get(item.session_id)), item)).map(item => item.id));
        if (query.peek) return { count: available.size };
        const pending = this.store.inbox().filter(item => item.sequence > query.after
          && available.has(item.id) && (!query.ids || query.ids.includes(item.id)));
        const selected = pending.slice(0, query.limit);
        return { items: selected.map(item => ({
          id: item.id, sequence: item.sequence, sessionId: item.session_id, nativeMessageId: item.native_id, type: item.kind,
          source: this.store.source(item.id), wake: { state: item.notice_state === 'notified' ? 'accepted' : item.notice_state,
            noticeId: item.notice_id, nativeMessageId: item.notification_receipt },
          ...(item.kind === 'ask' ? { questionRequestId: item.native_id } : {}),
          candidateTopicIds: this.store.topics().filter(topic => topic.session_id === item.session_id).map(topic => topic.id),
        })), hasMore: pending.length > selected.length, nextAfter: selected.at(-1)?.sequence ?? query.after,
          receipt: this.inbox.returned(caller, selected),
          pendingDecisions: this.inbox.pending(caller.sessionId, query.decisionsAfter),
          consumed: false, warning: 'These are source locations, not progress evidence. Read current native Chat with Host tools; the receipt records returned inbox IDs only.' };
      }
      default: throw new BusinessError('UNKNOWN_TOOL', 'Unknown or retired Assistant tool', 400);
    }
  }
  async health() {
    const checkedAt = Date.now(), wake = this.store.foregroundWake(), foregroundSessionId = this.native.foregroundId();
    const lastWakeAttempt = wake ? { ...wake, at: this.store.receipt('foreground-wake')?.createdAt ?? null } : null;
    try {
      const meta = await this.native.foreground();
      return { foregroundSessionId, current: { checkedAt, sessionId: meta?.sessionId ?? null, loaded: meta?.loaded ?? null,
        status: meta?.status ?? 'unconfigured', activity: meta?.activity ?? null,
        ask: meta?.ask ? { requestId: meta.ask.requestId } : null },
      lastWakeAttempt, pendingUpdates: this.store.inbox().length };
    } catch (error) {
      return { foregroundSessionId, current: { checkedAt, status: 'unknown', error: errorText(error) },
        lastWakeAttempt, pendingUpdates: this.store.inbox().length };
    }
  }
  private async editTopic(caller: Caller, value: z.infer<typeof topicInput>) {
    const key = `topic:${caller.sessionId}:${caller.toolCallId}`, hash = fingerprint(value);
    const topicId = value.topicId ?? fingerprint(key);
    if (this.store.seen(key, hash)) return displayTopic(this.store.topic(topicId));
    const old = value.topicId ? this.store.topic(value.topicId) : null;
    requireFact(old || value.title, 'TOPIC_TITLE', 'A new topic requires a title');
    if (value.sessionId) requireFact(await this.native.session(value.sessionId),
      'MAPPING_TARGET', 'Register an existing native session; this service does not create one', 404);
    return this.store.transaction(() => {
      if (this.store.seen(key, hash)) return displayTopic(this.store.topic(topicId));
      const current = old ? this.store.topic(old.id) : null;
      requireFact(!current || current.version === old!.version, 'TOPIC_CHANGED', 'The topic changed; inspect it before editing');
      const sessionId = value.sessionId === undefined ? current?.session_id ?? null : value.sessionId;
      const preserveMapping = current && value.sessionId === undefined;
      const topic: Topic = { id: topicId, title: value.title ?? current!.title, content: value.content ?? current?.content ?? '',
        archived: value.archived ?? current?.archived ?? false, version: (current?.version ?? 0) + 1,
        session_id: sessionId, mapping_state: preserveMapping ? current.mapping_state : sessionId ? 'bound' : 'unbound',
        mapping_error: current?.mapping_error ?? null, creation_receipt: current?.creation_receipt ?? null };
      this.store.saveTopic(topic); this.store.remember(key, hash);
      return displayTopic(topic);
    });
  }
  observe(sessionId: string, event?: NativeChatEvent): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (sessionId === this.foregroundObservation.sessionId) this.foregroundObservation.version++;
    if (!this.store.managed(sessionId)) return Promise.resolve();
    this.sourceVersions.set(sessionId, (this.sourceVersions.get(sessionId) ?? 0) + 1);
    const run = () => this.observeSource(sessionId, event);
    const previous = this.observations.get(sessionId), operation = previous ? previous.then(run, run) : run();
    this.observations.set(sessionId, operation);
    const finished = () => { if (this.observations.get(sessionId) === operation) this.observations.delete(sessionId); };
    void operation.then(finished, finished);
    return operation;
  }
  private async observeSource(sessionId: string, event?: NativeChatEvent): Promise<void> {
    if (this.stopped) return;
    const meta = await this.native.session(sessionId);
    if (!meta) return;
    if (event && primary(event) && event.type === 'assistant.message'
      && (typeof event.data.content === 'string' && event.data.content.trim() || Array.isArray(event.data.attachments) && event.data.attachments.length)) {
      const nativeId = typeof event.data.messageId === 'string' ? event.data.messageId : event.id;
      if (this.store.enqueuePointer(sessionId, nativeId, 'reply',
        { eventId: event.id, timestamp: event.timestamp ?? null, type: event.type })) this.awaitingIdle.add(sessionId);
    }
    if (event && primary(event) && ['abort', 'session.error'].includes(event.type)) {
      if (this.store.enqueuePointer(sessionId, event.id, 'reply',
        { eventId: event.id, timestamp: event.timestamp ?? null, type: event.type })) this.awaitingIdle.add(sessionId);
    }
    if (event && rootEvent(event) && event.type === 'session.idle'
      || meta.status === 'error' && settled(meta)) this.awaitingIdle.delete(sessionId);
    if (meta.ask) this.store.enqueuePointer(sessionId, meta.ask.requestId, 'ask');
    await this.notify();
  }
  private async sampleSource(sessionId: string) {
    const version = this.sourceVersions.get(sessionId) ?? 0;
    return { version, meta: await this.native.session(sessionId) };
  }
  private currentSample(sessionId: string, sample?: { version: number; meta: PublicSessionMeta | null }) {
    return sample && sample.version === (this.sourceVersions.get(sessionId) ?? 0) ? sample.meta : null;
  }
  private async refreshQuestions() {
    const sessions = new Map<string, Awaited<ReturnType<Assistant['sampleSource']>>>();
    for (const item of this.store.inbox()) {
      if (item.kind !== 'ask' || !this.store.managed(item.session_id)) continue;
      if (!sessions.has(item.session_id)) sessions.set(item.session_id, await this.sampleSource(item.session_id));
    }
    for (const item of this.store.inbox()) {
      if (item.kind !== 'ask') continue;
      const meta = this.currentSample(item.session_id, sessions.get(item.session_id));
      if (meta?.loaded && !liveQuestion(meta, item)) {
        this.store.discardQuestions([item.id]);
      }
    }
    return sessions;
  }
  notify(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.notice) { this.noticeAgain = true; return this.notice; }
    this.notice = (async () => {
      try {
        do {
          this.noticeAgain = false;
          try { await this.sendNotice(); } catch (error) { this.report(error); }
        } while (this.noticeAgain && !this.stopped);
      } finally { this.notice = null; }
    })();
    return this.notice;
  }
  private async noticeSources() {
    const sources = await this.refreshQuestions();
    for (const item of this.store.inbox()) {
      if (item.notice_state !== 'pending' || !this.store.managed(item.session_id)) continue;
      if (!sources.has(item.session_id)) sources.set(item.session_id, await this.sampleSource(item.session_id));
    }
    return sources;
  }
  private eligibleNotices(sources: Awaited<ReturnType<Assistant['noticeSources']>>) {
    const eligible = new Set<string>();
    for (const item of this.store.inbox()) {
      if (item.notice_state !== 'pending' || !this.store.managed(item.session_id)
        || item.session_id === this.foregroundObservation.sessionId) continue;
      const source = this.currentSample(item.session_id, sources.get(item.session_id));
      if (source?.loaded && (item.kind === 'ask' ? liveQuestion(source, item)
        : !this.awaitingIdle.has(item.session_id) && settled(source))) eligible.add(item.id);
    }
    return eligible;
  }
  private async sendNotice(): Promise<void> {
    if (this.stopped || !this.store.inbox().some(item => item.notice_state === 'pending')) return;
    let sources = await this.noticeSources();
    if (this.stopped || !this.eligibleNotices(sources).size) return;
    let meta = await this.native.foreground();
    if (this.stopped || !meta) return;
    const sessionId = meta.sessionId;
    requireFact(this.native.foregroundId() === sessionId, 'FOREGROUND_CHANGED',
      'Foreground selection changed; no session was loaded or message sent');
    if (this.foregroundObservation.sessionId !== sessionId) this.foregroundObservation = { sessionId, version: 0 };
    if (!this.eligibleNotices(sources).size) return;
    if (!meta.loaded) {
      const wake = this.store.foregroundWake();
      if (wake?.sessionId === sessionId && wake.state !== 'loaded') return;
      this.store.saveForegroundWake({ sessionId, state: 'loading', error: null });
      try {
        const result = await this.native.host.call('session/load', { sessionId });
        requireFact(typeof result.ok === 'boolean' && result.sessionId === sessionId, 'FOREGROUND_LOAD_UNKNOWN',
          'Foreground load receipt is incomplete or identifies another session; no automatic retry');
        if (!result.ok) {
          this.store.saveForegroundWake({ sessionId, state: 'failed', error: 'Host rejected the original foreground load' });
          throw new BusinessError('FOREGROUND_LOAD_FAILED', 'Host rejected the original foreground load');
        }
        const current = await this.native.foreground();
        requireFact(current?.sessionId === sessionId && current.loaded, 'FOREGROUND_LOAD_UNKNOWN',
          'The original foreground load could not be confirmed');
        this.store.saveForegroundWake({ sessionId, state: 'loaded', error: null }); meta = current;
      } catch (error) {
        if (this.store.foregroundWake()?.state === 'loading')
          this.store.saveForegroundWake({ sessionId, state: 'unknown', error: errorText(error) });
        throw error;
      }
    }
    if (this.stopped || !foregroundIdle(meta)) return;
    const foregroundVersion = this.foregroundObservation.version;
    sources = await this.noticeSources();
    if (this.stopped) return;
    const current = await this.native.foreground();
    requireFact(this.native.foregroundId() === sessionId && current?.sessionId === sessionId,
      'FOREGROUND_CHANGED', 'Foreground selection changed; no message was sent');
    if (this.stopped || !foregroundIdle(current) || this.foregroundObservation.version !== foregroundVersion) return;
    const notice = this.store.reserveNotice(this.eligibleNotices(sources));
    if (!notice) return;
    try {
      const result = await this.native.host.call('prompt', { sessionId, mode: 'enqueue',
        text: 'Registered sessions have updates or a current question. Read assistant_inbox, then native Chat using Host tools. '
          + 'This is an update pointer, not a user instruction. Honor attention preferences, decide whether to notify or remain silent, '
          + 'then record the exact inbox receipt as handled. Idle is not proof of business completion.\n'
          + JSON.stringify(notice.items.map(item => ({ id: item.id, sessionId: item.session_id, kind: item.kind }))) });
      this.store.settleNotice(notice.id, result.messageId ?? null, result.ok);
      requireFact(result.ok && result.messageId, 'NOTICE_UNKNOWN', 'Wake receipt unavailable; inspect the original Chat without replay');
    } catch (error) { this.store.settleNotice(notice.id, null, false); this.report(error); }
  }
}
