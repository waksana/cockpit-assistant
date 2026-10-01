import type { McpInvocationMeta, NativeChatEvent, PublicSessionMeta } from '@waksana/cockpit-module-sdk/backend';
import { homedir } from 'node:os';
import { z } from 'zod';
import { attachmentsSchema } from './attachments.ts';
import { BusinessError, errorText, requireFact } from './errors.ts';
import type { Caller, Gateway, Input } from './gateway.ts';
import { Store, fingerprint, incomingIdentity, type Delivery, type Incoming, type Topic } from './store.ts';
import { questionIdentity } from './question.ts';

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
});
export const historyInput = z.strictObject({ sessionId: id, cursor: z.string().min(1).max(16384).optional() });
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
const activeRole = (meta: PublicSessionMeta, name: string) =>
  meta.appliedRoles?.some(role => role.moduleId === 'assistant' && role.roleId === name) === true;
const worker = (meta: PublicSessionMeta | null): meta is PublicSessionMeta => !!meta
  && (Array.isArray(meta.roles) || Array.isArray(meta.appliedRoles))
  && ![...(meta.roles ?? []), ...(meta.appliedRoles ?? [])].some(role =>
    role.moduleId === 'assistant' && role.roleId !== 'worker');
const primary = (event: NativeChatEvent) => !event.ephemeral && !event.agentId && !event.parentToolCallId
  && !event.data.agentId && !event.data.parentToolCallId;
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
  sessionId: topic.session_id, archived: topic.archived, version: topic.version,
  mappingState: topic.mapping_state, error: topic.mapping_error });

