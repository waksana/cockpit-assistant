import type { AssistantService } from './service.ts';
import type { Message, Publication } from './types.ts';
import type { InputReceipt, TimelineItem, TimelinePage } from './ui-types.ts';
import { requireFact } from './errors.ts';
import { receiptInputSchema, withAttachments } from './attachments.ts';

export function timelineItem(service: AssistantService, publication: Publication): TimelineItem {
  const { db } = service;
  const message = publication.messageId ? db.get('messages', publication.messageId) : undefined;
  const anchor = publication.anchorId ? db.get('anchors', publication.anchorId) : undefined;
  const question = message ? db.forMessage('questions', message.id, 1).items[0] : undefined;
  const topicId = publication.topicId;
  const speaker = publication.type === 'clarification' ? 'assistant'
    : publication.type !== 'message' && publication.type !== 'question' ? 'system'
    : message?.kind === 'user' ? 'user'
    : message?.kind === 'reply' || message?.kind === 'ask' ? 'assistant' : 'system';
  return { ...publication, topicTitle: topicId ? db.get('topics', topicId)?.title ?? null : null,
    speaker, sessionId: message?.sessionId ?? anchor?.sessionId ?? null,
    question: question ? { state: question.state,
      ...(question.request.choices === undefined ? {} : { choices: question.request.choices }),
      ...(question.request.allowFreeform === undefined ? {} : { allowFreeform: question.request.allowFreeform }) } : null };
}

export function timeline(service: AssistantService, before: number | undefined,
  after: number | undefined, limit: number): TimelinePage {
  const page = service.db.publicationPage(after === undefined ? 'before' : 'after', after ?? before, limit);
  return { ...page, items: page.items.map(item => timelineItem(service, item)) };
}

export function inputReceipt(service: AssistantService, requestId: string): InputReceipt {
  const operation = service.db.must('operations', `input:${requestId}`);
  const original = operation.result as { message?: Message; input?: unknown } | null;
  requireFact(original?.message?.id, 'INPUT_RECEIPT_INVALID', 'Input receipt has no durable message');
  const message = withAttachments(original.message);
  const work = service.db.forMessage('work', message.id);
  const deliveries = service.db.forMessage('deliveries', message.id);
  // Older receipts saved only their original message snapshot, never the mutable current row.
  const input = receiptInputSchema.parse('input' in original ? original.input : {
    requestId, text: message.raw, attachments: message.attachments,
    ...(message.replyTo === null ? {} : { replyTo: message.replyTo }),
    ...(message.topicId === null ? {} : { topicId: message.topicId }) });
  requireFact(input.requestId === requestId, 'INPUT_RECEIPT_INVALID', 'Input receipt identity does not match');
  return { requestId, input, message, work: work.items.filter(item => item.role === 'coordinator'),
    deliveries: deliveries.items, hasMore: { work: work.hasMore, deliveries: deliveries.hasMore } };
}
