import { randomUUID } from 'node:crypto';
import type { AskRequest, McpInvocationMeta, ModuleHostApi, NativeChatEvent, PublicSessionMeta, SessionToolScope } from '@waksana/cockpit-module-sdk/backend';
import { fingerprint } from './database.ts';
import { BusinessError, errorText, requireFact } from './errors.ts';
import { finalMessage, hasRole, Ingestion, internal, primary } from './ingestion.ts';
import { AssistantService, askAnswer } from './service.ts';
import { activateRolesSchema, bindingSchema, createSessionSchema, dispatchSchema, inputSchema, organizerInputSchema, topicSchema } from './schema.ts';
import type { AskBinding, ForegroundInput, Message, Operation, Role, Topic } from './types.ts';
import type { Readiness, RoleReadiness, SessionInspection } from './ui-types.ts';
import { creationOptions, ensureTopicSession, roleScope, roleScopeProof } from './topic-session.ts';
import { withRoleMetadata } from './native.ts';
import { questionIdentity } from './question.ts';
import { attachmentsSchema } from './attachments.ts';
export { coordinatorTools } from './topic-session.ts';

export interface HistoryPage {
  events: NativeChatEvent[]; cursor: string | null; liveCursor?: string | null; cursorStatus: string; hasMore: boolean;
}
export interface NativeAccess {
  host: ModuleHostApi;
  scope(sessionId: string): Promise<SessionToolScope>;
  read(sessionId: string, cursor: string | null, bootstrap: boolean, backward?: boolean, all?: boolean): Promise<HistoryPage>;
  answer(sessionId: string, requestId: string, answer: string, wasFreeform: boolean): Promise<{ accepted: boolean; result: unknown }>;
}
function evidenceEvent(event: NativeChatEvent): NativeChatEvent {
  return { id: event.id, type: event.type, ephemeral: event.ephemeral, agentId: event.agentId,
    parentToolCallId: event.parentToolCallId, data: { messageId: event.data.messageId,
      interactionId: event.data.interactionId, agentId: event.data.agentId,
      parentToolCallId: event.data.parentToolCallId,
      ...(Array.isArray(event.data.toolRequests) ? { toolRequests: event.data.toolRequests.map(request =>
        request && typeof request === 'object' && 'toolCallId' in request ? { toolCallId: request.toolCallId } : {}) } : {}) } };
}
export class Runtime {
  readonly ingestion: Ingestion;
  readonly operations = new Map<string, Operation>();
  private stopped = false;
  private incoming: Promise<void> = Promise.resolve();
  private running: Promise<void> | null = null;
  private again = false;
  private sessions = new Set<string>();
  private evidence = new Map<string, NativeChatEvent[]>();
  private pendingForeground = new Map<string, NativeChatEvent[]>();
  private foregroundTurns = new Set<string>();
  private nativeSending = new Map<string, Promise<unknown>>();
  private foregroundSessionId: string | null;
  constructor(readonly service: AssistantService, readonly native: NativeAccess,
    readonly report: (error: unknown) => void, readonly notify: () => void) {
    this.ingestion = new Ingestion(service);
    this.foregroundSessionId = service.config.foregroundSessionId;
  }
  async start(): Promise<void> {
    this.service.recover();
    const ids = new Set([...this.service.db.records('workers').map(worker => worker.id),
      ...this.service.db.find('topics', topic => !!topic.sessionId).map(topic => topic.sessionId!)]);
    for (const id of ids) {
      try { await this.observe(id); } catch (error) { this.report(error); }
    }
    // No directory-wide native history collection, old unprocessed queue, or classifier replay.
    await this.wake();
  }
  stop(): void { this.stopped = true; this.evidence.clear(); this.pendingForeground.clear(); }
  async settled(): Promise<void> { await this.running; await this.incoming; }
  private receive<T>(action: () => T | Promise<T>): Promise<T> {
    const result = this.incoming.then(() => {
      requireFact(!this.stopped, 'STOPPING', 'Assistant is stopping', 503); return action();
    });
    this.incoming = result.then(() => {}, () => {}); return result;
  }
  private remember(sessionId: string, event: NativeChatEvent): void {
    if (event.ephemeral || !primary(event)) return;
    const events = this.evidence.get(sessionId) ?? [];
    if (!events.some(item => item.id === event.id)) events.push(evidenceEvent(event));
    this.evidence.set(sessionId, events.slice(-256));
  }
  noteEvent(sessionId: string, event: NativeChatEvent): void {
    if (this.stopped) return;
    if (!this.service.managed(sessionId) && !this.service.db.records('foreground_inputs').some(r => r.sessionId === sessionId)) return;
    // Cache only native identity evidence. Bodies are held only until a foreground send returns its receipt.
    this.remember(sessionId, event);
    void this.observe(sessionId, event).catch(this.report);
  }
  noteQuestion(sessionId: string, question: AskRequest): void {
    if (!this.stopped) void this.observe(sessionId, undefined, question).catch(this.report);
  }
  wake(sessionId?: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (sessionId) this.sessions.add(sessionId);
    this.again = true;
    if (!this.running) this.running = this.pump().finally(() => {
      this.running = null;
      if (this.again && !this.stopped) void this.wake().catch(this.report);
    });
    return this.running;
  }
  private async pump(): Promise<void> {
    while (this.again && !this.stopped) {
      this.again = false;
      const sessions = [...this.sessions]; this.sessions.clear();
      for (const id of sessions) {
        try { await this.observe(id); } catch (error) { this.report(error); }
      }
      await this.incoming;
      if (this.stopped) break;
      for (const root of this.service.db.records('foreground_inputs').filter(r => r.state === 'pending'))
        await this.sendForeground(root);
      for (const row of this.service.db.find('topic_messages', t => t.origin === 'user' && t.state === 'pending'
        && this.service.db.must('messages', t.messageId).conversation?.channel === 'user'))
        await this.send(row.id);
      await this.notification();
      this.notify();
    }
  }
  async meta(sessionId: string): Promise<PublicSessionMeta | null> {
    requireFact(!this.stopped, 'STOPPING', 'Assistant is stopping', 503);
    const { meta } = await this.native.host.call('session/get', { sessionId });
    requireFact(!meta || meta.sessionId === sessionId, 'SESSION_MISMATCH', 'Host returned a different session');
    return meta ? withRoleMetadata(this.native.host, meta) : null;
  }
  private async directory() {
    const entries: PublicSessionMeta[] = [], seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.native.host.call('session/directory', { limit: 100, ...(cursor ? { cursor } : {}) });
      for (const item of page.sessions) entries.push(await withRoleMetadata(this.native.host, { ...item, ask: null }));
      cursor = page.cursor;
      if (cursor) { requireFact(!seen.has(cursor), 'DIRECTORY_CURSOR', 'Host directory cursor did not advance'); seen.add(cursor); }
    } while (cursor);
    return entries;
  }
  private idle(meta: PublicSessionMeta): boolean {
    const a = meta.activity;
    return meta.loaded && !meta.closing && meta.status === 'idle' && !meta.ask && !meta.decisions?.length
      && !!a && !a.processing && !a.hasActiveWork && a.queue.pendingCount === 0
      && a.queue.steeringCount === 0 && a.queue.inFlightSteeringCount === 0;
  }
  async readiness(): Promise<Readiness> {
    const selected = this.foregroundSessionId;
    const role: RoleReadiness = { role: 'coordinator', sessionId: selected, modelId: null, cwd: null,
      status: 'unbound', detail: selected ? null
        : 'Configure foregroundSessionId or explicitly bind/activate an exact native session; role labels do not select the foreground' };
    if (selected) {
      try {
        const meta = await this.meta(selected);
        requireFact(meta, 'SESSION_MISSING', 'Foreground session no longer exists');
        Object.assign(role, { modelId: meta.currentModelId ?? null, cwd: meta.cwd });
        if (!hasRole(meta, 'coordinator') || hasRole(meta, 'organizer') || hasRole(meta, 'worker')) {
          role.status = 'invalid'; role.detail = 'Selected session does not carry the distinct actual coordinator role';
        } else if (!meta.loaded) role.status = 'unloaded';
        else {
          const ready = await this.native.host.call('roles/readiness', { sessionId: meta.sessionId,
            roles: [{ moduleId: 'assistant', roleId: 'coordinator' }] });
          const scope = await this.native.scope(meta.sessionId);
          role.status = !scope.loaded ? 'unloaded' : ready.ready && ready.loaded && ready.rolesNeedReload === false
            && ready.appliedRoles?.some(r => r.moduleId === 'assistant' && r.roleId === 'coordinator')
            && roleScopeProof(scope, 'coordinator') ? 'ready' : scope.tools === null ? 'unknown' : 'invalid';
          if (role.status !== 'ready') role.detail = 'Foreground needs applied coordinator role, configured/applied scope and exact actual raw native tool identities; uninitialized tools are unconfirmed';
        }
      } catch (error) { role.status = 'unknown'; role.detail = errorText(error); }
    }
    if (selected !== this.foregroundSessionId) {
      Object.assign(role, { sessionId: this.foregroundSessionId, modelId: null, cwd: null,
        status: 'unknown', detail: 'Explicit foreground selection changed during readiness inspection' });
    }
    return { roles: [role], canSend: role.status === 'ready', receptions: [] };
  }
  async acceptReady(input: unknown) {
    const receipt = await this.receive(async () => {
      const value = inputSchema.parse(input);
      const old = this.service.db.input(value.requestId);
      if (old) return this.service.accept(value, old.conversation?.targetSessionId ?? '');
      const readiness = await this.readiness(), carrier = readiness.roles[0];
      requireFact(readiness.canSend && carrier?.sessionId, 'COORDINATOR_NOT_READY', 'One scoped native foreground Agent is required');
      return this.service.accept(value, carrier.sessionId);
    });
    await this.wake(); return this.service.receipt(this.service.db.must('messages', receipt.message.id));
  }
  visibleDiagnostic(message: Message): string | null { return message.diagnostic; }
  async organizerInput(sessionId: string, input: unknown) {
    const value = organizerInputSchema.parse(input), id = `organizer:${sessionId}:${value.requestId}`, hash = fingerprint(value);
    const old = this.service.db.record('foreground_inputs', id);
    if (old) { requireFact(old.fingerprint === hash, 'IDEMPOTENCY_CONFLICT', 'Organizer input changed'); return old; }
    const meta = await this.meta(sessionId);
    requireFact(meta && hasRole(meta, 'organizer') && !hasRole(meta, 'coordinator') && this.idle(meta),
      'ORGANIZER_NOT_READY', 'Explicit organizer input requires an idle applied organizer');
    await this.organizerReady(meta);
    const root: ForegroundInput = { id, kind: 'organizer', sessionId, messageId: null, text: value.text, fingerprint: hash,
      state: 'pending', receipt: null, interactionId: null, dispatchHash: null, result: null, inboxIds: [],
      historySessionIds: value.historySessionIds };
    const inserted = this.service.db.transaction(() => {
      const existing = this.service.db.record('foreground_inputs', id);
      if (existing) {
        requireFact(existing.fingerprint === hash, 'IDEMPOTENCY_CONFLICT', 'Organizer input changed');
        return false;
      }
      this.service.db.save('foreground_inputs', root); return true;
    });
    if (inserted) await this.wake();
    return this.service.db.record('foreground_inputs', id);
  }
  private async sendForeground(root: ForegroundInput): Promise<void> {
    if (this.stopped || root.state !== 'pending') return;
    if (root.kind === 'notification' && !root.inboxIds.some(id => {
      const item = this.service.db.record('inbox', id); return item && !item.presented && !item.reads.length;
    })) { root.state = 'cancelled'; this.service.db.save('foreground_inputs', root); return; }
    const meta = await this.meta(root.sessionId);
    if (!meta?.loaded) return; // Keep original identity; an operator may load it, never recreate it.
    requireFact(root.kind === 'organizer' ? hasRole(meta, 'organizer') && !hasRole(meta, 'coordinator')
      : hasRole(meta, 'coordinator'), 'STALE_ROLE', 'Prompt target changed its actual native role');
    if (root.kind === 'organizer') await this.organizerReady(meta);
    else {
      const readiness = await this.readiness();
      if (!readiness.canSend || readiness.roles[0]?.sessionId !== root.sessionId) return;
    }
    if (root.kind === 'notification' && (!this.idle(meta) || this.foregroundTurns.has(root.sessionId))) return;
    if (root.kind === 'notification') {
      const items = root.inboxIds.map(id => this.service.db.record('inbox', id)).filter(item => item && !item.presented && !item.reads.length);
      if (!items.length) { root.state = 'cancelled'; this.service.db.save('foreground_inputs', root); return; }
      root.inboxIds = items.map(item => item!.id);
      root.text = this.noticeText(root.inboxIds);
      root.fingerprint = fingerprint(root.text);
    }
    const message = root.messageId ? this.service.db.must('messages', root.messageId) : null;
    const text = message?.raw ?? root.text;
    requireFact(typeof text === 'string', 'SOURCE_BODY', 'Trusted prompt has no saved human original or internal notification text');
    root.state = 'calling'; this.service.db.save('foreground_inputs', root);
    this.foregroundTurns.add(root.sessionId);
    try {
      const sending = this.native.host.call('prompt', { sessionId: root.sessionId, mode: 'enqueue', text,
        ...(message?.attachments.length ? { attachments: message.attachments } : {}) });
      this.nativeSending.set(root.sessionId, sending);
      const result = await sending;
      root.result = result; root.receipt = result.messageId ?? null;
      root.state = !result.ok ? 'rejected' : result.messageId ? 'accepted' : 'unknown';
      requireFact(root.state !== 'accepted' || !this.service.db.records('foreground_inputs').some(prior =>
        prior.id !== root.id && prior.sessionId === root.sessionId && prior.state === 'accepted' && prior.receipt === root.receipt),
        'NATIVE_ID_CONFLICT', 'Native acceptance receipt already belongs to another trusted input');
      const userEvents = (this.evidence.get(root.sessionId) ?? []).filter(event =>
        event.type === 'user.message' && event.data.messageId === root.receipt);
      requireFact(userEvents.length <= 1, 'NATIVE_ID_CONFLICT', 'Native prompt receipt has competing user event identities');
      if (root.state === 'accepted' && userEvents[0] && typeof userEvents[0].data.interactionId === 'string') {
        root.interactionId = userEvents[0].data.interactionId; root.nativeUserEventId = userEvents[0].id;
      }
      this.service.db.save('foreground_inputs', root);
      if (root.state !== 'accepted') {
        this.foregroundTurns.delete(root.sessionId);
        if (message) { message.diagnostic = 'Foreground delivery rejected or uncertain; no automatic resend'; this.service.db.put('messages', message); }
        this.report(Object.assign(new Error('Foreground prompt was rejected or its native acceptance receipt is unknown'),
          { code: 'FOREGROUND_DELIVERY', inputId: root.id, kind: root.kind, state: root.state }));
      }
    } catch (error) {
      root.state = 'unknown'; root.result = { error: errorText(error) }; this.service.db.save('foreground_inputs', root);
      this.foregroundTurns.delete(root.sessionId);
      if (message) { message.diagnostic = 'Foreground delivery is uncertain; no automatic resend'; this.service.db.put('messages', message); }
      this.report(error);
    } finally { this.nativeSending.delete(root.sessionId); }
    const events = this.pendingForeground.get(root.sessionId) ?? []; this.pendingForeground.delete(root.sessionId);
    for (const event of events) await this.observe(root.sessionId, event);
  }
  observe(sessionId: string, event?: NativeChatEvent, request?: AskRequest): Promise<void> {
    return this.receive(async () => {
      if (!this.service.managed(sessionId) && !this.service.db.records('foreground_inputs').some(r => r.sessionId === sessionId)) return;
      const meta = await this.meta(sessionId);
      if (!meta) return;
      if (hasRole(meta, 'coordinator')) {
        if (event) {
          this.remember(sessionId, event);
          const roots = this.service.db.records('foreground_inputs').filter(r => r.sessionId === sessionId && r.state === 'accepted');
          const knownInteraction = (interaction: unknown) => roots.find(root => {
            const user = (this.evidence.get(sessionId) ?? []).find(e => e.type === 'user.message' && e.data.messageId === root.receipt);
            return typeof interaction === 'string' && (user?.data.interactionId === interaction || root.interactionId === interaction);
          });
          const root = knownInteraction(event.data.interactionId);
          if (event.type === 'user.message' && primary(event) && !event.ephemeral) {
            const receiptRoot = roots.find(r => r.receipt === event.data.messageId);
            if (receiptRoot && typeof event.data.interactionId === 'string') {
              requireFact(!receiptRoot.interactionId || receiptRoot.interactionId === event.data.interactionId,
                'NATIVE_ID_CONFLICT', 'Native receipt changed its original interaction identity');
              receiptRoot.interactionId = event.data.interactionId; receiptRoot.nativeUserEventId = event.id;
              this.service.db.save('foreground_inputs', receiptRoot);
            }
          }
          if (finalMessage(event) && root) this.projectForeground(sessionId, event, root);
          else if (finalMessage(event) && this.service.db.records('foreground_inputs')
            .some(r => r.sessionId === sessionId && r.state === 'calling')) {
            const pending = this.pendingForeground.get(sessionId) ?? []; pending.push(event);
            this.pendingForeground.set(sessionId, pending.slice(-64));
          }
          if (root && primary(event) && !event.ephemeral && ['assistant.turn_end', 'abort'].includes(event.type)) {
            this.foregroundTurns.delete(sessionId);
            if (event.type === 'abort' && typeof event.data.interactionId === 'string')
              this.service.cancelPresentations(sessionId, event.data.interactionId);
          }
        }
        if (this.idle(meta) && !this.service.db.records('foreground_inputs').some(r => r.sessionId === sessionId && r.state === 'calling'))
          this.foregroundTurns.delete(sessionId);
      } else if (!internal(meta) && this.service.managed(sessionId)) {
        if (event) this.ingestion.apply(sessionId, [event], meta, this.evidence.get(sessionId) ?? []);
        const current = request && fingerprint(questionIdentity(request)) === fingerprint(questionIdentity(meta.ask))
          ? request : meta.ask;
        this.ingestion.question(sessionId, current, meta);
      }
    });
  }
  private projectForeground(sessionId: string, event: NativeChatEvent, root: ForegroundInput): void {
    const raw = typeof event.data.content === 'string' ? event.data.content : '';
    const attachments = attachmentsSchema.parse(event.data.attachments ?? []);
    const nativeId = typeof event.data.messageId === 'string' ? event.data.messageId : null;
    const interactionId = typeof event.data.interactionId === 'string' ? event.data.interactionId : root.interactionId;
    this.service.saveForegroundReply({ raw, attachments, sessionId, nativeMessageId: nativeId, nativeEventId: event.id },
      root, interactionId);
  }
  private async notification(): Promise<void> {
    if (this.stopped) return;
    const pending = this.service.db.records('inbox').filter(item => !item.presented && !item.reads.length && !item.notificationId
      && (item.kind === 'result' || item.askState === 'pending'));
    if (!pending.length || this.service.db.records('foreground_inputs').some(r => r.state === 'pending' && r.kind !== 'notification')) return;
    const readiness = await this.readiness(), sessionId = readiness.roles[0]?.sessionId;
    if (!readiness.canSend || !sessionId || this.foregroundTurns.has(sessionId)) return;
    const meta = await this.meta(sessionId);
    if (!meta || !this.idle(meta)) return;
    const id = randomUUID(), text = this.noticeText(pending.map(item => item.id));
    const root: ForegroundInput = { id, kind: 'notification', sessionId, messageId: null, text,
      fingerprint: fingerprint(text), state: 'pending', receipt: null, interactionId: null,
      dispatchHash: null, result: null, inboxIds: pending.map(item => item.id), historySessionIds: [] };
    this.service.db.transaction(() => {
      this.service.db.save('foreground_inputs', root);
      for (const item of pending) { item.notificationId = id; this.service.db.save('inbox', item); }
    });
    await this.sendForeground(root);
  }
  private noticeText(ids: string[]): string {
    return `New managed-worker inbox locations: ${JSON.stringify(ids.map(id => this.service.db.record('inbox', id)!).map(item => ({
      id: item.id, sessionId: item.sessionId, topicIds: item.topicIds,
      topicNames: item.topicIds.map(topicId => this.service.db.get('topics', topicId)?.title ?? topicId),
      candidateTopicIds: item.candidateTopicIds,
      candidateTopicNames: item.candidateTopicIds.map(topicId => this.service.db.get('topics', topicId)?.title ?? topicId),
      attribution: item.attribution,
      type: item.kind === 'ask' ? 'needs-user-answer' : 'new-result',
    })))}`;
  }
  /** Only recorded module HTTP input + public native receipt can grant mutating business authority. */
  async authorize(identity: McpInvocationMeta): Promise<ForegroundInput> {
    requireFact(!this.stopped && !identity.subagent && identity.sessionId === identity.runtimeSessionId && identity.toolCallId,
      'INTERNAL_IDENTITY', 'A primary native tool-call identity is required', 403);
    const meta = await this.meta(identity.sessionId);
    requireFact(meta?.loaded && (hasRole(meta, 'coordinator') || hasRole(meta, 'organizer')),
      'STALE_ROLE', 'Only an actual foreground or explicitly authorized organizer can use Assistant tools', 403);
    await this.nativeSending.get(identity.sessionId)?.catch(() => {});
    requireFact(!this.stopped, 'STOPPING', 'Assistant stopped while native acceptance was pending', 503);
    let events = this.evidence.get(identity.sessionId) ?? [];
    const calls = () => events.filter(e => primary(e) && !e.ephemeral && e.type === 'assistant.message'
      && Array.isArray(e.data.toolRequests) && e.data.toolRequests.some(request => request && typeof request === 'object'
        && 'toolCallId' in request && request.toolCallId === identity.toolCallId));
    const priorInteraction = calls()[0]?.data.interactionId;
    if (!calls().length || !events.some(e => e.type === 'user.message' && e.data.interactionId === priorInteraction)
      && !this.service.db.records('foreground_inputs').some(root => root.sessionId === identity.sessionId
        && root.interactionId === priorInteraction && root.nativeUserEventId)) {
      const page = await this.native.read(identity.sessionId, null, true, false, true);
      requireFact(page.cursorStatus === 'ok', 'PROVENANCE_EXPIRED', 'Native provenance page expired', 403);
      for (const event of page.events) this.remember(identity.sessionId, event);
      events = this.evidence.get(identity.sessionId) ?? [];
    }
    const matched = calls(), interactionId = matched[0]?.data.interactionId;
    requireFact(matched.length === 1 && typeof interactionId === 'string'
      && (matched[0]!.data.toolRequests as { toolCallId?: string }[]).filter(r => r.toolCallId === identity.toolCallId).length === 1,
      'TOOL_PROVENANCE', 'Tool call does not identify one exact native interaction', 403);
    const users = events.filter(e => primary(e) && !e.ephemeral && e.type === 'user.message' && e.data.interactionId === interactionId);
    requireFact(users.length <= 1 && (!users.length || typeof users[0]!.data.messageId === 'string'),
      'TOOL_PROVENANCE', 'Tool call does not identify one exact native user receipt', 403);
    const roots = this.service.db.records('foreground_inputs').filter(r => r.sessionId === identity.sessionId
      && r.state === 'accepted' && (users.length ? r.receipt === users[0]!.data.messageId
        : r.interactionId === interactionId && !!r.nativeUserEventId));
    requireFact(roots.length === 1, 'TOOL_PROVENANCE', 'Unknown native peer input has no human or notification provenance', 403);
    const root = roots[0]!;
    requireFact(root.kind === 'organizer' ? hasRole(meta, 'organizer') && !hasRole(meta, 'coordinator')
      : hasRole(meta, 'coordinator'), 'STALE_ROLE', 'Role no longer matches this trusted input', 403);
    if (root.kind !== 'organizer') {
      const readiness = await this.readiness();
      requireFact(readiness.canSend && readiness.roles[0]?.sessionId === root.sessionId,
        'STALE_ROLE', 'Foreground role or native scope changed during provenance verification', 403);
      requireFact(this.foregroundSessionId === root.sessionId, 'STALE_ROLE', 'Explicit foreground selection changed', 403);
    }
    else await this.organizerReady(meta);
    requireFact(!root.interactionId || root.interactionId === interactionId,
      'NATIVE_ID_CONFLICT', 'Native source receipt changed its interaction identity', 403);
    root.interactionId = interactionId;
    if (users.length) root.nativeUserEventId = users[0]!.id;
    this.service.db.save('foreground_inputs', root);
    return root;
  }
  private async organizerReady(meta: PublicSessionMeta): Promise<void> {
    const evidence = await this.native.host.call('roles/readiness', { sessionId: meta.sessionId,
      roles: [{ moduleId: 'assistant', roleId: 'organizer' }] });
    const scope = await this.native.scope(meta.sessionId);
    requireFact(evidence.ready && evidence.loaded && evidence.rolesNeedReload === false
      && evidence.appliedRoles?.some(role => role.moduleId === 'assistant' && role.roleId === 'organizer')
      && roleScopeProof(scope, 'organizer'),
      'ORGANIZER_NOT_READY', 'Organizer requires its actual applied role and native tool scope', 403);
  }
  async topic(identity: McpInvocationMeta, input: unknown) {
    const root = await this.authorize(identity), value = topicSchema.parse(input);
    requireFact(root.kind !== 'notification', 'HUMAN_REQUIRED', 'Internal result notifications cannot mutate registry', 403);
    const actionId = `${identity.sessionId}:${identity.toolCallId}`;
    const prior = this.service.db.toolAction(actionId, value);
    if (prior) return prior as Topic;
    if (root.kind === 'organizer') {
      const existing = value.topicId ? this.service.db.get('topics', value.topicId) : undefined;
      for (const sessionId of [existing?.sessionId, value.sessionId]) {
        if (sessionId) requireFact(root.historySessionIds.includes(sessionId), 'ORGANIZER_SCOPE',
          'Organizer registry changes must remain within this request selected-history scope', 403);
      }
    }
    if (value.sessionId) {
      const meta = await this.meta(value.sessionId);
      requireFact(meta && !internal(meta), 'MAPPING_TARGET', 'Mapping needs a real eligible worker, never foreground/organizer/observer');
      if (root.kind === 'organizer') requireFact(root.historySessionIds.includes(value.sessionId),
        'ORGANIZER_SCOPE', 'Organizer adoption requires explicit human-selected session metadata', 403);
    }
    if (root.kind === 'human') requireFact(this.foregroundSessionId === root.sessionId, 'STALE_ROLE',
      'Explicit foreground selection changed during registry validation', 403);
    return this.service.topic(value, root, actionId);
  }
  async dispatch(identity: McpInvocationMeta, input: unknown) {
    const root = await this.authorize(identity);
    if (root.kind === 'human') requireFact(this.foregroundSessionId === root.sessionId, 'STALE_ROLE',
      'Only the explicitly selected foreground can dispatch this human input', 403);
    if (root.kind !== 'human' || this.service.db.record('foreground_inputs', root.id)?.dispatchHash)
      return this.service.dispatch(input, root);
    const value = dispatchSchema.parse(input);
    let binding: AskBinding | undefined;
    try {
      const original = this.service.db.must('messages', root.messageId!);
      for (const item of value.items) {
        const topic = this.service.db.must('topics', item.topicId);
        if (!topic.sessionId) continue;
        const meta = await this.meta(topic.sessionId);
        requireFact(meta && !internal(meta), 'MAPPING_TARGET', 'Dispatch needs a real eligible mapped worker');
        if (!meta.ask) continue;
        requireFact(value.items.length === 1, 'ASK_SINGLE_TOPIC', 'Worker asks require a separate single-topic human answer, not mixed dispatch');
        const questionHash = fingerprint(questionIdentity(meta.ask));
        const questions = this.service.db.records('inbox').filter(question => question.kind === 'ask'
          && question.sessionId === meta.sessionId && question.nativeId === meta.ask!.requestId
          && question.askState === 'pending' && question.candidateTopicIds.includes(item.topicId));
        requireFact(questions.length === 1 && questions[0]!.hash === questionHash, 'UNMAPPED_ASK',
          'Answer needs this exact known native request; inspect and answer separately');
        const question = questions[0]!;
        requireFact(original.sequence > question.observedAfterSequence, 'ASK_SOURCE_ORDER',
          'Human input predating the worker question cannot become its answer');
        const answer = this.service.humanAskAnswer(original.id, meta.ask, item.prompt);
        binding = { messageId: original.id, topicId: item.topicId, sessionId: meta.sessionId,
          requestId: meta.ask.requestId, questionHash, inboxId: question.id, wasFreeform: answer.wasFreeform };
      }
    } catch (error) {
      if (!(error instanceof BusinessError)) throw error;
      const rows = this.service.dispatch(value, root, undefined, errorText(error));
      this.report(error); this.notify(); return rows;
    }
    requireFact(this.foregroundSessionId === root.sessionId, 'STALE_ROLE', 'Foreground changed during dispatch validation');
    const result = this.service.dispatch(value, root, binding); await this.wake(); return result;
  }
  async presentation(identity: McpInvocationMeta, input: unknown) {
    const root = await this.authorize(identity);
    return this.service.declarePresentation(input, root, `presentation:${identity.sessionId}:${identity.toolCallId}`);
  }
  async history(root: ForegroundInput, sessionId: string, cursor?: string) {
    requireFact(root.kind === 'organizer' ? root.historySessionIds.includes(sessionId) : this.service.managed(sessionId),
      'HISTORY_SCOPE', 'History is limited to registered workers or explicitly selected organizer sources', 403);
    const meta = await this.meta(sessionId);
    requireFact(meta && !internal(meta), 'INTERNAL_HISTORY', 'Internal sessions are not business history sources', 403);
    const page = await this.native.host.call('session/chat', { sessionId, source: 'persisted', direction: 'backward',
      max: 16, bootstrap: false, waitMs: 0, ...(cursor ? { cursor } : {}) });
    return { sessionId, currentAsk: meta.ask, cursor: page.cursor, hasMore: page.hasMore,
      events: page.events.filter(e => primary(e) && !e.ephemeral && ['user.message', 'assistant.message'].includes(e.type))
        .map(e => ({ id: e.id, type: e.type, content: e.data.content, attachments: e.data.attachments })) };
  }
  async status(topicId?: string) {
    const topics = topicId ? [this.service.db.must('topics', topicId)] : this.service.db.list('topics', 0, 100).items;
    const ids = [...new Set(topics.flatMap(t => t.sessionId ? [t.sessionId] : []))];
    return Promise.all(ids.map(async sessionId => {
      const meta = await this.meta(sessionId);
      return { sessionId, topicIds: topics.filter(t => t.sessionId === sessionId).map(t => t.id),
        loaded: meta?.loaded ?? false, status: meta?.status ?? 'missing', ask: meta?.ask ?? null,
        activity: meta?.activity ?? null, toolScope: meta ? await this.native.scope(sessionId) : null };
    }));
  }
  async candidates(root: ForegroundInput) {
    requireFact(root.kind === 'organizer', 'ORGANIZER_REQUIRED', 'Only the manually authorized organizer reads adoption candidates', 403);
    return (await this.directory()).filter(m => !internal(m)).map(m => ({
      sessionId: m.sessionId, title: m.title, cwd: m.cwd, loaded: m.loaded, status: m.status, managed: this.service.managed(m.sessionId) }));
  }
  private async send(id: string): Promise<void> {
    const db = this.service.db;
    let row = db.must('topic_messages', id), uncertain = false;
    if (this.stopped || row.state !== 'pending' || db.must('messages', row.messageId).conversation?.channel !== 'user') return;
    try {
      const sessionId = await ensureTopicSession(this.service, this.native.host, id);
      row = db.must('topic_messages', id);
      let meta = await this.meta(sessionId);
      requireFact(meta && !internal(meta), 'MAPPING_TARGET', 'Original target missing or no longer a managed worker');
      if (!meta.loaded) {
        requireFact(!this.stopped, 'STOPPING', 'Assistant stopped before original worker load');
        row.state = 'calling'; db.put('topic_messages', row); uncertain = true;
        const load = await this.native.host.call('session/load', { sessionId });
        requireFact(load.ok && load.sessionId === sessionId, 'LOAD_UNCONFIRMED', 'Original worker load unconfirmed');
        meta = await this.meta(sessionId);
        requireFact(meta?.loaded && !internal(meta), 'MAPPING_TARGET', 'Worker changed during load');
        uncertain = false;
      }
      requireFact(!this.stopped, 'STOPPING', 'Assistant stopped before worker dispatch');
      const original = db.must('messages', row.messageId);
      const ask = meta.ask;
      const binding = db.record('foreground_inputs', row.messageId)?.askBinding;
      const question = binding ? db.record('inbox', binding.inboxId) : undefined;
      requireFact(!ask || binding, 'ASK_UNBOUND', 'New current worker ask needs a separate genuine human answer; original business text was not sent');
      let answer: ReturnType<typeof askAnswer> | null = null;
      if (binding) {
        requireFact(ask && question && question.askState === 'pending' && binding.messageId === original.id
          && binding.topicId === row.topicId && binding.sessionId === sessionId && binding.requestId === ask.requestId
          && binding.questionHash === question.hash && binding.questionHash === fingerprint(questionIdentity(ask))
          && row.mode === 'ask' && row.requestId === binding.requestId
          && db.topicMessages(original.id).length === 1 && row.prompt!.trim() === original.raw.trim(),
          'STALE_NATIVE_ASK', 'Frozen original/native question identity changed; no answer or substitute business prompt was sent');
        answer = this.service.humanAskAnswer(binding.messageId, ask, row.prompt!);
        requireFact(answer.wasFreeform === binding.wasFreeform, 'STALE_NATIVE_ASK', 'Native answer mode changed');
        const current = await this.meta(sessionId);
        requireFact(current && !internal(current) && current.ask
          && fingerprint(questionIdentity(current.ask)) === binding.questionHash,
          'STALE_NATIVE_ASK', 'Current exact worker question changed; answer was not sent');
      } else row.mode = 'prompt';
      row.state = 'calling'; db.put('topic_messages', row); uncertain = true;
      if (answer) {
        const result = await this.native.answer(sessionId, row.requestId!, answer.answer, answer.wasFreeform);
        row.result = result.result; row.state = result.accepted ? 'accepted' : 'rejected';
        row.error = result.accepted ? null : 'Native question answer rejected';
      } else {
        const result = await this.native.host.call('prompt', { sessionId, mode: 'enqueue', text: row.prompt!,
          ...(original.attachments.length ? { attachments: original.attachments } : {}) });
        row.result = result; row.nativeMessageId = result.messageId ?? null;
        row.state = !result.ok ? 'rejected' : result.messageId ? 'accepted' : 'unknown';
        row.error = row.state === 'accepted' ? null : 'Worker prompt rejected or receipt unknown';
      }
      db.transaction(() => {
        db.put('topic_messages', row);
        if (row.nativeMessageId) {
          const roots = (this.evidence.get(sessionId) ?? []).filter(event => event.type === 'user.message'
            && event.data.messageId === row.nativeMessageId);
          if (roots.length === 1) for (const item of db.records('inbox').filter(item => item.kind === 'result'
            && item.sessionId === sessionId && item.interactionId === roots[0]!.data.interactionId)) {
            if (!item.dispatchIds.includes(row.id)) item.dispatchIds.push(row.id);
            if (!item.topicIds.includes(row.topicId)) item.topicIds.push(row.topicId);
            item.attribution = 'native-dispatch';
            db.save('inbox', item);
          }
        }
        if (question && ['accepted', 'unknown'].includes(row.state!)) {
          question.askState = row.state === 'accepted' ? 'answered' : 'unknown'; db.save('inbox', question);
        }
      });
    } catch (error) {
      row = db.must('topic_messages', id);
      if (!['pending', 'calling'].includes(row.state ?? '')) return;
      row.state = uncertain || db.must('topics', row.topicId).mappingState === 'unknown' ? 'unknown' : 'rejected';
      row.error = errorText(error); row.result = { error: row.error }; db.put('topic_messages', row); this.report(error);
    }
  }
  async inspect(sessionId: string): Promise<SessionInspection> {
    const meta = await this.meta(sessionId); requireFact(meta, 'SESSION_MISSING', 'Session does not exist', 404);
    return { sessionId, cwd: meta.cwd, loaded: meta.loaded, status: meta.status,
      modelId: meta.currentModelId ?? null, rolesNeedReload: meta.rolesNeedReload ?? null };
  }
  async allowRoles(_sessionId: string | null, roles: readonly Role[]) {
    if (_sessionId) {
      const meta = await this.meta(_sessionId);
      const existing = ['coordinator', 'organizer', 'worker'].filter(role => meta && hasRole(meta, role));
      return { allowed: new Set([...existing, ...roles]).size <= 1, reason: 'Foreground, organizer, and worker roles cannot be combined' };
    }
    return { allowed: new Set(roles).size <= 1, reason: 'Foreground, organizer, and worker roles cannot be combined' };
  }
  async registerRoles(sessionId: string, _roles: readonly Role[], _requestId: string, signal?: AbortSignal): Promise<void> {
    requireFact(!signal?.aborted && !this.stopped, 'STOPPING', 'Assistant stopped during role notification');
    await this.observe(sessionId);
  }
  private async operation(id: string, kind: Operation['kind'], value: unknown, action: () => Promise<unknown>) {
    const previous = this.operations.get(id), hash = fingerprint(value);
    if (previous) { requireFact(previous.fingerprint === hash, 'IDEMPOTENCY_CONFLICT', 'Setup request changed'); return previous; }
    const operation: Operation = { id, kind, fingerprint: hash, state: 'calling', result: null };
    this.operations.set(id, operation);
    try {
      operation.result = await action(); operation.state = 'accepted';
      if (operation.result && typeof operation.result === 'object' && 'sessionId' in operation.result
        && typeof operation.result.sessionId === 'string') operation.sessionId = operation.result.sessionId;
    } catch (error) {
      const detail = error && typeof error === 'object' ? error as Record<string, unknown> : {};
      operation.state = error instanceof BusinessError && ['ROLE_CONFIGURATION', 'HOST_CAPABILITY', 'WORKER_CONFIG_UNSUPPORTED'].includes(error.code)
        ? 'rejected' : 'unknown'; operation.result = { error: errorText(error),
          ...(typeof detail.createdId === 'string' ? { createdId: detail.createdId } : {}),
          ...(typeof detail.sessionId === 'string' ? { sessionId: detail.sessionId } : {}),
          ...('roleAssignment' in detail ? { roleAssignment: detail.roleAssignment } : {}),
          warning: 'Inspect native state; do not blindly recreate' };
      this.report(error);
    }
    return operation;
  }
  async create(input: unknown): Promise<Operation> {
    const value = createSessionSchema.parse(input);
    return this.operation(`create:${value.requestId}`, 'create', value, async () =>
      this.native.host.call('session/new', creationOptions(this.service, this.native.host, value.role, value.cwd)));
  }
  async bind(input: unknown): Promise<Operation> {
    const value = bindingSchema.parse(input);
    return this.operation(`bind:${value.requestId}`, 'bind', value, async () => {
      const meta = await this.meta(value.sessionId);
      requireFact(meta?.loaded && hasRole(meta, value.role)
        && !hasRole(meta, value.role === 'coordinator' ? 'organizer' : 'coordinator')
        && !hasRole(meta, 'worker'), 'ROLE_CONFIGURATION', 'Select the distinct actual role on a loaded native session first');
      const preparation = await this.native.host.call('session/resources-prepare', {
        sessionId: value.sessionId, mcpServers: roleScope(value.role).mcpServers });
      requireFact(preparation.ok, 'PREPARATION_FAILED', preparation.error ?? 'Native role preparation failed');
      if (value.role === 'organizer') {
        const current = await this.meta(value.sessionId); requireFact(current, 'SESSION_MISSING', 'Organizer disappeared during preparation');
        await this.organizerReady(current);
        return { sessionId: value.sessionId, preparation, ready: true, role: 'organizer',
          warning: 'Preparation is current-session only. Selected history requires POST /organizers/:id/messages; bare native input is not authenticated human authority.' };
      }
      this.foregroundSessionId = value.sessionId;
      return { sessionId: value.sessionId, preparation, readiness: await this.readiness(), ...this.selectionReceipt() };
    });
  }
  async activateRoles(input: unknown): Promise<Operation> {
    const value = activateRolesSchema.parse(input);
    return this.operation(`activate:${value.requestId}`, 'activate', value, async () => {
      const expected = value.bindings[0]!;
      const meta = await this.meta(expected.sessionId); requireFact(meta, 'SESSION_MISSING', 'Foreground no longer exists');
      requireFact(hasRole(meta, 'coordinator') && !hasRole(meta, 'organizer') && !hasRole(meta, 'worker'),
        'ROLE_CONFIGURATION', 'Explicit foreground selection needs the distinct actual coordinator role');
      const effect = meta.loaded ? 'already_loaded' : await this.native.host.call('session/load', { sessionId: expected.sessionId });
      requireFact(effect === 'already_loaded' || effect.ok && effect.sessionId === expected.sessionId, 'LOAD_UNCONFIRMED', 'Original foreground load unconfirmed');
      this.foregroundSessionId = expected.sessionId;
      return { sessionId: expected.sessionId, effect, readiness: await this.readiness(), ...this.selectionReceipt() };
    });
  }
  private selectionReceipt() {
    return { foregroundSessionId: this.foregroundSessionId,
      persistent: this.service.config.foregroundSessionId === this.foregroundSessionId,
      warning: 'Binding selects this running service only; persist foregroundSessionId through Host module configuration for cold start. Selection does not prove role/scope readiness.' };
  }
}
