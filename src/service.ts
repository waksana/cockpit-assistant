import { randomUUID } from 'node:crypto';
import type { AskRequest, McpInvocationMeta } from '@waksana/cockpit-module-sdk/backend';
import { Database, fingerprint } from './database.ts';
import { requireFact } from './errors.ts';
import { MemoryEngine } from './memory.ts';
import { configSchema, decisionSchema, inputSchema, rememberSchema } from './schema.ts';
import type { Config, Decision, Proof } from './schema.ts';
import type { Anchor, Binding, Delivery, Message, Publication, Question, Role, SourceRef, Topic, Work } from './types.ts';

export const questionKey = (sessionId: string, requestId: string): string => fingerprint([sessionId, requestId]);
export const ref = (message: Message): SourceRef => ({
  messageId: message.id, version: message.version, assignmentVersion: message.assignmentVersion,
});

export class AssistantService {
  readonly memory: MemoryEngine;
  constructor(readonly db: Database, readonly now: () => number = Date.now) {
    this.memory = new MemoryEngine(db);
  }
  get version(): number { return this.db.meta('stateVersion', 0); }
  changed(): number { return this.db.next('stateVersion'); }
  get config(): Config { return configSchema.parse(this.db.meta('config', {})); }

  idempotent<T>(requestId: string, operation: unknown, action: () => T): T {
    const hash = fingerprint(operation);
    const existing = this.db.get('operations', requestId);
    if (existing) {
      requireFact(existing.fingerprint === hash, 'IDEMPOTENCY_CONFLICT', 'Request ID already has different input');
      return existing.result as T;
    }
    const result = action();
    this.db.put('operations', { id: requestId, fingerprint: hash, state: 'accepted', result });
    return result;
  }

  accept(input: unknown): { message: Message; work: Work } {
    const value = inputSchema.parse(input);
    return this.db.transaction(() => this.idempotent(`input:${value.requestId}`, value, () => {
      if (value.replyTo) {
        const anchor = this.db.must('anchors', value.replyTo);
        this.reception(anchor.sessionId, true);
      }
      if (value.topicId) this.db.must('topics', value.topicId);
      const message = this.addMessage({
        kind: 'user', raw: value.text, topicId: value.topicId ?? null,
        replyTo: value.replyTo ?? null,
      });
      const work = this.addWork(message);
      return { message, work };
    }));
  }

