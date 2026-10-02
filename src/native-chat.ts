import type { McpInvocationMeta, ModuleHostApi, PublicSessionMeta } from '@waksana/cockpit-module-sdk/backend';
import { z } from 'zod';
import { requireFact } from './errors.ts';
import type { Caller, Gateway } from './gateway.ts';
import { Store } from './store.ts';

const foregroundState = z.string().nullable();

export class NativeChat implements Gateway {
  private selected: string | null;
  private closed = false;
  constructor(readonly host: ModuleHostApi, readonly store: Store, foreground: string | null) {
    this.selected = store.receipt('evidence:foreground')
      ? store.state('foreground', foregroundState)
      : foreground ?? store.receipt('foreground')?.fingerprint ?? null;
  }
  private assertOpen(): void {
    requireFact(!this.closed, 'STOPPING', 'Assistant is stopped', 503);
  }
  foregroundId(): string | null { return this.selected; }
  async session(sessionId: string): Promise<PublicSessionMeta | null> {
    const { meta } = await this.host.call('session/get', { sessionId });
    requireFact(!meta || meta.sessionId === sessionId, 'SESSION_MISMATCH', 'Native session identity differs');
    return meta;
  }
  async foreground(): Promise<PublicSessionMeta | null> {
    if (this.selected === null) return null;
    const sessionId = this.selected, meta = await this.session(sessionId);
    requireFact(meta, 'FOREGROUND_MISSING',
      `The selected foreground ${sessionId} no longer exists; no replacement was created`, 404);
    return meta;
  }
  async setForeground(sessionId: string | null): Promise<void> {
    this.assertOpen();
    if (sessionId !== null) {
      const meta = await this.session(sessionId);
      this.assertOpen();
      requireFact(meta, 'FOREGROUND_MISSING', `The selected foreground ${sessionId} does not exist`, 404);
    }
    this.store.saveState('foreground', sessionId, foregroundState);
    this.selected = sessionId;
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
  close(): void { this.closed = true; }
}
