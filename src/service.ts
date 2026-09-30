import { randomUUID } from 'node:crypto';
import type { AskRequest } from '@waksana/cockpit-module-sdk/backend';
import { Database, fingerprint } from './database.ts';
import { requireFact } from './errors.ts';
import { inputSchema, configSchema, topicSchema, dispatchSchema, presentationSchema } from './schema.ts';
import type { Config } from './schema.ts';
import type { AskBinding, ForegroundInput, InboxItem, Message, PresentationReceipt, Topic, TopicMessage } from './types.ts';
import type { InputReceipt } from './ui-types.ts';
import { questionIdentity } from './question.ts';

export function askAnswer(request: AskRequest, answer: string, attachments: Message['attachments']) {
  requireFact(attachments.length === 0, 'ASK_ATTACHMENTS', 'Native ask responses do not support attachments', 400);
  if (request.choices?.includes(answer)) return { answer, wasFreeform: false };
  requireFact(request.allowFreeform !== false, 'ASK_CHOICE', 'Answer must exactly match a current native choice', 400);
  requireFact(!!answer.trim(), 'ASK_ANSWER', 'A native answer is required', 400);
  return { answer, wasFreeform: true };
}
export function presentationTextHash(text: string): string {
  return fingerprint(text.replace(/\r\n?/g, '\n').trim());
}
export class AssistantService {
  readonly config: Config;
  constructor(readonly db: Database, readonly now = Date.now, config: unknown = {}) {
    this.config = configSchema.parse(config);
  }
  accept(input: unknown, sessionId: string): InputReceipt {
    const value = inputSchema.parse(input), hash = fingerprint(value), existing = this.db.input(value.requestId);
    if (existing) {
      requireFact(existing.input?.fingerprint === hash, 'IDEMPOTENCY_CONFLICT', 'Original input request changed');
      return this.receipt(existing);
    }
    return this.db.transaction(() => {
      const message = this.addMessage({ kind: 'user', raw: value.text, attachments: value.attachments,
        input: { ...value, fingerprint: hash },
        conversation: { channel: 'user', targetSessionId: sessionId, rootId: null } });
      this.db.save('foreground_inputs', { id: message.id, kind: 'human', sessionId, messageId: message.id,
        text: null, fingerprint: hash, state: 'pending', receipt: null, interactionId: null,
        dispatchHash: null, result: null, inboxIds: [], historySessionIds: [] });
      return this.receipt(message);
    });
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
  humanAskAnswer(messageId: string, request: AskRequest, splitPrompt: string) {
    const original = this.db.must('messages', messageId);
    requireFact(original.kind === 'user' && original.conversation?.channel === 'user' && original.input,
      'HUMAN_REQUIRED', 'Native answers require an immutable genuine human original', 403);
    requireFact(splitPrompt.trim() === original.raw.trim(), 'ASK_ORIGINAL',
      'Answer dispatch must match the entire genuine human text (outer trim only); answer separately without model rewriting');
    return askAnswer(request, original.raw.trim(), original.attachments);
  }
  topic(input: unknown, root: ForegroundInput, actionId: string): Topic {
    const value = topicSchema.parse(input);
    requireFact(root.kind !== 'notification', 'HUMAN_REQUIRED', 'Notifications cannot mutate topic registry', 403);
    return this.db.transaction(() => {
      const prior = this.db.toolAction(actionId, value);
      if (prior) return prior as Topic;
      const old = value.topicId ? this.db.get('topics', value.topicId) : undefined;
      requireFact(old || value.title, 'TOPIC_TITLE', 'A new topic needs a title', 400);
      const sessionId = Object.hasOwn(value, 'sessionId') ? value.sessionId! : old?.sessionId ?? null;
      requireFact(!(sessionId === null && old && ['calling', 'unknown'].includes(old.mappingState)),
        'UNCERTAIN_MAPPING', 'Inspect uncertain worker creation before replacing a mapping');
      const topic: Topic = { id: old?.id ?? value.topicId ?? randomUUID(), title: value.title ?? old!.title,
        content: value.content ?? old?.content ?? '', archived: value.archived ?? old?.archived ?? false,
        version: (old?.version ?? 0) + 1, sessionId,
        mappingState: sessionId ? 'bound' : 'unbound', mappingError: null, creationReceipt: old?.creationReceipt ?? null };
      if (sessionId) this.db.save('workers', { id: sessionId, registeredBy: root.id, parentSessionId: null });
      this.db.put('topics', topic); this.db.saveToolAction(actionId, value, topic);
      return topic;
    });
  }
  dispatch(input: unknown, root: ForegroundInput, askBinding?: AskBinding, rejection?: string): TopicMessage[] {
    const value = dispatchSchema.parse(input), hash = fingerprint(value);
    requireFact(root.kind === 'human' && root.messageId && root.state === 'accepted',
      'HUMAN_REQUIRED', 'Only a receipt-authenticated foreground human input can dispatch business work', 403);
    return this.db.transaction(() => {
      const current = this.db.record('foreground_inputs', root.id)!;
      if (current.dispatchHash) {
        requireFact(current.dispatchHash === hash, 'FROZEN_DISPATCH', 'This human input already has its one frozen split');
        return this.db.topicMessages(root.messageId!);
      }
      requireFact(new Set(value.items.map(item => item.topicId)).size === value.items.length,
        'DUPLICATE_TOPIC', 'Each topic occurs once in the frozen split');
      for (const item of value.items) requireFact(!this.db.must('topics', item.topicId).archived,
        'ARCHIVED_TOPIC', 'Archived topics do not accept new business input');
      for (const item of value.items) {
        const topic = this.db.must('topics', item.topicId);
        this.db.put('topic_messages', { id: randomUUID(), messageId: root.messageId!, topicId: item.topicId,
          origin: 'user', prompt: item.prompt, sessionId: askBinding?.sessionId ?? topic.sessionId,
          state: rejection ? 'rejected' : 'pending', mode: askBinding ? 'ask' : null,
          requestId: askBinding?.requestId ?? null, wasFreeform: askBinding?.wasFreeform ?? null,
          nativeMessageId: null, result: null, error: rejection ?? null, createdAt: this.now() });
      }
      current.dispatchHash = hash;
      if (askBinding) current.askBinding = askBinding;
      this.db.save('foreground_inputs', current);
      if (rejection) {
        const message = this.db.must('messages', root.messageId!);
        message.diagnostic = rejection; this.db.put('messages', message);
      }
      return this.db.topicMessages(root.messageId!);
    });
  }
  managed(sessionId: string): boolean {
    return !!this.db.record('workers', sessionId) || !!this.db.find('topics', t => t.sessionId === sessionId).length;
  }
  inbox(value: Omit<InboxItem, 'id' | 'createdAt' | 'observedAfterSequence' | 'reads' | 'presented' | 'notificationId'>): InboxItem {
    const id = fingerprint([value.sessionId, value.kind, value.nativeId]);
    const old = this.db.record('inbox', id) ?? (value.eventId
      ? this.db.records('inbox').find(item => item.sessionId === value.sessionId && item.kind === value.kind && item.eventId === value.eventId)
      : undefined);
    if (old) {
      requireFact(old.hash === value.hash && old.nativeId === value.nativeId && old.interactionId === value.interactionId,
        'NATIVE_ID_CONFLICT', 'Native inbox identity changed its original content');
      if (value.kind === 'ask' && ['stale', 'unknown'].includes(old.askState ?? '')) {
        old.askState = 'pending'; old.observedAfterSequence = this.db.nextSequence - 1; this.db.save('inbox', old);
      }
      return old; // A duplicate never restores consumed content.
    }
    const item: InboxItem = { ...value, id, createdAt: this.now(), observedAfterSequence: this.db.nextSequence - 1,
      reads: [], presented: null, notificationId: null };
    this.db.save('inbox', item); return item;
  }
  readInbox(ids: string[], root: ForegroundInput): InboxItem[] {
    requireFact(root.kind !== 'organizer' && root.interactionId, 'FOREGROUND_REQUIRED', 'Only foreground interactions present results', 403);
    return this.db.transaction(() => ids.map(id => {
      const item = this.db.record('inbox', id);
      requireFact(item, 'NOT_FOUND', 'Inbox result not found', 404);
      if (!item.presented && !item.reads.some(read => read.sessionId === root.sessionId && read.interactionId === root.interactionId)) {
        item.reads.push({ sessionId: root.sessionId, interactionId: root.interactionId!, afterSequence: this.db.nextSequence - 1 });
        this.db.save('inbox', item);
      }
      return item;
    }));
  }
  declarePresentation(input: unknown, root: ForegroundInput, actionId: string): PresentationReceipt {
    const value = presentationSchema.parse(input);
    requireFact(root.kind !== 'organizer' && root.state === 'accepted' && root.interactionId,
      'FOREGROUND_REQUIRED', 'Only authenticated foreground interactions may declare presentation', 403);
    return this.db.transaction(() => {
      const previous = this.db.toolAction(actionId, value);
      if (previous) return previous as PresentationReceipt;
      requireFact(!this.db.record('foreground_inputs', root.id)?.presentationAborted,
        'PRESENTATION_ABORTED', 'This native interaction was aborted; read and declare in a fresh foreground interaction');
      const items = value.ids.map(id => {
        const item = this.db.record('inbox', id);
        requireFact(item && !item.presented, 'PRESENTATION_PENDING', 'Presentation IDs must refer to unconsumed inbox items');
        requireFact(item.reads.some(read => read.sessionId === root.sessionId && read.interactionId === root.interactionId),
          'PRESENTATION_UNREAD', 'Each declared ID must have been read in this exact native interaction', 403);
        return item;
      });
      const textHash = presentationTextHash(value.text), afterSequence = this.db.nextSequence - 1;
      for (const item of items) {
        item.presentations ??= [];
        item.presentations.push({ actionId, sessionId: root.sessionId, interactionId: root.interactionId!,
          textHash, afterSequence, state: 'pending' });
        this.db.save('inbox', item);
      }
      const receipt: PresentationReceipt = { declared: true, ids: value.ids, sessionId: root.sessionId, interactionId: root.interactionId!,
        textHash, afterSequence, normalization: 'crlf-to-lf-outer-trim-v1' };
      this.db.saveToolAction(actionId, value, receipt);
      return receipt;
    });
  }
  saveForegroundReply(value: Pick<Message, 'raw' | 'attachments' | 'sessionId' | 'nativeMessageId' | 'nativeEventId'>,
    root: ForegroundInput, interactionId: string | null): Message {
    requireFact(value.sessionId === root.sessionId, 'SESSION_MISMATCH', 'Foreground projection must retain its source session');
    return this.db.transaction(() => {
      const old = value.nativeMessageId ? this.db.nativeMessage(root.sessionId, value.nativeMessageId)
        : value.nativeEventId ? this.db.nativeEvent(root.sessionId, value.nativeEventId) : undefined;
      const responseHash = fingerprint([value.raw, value.attachments]);
      if (old) requireFact(fingerprint([old.raw, old.attachments]) === responseHash,
        'NATIVE_ID_CONFLICT', 'Foreground native identity changed its original body');
      const projection = old ?? this.addMessage({ ...value, kind: 'reply',
        conversation: { channel: 'assistant', targetSessionId: root.sessionId, rootId: root.id } });
      if (interactionId) {
        const textHash = presentationTextHash(value.raw);
        for (const item of this.db.records('inbox')) {
          const claim = item.presentations?.find(claim => claim.state === 'pending' && claim.sessionId === root.sessionId
            && claim.interactionId === interactionId && claim.textHash === textHash && projection.sequence > claim.afterSequence);
          if (item.presented || !claim) continue;
          item.presented = { sessionId: root.sessionId, responseId: value.nativeMessageId ?? value.nativeEventId!, responseHash };
          item.body = null; item.attachments = null; item.question = null;
          this.db.save('inbox', item);
        }
      }
      return projection;
    });
  }
  cancelPresentations(sessionId?: string, interactionId?: string): void {
    this.db.transaction(() => {
      if (sessionId !== undefined && interactionId !== undefined) {
        for (const root of this.db.records('foreground_inputs').filter(root =>
          root.sessionId === sessionId && root.interactionId === interactionId)) {
          root.presentationAborted = true; this.db.save('foreground_inputs', root);
        }
      }
      this.cancelPresentationClaims(sessionId, interactionId);
    });
  }
  private cancelPresentationClaims(sessionId?: string, interactionId?: string): void {
    for (const item of this.db.records('inbox')) {
      let changed = false;
      for (const claim of item.presentations ?? []) {
        if (claim.state !== 'pending' || sessionId !== undefined && claim.sessionId !== sessionId
          || interactionId !== undefined && claim.interactionId !== interactionId) continue;
        claim.state = 'cancelled'; changed = true;
      }
      if (changed) this.db.save('inbox', item);
    }
  }
  /** Historical question inspection retains schema-3 representations without reclassification. */
  question(sessionId: string, request: AskRequest | null, allowNew = true): Message | undefined {
    return this.db.transaction(() => {
      for (const message of this.db.find('messages', m => m.sessionId === sessionId
        && ['pending', 'unknown'].includes(m.question?.state ?? '') && m.question?.request.requestId !== request?.requestId)) {
        message.question!.state = 'stale'; message.question!.stateVersion++; this.db.put('messages', message);
      }
      if (!request) return;
      const old = this.db.nativeQuestion(sessionId, request.requestId);
      if (old) {
        requireFact(fingerprint(questionIdentity(old.question?.request)) === fingerprint(questionIdentity(request)),
          'NATIVE_ID_CONFLICT', 'Native question identity changed its original content');
        if (old.question!.state === 'unknown' || old.question!.state === 'stale') {
          old.question!.state = 'pending'; old.question!.stateVersion++; this.db.put('messages', old);
        }
        return old;
      }
      if (allowNew) return this.addMessage({ kind: 'ask', raw: request.question, attachments: [], sessionId,
        question: { request, state: 'pending', stateVersion: 1 } });
    });
  }
  recover(): void {
    this.db.transaction(() => {
      this.cancelPresentationClaims();
      for (const root of this.db.records('foreground_inputs')) if (root.state === 'calling') {
        root.state = 'unknown'; root.result = { error: 'Interrupted native send; inspect receipt, never automatically resend' };
        this.db.save('foreground_inputs', root);
        if (root.messageId) {
          const message = this.db.must('messages', root.messageId);
          message.diagnostic = 'Foreground delivery is uncertain; no automatic resend'; this.db.put('messages', message);
        }
      }
      for (const row of this.db.find('topic_messages', t => t.state === 'calling'
        && this.db.must('messages', t.messageId).conversation?.channel === 'user')) {
        row.state = 'unknown'; row.error = 'Interrupted worker delivery; no automatic resend'; this.db.put('topic_messages', row);
      }
      for (const topic of this.db.find('topics', t => t.mappingState === 'calling'
        && this.db.find('topic_messages', row => row.topicId === t.id
          && this.db.must('messages', row.messageId).conversation?.channel === 'user').length > 0)) {
        topic.mappingState = 'unknown'; topic.mappingError = 'Interrupted creation; inspect original native ID'; this.db.put('topics', topic);
      }
    });
  }
  source(messageId: string): Message { return this.db.must('messages', messageId); }
}
