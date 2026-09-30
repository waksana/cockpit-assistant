import type { NativeChatEvent, PublicSessionMeta } from '@waksana/cockpit-module-sdk/backend';
import { fingerprint } from './database.ts';
import type { AssistantService } from './service.ts';
import { requireFact } from './errors.ts';
import { attachmentsSchema } from './attachments.ts';

export const nativeTypes = ['assistant.turn_start', 'assistant.turn_end', 'assistant.message', 'abort', 'user.message'];
export function primary(event: NativeChatEvent): boolean {
  return !event.agentId && !event.parentToolCallId && !event.data.agentId && !event.data.parentToolCallId;
}
export function internal(meta: Pick<PublicSessionMeta, 'roles' | 'appliedRoles'>): boolean {
  return [...(meta.roles ?? []), ...(meta.appliedRoles ?? [])].some(role =>
    role.moduleId === 'assistant' && ['coordinator', 'memory'].includes(role.roleId));
}
/** Only actually observed complete primary replies enter the business timeline. */
export class Ingestion {
  constructor(readonly service: AssistantService) {}
  apply(sessionId: string, events: NativeChatEvent[], meta: PublicSessionMeta): void {
    requireFact(meta.sessionId === sessionId, 'SESSION_MISMATCH', 'Host returned another session');
    requireFact(Array.isArray(meta.roles) || Array.isArray(meta.appliedRoles),
      'ROLE_METADATA_UNKNOWN', 'Ordinary origin requires actual native role metadata');
    if (internal(meta)) { this.service.excludeSession(sessionId); return; }
    this.service.db.transaction(() => {
      for (const event of events) {
        if (event.ephemeral || !primary(event) || event.type !== 'assistant.message') continue;
        const nativeId = typeof event.data.messageId === 'string' && event.data.messageId ? event.data.messageId : null;
        const raw = typeof event.data.content === 'string' ? event.data.content : '';
        const attachments = attachmentsSchema.parse(event.data.attachments ?? []);
        if (!raw.trim() && !attachments.length) continue;
        const existing = nativeId ? this.service.db.nativeMessage(sessionId, nativeId)
          : this.service.db.nativeEvent(sessionId, event.id);
        if (existing) {
          requireFact(fingerprint([existing.raw, existing.attachments]) === fingerprint([raw, attachments]),
            'NATIVE_ID_CONFLICT', 'Native reply identity changed its immutable body');
          continue;
        }
        this.service.addMessage({ kind: 'reply', raw, attachments, sessionId,
          nativeMessageId: nativeId, nativeEventId: event.id });
      }
    });
  }
}
