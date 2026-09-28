import type { ModuleHostApi } from '@waksana/cockpit-module-sdk/backend';
import type { NativeAccess } from './runtime.ts';
import { requireFact } from './errors.ts';
import { nativeTypes } from './ingestion.ts';

export function nativeAccess(host: ModuleHostApi): NativeAccess {
  requireFact(host.chatReadVersion === 1 && host.askResponseVersion === 1
    && host.resourcePreparationVersion === 1 && host.roleAssignmentVersion === 1
    && host.sessionDirectoryVersion === 1 && host.sessionLoadVersion === 1,
  'HOST_CAPABILITY', 'Assistant requires chatReadVersion, askResponseVersion, resourcePreparationVersion, '
    + 'roleAssignmentVersion, sessionDirectoryVersion and sessionLoadVersion 1');
  return {
    host,
    async read(sessionId, cursor, bootstrap, backward = false) {
      return host.call('session/chat', {
        sessionId, source: 'live', direction: bootstrap || backward ? 'backward' : 'forward',
        max: 64, waitMs: 0, bootstrap, agentScope: 'primary', types: nativeTypes,
        ...(cursor === null ? {} : { cursor }),
      });
    },
    async answer(sessionId, requestId, answer, wasFreeform) {
      const result = await host.call('respondAsk', { sessionId, requestId, answer, wasFreeform });
      return { accepted: result.ok, result };
    },
  };
}
