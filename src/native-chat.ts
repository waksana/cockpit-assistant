import type { McpInvocationMeta, ModuleHostApi, NativeChatEvent, PublicSessionMeta, PromptAccepted } from '@waksana/cockpit-module-sdk/backend';
import { attachmentsSchema } from './attachments.ts';
import { requireFact } from './errors.ts';
import type { Caller, Gateway } from './gateway.ts';
import { Store, fingerprint } from './store.ts';

const primary = (event: NativeChatEvent) => !event.ephemeral && !event.agentId && !event.parentToolCallId
  && !event.data.agentId && !event.data.parentToolCallId;
const roleOf = (meta: PublicSessionMeta | null): Caller['role'] | null => {
  if (!meta?.loaded || meta.rolesNeedReload || meta.appliedRoles?.length !== 1) return null;
  const role = meta.appliedRoles[0]!;
  return role.moduleId === 'assistant' && (role.roleId === 'coordinator' || role.roleId === 'organizer') ? role.roleId : null;
};
const receiptId = (sessionId: string, messageId: string) => `input:${fingerprint([sessionId, messageId])}`;

export class NativeChat implements Gateway {
  private events = new Map<string, NativeChatEvent[]>();
  private tracked = new Set<string>();
  private waiting = new Map<string, Set<() => void>>();
  private selected: string | null;
  private closed = false;
  constructor(readonly host: ModuleHostApi, readonly store: Store, foreground: string | null,
    readonly allowedTools: readonly string[]) {
    this.selected = foreground ?? store.receipt('foreground')?.fingerprint ?? null;
    if (this.selected) this.tracked.add(this.selected);
  }
  async session(sessionId: string): Promise<PublicSessionMeta | null> {
    const { meta } = await this.host.call('session/get', { sessionId });
    requireFact(!meta || meta.sessionId === sessionId, 'SESSION_MISMATCH', 'Native session identity differs');
    return meta;
  }
  async foreground() {
    if (!this.selected) return null;
    const meta = await this.session(this.selected);
    requireFact(meta, 'FOREGROUND_MISSING', `The selected foreground ${this.selected} no longer exists; no replacement was created`, 404);
    return meta;
  }
  async validateForeground(meta: PublicSessionMeta): Promise<void> {
    requireFact(meta.sessionId === this.selected && roleOf(meta) === 'coordinator',
      'FOREGROUND_ROLE', 'The original foreground must have only the applied Assistant role with no pending role reload', 403);
    await this.validateResources(meta.sessionId, 'coordinator');
  }
  private async validateResources(sessionId: string, role: Caller['role']): Promise<void> {
    requireFact(!this.closed, 'STOPPING', 'Assistant stopped before resource validation', 503);
    const scope = await this.host.call('session/tool-scope', { sessionId });
    const names = role === 'organizer' ? ['assistant_topics', 'assistant_topic', 'assistant_history'] : this.allowedTools;
    requireFact(scope.sessionId === sessionId && scope.loaded && scope.tools?.length === names.length
      && new Set(scope.tools.map(tool => tool.mcpToolName)).size === names.length
      && scope.tools.every(tool => tool.mcpServerName === 'assistant' && names.includes(tool.mcpToolName ?? '')),
    'CALLER_RESOURCES', 'The native Assistant tool set is not the role-only toolkit', 403);
    requireFact(!this.closed, 'STOPPING', 'Assistant stopped before resource readiness', 503);
    const ready = await this.host.call('roles/readiness', { sessionId });
    requireFact(ready.sessionId === sessionId && ready.ready && !ready.rolesNeedReload,
      'CALLER_RESOURCES', 'Assistant role resources are not ready', 403);
  }
  observe(sessionId: string, event: NativeChatEvent): void {
    if (!this.tracked.has(sessionId) || !primary(event) || !['user.message', 'assistant.message'].includes(event.type)) return;
    const events = this.events.get(sessionId) ?? [];
    if (!events.some(old => old.id === event.id)) events.push(event);
    this.events.set(sessionId, events.slice(-64));
  }
  async accepted(event: PromptAccepted): Promise<void> {
    const meta = await this.session(event.sessionId), role = roleOf(meta);
    if (!role) return;
    this.tracked.add(event.sessionId);
    const key = receiptId(event.sessionId, event.messageId), hash = fingerprint(event.origin);
    if (!this.store.seen(key, hash)) this.store.remember(key, hash, event.acceptedAt);
    for (const resolve of this.waiting.get(key) ?? []) resolve();
  }
  private async receipt(key: string) {
    if (!this.store.receipt(key)) await new Promise<void>(resolve => {
      const waiting = this.waiting.get(key) ?? new Set<() => void>();
      const finish = () => {
        clearTimeout(timeout); waiting.delete(finish);
        if (!waiting.size) this.waiting.delete(key);
        resolve();
      };
      const timeout = setTimeout(finish, 1500);
      waiting.add(finish); this.waiting.set(key, waiting);
    });
    return this.store.receipt(key);
  }
  async caller(identity: McpInvocationMeta): Promise<Caller> {
    requireFact(identity.sessionId === identity.runtimeSessionId && !identity.subagent && identity.toolCallId,
      'CALLER_IDENTITY', 'A primary native tool-call identity is required', 403);
    const meta = await this.session(identity.sessionId), role = roleOf(meta);
    requireFact(role, 'CALLER_ROLE', 'Select and load the distinct Assistant role in native Chat', 403);
    this.tracked.add(identity.sessionId);
    await this.validateResources(identity.sessionId, role);
    let events = this.events.get(identity.sessionId) ?? [];
    const matches = () => events.filter(event => event.type === 'assistant.message'
      && Array.isArray(event.data.toolRequests) && event.data.toolRequests.some(tool =>
        tool && typeof tool === 'object' && 'toolCallId' in tool && tool.toolCallId === identity.toolCallId));
    const interaction = matches()[0]?.data.interactionId;
    if (!matches().length || !events.some(event => event.type === 'user.message' && event.data.interactionId === interaction)) {
      const page = await this.host.call('session/chat', { sessionId: identity.sessionId, source: 'live',
        direction: 'backward', agentScope: 'primary', types: ['user.message', 'assistant.message'],
        max: 64, bootstrap: false, waitMs: 0 });
      requireFact(page.cursorStatus === 'ok', 'NATIVE_HISTORY', 'Native evidence is unavailable; no message was inferred');
      for (const event of page.events) this.observe(identity.sessionId, event);
      events = this.events.get(identity.sessionId) ?? [];
    }
    const tool = matches(), interactionId = tool[0]?.data.interactionId;
    requireFact(tool.length === 1 && typeof interactionId === 'string', 'CALLER_PROVENANCE',
      'This tool call does not identify one native interaction', 403);
    requireFact((tool[0]!.data.toolRequests as { toolCallId?: string }[]).filter(tool => tool.toolCallId === identity.toolCallId).length === 1,
      'CALLER_PROVENANCE', 'Native tool identity is duplicated', 403);
    const sources = events.filter(event => event.type === 'user.message' && event.data.interactionId === interactionId);
    requireFact(sources.length <= 1, 'CALLER_PROVENANCE', 'Native input attribution is ambiguous', 403);
    const source = sources[0], messageId = source?.data.messageId;
    const proof = typeof messageId === 'string' ? await this.receipt(receiptId(identity.sessionId, messageId)) : null;
    const isHuman = proof?.fingerprint === fingerprint('user') && !source?.data.source && source?.data.isAutopilotContinuation !== true;
    requireFact(roleOf(await this.session(identity.sessionId)) === role, 'CALLER_ROLE', 'The native role changed during input verification', 403);
    if (isHuman && role === 'coordinator') {
      requireFact(!this.selected || this.selected === identity.sessionId, 'FOREGROUND_SELECTED', 'Another foreground session is selected');
      if (!this.selected) {
        this.store.remember('foreground', identity.sessionId);
        this.selected = identity.sessionId;
      }
    }
    requireFact(role !== 'coordinator' || this.selected === identity.sessionId,
      'FOREGROUND_SELECTED', 'Only the selected Assistant foreground may consume results', 403);
    return { sessionId: identity.sessionId, toolCallId: identity.toolCallId, role,
      input: source && typeof messageId === 'string' ? {
        sessionId: identity.sessionId, messageId, interactionId, human: isHuman,
        text: typeof source.data.content === 'string' ? source.data.content : '',
        attachments: attachmentsSchema.parse(source.data.attachments ?? []),
        createdAt: typeof source.timestamp === 'number' ? source.timestamp
          : typeof source.timestamp === 'string' && Number.isFinite(Date.parse(source.timestamp)) ? Date.parse(source.timestamp) : 0,
      } : null };
  }
  close(): void {
    this.closed = true;
    for (const waiting of this.waiting.values()) for (const finish of waiting) finish();
    this.waiting.clear(); this.events.clear(); this.tracked.clear();
  }
}
