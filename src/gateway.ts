import type { McpInvocationMeta, ModuleHostApi, PublicSessionMeta } from '@waksana/cockpit-module-sdk/backend';

export interface Caller {
  sessionId: string;
  toolCallId: string;
}
export interface Gateway {
  readonly host: ModuleHostApi;
  caller(identity: McpInvocationMeta): Promise<Caller>;
  session(id: string): Promise<PublicSessionMeta | null>;
  foregroundId(): string | null;
  foreground(): Promise<PublicSessionMeta | null>;
  setForeground(sessionId: string | null): Promise<void>;
}
