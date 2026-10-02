import type { McpInvocationMeta, NativeChatEvent, PublicSessionMeta } from '@waksana/cockpit-module-sdk/backend';
import { homedir } from 'node:os';
import { z } from 'zod';
import { attachmentsSchema } from './attachments.ts';
import { BusinessError, errorText, requireFact } from './errors.ts';
import type { Caller, Gateway, Input } from './gateway.ts';
import { Store, fingerprint, incomingIdentity, type Delivery, type Incoming, type Topic } from './store.ts';
import { questionIdentity } from './question.ts';
import { appliedAssistantRole, assistantRole, roleIdentity } from './roles.ts';
import { Evidence, readInput, resolveInput } from './evidence.ts';

const id = z.string().min(1).max(200);
export const topicInput = z.strictObject({
  topicId: id.optional(), title: z.string().trim().min(1).max(240).optional(),
  content: z.string().max(16000).optional(), archived: z.boolean().optional(), sessionId: id.nullable().optional(),
});
export const dispatchInput = z.strictObject({
  items: z.array(z.strictObject({ topicId: id, prompt: z.string().trim().min(1).max(100000) })).min(1).max(20),
});
export const inboxInput = z.strictObject({
  ids: z.array(id).min(1).max(100).optional(), limit: z.int().min(1).max(100).default(50), peek: z.boolean().default(false),
  decisionsAfter: z.int().nonnegative().default(0),
});
export const historyInput = z.strictObject({
  sessionId: id, cursor: z.string().min(1).max(16384).optional(), recent: z.boolean().optional(),
});
export const pageInput = z.strictObject({ after: z.int().nonnegative().default(0), limit: z.int().min(1).max(100).default(50) });
const role = z.strictObject({ moduleId: id, roleId: id });
const toolScope = z.strictObject({
  builtins: z.array(id).max(256), mcpServers: z.array(z.strictObject({ name: id, tools: z.array(id).max(256) })).max(64),
});
export const configInput = z.strictObject({
  defaultCwd: z.string().startsWith('/').default(homedir),
  foregroundSessionId: id.nullable().default(null),
  worker: z.strictObject({ cwd: z.string().startsWith('/').optional(), roles: z.array(role).max(64).optional(),
    toolScope: toolScope.optional() }).default({}),
});
export type Config = z.infer<typeof configInput>;
const retiredWorker = (selection: z.infer<typeof role>) => selection.moduleId === 'assistant' && selection.roleId === 'worker';
const legacyBuiltins = ['view', 'grep', 'glob', 'bash', 'apply_patch', 'ask_user', 'skill'];
function sessionOptions(config: Config) {
  const { cwd, roles, toolScope } = config.worker;
  // Only the complete former built-in preset identifies a scope we may retire.
  const legacy = roles?.length === 1 && retiredWorker(roles[0]!) && toolScope
    && toolScope.mcpServers.length === 0 && toolScope.builtins.length === legacyBuiltins.length
    && legacyBuiltins.every(name => toolScope.builtins.includes(name));
  const selectedRoles = roles?.filter(role => !retiredWorker(role));
  return { cwd: cwd ?? config.defaultCwd,
    ...(selectedRoles?.length ? { roles: selectedRoles } : {}),
    ...(toolScope && !legacy ? { toolScope } : {}) };
}
const worker = (meta: PublicSessionMeta | null): meta is PublicSessionMeta => !!meta
  && (Array.isArray(meta.roles) || Array.isArray(meta.appliedRoles))
  && ![...(meta.roles ?? []), ...(meta.appliedRoles ?? [])].some(role =>
    role.moduleId === 'assistant' && role.roleId !== 'worker');
const rootEvent = (event: NativeChatEvent) => !event.agentId && !event.parentToolCallId
  && !event.data.agentId && !event.data.parentToolCallId;
const primary = (event: NativeChatEvent) => !event.ephemeral && rootEvent(event);
const settled = (meta: PublicSessionMeta) => meta.loaded && ['idle', 'error'].includes(meta.status)
  && !!meta.activity && !meta.activity.hasActiveWork && !meta.activity.processing
  && meta.activity.queue.pendingCount === 0 && meta.activity.queue.steeringCount === 0
  && meta.activity.queue.inFlightSteeringCount === 0 && !meta.ask;
