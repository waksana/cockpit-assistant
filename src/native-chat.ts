import type { McpInvocationMeta, ModuleHostApi, PublicSessionMeta, RoleAssignment,
  RoleAssignmentNotification, RoleAvailabilityCheck, ModuleRoleAvailabilityReason, RoleSelection,
} from '@waksana/cockpit-module-sdk/backend';
import { z } from 'zod';
import { requireFact } from './errors.ts';
import type { Caller, Gateway } from './gateway.ts';
import type { Store } from './store.ts';

const coordinator = { moduleId: 'assistant', roleId: 'coordinator' } as const;
const hasCoordinator = (roles: readonly RoleSelection[] | undefined) =>
  roles?.some(role => role.moduleId === coordinator.moduleId && role.roleId === coordinator.roleId) ?? false;
const directoryLimit = 100, directoryPages = 100;
const directoryPage = z.object({
  sessions: z.array(z.object({
    sessionId: z.string().min(1).refine(value => value.trim() === value),
    roles: z.array(z.object({ moduleId: z.string().min(1), roleId: z.string().min(1) })).optional(),
  })).max(directoryLimit),
  cursor: z.string().min(1).optional(),
});

export class NativeChat implements Gateway {
  private selected: string | null = null;
  private discovery = 0;
  private foregroundRead: Promise<PublicSessionMeta | null> | null = null;
  private closed = false;
  constructor(readonly host: ModuleHostApi, _store?: Store, _legacyForeground?: string | null) {}
  private assertOpen(signal?: AbortSignal): void {
    requireFact(!this.closed && !signal?.aborted, 'STOPPING', 'Assistant is stopped or the role check was aborted', 503);
  }
  invalidateForeground(): void {
    this.discovery++;
    this.selected = null;
    this.foregroundRead = null;
  }
  foregroundId(): string | null { return this.selected; }
  private async owners(signal?: AbortSignal): Promise<string[]> {
    const owners: string[] = [], cursors = new Set<string>(), sessions = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < directoryPages; page++) {
      this.assertOpen(signal);
      const result = await this.host.call('session/directory', { limit: directoryLimit, ...(cursor ? { cursor } : {}) });
      this.assertOpen(signal);
      const parsed = directoryPage.parse(result);
      for (const session of parsed.sessions) {
        requireFact(!sessions.has(session.sessionId), 'COORDINATOR_DIRECTORY_CHANGED',
          'Session directory repeated an identity; coordinator ownership is unknown');
        sessions.add(session.sessionId);
        if (hasCoordinator(session.roles)) owners.push(session.sessionId);
      }
      if (parsed.cursor === undefined) return owners;
      requireFact(!cursors.has(parsed.cursor), 'COORDINATOR_DIRECTORY_CURSOR',
        'Session directory repeated a cursor; coordinator ownership is unknown');
      cursors.add(parsed.cursor); cursor = parsed.cursor;
    }
    requireFact(false, 'COORDINATOR_DIRECTORY_LIMIT',
      'Session directory exceeded the bounded ownership scan; coordinator ownership is unknown');
  }
  async availability(selection: RoleAvailabilityCheck, signal: AbortSignal): Promise<{ reasons: ModuleRoleAvailabilityReason[] }> {
    this.assertOpen(signal);
    if (!hasCoordinator(selection.roles)) return { reasons: [] };
    const owners = await this.owners(signal);
    this.assertOpen(signal);
    if (owners.length === 0 || owners.length === 1 && owners[0] === selection.sessionId) return { reasons: [] };
    return { reasons: [{
      status: 'denied', code: owners.length > 1 ? 'COORDINATOR_CONFLICT' : 'COORDINATOR_OWNED',
      message: owners.length > 1
        ? `Multiple sessions have the saved Assistant coordinator role: ${owners.join(', ')}; resolve the conflict explicitly`
        : `The Assistant coordinator role is already saved on session ${owners[0]}`,
      roles: [coordinator], capabilities: ['instructions', 'mcp', 'skills'],
    }] };
  }
  async permit(assignment: RoleAssignment, signal: AbortSignal): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    const { reasons } = await this.availability(assignment, signal);
    this.assertOpen(signal);
    return reasons.length ? { allowed: false, reason: reasons.map(reason => reason.message).join('; ') } : { allowed: true };
  }
  saved(_notification: RoleAssignmentNotification, _signal: AbortSignal): void {
    // Saved hooks run under Host role locks: invalidate only, never load or notify here.
    this.invalidateForeground();
  }
  async session(sessionId: string): Promise<PublicSessionMeta | null> {
    const { meta } = await this.host.call('session/get', { sessionId });
    requireFact(!meta || meta.sessionId === sessionId, 'SESSION_MISMATCH', 'Native session identity differs');
    return meta;
  }
  async foreground(): Promise<PublicSessionMeta | null> {
    this.assertOpen();
    if (this.foregroundRead) return this.foregroundRead;
    const discovery = this.discovery, operation = this.discoverForeground(discovery);
    this.foregroundRead = operation;
    const finished = () => { if (this.foregroundRead === operation) this.foregroundRead = null; };
    void operation.then(finished, () => {
      if (this.discovery === discovery) this.selected = null;
      finished();
    });
    return operation;
  }
  private async discoverForeground(discovery: number): Promise<PublicSessionMeta | null> {
    const owners = await this.owners();
    const assertCurrent = () => {
      this.assertOpen();
      requireFact(discovery === this.discovery, 'FOREGROUND_CHANGED',
        'Coordinator ownership changed during discovery; no stale destination can be used');
    };
    assertCurrent();
    requireFact(owners.length <= 1, 'COORDINATOR_CONFLICT',
      `Multiple sessions have the saved Assistant coordinator role: ${owners.join(', ')}; no destination was selected`);
    if (!owners.length) { this.selected = null; return null; }
    const sessionId = owners[0]!, meta = await this.session(sessionId);
    assertCurrent();
    requireFact(meta && hasCoordinator(meta.roles), 'COORDINATOR_CHANGED',
      `The saved Assistant coordinator ${sessionId} disappeared or changed during discovery`);
    requireFact(!meta.loaded || hasCoordinator(meta.appliedRoles) && !meta.rolesNeedReload,
      'COORDINATOR_NOT_APPLIED', 'The loaded coordinator has not applied its saved role; explicit reload is required');
    this.selected = sessionId;
    return meta;
  }
  async caller(identity: McpInvocationMeta): Promise<Caller> {
    this.assertOpen();
    requireFact(typeof identity.sessionId === 'string' && identity.sessionId.trim()
      && identity.sessionId === identity.runtimeSessionId
      && typeof identity.toolCallId === 'string' && identity.toolCallId.trim(),
    'CALLER_IDENTITY', 'A consistent native session and tool-call identity are required', 403);
    const meta = await this.session(identity.sessionId);
    this.assertOpen();
    requireFact(meta, 'CALLER_MISSING', 'The native calling session no longer exists', 404);
    return { sessionId: identity.sessionId, toolCallId: identity.toolCallId };
  }
  close(): void { this.closed = true; this.invalidateForeground(); }
}
