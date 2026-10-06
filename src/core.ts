import type { McpInvocationMeta, NativeChatEvent, PublicSessionMeta } from '@waksana/cockpit-module-sdk/backend';
import { z } from 'zod';
import { BusinessError, errorText, requireFact, sampleMetadata, type MetadataSample } from './errors.ts';
import type { Caller, Gateway } from './gateway.ts';
import { Store, fingerprint, type InboxItem, type Topic, type Watch } from './store.ts';
import { Inbox, checkpointInput, resolveInput } from './inbox.ts';
import { recentSearchInput as searchInput } from './recent.ts';
export { searchInput };

const id = z.string().min(1).max(200);
export const watchInput = z.strictObject({
  sessionId: id, enabled: z.boolean(), expectedVersion: z.int().nonnegative().optional(),
});
export const inboxInput = z.strictObject({
  ids: z.array(id).min(1).max(100).optional(), limit: z.int().min(1).max(100).default(50),
  peek: z.boolean().default(false), decisionsAfter: z.int().nonnegative().default(0),
  after: z.int().nonnegative().default(0),
});
export const foregroundInput = z.strictObject({});
export interface RecentSearch {
  search(query: string, limit: number): Promise<unknown>;
}
export const pageInput = z.strictObject({ after: z.int().nonnegative().default(0), limit: z.int().min(1).max(100).default(50) });
export const configInput = z.strictObject({
  // Legacy selection is accepted for configuration compatibility but never selects the role owner.
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
  contentUse: 'legacy-discovery-only', readOnly: true,
  warning: 'Retained topic metadata is an optional historical clue, not current responsibility, progress or a notification subscription.',
  sessionId: topic.session_id, archived: topic.archived, version: topic.version,
  mappingState: topic.mapping_state, error: topic.mapping_error, creationReceipt: topic.creation_receipt });
const displayWatch = (watch: Watch) => ({ sessionId: watch.session_id, enabled: watch.enabled,
  version: watch.version, updatedAt: watch.updated_at,
  purpose: 'notification-attention-only' as const });

