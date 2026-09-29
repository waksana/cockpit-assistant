import type { Delivery, Message, Publication, Question, Reception, Role, Work } from './types.ts';
import type { NativeInput } from './attachments.ts';

export interface TimelineItem extends Publication {
  topicTitle: string | null;
  speaker: 'user' | 'assistant' | 'system';
  sessionId: string | null;
  question: {
    state: Question['state'];
    choices?: string[];
    allowFreeform?: boolean;
  } | null;
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
  epoch: number;
  modelId: string | null;
  cwd: string | null;
  status: 'unbound' | 'unloaded' | 'invalid' | 'unknown' | 'ready';
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
  input: NativeInput;
  message: Message;
  work: Work[];
  deliveries: Delivery[];
  hasMore: { work: boolean; deliveries: boolean };
}
