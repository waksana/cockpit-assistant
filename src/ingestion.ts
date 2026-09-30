import type { NativeChatEvent } from '@waksana/cockpit-module-sdk/backend';
import { fingerprint } from './database.ts';
import { AssistantService } from './service.ts';
import { requireFact } from './errors.ts';
import { attachmentsSchema } from './attachments.ts';

export const nativeTypes = ['assistant.turn_start', 'assistant.turn_end', 'assistant.message', 'abort', 'user.message'];
export function primary(event: NativeChatEvent): boolean {
  return !event.agentId && !event.parentToolCallId && !event.data.agentId && !event.data.parentToolCallId;
}
function identity(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Persist originals once and minimal native evidence, never a native history mirror. */
export class Ingestion {
  constructor(readonly service: AssistantService) {}
  apply(sessionId: string, generation: number, events: NativeChatEvent[], cursor: string,
    historical = false, advance = true): void {
    this.service.db.transaction(() =>
      this.applyWithinTransaction(sessionId, generation, events, cursor, historical, advance));
  }
  applyWithinTransaction(sessionId: string, generation: number, events: NativeChatEvent[], cursor: string,
    historical = false, advance = true, liveEventIds?: ReadonlySet<string>): void {
    const { db } = this.service;
    const reception = this.service.reception(sessionId, true);
    requireFact(reception.generation === generation, 'STALE_READER', 'Reception enrollment changed during history read');
    const deliveries = db.find('deliveries', delivery => delivery.sessionId === sessionId
      && delivery.kind === 'prompt' && delivery.state === 'accepted' && !!delivery.nativeMessageId);
    const eligible = events.filter(event => !event.ephemeral && primary(event));

    // Receipts name data.messageId, not the event envelope's id. Resolve all roots
    // first so a backward/bootstrap page does not depend on its traversal order.
    for (const event of eligible) {
      if (event.type !== 'user.message') continue;
      const messageId = identity(event.data.messageId);
      const interactionId = identity(event.data.interactionId);
      if (!messageId || !interactionId) continue;
      const matches = deliveries.filter(delivery => delivery.nativeMessageId === messageId);
      requireFact(matches.length <= 1, 'RECEIPT_CONFLICT', 'Native receipt identifies more than one Assistant delivery');
      const delivery = matches[0];
      if (!delivery) continue;
      requireFact(!delivery.interactionId || delivery.interactionId === interactionId,
        'INTERACTION_CONFLICT', 'Native receipt changed its interaction identity');
      delivery.interactionId = interactionId;
      delivery.interactionState = 'active';
      db.put('deliveries', delivery);
      this.evidence(sessionId, event, { messageId, interactionId }, historical);
    }
    if (reception.kind === 'reception') for (const event of eligible) {
      if (event.type !== 'assistant.message') continue;
      const interactionId = identity(event.data.interactionId);
      const matches = deliveries.filter(delivery => interactionId && delivery.interactionId === interactionId);
      requireFact(matches.length <= 1, 'INTERACTION_CONFLICT', 'Native interaction identifies multiple Assistant prompts');
      const delivery = matches[0];
      const attachments = attachmentsSchema.parse(event.data.attachments ?? []);
      const messageId = identity(event.data.messageId);
      if (!this.evidence(sessionId, event, { messageId, interactionId,
        contentFingerprint: fingerprint([event.data.content, attachments]) }, historical)) continue;
      const content = typeof event.data.content === 'string' ? event.data.content : '';
      if (!content.trim() && !attachments.length) continue;
      const prior = db.nativeMessage(sessionId, messageId, event.id);
      if (prior) {
        requireFact(!prior.deliveryId || !delivery || prior.deliveryId === delivery.id,
          'SOURCE_CONFLICT', 'Native reply changed its originating delivery');
        if (prior.raw === content && fingerprint(prior.attachments) === fingerprint(attachments)) continue;
        db.setMeta(`revision:${prior.id}:${prior.version}`, prior);
        this.service.memory.invalidate(prior.id, 'Native source replacement');
        prior.raw = content;
        prior.attachments = attachments;
        prior.version++;
        prior.nativeEventId = event.id;
        db.put('messages', prior);
        this.service.memory.resumeAffected(prior.id);
        this.service.addWork(prior);
        this.service.publish({ type: 'correction', messageId: prior.id, topicId: prior.topicId,
          text: 'The original session reply was updated.' });
      } else {
        const message = this.service.addMessage({
          kind: 'reply', raw: content, attachments, sessionId,
          nativeEventId: event.id, nativeMessageId: messageId, nativeParentId: event.parentId ?? null,
          ...(delivery ? { deliveryId: delivery.id } : {}), correlation: 'native',
          historical: historical && !liveEventIds?.has(event.id),
        });
        this.service.addWork(message);
      }
    }
    if (advance) reception.cursor = cursor;
    db.put('receptions', reception);
  }
  private evidence(sessionId: string, event: NativeChatEvent, data: Record<string, unknown>,
    historical: boolean): boolean {
    const { db } = this.service;
    const id = fingerprint([sessionId, event.id]);
    const projected: NativeChatEvent = { id: event.id, type: event.type,
      ...(event.parentId !== undefined ? { parentId: event.parentId } : {}), data };
    const old = db.get('native', id);
    requireFact(!old || fingerprint(old.event) === fingerprint(projected),
      'EVENT_ID_CONFLICT', 'Native event ID changed its durable payload');
    if (old) return false;
    db.put('native', { id, sessionId, event: projected, historical });
    return true;
  }
}