const liveQuestion = (meta: PublicSessionMeta | null | undefined, question: Incoming['question']) =>
  !!meta?.loaded && worker(meta) && !!meta.ask
  && fingerprint(questionIdentity(meta.ask)) === fingerprint(questionIdentity(question));
const foregroundIdle = (meta: PublicSessionMeta) => meta.status === 'idle' && settled(meta);
const foregroundRole = (meta: PublicSessionMeta) => appliedAssistantRole(meta) === 'coordinator';
function historyExcerpt(text: string): string {
  let low = 0, high = Math.min(text.length, 3000);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(text.slice(0, middle))) <= 3000) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low).replace(/[\uD800-\uDBFF]$/u, '');
}
const human = (caller: Caller): Input => {
  requireFact(caller.role === 'coordinator' && caller.input?.human, 'HUMAN_REQUIRED',
    'Only a genuine native Chat input can authorize business dispatch or registry changes', 403);
  return caller.input;
};
function organizerSources(caller: Caller): string[] {
  requireFact(caller.role === 'organizer' && caller.input?.human, 'ORGANIZER_SCOPE', 'Only a native user input selects organizer sources', 403);
  const value = /^historySessionIds:\s*(\[.*\])\s*$/m.exec(caller.input.text)?.[1];
  requireFact(value, 'ORGANIZER_SCOPE', 'Include historySessionIds: ["native-session-id"] in this input to select history explicitly', 403);
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new BusinessError('ORGANIZER_SCOPE', 'historySessionIds must be a JSON array', 400);
  }
  return z.array(id).max(20).parse(parsed);
}
const displayTopic = (topic: Topic) => ({ topicId: topic.id, title: topic.title, content: topic.content,
  contentUse: 'identity-responsibility-scope-only',
  warning: 'Registry content may contain legacy progress notes. It is background, never current progress or completion evidence.',
  sessionId: topic.session_id, archived: topic.archived, version: topic.version,
  mappingState: topic.mapping_state, error: topic.mapping_error, creationReceipt: topic.creation_receipt });