  addMessage(input: Partial<Message> & Pick<Message, 'kind' | 'raw'>): Message {
    const message: Message = {
      id: randomUUID(), version: 1, topicId: null, assignmentVersion: 0,
      assignmentReason: null, sessionId: null, nativeEventId: null, nativeMessageId: null,
      nativeParentId: null, correlation: 'unknown', replyTo: null, historical: false,
      sequence: this.db.next('messageSequence'), createdAt: this.now(), ...input,
    };
    this.db.put('messages', message);
    if (message.topicId) this.dirty(message.topicId, message.sequence);
    return message;
  }
  addWork(message: Message): Work {
    const work: Work = {
      id: `message:${message.id}:${message.version}`, role: 'coordinator',
      kind: message.kind === 'user' ? 'input' : 'output', messageId: message.id,
      topicId: message.topicId, inputVersion: message.version, stateVersion: this.version,
      sources: [ref(message)], through: message.sequence, state: 'pending', epoch: null,
      token: null, leaseUntil: 0, result: null,
    };
    this.db.put('work', work);
    return work;
  }
  publish(input: Pick<Publication, 'type' | 'text'> & Partial<Publication>): Publication {
    const publication: Publication = {
      id: randomUUID(), sequence: this.db.next('publicationSequence'), messageId: null,
      topicId: null, anchorId: null, sources: [], createdAt: this.now(), ...input,
    };
    this.db.put('publications', publication);
    return publication;
  }
  reception(sessionId: string, allowCollaborator = false) {
    const entry = this.db.must('receptions', sessionId);
    requireFact(entry.enabled && (allowCollaborator || entry.kind === 'reception'),
      'NOT_RECEPTION', 'Target is not an explicitly enabled direct reception');
    requireFact(!this.db.find('bindings', binding => binding.sessionId === sessionId).length,
      'INTERNAL_TARGET', 'Internal role sessions cannot receive user conversation');
    return entry;
  }
  authorize(identity: McpInvocationMeta, role: Role, epoch: number): Binding {
    requireFact(!identity.subagent && identity.runtimeSessionId === identity.sessionId,
      'MAIN_ONLY', 'Internal agents cannot act as the bound role', 403);
    const binding = this.db.must('bindings', role);
    requireFact(binding.sessionId === identity.sessionId && binding.epoch === epoch && binding.ready,
      'STALE_ROLE', 'Caller is not the ready current role epoch', 403);
    return binding;
  }
  claim(identity: McpInvocationMeta, role: Role, epoch: number, workId?: string): Work | null {
    return this.db.transaction(() => {
      this.authorize(identity, role, epoch);
      const work = workId ? this.db.must('work', workId)
        : this.db.find('work', item => item.role === role && (item.state === 'pending'
          || (item.state === 'leased' && (item.epoch !== epoch || item.leaseUntil <= this.now()))))[0];
      if (!work) return null;
      requireFact(work.role === role && (work.state === 'pending'
        || (work.state === 'leased' && (work.epoch === epoch || work.leaseUntil <= this.now()))),
      'WORK_UNAVAILABLE', 'Work is completed, invalidated, or leased to another epoch');
      work.state = 'leased';
      work.epoch = epoch;
      work.token = randomUUID();
      work.leaseUntil = this.now() + 300_000;
      work.stateVersion = this.version;
      this.db.put('work', work);
      return work;
    });
  }
  checkWork(identity: McpInvocationMeta, role: Role, proof: Proof): Work {
    this.authorize(identity, role, proof.epoch);
    const work = this.db.must('work', proof.workId);
    requireFact(work.role === role && work.state === 'leased' && work.epoch === proof.epoch
      && work.token === proof.token && work.leaseUntil > this.now(), 'STALE_LEASE', 'Work lease is no longer current');
    requireFact(work.inputVersion === proof.inputVersion && work.stateVersion === proof.stateVersion,
      'STALE_INPUT', 'Input or read snapshot changed');
    if (role === 'coordinator') requireFact(this.version === proof.stateVersion,
      'STALE_STATE', 'Conversation state changed; claim a fresh snapshot');
    return work;
  }
  decide(identity: McpInvocationMeta, input: unknown): unknown {
    const decision = decisionSchema.parse(input);
    return this.db.transaction(() => {
      this.authorize(identity, 'coordinator', decision.epoch);
      return this.idempotent(`decision:${decision.requestId}`, { identity, decision }, () => {
        const work = this.checkWork(identity, 'coordinator', decision);
        requireFact(work.messageId, 'WORK_KIND', 'Coordinator requires a message work item');
        const message = this.db.must('messages', work.messageId);
        requireFact(message.version === work.inputVersion, 'STALE_INPUT', 'Message was corrected');
        const topic = this.classify(message, decision.topic, decision.reason, work.kind === 'input');
        if (work.kind === 'input') this.publish({ type: 'message', messageId: message.id,
          topicId: topic.id, text: message.raw, sources: [ref(message)] });
        let result: unknown;
        switch (decision.action.kind) {
          case 'route':
            requireFact(work.kind === 'input', 'WORK_KIND', 'Only user inputs can route');
            result = this.route(message, topic, decision.action, decision.reason);
            break;
          case 'publish':
            requireFact(work.kind === 'output' && !message.historical,
              'WORK_KIND', 'Only newly received native outputs can publish');
            result = this.publishOutput(message, decision.action.text);
            break;
          case 'clarify':
            requireFact(work.kind === 'input', 'WORK_KIND', 'Clarifications apply to user inputs');
            result = this.publish({ type: 'clarification', topicId: topic.id,
              text: decision.action.text, sources: [ref(message)] });
            break;
          case 'suppress':
            requireFact(work.kind === 'output', 'WORK_KIND', 'User inputs cannot be silently suppressed');
            result = { suppressed: true, reason: decision.action.reason };
            break;
        }
        work.state = 'done';
        work.result = result;
        this.db.put('work', work);
        this.changed();
        return result;
      });
    });
  }
  classify(message: Message, target: Decision['topic'], reason: string, focus = false): Topic {
    let topic: Topic;
    if (target.id) {
      topic = this.db.must('topics', target.id);
      requireFact(!topic.archived, 'ARCHIVED_TOPIC', 'An archived topic cannot receive new routing decisions');
    } else {
      requireFact(target.title && target.independent !== undefined, 'TOPIC_REQUIRED', 'A new topic needs title and independence classification');
      for (const related of target.relatedTo ?? []) this.db.must('topics', related);
      topic = { id: randomUUID(), title: target.title, independent: target.independent,
        domain: target.domain ?? null, relatedTo: target.relatedTo ?? [], pinned: false,
        archived: false, version: 1, dirtyThrough: 0, memoryThrough: 0 };
      this.db.put('topics', topic);
    }
    if (message.topicId !== topic.id) {
      this.db.setMeta(`assignment:${message.id}:${message.assignmentVersion}`, {
        topicId: message.topicId, reason: message.assignmentReason,
      });
      this.memory.invalidate(message.id, 'Topic classification changed');
      message.topicId = topic.id;
      message.assignmentVersion++;
    }
    message.assignmentReason = reason;
    this.db.put('messages', message);
    this.dirty(topic.id, message.sequence);
    if (focus && message.kind === 'user') this.switchTopic(topic.id);
    return this.db.must('topics', topic.id);
  }
  dirty(topicId: string, through: number): void {
    const topic = this.db.must('topics', topicId);
    topic.dirtyThrough = Math.max(topic.dirtyThrough, through);
    this.db.put('topics', topic);
  }
  switchTopic(topicId: string): void {
    this.db.must('topics', topicId);
    const current = this.db.meta<string | null>('foregroundTopic', null);
    if (current === topicId) return;
    if (current) this.memory.schedule(current);
    this.db.setMeta('foregroundTopic', topicId);
    this.changed();
  }
  private route(message: Message, topic: Topic, action: Extract<Decision['action'], { kind: 'route' }>, reason: string) {
    requireFact(new Set(action.sessionIds).size === action.sessionIds.length,
      'DUPLICATE_TARGET', 'Duplicate reception targets');
    let anchor: Anchor | undefined = message.replyTo ? this.db.must('anchors', message.replyTo) : undefined;
    if (action.answerQuestionId) {
      const question = this.db.must('questions', action.answerQuestionId);
      requireFact(!anchor || anchor.requestId === question.request.requestId && anchor.sessionId === question.sessionId,
        'ANCHOR_MISMATCH', 'Explicit reply anchor cannot be changed');
      if (!anchor) {
        const matching = this.db.find('questions', q => q.state === 'pending'
          && q.request.choices?.filter(choice => choice === message.raw).length === 1);
        requireFact(matching.length === 1 && matching[0]!.id === question.id,
          'AMBIGUOUS_ANSWER', 'Unanchored answers require one unambiguous literal choice; otherwise clarify');
        anchor = { id: 'inferred-literal', kind: 'ask', messageId: question.messageId,
          sessionId: question.sessionId, requestId: question.request.requestId };
      }
    }
    if (anchor) requireFact(action.sessionIds.length === 1 && action.sessionIds[0] === anchor.sessionId,
      'ANCHOR_MISMATCH', 'Explicit replies stay bound to their original native object');
    const currentRoute = this.db.get('routes', topic.id);
    requireFact(action.routeVersion === (currentRoute?.version ?? 0), 'STALE_ROUTE', 'Topic reception route changed');
    if (!anchor) {
      const pending = this.db.find('questions', q => q.state === 'pending');
      requireFact(!pending.some(q => action.sessionIds.includes(q.sessionId)),
        'PENDING_ASK', 'A reception has pending questions; bind an answer or clarify before ordinary routing');
    }
    const deliveries: Delivery[] = [];
    for (const sessionId of action.sessionIds) {
      this.reception(sessionId);
      let kind: Delivery['kind'] = 'prompt';
      let answerFreeform: boolean | null = null;
      let requestId: string | null = null;
      let supplement: string | null = action.context ? `Assistant context (not new user authorization):\n${action.context}` : null;
      if (anchor?.kind === 'ask') {
        const question = this.db.must('questions', questionKey(sessionId, anchor.requestId!));
        requireFact(question.state === 'pending', 'STALE_ASK', 'Original question is no longer pending');
        const choices = question.request.choices ?? [];
        const count = choices.filter(choice => choice === message.raw).length;
        requireFact(count <= 1, 'AMBIGUOUS_CHOICE', 'Question has duplicate literal choices');
        answerFreeform = count !== 1;
        requireFact(!answerFreeform || question.request.allowFreeform !== false,
          'FREEFORM_FORBIDDEN', 'Answer must exactly match one original choice');
        requireFact(!this.db.find('deliveries', d => d.kind === 'ask' && d.sessionId === sessionId
          && d.requestId === anchor!.requestId && !['rejected', 'cancelled'].includes(d.state)).length,
        'ASK_IN_FLIGHT', 'An answer already exists for this native request');
        kind = 'ask';
        requestId = anchor.requestId;
        supplement = null;
      } else {
        if (anchor) {
          const original = this.db.must('messages', anchor.messageId);
          supplement = [`Explicit reply to original message ${original.id}:\n${original.raw}`, supplement].filter(Boolean).join('\n\n');
        }
        const warning = this.riskWarning(sessionId, topic.id);
        if (warning) supplement = [supplement, warning].filter(Boolean).join('\n\n');
      }
      const delivery: Delivery = { id: randomUUID(), kind, messageId: message.id, sessionId,
        requestId, text: message.raw, supplement, answerFreeform, state: 'pending',
        result: null, error: null, createdAt: this.now(), roleEpoch: null };
      this.db.put('deliveries', delivery);
      deliveries.push(delivery);
    }
    if (!anchor) {
      if (currentRoute && fingerprint(currentRoute.sessionIds) !== fingerprint(action.sessionIds)) this.memory.schedule(topic.id, 'handoff');
      this.db.put('routes', { id: topic.id, sessionIds: action.sessionIds,
        version: (currentRoute?.version ?? 0) + 1, evidence: reason });
    }
    return { deliveries };
  }
  private riskWarning(sessionId: string, topicId: string): string | null {
    if (!this.config.riskEnabled) return null;
    const topicIds = new Set(this.db.find('routes', route => route.sessionIds.includes(sessionId)).map(route => route.id));
    topicIds.add(topicId);
    const independent = [...topicIds].map(id => this.db.must('topics', id))
      .filter(topic => topic.independent && !topic.archived).sort((a, b) => a.id.localeCompare(b.id));
    if (independent.length < 2) return null;
    const signature = fingerprint(independent.map(topic => topic.id));
    const prior = this.db.get('risks', sessionId);
    if (prior?.signature === signature && (prior.suppressed || this.now() - prior.lastAt < this.config.riskCooldownMs)) return null;
    const warning = `Shared-context notice: ${independent.map(topic => topic.title).join(' / ')} use the same reception. `
      + 'Their native context is shared. This notice does not authorize splitting or transferring work.';
    this.db.put('risks', { id: sessionId, signature, lastAt: this.now(), suppressed: false });
    this.publish({ type: 'risk', topicId, text: warning });
    return warning;
  }
  private publishOutput(message: Message, text?: string): Publication {
    requireFact(message.sessionId, 'SOURCE_REQUIRED', 'Native output must preserve its reception');
    this.reception(message.sessionId);
    let anchor = this.db.get('anchors', message.id);
    if (!anchor) {
      const question = this.db.find('questions', q => q.messageId === message.id)[0];
      if (message.kind === 'ask') requireFact(question?.state === 'pending', 'STALE_ASK', 'Question is not currently pending');
      anchor = { id: message.id, messageId: message.id, sessionId: message.sessionId,
        kind: question ? 'ask' : 'comment', requestId: question?.request.requestId ?? null };
      this.db.put('anchors', anchor);
    }
    return this.publish({ type: message.kind === 'ask' ? 'question' : 'message',
      messageId: message.id, topicId: message.topicId,
      text: message.kind === 'ask' ? message.raw : text ?? message.raw,
      anchorId: anchor.id, sources: [ref(message)] });
  }
  syncQuestions(sessionId: string, asks: AskRequest[], available: boolean): void {
    for (const old of this.db.find('questions', q => q.sessionId === sessionId && q.state === 'pending')) {
      if (!available || !asks.some(ask => ask.requestId === old.request.requestId)) {
        old.state = available ? 'stale' : 'unknown';
        this.db.put('questions', old);
        this.publish({ type: 'status', messageId: old.messageId, text: `Native question is ${old.state}.` });
      }
    }
    if (!available) return;
    for (const request of asks) {
      const id = questionKey(sessionId, request.requestId);
      const old = this.db.get('questions', id);
      if (old) {
        requireFact(fingerprint(old.request) === fingerprint(request), 'QUESTION_MUTATED', 'Native request ID changed its question');
        if (old.state === 'unknown' || old.state === 'stale') {
          old.state = 'pending';
          this.db.put('questions', old);
        }
        continue;
      }
      const raw = `${request.question}${request.choices?.length ? `\n\nChoices:\n${request.choices.map(c => `- ${c}`).join('\n')}` : ''}`
        + `\n\nFree-text answers: ${request.allowFreeform !== false ? 'allowed' : 'not allowed'}.`;
      const message = this.addMessage({ kind: 'ask', raw, sessionId });
      const question: Question = { id, sessionId, request, messageId: message.id, state: 'pending' };
      this.db.put('questions', question);
      this.addWork(message);
    }
  }
  remember(identity: McpInvocationMeta, input: unknown): unknown {
    const value = rememberSchema.parse(input);
    return this.db.transaction(() => {
      this.authorize(identity, 'memory', value.epoch);
      return this.idempotent(`memory:${value.requestId}`, { identity, value }, () => {
        const work = this.checkWork(identity, 'memory', value);
        return this.memory.commit(work, value.entries);
      });
    });
  }
  correct(messageId: string, raw: string, expectedVersion: number, reason: string): Message {
    return this.db.transaction(() => {
      const message = this.db.must('messages', messageId);
      requireFact(message.version === expectedVersion, 'STALE_INPUT', 'Message version changed');
      requireFact(message.kind !== 'ask', 'NATIVE_ASK_IMMUTABLE', 'Native questions can only change through native control facts');
      const unfinished = this.db.find('work', w => w.messageId === messageId && (w.state === 'pending' || w.state === 'leased'));
      const hadDecision = this.db.find('work', w => w.messageId === messageId && w.state === 'done').length > 0;
      this.db.setMeta(`revision:${messageId}:${message.version}`, message);
      this.db.setMeta(`correction:${messageId}:${message.version + 1}`, { reason, origin: 'user-correction', at: this.now() });
      this.memory.invalidate(messageId, reason);
      message.version++;
      message.raw = raw;
      this.db.put('messages', message);
      for (const work of this.db.find('work', w => w.messageId === messageId && (w.state === 'pending' || w.state === 'leased'))) {
        work.state = 'invalidated';
        this.db.put('work', work);
      }
      if (unfinished.length && !hadDecision) this.addWork(message);
      this.publish({ type: 'correction', messageId, text: reason, sources: [ref(message)], topicId: message.topicId });
      this.changed();
      return message;
    });
  }
  recover(): void {
    this.db.transaction(() => {
      for (const delivery of this.db.find('deliveries', item => item.state === 'calling')) {
        delivery.state = 'unknown';
        delivery.error = 'Process ended after durable call intent; native effect is unknown. Do not resend.';
        this.db.put('deliveries', delivery);
      }
      for (const operation of this.db.find('operations', item => item.state === 'calling')) {
        operation.state = 'unknown';
        this.db.put('operations', operation);
      }
      for (const binding of this.db.find('bindings', () => true)) {
        binding.ready = false;
        this.db.put('bindings', binding);
      }
    });
  }
}
