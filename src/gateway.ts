import type { McpInvocationMeta, ModuleHostApi, NativeChatEvent, PublicSessionMeta } from '@waksana/cockpit-module-sdk/backend';
import type { NativeAttachment } from './attachments.ts';

/** A transient native input, never a second stored chat message. */
export interface Input {
  sessionId: string;
  messageId: string;
  interactionId: string;
  text: string;
  attachments: NativeAttachment[];
  createdAt: number;
  human: boolean;
}
export interface Caller {
  sessionId: string;
  toolCallId: string;
  role: 'coordinator' | 'organizer';
  input: Input | null;
}
export interface Gateway {
  readonly host: ModuleHostApi;
  caller(identity: McpInvocationMeta): Promise<Caller>;
  session(id: string): Promise<PublicSessionMeta | null>;
  foreground(): Promise<PublicSessionMeta | null>;
  validateForeground(meta: PublicSessionMeta, state?: 'saved' | 'applied'): Promise<void>;
  observe(sessionId: string, event: NativeChatEvent): void;
}