export class Assistant {
  readonly evidence: Evidence;
  private notice: Promise<void> | null = null;
  private noticeAgain = false;
  private creations = new Map<string, Promise<string>>();
  private observations = new Map<string, Promise<void>>();
  private awaitingIdle = new Set<string>();
  private sourceVersions = new Map<string, number>();
  private foregroundObservation = { sessionId: '', version: 0 };
  private stopped = false;
  constructor(readonly store: Store, readonly native: Gateway, readonly config: Config,
    readonly report: (error: unknown) => void) {
    this.evidence = new Evidence(store, native, () => this.stopped);
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
      case 'assistant_dispatch': return this.deliver(caller, dispatchInput.parse(input).items);
      case 'assistant_read': {
        requireFact(caller.role === 'coordinator', 'FOREGROUND_REQUIRED', 'Only the foreground reads update evidence', 403);
        return this.evidence.read(caller, readInput.parse(input));
      }
      case 'assistant_resolve': {
        requireFact(caller.role === 'coordinator', 'FOREGROUND_REQUIRED', 'Only the foreground decides update presentation', 403);
        return this.evidence.resolve(caller, resolveInput.parse(input));
      }
      case 'assistant_inbox': {
        requireFact(caller.role === 'coordinator', 'FOREGROUND_REQUIRED', 'Only the Assistant foreground reads the inbox', 403);
        const query = inboxInput.parse(input ?? {});
        const sources = await this.refreshQuestions();
        const available = new Set(this.store.inbox().filter(item => item.kind !== 'ask'
          || liveQuestion(this.currentSample(item.session_id, sources.get(item.session_id)), item.question)).map(item => item.id));
        if (query.peek) return { count: available.size };
        const pending = this.store.inbox().filter(item => available.has(item.id) && (!query.ids || query.ids.includes(item.id)));
        const selected = pending.slice(0, query.limit), tokens = new Map<string, string>();
        for (const item of selected) if (item.kind !== 'ask' && !tokens.has(item.session_id))
          tokens.set(item.session_id, this.evidence.locations(item.session_id, caller.sessionId,
            selected.filter(row => row.kind !== 'ask' && row.session_id === item.session_id)
              .map(row => this.store.source(row.id)?.eventId ?? row.native_id)));
        await this.evidence.reconcileOutput(caller.sessionId);
        return { items: selected.filter(item => item.kind !== 'ask'
          || liveQuestion(this.currentSample(item.session_id, sources.get(item.session_id)), item.question)).map(item => ({
          id: item.id, sessionId: item.session_id, nativeMessageId: item.native_id, type: item.kind,
          source: this.store.source(item.id), wake: { state: item.notice_state === 'notified' ? 'accepted' : item.notice_state,
            noticeId: item.notice_id, nativeMessageId: item.notification_receipt },
          ...(item.kind === 'ask' ? { question: item.question,
            receipt: this.evidence.question(caller, item.id, item.native_id, item.session_id) }
            : { readToken: tokens.get(item.session_id) }),
          candidateTopicIds: this.store.topics().filter(topic => topic.session_id === item.session_id).map(topic => topic.id),
        })), hasMore: pending.length > selected.length, pendingDecisions: this.evidence.pendingSummary(caller.sessionId, query.decisionsAfter),
          consumed: false, warning: 'Locations and wake receipts are not business evidence. Read native Chat, then resolve its exact receipt.' };
      }
      case 'assistant_history': {
        const query = historyInput.parse(input);
        requireFact(caller.role === 'organizer' ? organizerSources(caller).includes(query.sessionId)
          : this.store.managed(query.sessionId) || query.sessionId === caller.sessionId,
          'HISTORY_SCOPE', 'Read only registered topic sessions or this organizer input selected IDs', 403);
        requireFact(caller.role === 'coordinator' && query.sessionId === caller.sessionId || worker(await this.native.session(query.sessionId)),
          'INTERNAL_HISTORY', 'Internal sessions are not business history');
        if (query.recent ?? caller.role === 'organizer') {
          requireFact(!query.cursor, 'RECENT_HISTORY_CURSOR', 'Recent sampling starts at the latest event; use recent:false for native cursor pages', 400);
          return this.recentHistory(query.sessionId);
        }
        return this.native.host.call('session/chat', { sessionId: query.sessionId, source: 'persisted',
          direction: 'backward', max: 16, bootstrap: false, waitMs: 0, ...(query.cursor ? { cursor: query.cursor } : {}) });
      }
      case 'assistant_status': {
        const { topicId } = z.strictObject({ topicId: id }).parse(input), topic = this.store.topic(topicId);
        const meta = topic.session_id ? await this.native.session(topic.session_id) : null;
        requireFact(!meta || worker(meta), 'INTERNAL_HISTORY', 'The registered source is no longer a business session');
        await this.evidence.reconcileOutput(caller.sessionId);
        return { topic: displayTopic(topic), session: meta ? { sessionId: meta.sessionId, loaded: meta.loaded,
          status: meta.status, activity: meta.activity, ask: meta.ask } : null,
          freshness: meta ? await this.evidence.check(meta.sessionId, caller.sessionId) : null,
          health: await this.health(), pendingDecisions: this.evidence.pendingSummary(caller.sessionId) };
      }
      default: throw new BusinessError('UNKNOWN_TOOL', 'Unknown or retired Assistant tool', 400);
    }
  }
  async health() {
    const checkedAt = Date.now(), wake = this.store.foregroundWake();
    const lastWakeAttempt = wake ? { ...wake, at: this.store.receipt('foreground-wake')?.createdAt ?? null } : null;
    let sessionId: string | null = null;
    try {
      const meta = await this.native.foreground();
      sessionId = meta?.sessionId ?? null;
      if (!meta?.loaded) return { current: { sessionId, checkedAt, readiness: 'unknown', loaded: meta?.loaded ?? null },
        lastWakeAttempt, pendingUpdates: this.store.inbox().length };
      await this.native.validateForeground(meta);
      return { current: { sessionId, checkedAt, readiness: 'ready', loaded: true },
        lastWakeAttempt, pendingUpdates: this.store.inbox().length };
    } catch (error) {
      return { current: { sessionId, checkedAt, readiness: error instanceof BusinessError ? 'not-ready' : 'unknown',
        error: errorText(error) }, lastWakeAttempt, pendingUpdates: this.store.inbox().length };
    }
  }
  private async recentHistory(sessionId: string) {
    const messages: { eventId: string; messageId: string | null; type: string;
      content: string; truncated: boolean; originalLength: number }[] = [];
    let cursor: string | undefined, pages = 0, events = 0, hasMore = true;
    const cursors = new Set<string>();
    while (messages.length < 3 && hasMore && pages < 16) {
      requireFact(!this.stopped, 'STOPPING', 'Assistant stopped before reading another native history page', 503);
      const page = await this.native.host.call('session/chat', { sessionId, source: 'persisted',
        direction: 'backward', max: 32, bootstrap: false, waitMs: 0, ...(cursor ? { cursor } : {}) });
      requireFact(page.sessionId === sessionId && page.source === 'persisted' && page.direction === 'backward',
        'NATIVE_HISTORY', 'Native history returned a different source or direction');
      requireFact(page.cursorStatus === 'ok', 'NATIVE_HISTORY', 'Native history cursor expired; no complete recent sample was inferred');
      requireFact(page.events.length <= 32 && (!page.hasMore || (page.cursor && !cursors.has(page.cursor))),
        'NATIVE_HISTORY', 'Native history exceeded its page bound or did not advance');
      pages++; events += page.events.length; hasMore = page.hasMore;
      // Backward pages remain in append order. Ignore event timestamps and opaque IDs for ordering.
      for (const event of page.events.toReversed()) {
        if (!primary(event) || !['user.message', 'assistant.message'].includes(event.type)
          || typeof event.data.content !== 'string' || !event.data.content.trim()) continue;
        const content = historyExcerpt(event.data.content);
        messages.push({ eventId: event.id,
          messageId: typeof event.data.messageId === 'string' ? event.data.messageId : null,
          type: event.type, content, truncated: content.length < event.data.content.length,
          originalLength: event.data.content.length });
        if (messages.length === 3) break;
      }
      cursor = page.cursor; cursors.add(page.cursor);
    }
    const complete = messages.length === 3 || !hasMore;
    const result = { sessionId, source: 'persisted', view: 'recent', limit: 3, order: 'oldest-first',
      messages: messages.reverse(), complete, scanLimited: !complete, read: { pages, events } };
    requireFact(Buffer.byteLength(JSON.stringify(result)) <= 12000,
      'HISTORY_OUTPUT_LIMIT', 'Native message identities exceed the recent history output budget');
    return result;
  }
  private async editTopic(caller: Caller, value: z.infer<typeof topicInput>) {
    const selected = caller.role === 'organizer' ? organizerSources(caller) : (human(caller), null);
    const key = `topic:${caller.sessionId}:${caller.toolCallId}`, hash = fingerprint(value);
    const topicId = value.topicId ?? fingerprint(key);
    if (this.store.seen(key, hash)) return displayTopic(this.store.topic(topicId));
    const old = value.topicId ? this.store.topic(value.topicId) : null;
    requireFact(old || value.title, 'TOPIC_TITLE', 'A new topic requires a title');
    const checkScope = (session: string | null | undefined) => {
      requireFact(!selected || !session || selected.includes(session), 'ORGANIZER_SCOPE',
        'Organizer edits must remain within this input selected history', 403);
    };
    checkScope(old?.session_id); checkScope(value.sessionId);
    if (value.sessionId) requireFact(worker(await this.native.session(value.sessionId)), 'MAPPING_TARGET',
      'Select an existing business session, not a foreground or organizer');
    return this.store.transaction(() => {
      if (this.store.seen(key, hash)) return displayTopic(this.store.topic(topicId));
      const current = old ? this.store.topic(old.id) : null;
      checkScope(current?.session_id);
      requireFact(!current || current.version === old!.version, 'TOPIC_CHANGED', 'The topic changed during validation; inspect it before editing');
      requireFact(!current || !['calling', 'unknown'].includes(current.mapping_state), 'UNCERTAIN_MAPPING',
        'Inspect the original uncertain creation rather than silently replacing its mapping');
      const sessionId = value.sessionId === undefined ? current?.session_id ?? null : value.sessionId;
      const topic: Topic = { id: topicId, title: value.title ?? current!.title, content: value.content ?? current?.content ?? '',
        archived: value.archived ?? current?.archived ?? false, version: (current?.version ?? 0) + 1,
        session_id: sessionId, mapping_state: sessionId ? 'bound' : 'unbound', mapping_error: null,
        creation_receipt: current?.creation_receipt ?? null };
      this.store.saveTopic(topic); this.store.remember(key, hash);
      return displayTopic(topic);
    });
  }
  private async deliver(caller: Caller, items: z.infer<typeof dispatchInput>['items']) {
    const source = human(caller);
    if (this.store.deliveries(source.sessionId, source.messageId).length)
      return this.store.begin(source.sessionId, source.messageId, items).deliveries;
    const questions = new Map<string, NonNullable<PublicSessionMeta['ask']>>();
    const versions = new Map<string, number>();
    for (const item of items) {
      const topic = this.store.topic(item.topicId);
      versions.set(topic.id, topic.version);
      if (!topic.session_id) continue;
      const meta = await this.native.session(topic.session_id);
      requireFact(worker(meta), 'MAPPING_TARGET', 'Original target is missing or is an internal session');
      if (meta.ask) {
        requireFact(items.length === 1 && item.prompt.trim() === source.text.trim(), 'ASK_ORIGINAL',
          'Answer a native question separately with your complete original words; mixed dispatch was not sent');
        requireFact(source.attachments.length === 0, 'ASK_ATTACHMENTS', 'Native answers do not support attachments');
        requireFact(meta.ask.choices?.includes(source.text.trim()) || meta.ask.allowFreeform !== false,
          'ASK_CHOICE', 'Use one complete offered choice');
        const observed = this.store.observed(incomingIdentity({ session_id: meta.sessionId, native_id: meta.ask.requestId,
          kind: 'ask', text: meta.ask.question, attachments: [], question: meta.ask }).id);
        requireFact(observed !== null && source.createdAt > observed, 'ASK_SOURCE_ORDER',
          'A native answer must follow this exact observed question');
        questions.set(item.topicId, meta.ask);
      }
    }
    const sender = await this.native.session(source.sessionId);
    requireFact(sender && foregroundRole(sender),
      'CALLER_ROLE', 'The foreground role changed before dispatch', 403);
    await this.native.validateForeground(sender);
    requireFact(!this.stopped, 'STOPPING', 'Assistant stopped before dispatch', 503);
    for (const [id, version] of versions) requireFact(this.store.topic(id).version === version,
      'TOPIC_CHANGED', 'Topic mapping changed during dispatch validation; inspect it before sending');
    const started = this.store.begin(source.sessionId, source.messageId, items);
    if (!started.fresh) return started.deliveries;
    for (let index = 0; index < started.deliveries.length; index++) {
      let row = started.deliveries[index]!, called = false;
      try {
        const sessionId = await this.ensureWorker(row), prompt = items[index]!.prompt;
        row = this.store.delivery(row.id);
        row.session_id = sessionId; this.store.finish(row);
        let meta = await this.native.session(sessionId);
        requireFact(worker(meta), 'MAPPING_TARGET', 'Original worker is missing or has an internal role');
        requireFact(!this.stopped, 'STOPPING', 'Assistant stopped before native delivery', 503);
        if (!meta.loaded) {
          requireFact(!meta.roles?.some(retiredWorker), 'RETIRED_WORKER_ROLE',
            'The original session retains the removed assistant/worker role. Resolve its saved role through the Host before loading; no replacement or prompt was sent');
          called = true;
          const loaded = await this.native.host.call('session/load', { sessionId });
          requireFact(loaded.ok && loaded.sessionId === sessionId, 'LOAD_UNKNOWN', 'Original worker load was not confirmed');
          meta = await this.native.session(sessionId);
          requireFact(worker(meta) && meta.loaded, 'MAPPING_TARGET', 'Worker changed during load');
          called = false;
        }
        const question = questions.get(row.topic_id);
        requireFact(fingerprint(questionIdentity(meta.ask)) === fingerprint(questionIdentity(question)),
          'STALE_ASK', 'The current native question changed; no substitute prompt or answer was sent');
        if (question) {
          const answer = source.text.trim(), choice = question.choices?.includes(answer) ?? false;
          requireFact(choice || question.allowFreeform !== false, 'ASK_CHOICE', 'Use one complete offered choice');
          row.mode = 'ask'; row.request_id = question.requestId; this.store.finish(row);
          const current = await this.native.session(sessionId);
          requireFact(!this.stopped && worker(current)
            && fingerprint(questionIdentity(current.ask)) === fingerprint(questionIdentity(question)),
          'STALE_ASK', 'The native question changed or Assistant is stopping');
          called = true;
          const result = await this.native.host.call('respondAsk', { sessionId, requestId: question.requestId, answer, wasFreeform: !choice });
          row.result = result; row.state = result.ok ? 'accepted' : 'rejected';
        } else {
          requireFact(!this.stopped, 'STOPPING', 'Assistant stopped before worker prompt', 503);
          row.mode = 'prompt'; this.store.finish(row);
          called = true;
          const result = await this.native.host.call('prompt', { sessionId, mode: 'immediate', text: prompt,
            ...(source.attachments.length ? { attachments: source.attachments } : {}) });
          row.native_message_id = result.messageId ?? null; row.result = result;
          row.state = !result.ok ? 'rejected' : result.messageId ? 'accepted' : 'unknown';
        }
        row.error = row.state === 'accepted' ? null : 'Native delivery was rejected or its receipt is unavailable';
        this.store.finish(row);
      } catch (error) {
        row = this.store.delivery(row.id);
        if (row.state !== 'calling') throw error;
        row.state = called || this.store.topic(row.topic_id).mapping_state === 'unknown' ? 'unknown' : 'rejected';
        row.error = errorText(error); this.store.finish(row); this.report(error);
      }
    }
    return this.store.deliveries(source.sessionId, source.messageId);
  }
  private ensureWorker(delivery: Delivery): Promise<string> {
    if (delivery.session_id) return Promise.resolve(delivery.session_id);
    const existing = this.creations.get(delivery.topic_id);
    if (existing) return existing;
    const creating = this.createWorker(delivery).finally(() => { this.creations.delete(delivery.topic_id); });
    this.creations.set(delivery.topic_id, creating);
    return creating;
  }
  private async createWorker(delivery: Delivery): Promise<string> {
    if (delivery.session_id) return delivery.session_id;
    let topic = this.store.topic(delivery.topic_id);
    if (topic.session_id) return topic.session_id;
    requireFact(topic.mapping_state === 'unbound', 'UNKNOWN_CREATION', 'Inspect the uncertain worker; do not create a replacement');
    const options = sessionOptions(this.config);
    requireFact(!options.toolScope?.mcpServers.some(server => ['assistant', 'cockpit'].includes(server.name)), 'WORKER_SCOPE',
      'Workers do not receive foreground or generic peer-message tools');
    requireFact(!options.roles?.some(role => role.moduleId === 'assistant'), 'WORKER_ROLE',
      'Worker and foreground roles cannot be combined');
    requireFact(!this.stopped, 'STOPPING', 'Assistant stopped before worker creation', 503);
    topic.mapping_state = 'calling'; this.store.saveTopic(topic);
    let created: { sessionId: string } | undefined;
    try {
      const result = await this.native.host.call('session/new', options);
      created = result;
      topic = this.store.topic(topic.id);
      requireFact(topic.mapping_state === 'calling' && result.sessionId, 'CREATE_UNKNOWN', 'Worker creation changed or has no receipt');
      topic.session_id = result.sessionId; topic.creation_receipt = result; topic.mapping_state = 'bound'; topic.version++;
      this.store.saveTopic(topic); return result.sessionId;
    } catch (error) {
      topic = this.store.topic(topic.id);
      if (topic.mapping_state === 'calling') {
        topic.mapping_state = 'unknown'; topic.mapping_error = errorText(error);
        const detail = error && typeof error === 'object' ? error : {};
        const code = 'code' in detail && typeof detail.code === 'string' ? detail.code : undefined;
        topic.creation_receipt = {
          stage: created ? 'binding' : code === 'SESSION_CREATION_INCOMPLETE' ? 'readiness' : 'creation',
          promptAttempted: false, error: errorText(error), ...(code ? { code } : {}),
          ...(created ?? ('sessionId' in detail && typeof detail.sessionId === 'string' ? { sessionId: detail.sessionId } : {})),
          ...('createdId' in detail && typeof detail.createdId === 'string' ? { createdId: detail.createdId } : {}),
        };
        this.store.saveTopic(topic);
      }
      throw error;
    }
  }
  observe(sessionId: string, event?: NativeChatEvent): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (sessionId === this.foregroundObservation.sessionId) this.foregroundObservation.version++;
    if (event) this.native.observe(sessionId, event);
    const foreground = event ? this.evidence.observeForeground(sessionId, event) : Promise.resolve();
    if (!this.store.managed(sessionId)) return foreground;
    this.sourceVersions.set(sessionId, (this.sourceVersions.get(sessionId) ?? 0) + 1);
    // Native callbacks may overlap while metadata is awaited. Drain each source
    // in event order so an idle wake cannot reserve only the first of its replies.
    const run = async () => { await foreground; await this.observeSource(sessionId, event); };
    const previous = this.observations.get(sessionId);
    const operation = previous ? previous.then(run, run) : run();
    this.observations.set(sessionId, operation);
    const finished = () => { if (this.observations.get(sessionId) === operation) this.observations.delete(sessionId); };
    void operation.then(finished, finished);
    return operation;
  }
  private async observeSource(sessionId: string, event?: NativeChatEvent): Promise<void> {
    if (this.stopped) return;
    const meta = await this.native.session(sessionId);
    if (!worker(meta)) return;
    if (event && primary(event) && event.type === 'assistant.message'
      && (typeof event.data.content === 'string' && event.data.content.trim() || Array.isArray(event.data.attachments) && event.data.attachments.length)) {
      const item: Incoming = { session_id: sessionId, native_id: typeof event.data.messageId === 'string' ? event.data.messageId : event.id,
        kind: 'reply', text: typeof event.data.content === 'string' ? event.data.content : '',
        attachments: attachmentsSchema.parse(event.data.attachments ?? []), question: null };
      if (this.store.enqueue(item, 'pending', { eventId: event.id, timestamp: event.timestamp ?? null })) this.awaitingIdle.add(sessionId);
    }
    if (event && primary(event) && ['abort', 'session.error'].includes(event.type)) {
      const detail = event.type === 'abort' ? 'Native processing was interrupted.'
        : `Native processing reported an error: ${typeof event.data.message === 'string' ? event.data.message : 'No error text supplied'}`;
      if (this.store.enqueue({ session_id: sessionId, native_id: event.id, kind: 'reply',
        text: `${detail}\nEarlier output may be incomplete; this is not a successful completion receipt.`,
        attachments: [], question: null }, 'pending', { eventId: event.id, timestamp: event.timestamp ?? null })) this.awaitingIdle.add(sessionId);
    }
    if (event && rootEvent(event) && event.type === 'session.idle'
      || meta.status === 'error' && settled(meta)) this.awaitingIdle.delete(sessionId);
    if (meta.ask) this.store.enqueue({ session_id: sessionId, native_id: meta.ask.requestId, kind: 'ask',
      text: meta.ask.question, attachments: [], question: meta.ask });
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
      if (item.kind !== 'ask') continue;
      if (!this.store.managed(item.session_id)) continue;
      if (!sessions.has(item.session_id)) sessions.set(item.session_id, await this.sampleSource(item.session_id));
    }
    for (const item of this.store.inbox()) {
      if (item.kind !== 'ask') continue;
      const meta = this.currentSample(item.session_id, sessions.get(item.session_id));
      // Keep unavailable questions unread without presenting them as live decisions.
      if (meta?.loaded && fingerprint(questionIdentity(meta.ask)) !== fingerprint(questionIdentity(item.question))) {
        this.evidence.expireQuestion(item.id);
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
          try { await this.sendNotice(); }
          catch (error) { this.report(error); }
        } while (this.noticeAgain && !this.stopped);
      } finally { this.notice = null; }
    })();
    return this.notice;
  }
  private async noticeSources() {
    const sources = await this.refreshQuestions();
    for (const item of this.store.inbox()) {
      if (item.notice_state !== 'pending') continue;
      if (!this.store.managed(item.session_id)) continue;
      if (!sources.has(item.session_id)) sources.set(item.session_id, await this.sampleSource(item.session_id));
    }
    return sources;
  }
  private eligibleNotices(sources: Awaited<ReturnType<Assistant['noticeSources']>>) {
    const eligible = new Set<string>();
    // Later source lookups may yield to a decision change or a new native run.
    // Recheck observations and the live idle latch without another async gap.
    for (const item of this.store.inbox()) {
      if (item.notice_state !== 'pending') continue;
      if (!this.store.managed(item.session_id)) continue;
      const source = this.currentSample(item.session_id, sources.get(item.session_id));
      if (worker(source) && source.loaded
        && (item.kind === 'ask' ? liveQuestion(source, item.question)
          : !this.awaitingIdle.has(item.session_id) && settled(source))) eligible.add(item.id);
    }
    return eligible;
  }
  private async sendNotice(): Promise<void> {
    if (this.stopped || !this.store.inbox().some(item => item.notice_state === 'pending')) return;
    let sources = await this.noticeSources();
    if (this.stopped || !this.eligibleNotices(sources).size) return;
    let meta = await this.native.foreground();
    if (this.stopped || !meta || !this.eligibleNotices(sources).size) return;
    const sessionId = meta.sessionId;
    let loadedForNotice = false;
    if (this.foregroundObservation.sessionId !== sessionId) this.foregroundObservation = { sessionId, version: 0 };
    if (!meta.loaded) {
      const wake = this.store.foregroundWake();
      if (wake?.sessionId === sessionId && wake.state !== 'loaded') return;
      requireFact(assistantRole(meta.roles) === 'coordinator', 'FOREGROUND_ROLE',
        'The original foreground must retain one saved Assistant coordinator identity before loading', 403);
      await this.native.validateForeground(meta, 'saved');
      if (this.stopped) return;
      this.store.saveForegroundWake({ sessionId, state: 'loading', error: null });
      try {
        const result = await this.native.host.call('session/load', { sessionId });
        requireFact(typeof result.ok === 'boolean' && result.sessionId === sessionId, 'FOREGROUND_LOAD_UNKNOWN',
          'Foreground load returned an incomplete receipt or different identity; do not retry automatically');
        if (result.ok !== true) {
          this.store.saveForegroundWake({ sessionId, state: 'failed', error: 'Host rejected the original foreground load' });
          throw new BusinessError('FOREGROUND_LOAD_FAILED', 'Host rejected the original foreground load');
        }
        // Acknowledgement is not proof of loaded state or readiness.
        const current = await this.native.foreground();
        requireFact(current?.sessionId === sessionId && current.loaded, 'FOREGROUND_LOAD_UNKNOWN',
          'The original foreground load could not be confirmed; inspect it without automatic replay');
        this.store.saveForegroundWake({ sessionId, state: 'loaded', error: null });
        loadedForNotice = true;
        meta = current;
      } catch (error) {
        if (this.store.foregroundWake()?.state === 'loading')
          this.store.saveForegroundWake({ sessionId, state: 'unknown', error: errorText(error) });
        throw error;
      }
    }
    if (this.stopped || !foregroundIdle(meta)) return;
    const foregroundVersion = this.foregroundObservation.version;
    const roles = roleIdentity(meta);
    try {
      requireFact(foregroundRole(meta), 'FOREGROUND_ROLE', 'The loaded foreground role is not ready for Assistant notifications', 403);
      await this.native.validateForeground(meta);
    } catch (error) {
      if (loadedForNotice) this.store.saveForegroundWake({ sessionId, state: 'failed', error: errorText(error) });
      throw error;
    }
    if (this.stopped) return;
    sources = await this.noticeSources();
    if (this.stopped) return;
    const current = await this.native.foreground();
    requireFact(current?.sessionId === sessionId, 'FOREGROUND_CHANGED',
      'Foreground selection changed while preparing a notification; no message was sent');
    if (this.stopped || !foregroundIdle(current)) return;
    requireFact(foregroundRole(current) && roleIdentity(current) === roles, 'FOREGROUND_CHANGED',
      'Foreground roles changed after readiness validation; no message was sent');
    if (this.stopped || this.foregroundObservation.version !== foregroundVersion) return;
    const notice = this.store.reserveNotice(this.eligibleNotices(sources));
    if (!notice) return;
    try {
      const result = await this.native.host.call('prompt', { sessionId: meta.sessionId, mode: 'enqueue',
        text: `Registered sessions have updates or a current question. Read assistant_inbox, then assistant_read for native evidence; this is not a new business request. `
          + `Honor user attention preferences. Decide with assistant_resolve: silent for routine/repeated facts, notify before presenting meaningful news or a current question. `
          + `Source idle is not evidence of business success.\n${JSON.stringify(
          notice.items.map(item => ({ id: item.id, sessionId: item.session_id, kind: item.kind })))}` });
      this.store.settleNotice(notice.id, result.messageId ?? null, result.ok);
      requireFact(result.ok && result.messageId, 'NOTICE_UNKNOWN', 'Notification receipt is unavailable; inspect the native session without replay');
    } catch (error) { this.store.settleNotice(notice.id, null, false); this.report(error); }
  }
}
