import type { Clarification, Message, Question, Reception, Role, TopicMessage } from './types.ts';
import type { NativeAttachment, ReceiptInput } from './attachments.ts';
export interface TimelineItem {
  id: string;
  messageId: string;
  sequence: number;
  snapshotRevision: number;
  type: 'message' | 'question';
  text: string;
  attachments: NativeAttachment[];
  createdAt: number;
  speaker: 'user' | 'assistant' | 'system';
  sessionId: string | null;
  topicId: string | null;
  topicTitle: string | null;
  question: { state: Question['state']; stateVersion: number; requestId: string;
    choices?: string[]; allowFreeform?: boolean } | null;
  clarifications: Clarification[];
  diagnostic: string | null;
  deliveryIssues: { topicMessageId: string; state: 'rejected' | 'unknown' | 'cancelled'; detail: string }[];
}
export interface TimelinePage {
  items: TimelineItem[];
  before: number | null;
  hasMore: boolean;
  watermark: number;
  cursor?: number;
}
export interface RoleReadiness {
  role: Role;
  sessionId: string | null;
  modelId: string | null;
  cwd: string | null;
  status: 'unbound' | 'unloaded' | 'invalid' | 'unknown' | 'ambiguous' | 'ready';
  detail: string | null;
}
export interface Readiness {
  roles: RoleReadiness[];
  canSend: boolean;
  receptions: Reception[];
}
export interface SessionInspection {
  sessionId: string;
  modelId: string | null;
  cwd: string;
  loaded: boolean;
  status: string;
  rolesNeedReload: boolean | null;
}
export interface InputReceipt {
  requestId: string;
  input: ReceiptInput;
  message: Message;
  topicMessages: TopicMessage[];
  hasMore: { topicMessages: boolean };
}
