import type { AskRequest } from '@waksana/cockpit-module-sdk/backend';
import type { NativeAttachment } from './attachments.ts';

export type Role = 'coordinator';
export type EffectState = 'pending' | 'calling' | 'accepted' | 'rejected' | 'unknown' | 'cancelled';
export interface Topic {
  id: string;
  title: string;
  content: string;
  archived: boolean;
  version: number;
  sessionId: string | null;
  mappingState: 'unbound' | 'bound' | 'calling' | 'unknown';
  mappingError: string | null;
  creationReceipt: unknown;
}
export interface Clarification {
  id: string;
  question: string;
  choices: string[];
  allowFreeform: boolean;
  createdAt: number;
  answer: string | null;
  answeredAt: number | null;
  requestId: string | null;
}
export interface Question {
  request: AskRequest;
  state: 'pending' | 'stale' | 'answered' | 'unknown';
  stateVersion: number;
}
export interface Message {
  id: string;
  kind: 'user' | 'reply' | 'ask';
  raw: string;
  attachments: NativeAttachment[];
  sessionId: string | null;
  nativeEventId: string | null;
  nativeMessageId: string | null;
  sequence: number;
  revision: number;
  createdAt: number;
  processed: boolean;
  excluded: boolean;
  diagnostic: string | null;
  input?: { requestId: string; text: string; attachments: NativeAttachment[]; fingerprint: string };
  question: Question | null;
  clarificationHistory: Clarification[];
  clarification: Clarification | null;
}
/** Session-origin associations never contain a copied body or a delivery. */
export interface TopicMessage {
  id: string;
  messageId: string;
  topicId: string;
  origin: 'user' | 'session';
  prompt: string | null;
  sessionId: string | null;
  state: EffectState | null;
  mode: 'prompt' | 'ask' | null;
  requestId: string | null;
  wasFreeform: boolean | null;
  nativeMessageId: string | null;
  result: unknown;
  error: string | null;
  createdAt: number;
}
/** Setup receipts exist only in the running service, never in application storage. */
export interface Operation {
  id: string;
  fingerprint: string;
  state: EffectState;
  result: unknown;
  kind: 'create' | 'load' | 'bind' | 'activate';
  sessionId?: string;
}
export interface Reception {
  id: string;
  label: string;
  availability: 'loaded' | 'unloaded' | 'missing' | 'unknown';
}
export interface Tables {
  messages: Message;
  topic_messages: TopicMessage;
  topics: Topic;
}
export type Table = keyof Tables;
