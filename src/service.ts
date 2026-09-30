import { randomUUID } from 'node:crypto';
import type { AskRequest } from '@waksana/cockpit-module-sdk/backend';
import { Database, fingerprint } from './database.ts';
import { requireFact } from './errors.ts';
import { inputSchema, clarificationSchema, clarificationAnswerSchema, completeSchema, configSchema } from './schema.ts';
import type { Complete, Config } from './schema.ts';
import type { Clarification, Message, Topic, TopicMessage } from './types.ts';
import type { InputReceipt } from './ui-types.ts';

export function askAnswer(request: AskRequest, answer: string, attachments: Message['attachments']) {
  requireFact(attachments.length === 0, 'ASK_ATTACHMENTS', 'Native ask responses do not support attachments; operate the original session', 400);
  if (request.choices?.includes(answer)) return { answer, wasFreeform: false };
  requireFact(request.allowFreeform !== false, 'ASK_CHOICE', 'Answer must exactly match a current native choice', 400);
  requireFact(!!answer.trim(), 'ASK_ANSWER', 'A native answer is required', 400);
  return { answer, wasFreeform: true };
}
export class AssistantService {
  readonly config: Config;
  constructor(readonly db: Database, readonly now = Date.now, config: unknown = {}) {
    this.config = configSchema.parse(config);
  }
  accept(input: unknown): InputReceipt {
    const value = inputSchema.parse(input), hash = fingerprint(value);
    const existing = this.db.input(value.requestId);
    if (existing) {
      requireFact(existing.input?.fingerprint === hash, 'IDEMPOTENCY_CONFLICT', 'Original input request changed');
      return this.receipt(existing);
    }
    const message = this.db.transaction(() => this.addMessage({
      kind: 'user', raw: value.text, attachments: value.attachments,
      input: { ...value, fingerprint: hash },
    }));
    return this.receipt(message);
  }
  receipt(message: Message): InputReceipt {
    requireFact(message.input, 'NOT_FOUND', 'Input receipt not found', 404);
    return { requestId: message.input.requestId,
      input: { requestId: message.input.requestId, text: message.input.text, attachments: message.input.attachments },
      message, topicMessages: this.db.topicMessages(message.id), hasMore: { topicMessages: false } };
  }
  addMessage(value: Pick<Message, 'kind' | 'raw' | 'attachments'> & Partial<Message>): Message {
    const message: Message = { id: randomUUID(), sessionId: null, nativeEventId: null, nativeMessageId: null,
      sequence: this.db.nextSequence, revision: 0, createdAt: this.now(), processed: false,
      excluded: false, diagnostic: null, question: null, clarificationHistory: [], clarification: null, ...value };
    this.db.put('messages', message);
    return message;
  }
  /** All semantic definitions, mappings and associations commit before any native send. */
  complete(input: unknown): { saved: true; alreadyProcessed: boolean; message: Message; topicMessages: TopicMessage[] } {
    const value = completeSchema.parse(input);
    return this.db.transaction(() => {
      const message = this.db.must('messages', value.messageId);
      if (message.processed) return { saved: true, alreadyProcessed: true, message, topicMessages: this.db.topicMessages(message.id) };
      requireFact(!message.excluded, 'INTERNAL_SOURCE', 'Source is no longer an ordinary business message', 403);
      requireFact(!message.clarification, 'CLARIFICATION_WAITING', 'Answer the current local question first');
      requireFact(new Set(value.topics.map(t => t.topicId)).size === value.topics.length
        && new Set(value.items.map(t => t.topicId)).size === value.items.length, 'DUPLICATE_TOPIC', 'Each topic occurs once');
      const affected = new Set(value.items.map(item => item.topicId));
      for (const definition of value.topics) {
        requireFact(affected.has(definition.topicId), 'TOPIC_SCOPE', 'Only topics associated with this original may change');
        const old = this.db.get('topics', definition.topicId);
        const specified = Object.hasOwn(definition, 'sessionId');
        let sessionId = specified ? definition.sessionId! : old?.sessionId ?? (message.kind === 'user' ? null : message.sessionId);
        requireFact(!(specified && sessionId === null && old && ['calling','unknown'].includes(old.mappingState)),
          'UNCERTAIN_MAPPING', 'An uncertain native creation cannot be cleared into another automatic creation');
        if (message.kind !== 'user' && old && specified && sessionId !== old.sessionId && sessionId !== null)
          requireFact(message.raw.includes(sessionId), 'HANDOFF_IDENTITY',
            'A session reply must explicitly identify the real new session before changing an existing topic mapping');
        if (!specified && old) sessionId = old.sessionId;
        const topic: Topic = { id: definition.topicId, title: definition.title, content: definition.content,
          archived: definition.archived ?? old?.archived ?? false, version: (old?.version ?? 0) + 1, sessionId,
          mappingState: specified || !old ? sessionId ? 'bound' : 'unbound' : old.mappingState,
          mappingError: specified || !old ? null : old.mappingError,
          creationReceipt: old?.creationReceipt ?? null };
        this.db.put('topics', topic);
      }
      const associations: TopicMessage[] = [];
      for (const item of value.items) {
        const topic = this.db.must('topics', item.topicId);
        requireFact(message.kind !== 'user' || !topic.archived, 'ARCHIVED_TOPIC', 'Cannot route new user content to an archived topic');
        requireFact(message.kind === 'user' ? !!item.prompt?.trim() : item.prompt === undefined,
          'TOPIC_MESSAGE_ORIGIN', 'User rows need a split prompt; session rows must not copy or rewrite the native body');
        const row: TopicMessage = { id: randomUUID(), messageId: message.id, topicId: topic.id,
          origin: message.kind === 'user' ? 'user' : 'session',
          prompt: item.prompt ?? null, sessionId: message.kind === 'user' ? null : message.sessionId,
          state: message.kind === 'user' ? 'pending' : null, mode: null, requestId: null, wasFreeform: null,
          nativeMessageId: null, result: null, error: null, createdAt: this.now() };
        this.db.put('topic_messages', row);
        associations.push(row);
      }
      message.processed = true;
      message.diagnostic = null;
      this.db.put('messages', message);
      return { saved: true, alreadyProcessed: false, message, topicMessages: associations };
    });
  }
  clarify(input: unknown): { messageId: string; clarification: Clarification } {
    const value = clarificationSchema.parse(input);
    return this.db.transaction(() => {
      const message = this.db.must('messages', value.messageId);
      requireFact(!message.processed && !message.excluded, 'SOURCE_COMPLETE', 'Source cannot receive a new clarification');
      if (message.clarification) {
        requireFact(fingerprint([message.clarification.question, message.clarification.choices, message.clarification.allowFreeform])
          === fingerprint([value.question, value.choices, value.allowFreeform]), 'CLARIFICATION_WAITING', 'Another local question is already waiting');
        return { messageId: message.id, clarification: message.clarification };
      }
      const clarification: Clarification = { id: randomUUID(), question: value.question, choices: value.choices,
        allowFreeform: value.allowFreeform, createdAt: this.now(), answer: null, answeredAt: null, requestId: null };
      message.clarificationHistory.push(clarification);
      message.clarification = clarification;
      message.diagnostic = null;
      this.db.put('messages', message);
      return { messageId: message.id, clarification };
    });
  }
  clarification(messageId: string, clarificationId: string) {
    const message = this.db.must('messages', messageId);
    const clarification = message.clarificationHistory.find(item => item.id === clarificationId);
    requireFact(clarification, 'NOT_FOUND', 'Clarification does not belong to this original', 404);
    return { messageId, clarification };
  }
  answerClarification(messageId: string, clarificationId: string, input: unknown) {
    const value = clarificationAnswerSchema.parse(input);
    return this.db.transaction(() => {
      const message = this.db.must('messages', messageId);
      const { clarification } = this.clarification(messageId, clarificationId);
      // Request IDs are scoped to the original, and cannot accidentally answer its next question.
      const previous = message.clarificationHistory.find(item => item.requestId === value.requestId);
      if (previous) {
        requireFact(previous.id === clarificationId && previous.answer === value.answer,
          'IDEMPOTENCY_CONFLICT', 'Clarification request ID already names another answer');
        return { messageId, clarification: previous };
      }
      requireFact(clarification.answer === null && message.clarification?.id === clarificationId
        && !message.processed && !message.excluded, 'STALE_CLARIFICATION', 'This exact question is no longer waiting');
      requireFact(clarification.allowFreeform || clarification.choices.includes(value.answer),
        'CLARIFICATION_CHOICE', 'Choose an exact offered clarification answer', 400);
      Object.assign(clarification, { answer: value.answer, answeredAt: this.now(), requestId: value.requestId });
      message.clarificationHistory = message.clarificationHistory.map(item => item.id === clarificationId ? clarification : item);
      message.clarification = null;
      this.db.put('messages', message);
      return { messageId, clarification };
    });
  }
  question(sessionId: string, request: AskRequest | null, allowNew = true): Message | undefined {
    return this.db.transaction(() => {
      for (const message of this.db.find('messages', item => item.sessionId === sessionId
        && (item.question?.state === 'pending' || item.question?.state === 'unknown')
        && item.question.request.requestId !== request?.requestId)) {
        message.question!.state = 'stale'; message.question!.stateVersion++;
        this.db.put('messages', message);
      }
      if (!request) return;
      const existing = this.db.nativeQuestion(sessionId, request.requestId);
      if (existing) {
        requireFact(fingerprint(existing.question?.request) === fingerprint(request),
          'NATIVE_ID_CONFLICT', 'Native question identity changed its original content');
        if (existing.question!.state === 'unknown' || existing.question!.state === 'stale') {
          existing.question!.state = 'pending'; existing.question!.stateVersion++;
          this.db.put('messages', existing);
        }
        return existing;
      }
      if (!allowNew) return;
      return this.addMessage({ kind: 'ask', raw: request.question, attachments: [], sessionId,
        question: { request, state: 'pending', stateVersion: 1 } });
    });
  }
  excludeSession(sessionId: string): void {
    this.db.transaction(() => {
      for (const message of this.db.find('messages', m => m.sessionId === sessionId && !m.excluded)) {
        if (message.processed && message.question?.state !== 'pending' && message.question?.state !== 'unknown') continue;
        message.excluded = true;
        message.diagnostic = 'Source became an internal role carrier; business processing stopped';
        if (message.question?.state === 'pending' || message.question?.state === 'unknown') {
          message.question.state = 'stale'; message.question.stateVersion++;
        }
        this.db.put('messages', message);
      }
      for (const row of this.db.find('topic_messages', t => t.origin === 'user' && t.state === 'pending'
        && (t.sessionId ?? this.db.get('topics', t.topicId)?.sessionId) === sessionId)) {
        row.state = 'cancelled'; row.error = 'Target became an internal role carrier';
        this.db.put('topic_messages', row);
      }
    });
  }
  recover(): void {
    this.db.transaction(() => {
      for (const row of this.db.find('topic_messages', t => t.state === 'calling')) {
        row.state = 'unknown'; row.error = 'Service stopped during native preparation or delivery; inspect the original target before any new action';
        this.db.put('topic_messages', row);
      }
      for (const topic of this.db.find('topics', t => t.mappingState === 'calling')) {
        topic.mappingState = 'unknown'; topic.mappingError = 'Service stopped during session creation; original creation may have happened';
        this.db.put('topics', topic);
      }
    });
  }
  source(messageId: string): Message { return this.db.must('messages', messageId); }
  validateComplete(input: unknown): Complete { return completeSchema.parse(input); }
}
