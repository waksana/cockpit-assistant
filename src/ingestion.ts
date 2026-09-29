import type { NativeChatEvent } from '@waksana/cockpit-module-sdk/backend';
import { fingerprint } from './database.ts';
import { AssistantService } from './service.ts';
import { requireFact } from './errors.ts';
import type { Reception } from './types.ts';
import { attachmentsSchema } from './attachments.ts';

export const nativeTypes = ['assistant.turn_start', 'assistant.turn_end', 'assistant.message', 'abort', 'user.message'];
export function primary(event: NativeChatEvent): boolean {
  return !event.agentId && !event.parentToolCallId && !event.data.agentId && !event.data.parentToolCallId;
}
function retained(event: NativeChatEvent): NativeChatEvent {
  const data: Record<string, unknown> = {};
  for (const key of ['messageId', 'content', 'turnId', 'agentId', 'parentToolCallId']) {
    if (typeof event.data[key] === 'string') data[key] = event.data[key];
  }
  if (Array.isArray(event.data.toolRequests)) data.toolRequests = event.data.toolRequests.map(() => ({}));
  // Native history may expose descriptors (for example omitted blob bytes), not sendable inputs.
  // Retain those facts verbatim; only complete output attachments can become routed message content.
  if ('attachments' in event.data) data.attachments = structuredClone(event.data.attachments);
  return { ...event, data };
}

/** Hooks only wake a reader. Only durable cursor pages may advance this ledger. */
export class Ingestion {
  constructor(readonly service: AssistantService) {}
  apply(sessionId: string, generation: number, events: NativeChatEvent[], cursor: string,
    historical = false, advance = true): void {
    const { db } = this.service;
    db.transaction(() => {
      this.applyWithinTransaction(sessionId, generation, events, cursor, historical, advance);
    });
  }
  applyWithinTransaction(sessionId: string, generation: number, events: NativeChatEvent[], cursor: string,
    historical = false, advance = true, liveEventIds?: ReadonlySet<string>): void {
      const { db } = this.service;
      const reception = this.service.reception(sessionId, true);
      requireFact(reception.generation === generation, 'STALE_READER', 'Reception enrollment changed during history read');
      for (const event of events) {
        if (event.ephemeral || !nativeTypes.includes(event.type)) continue;
        const id = fingerprint([sessionId, event.id]);
        const saved = retained(event);
        const old = db.get('native', id);
        if (old) {
          // Pre-attachment readers deliberately omitted this field. Enrich only that legacy shape.
          const comparable = !old.attachmentRetentionVersion && !('attachments' in old.event.data)
            && 'attachments' in saved.data
            ? { ...old.event, data: { ...old.event.data, attachments: saved.data.attachments } } : old.event;
          requireFact(fingerprint(comparable) === fingerprint(saved), 'EVENT_ID_CONFLICT', 'Native event ID changed its durable payload');
          if (!old.attachmentRetentionVersion) db.put('native', { ...old, event: saved, attachmentRetentionVersion: 1 });
          continue;
        }
        db.put('native', { id, sessionId, event: saved, historical: historical && !liveEventIds?.has(event.id),
          attachmentRetentionVersion: 1 });
      }
      if (reception.kind === 'reception') this.reconcile(reception);
      if (advance) reception.cursor = cursor;
      db.put('receptions', reception);
  }
  private reconcile(reception: Reception): void {
    const { db } = this.service;
    let after = 0;
    for (;;) {
      const page = db.nativeByType(reception.id, 'assistant.turn_end', after);
      if (!page.length) return;
      after = page[page.length - 1]!.ordinal;
      for (const { record: end } of page) {
        if (!primary(end.event)) continue;
        const endKey = `consumed:${end.id}`;
        if (db.meta(endKey, false)) continue;
        const parentId = end.event.parentId;
        if (!parentId) continue;
        const candidate = db.get('native', fingerprint([reception.id, parentId]));
        if (!candidate || candidate.event.type !== 'assistant.message' || !primary(candidate.event)) continue;
        const event = candidate.event;
        const requests = event.data.toolRequests;
        const attachments = attachmentsSchema.parse('attachments' in event.data ? event.data.attachments : []);
        if (!Array.isArray(requests) || requests.length !== 0 || typeof event.data.content !== 'string'
          || (!event.data.content.trim() && attachments.length === 0) || !event.parentId) continue;
        const start = db.get('native', fingerprint([reception.id, event.parentId]));
        if (!start || start.event.type !== 'assistant.turn_start' || !primary(start.event)) continue;
        const messageId = typeof event.data.messageId === 'string' ? event.data.messageId : null;
        const prior = db.nativeMessage(reception.id, messageId, event.id);
        if (prior) {
          if (prior.raw !== event.data.content || fingerprint(prior.attachments) !== fingerprint(attachments)) {
            db.setMeta(`revision:${prior.id}:${prior.version}`, prior);
            this.service.memory.invalidate(prior.id, 'Native source replacement');
            prior.raw = event.data.content;
            prior.attachments = attachments;
            prior.version++;
            prior.nativeEventId = event.id;
            db.put('messages', prior);
            this.service.memory.resumeAffected(prior.id);
            this.service.addWork(prior);
            this.service.publish({ type: 'correction', messageId: prior.id, topicId: prior.topicId,
              text: 'A native source has a new complete revision; prior publications remain unchanged.' });
          }
        } else {
          const message = this.service.addMessage({
            kind: 'reply', raw: event.data.content, attachments, sessionId: reception.id,
            nativeEventId: event.id, nativeMessageId: messageId, nativeParentId: event.parentId,
            historical: end.historical,
          });
          this.service.addWork(message);
        }
        db.setMeta(endKey, true);
      }
    }
  }
}
