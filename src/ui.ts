import type { AssistantService } from './service.ts';
import type { Message } from './types.ts';
import type { InputReceipt, TimelineItem, TimelinePage } from './ui-types.ts';
import { requireFact } from './errors.ts';

export function timelineItem(service: AssistantService, message: Message, diagnostic = message.diagnostic): TimelineItem {
  const rows = service.db.topicMessages(message.id);
  const topics = rows.map(row => service.db.get('topics', row.topicId)).filter(topic => !!topic);
  const question = message.question;
  return { id: message.id, messageId: message.id, sequence: message.sequence, snapshotRevision: message.revision,
    type: message.kind === 'ask' ? 'question' : 'message', text: message.raw, attachments: message.attachments,
    createdAt: message.createdAt, speaker: message.kind === 'user' ? 'user' : 'assistant',
    sessionId: message.sessionId ?? message.conversation?.targetSessionId ?? null, topicId: topics.length === 1 ? topics[0]!.id : null,
    topicTitle: message.conversation?.channel === 'legacy' && topics.length
      ? topics.length === 1 ? topics[0]!.title : `关于${topics.map(t => t.title).join('和')}` : null,
    question: question ? { state: question.state, stateVersion: question.stateVersion, requestId: question.request.requestId,
      ...(question.request.choices ? { choices: question.request.choices } : {}),
      ...(question.request.allowFreeform === undefined ? {} : { allowFreeform: question.request.allowFreeform }) } : null,
    clarifications: message.conversation?.channel === 'legacy' ? message.clarificationHistory : [], diagnostic,
    deliveryIssues: rows.flatMap(row => row.state === 'rejected' || row.state === 'unknown' || row.state === 'cancelled'
      ? [{ topicMessageId: row.id, state: row.state, detail: row.error ?? 'Native result could not be confirmed' }] : []) };
}
export function timeline(service: AssistantService, before: number | undefined, after: number | undefined, limit: number,
  diagnostic?: (message: Message) => string | null, legacy = false): TimelinePage {
  const page = service.db.messagePage(after === undefined ? 'before' : 'after', after ?? before, limit, legacy);
  return { ...page, items: page.items.map(message => timelineItem(service, message, diagnostic?.(message))) };
}
export function inputReceipt(service: AssistantService, requestId: string): InputReceipt {
  const message = service.db.input(requestId);
  requireFact(message, 'NOT_FOUND', 'Input receipt not found', 404);
  return service.receipt(message);
}
