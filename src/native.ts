import type { ModuleHostApi, PublicSessionMeta } from '@waksana/cockpit-module-sdk/backend';
import type { NativeAccess } from './runtime.ts';
import { requireFact } from './errors.ts';
import { nativeTypes } from './ingestion.ts';

export async function withRoleMetadata(host: ModuleHostApi, meta: PublicSessionMeta): Promise<PublicSessionMeta> {
  if (Array.isArray(meta.roles) || Array.isArray(meta.appliedRoles)) return meta;
  const evidence = await host.call('roles/readiness', { sessionId: meta.sessionId });
  requireFact(evidence.sessionId === meta.sessionId && Array.isArray(evidence.roles),
    'ROLE_METADATA_UNKNOWN', 'Current native role metadata is unavailable; business origin cannot be confirmed');
  return { ...meta, roles: evidence.roles, appliedRoles: evidence.appliedRoles };
}
export function nativeAccess(host: ModuleHostApi): NativeAccess {
  requireFact(host.chatReadVersion === 1 && host.askResponseVersion === 1
    && host.resourcePreparationVersion === 1 && host.roleAssignmentVersion === 1
    && host.sessionDirectoryVersion === 1 && host.sessionLoadVersion === 1
    && 'promptReceiptVersion' in host && host.promptReceiptVersion === 1,
  'HOST_CAPABILITY', 'Assistant requires chatReadVersion, askResponseVersion, resourcePreparationVersion, '
    + 'roleAssignmentVersion, sessionDirectoryVersion, sessionLoadVersion and promptReceiptVersion 1');
  return {
    host,
    async read(sessionId, cursor, bootstrap, backward = false, all = false) {
      return host.call('session/chat', {
        sessionId, source: 'live', direction: bootstrap || backward ? 'backward' : 'forward',
        max: 64, waitMs: 0, bootstrap, agentScope: 'primary',
        types: all ? ['user.message', 'assistant.message'] : nativeTypes,
        ...(cursor === null ? {} : { cursor }),
      });
    },
    async answer(sessionId, requestId, answer, wasFreeform) {
      const result = await host.call('respondAsk', { sessionId, requestId, answer, wasFreeform });
      return { accepted: result.ok, result };
    },
  };
}
