import type { AskRequest, NativeChatEvent, PublicSessionMeta } from '@waksana/cockpit-module-sdk/backend';
import { fingerprint } from './database.ts';
import type { AssistantService } from './service.ts';
import { requireFact } from './errors.ts';
import { attachmentsSchema } from './attachments.ts';
import { questionIdentity } from './question.ts';

export const nativeTypes = ['assistant.turn_start', 'assistant.turn_end', 'assistant.message', 'abort', 'user.message'];
export function primary(event: NativeChatEvent): boolean {
  return !event.agentId && !event.parentToolCallId && !event.data.agentId && !event.data.parentToolCallId;
}
export function hasRole(meta: Pick<PublicSessionMeta, 'roles' | 'appliedRoles'>, roleId: string): boolean {
  return [...(meta.roles ?? []), ...(meta.appliedRoles ?? [])].some(r => r.moduleId === 'assistant' && r.roleId === roleId);
}
export function internal(meta: Pick<PublicSessionMeta, 'roles' | 'appliedRoles'>): boolean {
  return ['coordinator', 'organizer', 'memory', 'developer', 'observer'].some(role => hasRole(meta, role));
}
export function finalMessage(event: NativeChatEvent): boolean {
  return !event.ephemeral && primary(event) && event.type === 'assistant.message'
    && !(Array.isArray(event.data.toolRequests) && event.data.toolRequests.length)
    && (typeof event.data.content === 'string' && !!event.data.content.trim()
      || Array.isArray(event.data.attachments) && event.data.attachments.length > 0);
}
export class Ingestion {
  constructor(readonly service: AssistantService) {}
  apply(sessionId: string, events: NativeChatEvent[], meta: PublicSessionMeta, evidence: NativeChatEvent[] = []): void {
    requireFact(meta.sessionId === sessionId, 'SESSION_MISMATCH', 'Host returned another session');
    if (!this.service.managed(sessionId) || internal(meta)) return;
    for (const event of events) {
      if (!finalMessage(event)) continue;
      const nativeId = typeof event.data.messageId === 'string' && event.data.messageId ? event.data.messageId : event.id;
      const body = typeof event.data.content === 'string' ? event.data.content : '';
      const attachments = attachmentsSchema.parse(event.data.attachments ?? []);
      const topics = this.service.db.find('topics', t => t.sessionId === sessionId);
      const roots = evidence.filter(root => primary(root) && !root.ephemeral && root.type === 'user.message'
        && typeof event.data.interactionId === 'string' && root.data.interactionId === event.data.interactionId);
      const receipt = roots.length === 1 ? roots[0]!.data.messageId : null;
      const dispatches = typeof receipt === 'string' ? this.service.db.find('topic_messages',
        t => t.sessionId === sessionId && t.nativeMessageId === receipt && t.origin === 'user'
          && this.service.db.must('messages', t.messageId).conversation?.channel === 'user') : [];
      this.service.inbox({ sessionId, nativeId, eventId: event.id,
        interactionId: typeof event.data.interactionId === 'string' ? event.data.interactionId : null, kind: 'result',
        body, attachments, hash: fingerprint([body, attachments]), question: null,
        topicIds: [...new Set(dispatches.map(d => d.topicId))], candidateTopicIds: topics.map(t => t.id),
        attribution: dispatches.length ? 'native-dispatch' : 'unknown',
        dispatchIds: dispatches.map(d => d.id), askState: null });
    }
  }
  question(sessionId: string, request: AskRequest | null, meta: PublicSessionMeta): void {
    if (!this.service.managed(sessionId) || internal(meta)) return;
    for (const item of this.service.db.records('inbox')) {
      if (item.sessionId !== sessionId || item.kind !== 'ask' || !['pending', 'unknown'].includes(item.askState ?? '')) continue;
      if (item.nativeId !== request?.requestId) { item.askState = 'stale'; this.service.db.save('inbox', item); }
    }
    if (!request) return;
    this.service.inbox({ sessionId, nativeId: request.requestId, eventId: null, interactionId: null, kind: 'ask',
      body: request.question, attachments: [], question: request, hash: fingerprint(questionIdentity(request)),
      topicIds: [], candidateTopicIds: this.service.db.find('topics', t => t.sessionId === sessionId).map(t => t.id),
      attribution: 'unknown', dispatchIds: [], askState: 'pending' });
  }
}
