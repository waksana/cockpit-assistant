import type { AskRequest, NativeChatEvent } from '@waksana/cockpit-module-sdk/backend';
import type { NativeAttachment } from './attachments.ts';

export type Role = 'coordinator' | 'memory';
export type EffectState = 'pending' | 'calling' | 'accepted' | 'rejected' | 'unknown' | 'cancelled';
export type SourceRef = { messageId: string; version: number; assignmentVersion: number };
export interface Topic {
  id: string;
  title: string;
  content: string;
  color: string;
  sessionId: string | null;
  archived: boolean;
  version: number;
  dirtyThrough: number;
  memoryThrough: number;
}
export interface Reception {
  id: string;
  label: string;
  kind: 'reception' | 'collaborator';
  enabled: boolean;
  evidence: string;
  availability: 'loaded' | 'unloaded' | 'missing' | 'unknown';
  cursor: string | null;
  cursorSource: 'live' | 'persisted';
  cursorDirection: 'forward' | 'backward';
  baseline: boolean;
  gap: string | null;
  generation: number;
  version: number;
}
export interface Message {
  id: string;
  kind: 'user' | 'reply' | 'ask' | 'system';
  raw: string;
  attachments: NativeAttachment[];
  version: number;
  topicId: string | null;
  assignmentVersion: number;
  assignmentReason: string | null;
  sessionId: string | null;
  nativeEventId: string | null;
  nativeMessageId: string | null;
  nativeParentId: string | null;
  deliveryId?: string;
  correlation: 'unknown' | 'native';
  historical: boolean;
  sequence: number;
  createdAt: number;
}
export interface MessageTopic {
  id: string;
  messageId: string;
  topicId: string;
}
export interface Question {
  id: string;
  sessionId: string;
  request: AskRequest;
  messageId: string;
  state: 'pending' | 'stale' | 'answered' | 'unknown';
  stateVersion?: number;
}
/** Internal progress only: no coordinator tool accepts a work proof. */
export interface Work {
  id: string;
  role: Role;
  kind: 'input' | 'output' | 'memory' | 'handoff';
  messageId: string | null;
  attachments: NativeAttachment[];
  topicId: string | null;
  inputVersion: number;
  stateVersion: number;
  sources: SourceRef[];
  through: number;
  state: 'pending' | 'leased' | 'done' | 'invalidated' | 'failed';
  epoch: number | null;
  token: string | null;
  leaseUntil: number;
  result: unknown;
  attempts?: number;
  retryAfter?: number;
}
export interface Batch {
  id: string;
  role: Role;
  sessionId: string;
  epoch: number;
  workIds: string[];
  state: 'pending' | 'running' | 'done' | 'failed' | 'unknown';
  dispatchHash: string | null;
  createdAt: number;
}
export interface Binding {
  id: Role;
  sessionId: string;
  epoch: number;
  definitionVersion: string;
  modelId: string | null;
  cwd: string;
  ready: boolean;
  evidence: unknown;
}
export interface Delivery {
  id: string;
  kind: 'prompt' | 'ask' | 'wake';
  messageId: string | null;
  messageIds?: string[];
  topicId?: string;
  batchId?: string;
  sessionId: string;
  requestId: string | null;
  text: string;
  attachments: NativeAttachment[];
  supplement: string | null;
  answerFreeform: boolean | null;
  state: EffectState;
  result: unknown;
  error: string | null;
  createdAt: number;
  roleEpoch: number | null;
  inputVersion?: number;
  nativeMessageId?: string;
  interactionId?: string;
  interactionState?: 'pending' | 'active' | 'completed' | 'interrupted' | 'unknown';
  preparation?: {
    attempts: number;
    nextAttemptAt: number;
    error: string | null;
    loadOperationId?: string;
  };
}
export interface Publication {
  id: string;
  sequence: number;
  type: 'message' | 'question' | 'status' | 'correction' | 'clarification' | 'attribution';
  messageId: string | null;
  topicId: string | null;
  text: string;
  attachments: NativeAttachment[];
  sources: SourceRef[];
  createdAt: number;
}
export interface Memory {
  id: string;
  topicId: string;
  version: number;
  kind: 'confirmed' | 'reported' | 'inferred';
  text: string;
  sources: SourceRef[];
  workId: string;
  valid: boolean;
  correction: string | null;
}
export interface NativeRecord {
  id: string;
  sessionId: string;
  event: NativeChatEvent;
  historical: boolean;
  attachmentRetentionVersion?: 1;
}
export interface Operation {
  id: string;
  fingerprint: string;
  state: EffectState;
  result: unknown;
}
export interface Tables {
  topics: Topic;
  messageTopics: MessageTopic;
  batches: Batch;
  receptions: Reception;
  messages: Message;
  questions: Question;
  work: Work;
  bindings: Binding;
  deliveries: Delivery;
  publications: Publication;
  memories: Memory;
  native: NativeRecord;
  operations: Operation;
}
export type Table = keyof Tables;