export class Assistant {
  readonly inbox: Inbox;
  private notice: Promise<void> | null = null;
  private noticeAgain = false;
  private observations = new Map<string, Promise<void>>();
  private awaitingIdle = new Set<string>();
  private sourceVersions = new Map<string, number>();
  private watchEdits = new Map<string, number>();
  private deferredSources = new Map<string, number>();
  private coordinatorDeferred = false;
  private foregroundObservation = { sessionId: '', version: 0 };
  private stopped = false;
  constructor(readonly store: Store, readonly native: Gateway, readonly config: Config,
    readonly report: (error: unknown) => void, readonly recent?: RecentSearch) {
    this.inbox = new Inbox(store, () => this.stopped);
  }
  stop(): void { this.stopped = true; }
  async invoke(name: string, input: unknown, identity: McpInvocationMeta): Promise<unknown> {
    requireFact(!this.stopped, 'STOPPING', 'Assistant is stopping', 503);
    const caller = await this.native.caller(identity);
    requireFact(!this.stopped, 'STOPPING', 'Assistant is stopping', 503);
    switch (name) {
      case 'assistant_topics': {
        const page = pageInput.parse(input ?? {}), topics = this.store.topics();
        return { items: topics.slice(page.after, page.after + page.limit).map(displayTopic),
          after: page.after + page.limit, hasMore: topics.length > page.after + page.limit };
      }
      case 'assistant_watches': {
        const page = pageInput.parse(input ?? {}), watches = this.store.watches();
        return { items: watches.slice(page.after, page.after + page.limit).map(displayWatch),
          after: page.after + page.limit, hasMore: watches.length > page.after + page.limit };
      }
      case 'assistant_watch': return this.editWatch(caller, watchInput.parse(input));
      case 'assistant_search': {
        const query = searchInput.parse(input);
        requireFact(this.recent, 'SEARCH_UNAVAILABLE', 'Recent-session search is unavailable', 503);
        return this.recent.search(query.query, query.limit);
      }
      case 'assistant_dispatch':
      case 'assistant_topic':
      case 'assistant_history':
      case 'assistant_status':
      case 'assistant_read': throw new BusinessError('TOOL_RETIRED',
        'Use Host sessions and Chat for current context, search for candidate locations, and assistant_watch for notification attention. Topic writes and business dispatch wrappers are retired.', 410);
      case 'assistant_foreground': {
        foregroundInput.parse(input ?? {});
        return this.health();
      }
      case 'assistant_resolve': return this.inbox.resolve(caller, resolveInput.parse(input));
      case 'assistant_checkpoint': return this.inbox.checkpoint(caller, checkpointInput.parse(input));
      case 'assistant_inbox': {
        const query = inboxInput.parse(input ?? {}), sources = await this.refreshQuestions(false);
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
          watched: this.store.managed(item.session_id),
        })), hasMore: pending.length > selected.length, nextAfter: selected.at(-1)?.sequence ?? query.after,
          receipt: this.inbox.returned(caller, selected),
          pendingDecisions: this.inbox.pending(caller.sessionId, query.decisionsAfter),
          consumed: false, warning: 'These are source locations, not progress evidence. Read current native Chat with Host tools; the receipt records returned inbox IDs only.' };
      }
      default: throw new BusinessError('UNKNOWN_TOOL', 'Unknown or retired Assistant tool', 400);
    }
  }
  async health() {
    const checkedAt = Date.now(), wake = this.store.foregroundWake();
    const lastWakeAttempt = wake ? { ...wake, at: this.store.receipt('foreground-wake')?.createdAt ?? null } : null;
    try {
      const sample = await this.sampleForeground();
      if (sample.state === 'deferred') return {
        foregroundSessionId: this.native.foregroundId(), destination: 'coordinator-role' as const,
        current: { checkedAt, status: 'deferred', code: 'SESSION_TRANSITION' },
        lastWakeAttempt, pendingUpdates: this.store.inbox().length, observations: this.observationHealth(),
      };
      const meta = sample.meta;
      return { foregroundSessionId: meta?.sessionId ?? null, destination: 'coordinator-role' as const,
        current: { checkedAt, sessionId: meta?.sessionId ?? null, loaded: meta?.loaded ?? null,
        status: meta?.status ?? 'unconfigured', activity: meta?.activity ?? null,
        ask: meta?.ask ? { requestId: meta.ask.requestId } : null },
      lastWakeAttempt, pendingUpdates: this.store.inbox().length, observations: this.observationHealth() };
    } catch (error) {
      return { foregroundSessionId: this.native.foregroundId(), destination: 'coordinator-role' as const,
        current: { checkedAt, status: 'unknown', error: errorText(error) },
        lastWakeAttempt, pendingUpdates: this.store.inbox().length, observations: this.observationHealth() };
    }
  }
  private observationHealth() {
    for (const sessionId of this.deferredSources.keys())
      if (!this.store.managed(sessionId)) this.deferredSources.delete(sessionId);
    return { coordinatorDeferred: this.coordinatorDeferred, deferredSourceCount: this.deferredSources.size,
      deferredSources: [...this.deferredSources.keys()].slice(0, 100).map(sessionId => ({
        sessionId, code: 'SESSION_TRANSITION' as const,
      })), truncated: this.deferredSources.size > 100 };
  }
  private async sampleForeground() {
    const sample = await sampleMetadata(() => this.native.foreground());
    if (!this.stopped) this.coordinatorDeferred = sample.state === 'deferred';
    return sample;
  }
  private async editWatch(caller: Caller, value: z.infer<typeof watchInput>) {
    const key = `watch:${caller.sessionId}:${caller.toolCallId}`, hash = fingerprint(value);
    if (this.store.seen(key, hash)) {
      const watch = this.store.watch(value.sessionId);
      requireFact(watch, 'WATCH_MISSING', 'Recorded watch operation has no current state');
      return { ...displayWatch(watch), replayed: true };
    }
    const old = this.store.watch(value.sessionId), expected = value.expectedVersion ?? old?.version ?? 0;
    const edit = this.watchEdits.get(value.sessionId) ?? 0;
    requireFact(expected === (old?.version ?? 0), 'WATCH_CHANGED', 'Notification attention changed; inspect it before editing', 409);
    if (value.enabled) requireFact(await this.native.session(value.sessionId),
      'WATCH_TARGET', 'Watch an existing native session; this service does not create or load one', 404);
    requireFact(!this.stopped, 'STOPPING', 'Assistant is stopping', 503);
    const result = this.store.transaction(() => {
      if (this.store.seen(key, hash)) {
        const watch = this.store.watch(value.sessionId);
        requireFact(watch, 'WATCH_MISSING', 'Recorded watch operation has no current state');
        return { ...displayWatch(watch), replayed: true };
      }
      const current = this.store.watch(value.sessionId);
      requireFact((current?.version ?? 0) === expected && (this.watchEdits.get(value.sessionId) ?? 0) === edit,
        'WATCH_CHANGED', 'Notification attention changed; inspect it before editing', 409);
      const watch = current?.enabled === value.enabled ? current : this.store.saveWatch({
        session_id: value.sessionId, enabled: value.enabled, version: (current?.version ?? 0) + 1, updated_at: Date.now(),
      });
      this.store.remember(key, hash);
      return { ...displayWatch(watch), replayed: false };
    });
    if (!result.replayed) {
      // A repeated disable still fences an older enable awaiting native evidence.
      this.watchEdits.set(value.sessionId, edit + 1);
      if (!result.enabled) this.awaitingIdle.delete(value.sessionId);
      this.invalidateObservation(value.sessionId);
    }
    return result;
  }
  invalidateObservation(sessionId: string): void {
    if (this.stopped) return;
    if (sessionId === this.foregroundObservation.sessionId) this.foregroundObservation.version++;
    if (!this.store.managed(sessionId)) this.deferredSources.delete(sessionId);
    if (!this.store.managed(sessionId) && !this.store.hasPending(sessionId)) return;
    this.sourceVersions.set(sessionId, (this.sourceVersions.get(sessionId) ?? 0) + 1);
  }
  observe(sessionId: string, event?: NativeChatEvent): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.invalidateObservation(sessionId);
    if (!this.store.managed(sessionId)) return Promise.resolve();
    // Capture event facts at admission; queued reads must not restore an old idle
    // latch after notification attention has been disabled and enabled again.
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
    if (event && rootEvent(event) && event.type === 'session.idle') this.awaitingIdle.delete(sessionId);
    const run = () => this.observeSource(sessionId);
    const previous = this.observations.get(sessionId), operation = previous ? previous.then(run, run) : run();
    this.observations.set(sessionId, operation);
    const finished = () => { if (this.observations.get(sessionId) === operation) this.observations.delete(sessionId); };
    void operation.then(finished, finished);
    return operation;
  }
  private async observeSource(sessionId: string): Promise<void> {
    if (this.stopped || !this.store.managed(sessionId)) return;
    const sample = await this.sampleSource(sessionId);
    if (this.stopped) return;
    const meta = this.currentSample(sessionId, sample);
    if (meta?.status === 'error' && settled(meta)) this.awaitingIdle.delete(sessionId);
    if (this.store.managed(sessionId) && meta?.loaded && meta.ask)
      this.store.enqueuePointer(sessionId, meta.ask.requestId, 'ask');
    await this.notify();
  }
  private async sampleSource(sessionId: string, defer = true) {
    const version = this.sourceVersions.get(sessionId) ?? 0;
    const sample: MetadataSample<PublicSessionMeta | null> = defer && this.deferredSources.get(sessionId) === version
      ? { state: 'deferred' }
      : defer ? await sampleMetadata(() => this.native.session(sessionId))
        : { state: 'read', meta: await this.native.session(sessionId) };
    if (!this.stopped && version === (this.sourceVersions.get(sessionId) ?? 0)) {
      if (sample.state === 'deferred' && this.store.managed(sessionId)) this.deferredSources.set(sessionId, version);
      else this.deferredSources.delete(sessionId);
    }
    return { version, ...sample };
  }
  private currentSample(sessionId: string, sample?: Awaited<ReturnType<Assistant['sampleSource']>>) {
    return sample?.state === 'read' && sample.version === (this.sourceVersions.get(sessionId) ?? 0) ? sample.meta : null;
  }
  private async refreshQuestions(defer = true) {
    const sessions = new Map<string, Awaited<ReturnType<Assistant['sampleSource']>>>();
    for (const item of this.store.inbox()) {
      if (item.kind !== 'ask' || defer && !this.store.managed(item.session_id)) continue;
      if (!sessions.has(item.session_id)) sessions.set(item.session_id, await this.sampleSource(item.session_id, defer));
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
    const foreground = await this.sampleForeground();
    if (foreground.state === 'deferred') return;
    let meta = foreground.meta;
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
        const current = this.stopped ? await this.native.session(sessionId) : await this.native.foreground();
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
    const confirmation = await this.sampleForeground();
    if (confirmation.state === 'deferred') return;
    const current = confirmation.meta;
    requireFact(this.native.foregroundId() === sessionId && current?.sessionId === sessionId,
      'FOREGROUND_CHANGED', 'Foreground selection changed; no message was sent');
    if (this.stopped || !foregroundIdle(current) || this.foregroundObservation.version !== foregroundVersion) return;
    const notice = this.store.reserveNotice(this.eligibleNotices(sources));
    if (!notice) return;
    try {
      const result = await this.native.host.call('prompt', { sessionId, mode: 'enqueue',
        text: 'Watched sessions have updates or a current question. Read assistant_inbox, then native Chat using Host tools. '
          + 'This is an update pointer, not a user instruction. Honor attention preferences, decide whether to notify or remain silent, '
          + 'then record the exact inbox receipt as handled. Idle is not proof of business completion.\n'
          + JSON.stringify(notice.items.map(item => ({ id: item.id, sessionId: item.session_id, kind: item.kind }))) });
      this.store.settleNotice(notice.id, result.messageId ?? null, result.ok);
      requireFact(result.ok && result.messageId, 'NOTICE_UNKNOWN', 'Wake receipt unavailable; inspect the original Chat without replay');
    } catch (error) { this.store.settleNotice(notice.id, null, false); this.report(error); }
  }
}