export class Assistant {
  private notice: Promise<void> | null = null;
  private noticeAgain = false;
  private creations = new Map<string, Promise<string>>();
  private stopped = false;
  constructor(readonly store: Store, readonly native: Gateway, readonly config: Config,
    readonly report: (error: unknown) => void) {}
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
      case 'assistant_inbox': {
        requireFact(caller.role === 'coordinator', 'FOREGROUND_REQUIRED', 'Only the Assistant foreground reads the inbox', 403);
        const query = inboxInput.parse(input ?? {});
        if (query.peek) return { count: this.store.inbox().length };
        const result = this.store.take(`${caller.sessionId}:${caller.toolCallId}`, query.limit, query.ids);
        return { ...result, items: result.items.map(item => ({
          id: item.id, sessionId: item.session_id, nativeMessageId: item.native_id, type: item.kind,
          text: item.text, attachments: item.attachments, question: item.question,
          candidateTopicIds: this.store.topics().filter(topic => topic.session_id === item.session_id).map(topic => topic.id),
        })) };
      }
      case 'assistant_history': {
        const query = historyInput.parse(input);
        requireFact(caller.role === 'organizer' ? organizerSources(caller).includes(query.sessionId) : this.store.managed(query.sessionId),
          'HISTORY_SCOPE', 'Read only registered topic sessions or this organizer input selected IDs', 403);
        requireFact(worker(await this.native.session(query.sessionId)), 'INTERNAL_HISTORY', 'Internal sessions are not business history');
        return this.native.host.call('session/chat', { sessionId: query.sessionId, source: 'persisted',
          direction: 'backward', max: 16, bootstrap: false, waitMs: 0, ...(query.cursor ? { cursor: query.cursor } : {}) });
      }
      case 'assistant_status': {
        const { topicId } = z.strictObject({ topicId: id }).parse(input), topic = this.store.topic(topicId);
        const meta = topic.session_id ? await this.native.session(topic.session_id) : null;
        return { topic: displayTopic(topic), session: meta ? { sessionId: meta.sessionId, loaded: meta.loaded,
          status: meta.status, activity: meta.activity, ask: meta.ask } : null };
      }
      default: throw new BusinessError('UNKNOWN_TOOL', 'Unknown or retired Assistant tool', 400);
    }
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
    requireFact(sender?.loaded && !sender.rolesNeedReload && activeRole(sender, 'coordinator'),
      'CALLER_ROLE', 'The foreground role changed before dispatch', 403);
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
          row.mode = 'prompt'; this.store.finish(row);
          called = true;
          const result = await this.native.host.call('prompt', { sessionId, mode: 'enqueue', text: prompt,
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
    const worker = this.config.worker;
    const scope = worker.toolScope ?? { builtins: ['view', 'grep', 'glob', 'bash', 'apply_patch', 'ask_user', 'skill'], mcpServers: [] };
    requireFact(!scope.mcpServers.some(server => ['assistant', 'cockpit'].includes(server.name)), 'WORKER_SCOPE',
      'Workers do not receive foreground or generic peer-message tools');
    requireFact(!worker.roles?.some(role => role.moduleId === 'assistant' && role.roleId !== 'worker'), 'WORKER_ROLE',
      'Worker and foreground roles cannot be combined');
    requireFact(!this.stopped, 'STOPPING', 'Assistant stopped before worker creation', 503);
    topic.mapping_state = 'calling'; this.store.saveTopic(topic);
    try {
      const result = await this.native.host.call('session/new', { cwd: worker.cwd ?? this.config.defaultCwd,
        roles: [...(worker.roles ?? []).filter(role => role.moduleId !== 'assistant'), { moduleId: 'assistant', roleId: 'worker' }],
        toolScope: scope });
      topic = this.store.topic(topic.id);
      requireFact(topic.mapping_state === 'calling' && result.sessionId, 'CREATE_UNKNOWN', 'Worker creation changed or has no receipt');
      topic.session_id = result.sessionId; topic.creation_receipt = result; topic.mapping_state = 'bound'; topic.version++;
      this.store.saveTopic(topic); return result.sessionId;
    } catch (error) {
      topic = this.store.topic(topic.id);
      if (topic.mapping_state === 'calling') {
        topic.mapping_state = 'unknown'; topic.mapping_error = errorText(error);
        if (error && typeof error === 'object') topic.creation_receipt = {
          error: errorText(error),
          ...('sessionId' in error && typeof error.sessionId === 'string' ? { sessionId: error.sessionId } : {}),
          ...('createdId' in error && typeof error.createdId === 'string' ? { createdId: error.createdId } : {}),
        };
        this.store.saveTopic(topic);
      }
      throw error;
    }
  }
  async observe(sessionId: string, event?: NativeChatEvent): Promise<void> {
    if (this.stopped) return;
    if (event) this.native.observe(sessionId, event);
    if (!this.store.managed(sessionId)) return;
    const meta = await this.native.session(sessionId);
    if (!worker(meta)) return;
    if (event && primary(event) && event.type === 'assistant.message'
      && (typeof event.data.content === 'string' && event.data.content.trim() || Array.isArray(event.data.attachments) && event.data.attachments.length)) {
      const item: Incoming = { session_id: sessionId, native_id: typeof event.data.messageId === 'string' ? event.data.messageId : event.id,
        kind: 'reply', text: typeof event.data.content === 'string' ? event.data.content : '',
        attachments: attachmentsSchema.parse(event.data.attachments ?? []), question: null };
      this.store.enqueue(item);
    }
    if (meta.ask) this.store.enqueue({ session_id: sessionId, native_id: meta.ask.requestId, kind: 'ask',
      text: meta.ask.question, attachments: [], question: meta.ask });
    await this.notify();
  }
  notify(): Promise<void> {
    if (this.notice) { this.noticeAgain = true; return this.notice; }
    this.notice = this.sendNotice().finally(() => {
      this.notice = null;
      if (this.noticeAgain && !this.stopped) {
        this.noticeAgain = false; void this.notify().catch(this.report);
      }
    });
    return this.notice;
  }
  private async sendNotice(): Promise<void> {
    if (this.stopped || !this.store.inbox().some(item => item.notice_state === 'pending')) return;
    const meta = await this.native.foreground();
    if (!meta?.loaded || meta.status !== 'idle' || !meta.activity || meta.activity.hasActiveWork
      || meta.activity.processing || meta.ask || !activeRole(meta, 'coordinator')) return;
    const notice = this.store.reserveNotice();
    if (!notice) return;
    try {
      const result = await this.native.host.call('prompt', { sessionId: meta.sessionId, mode: 'enqueue',
        text: `New topic results are available. Read assistant_inbox; this is not a new business request.\n${JSON.stringify(
          notice.items.map(item => ({ id: item.id, sessionId: item.session_id, kind: item.kind })))}` });
      this.store.settleNotice(notice.id, result.messageId ?? null, result.ok);
      requireFact(result.ok && result.messageId, 'NOTICE_UNKNOWN', 'Notification receipt is unavailable; inspect the native session without replay');
    } catch (error) { this.store.settleNotice(notice.id, null, false); this.report(error); }
  }
}
