import type { Readiness, TimelineItem } from '../src/ui-types.ts';
import type { Operation } from '../src/types.ts';
import type { DraftReference, ModuleDraftSnapshot } from '@waksana/cockpit-module-sdk/frontend';
import type { ClarificationActions } from './clarification.ts';

export interface Submission {
  requestId: string;
  submissionId: string;
  state: 'pending' | 'accepted' | 'unknown' | 'error';
  detail: string;
  receipt?: unknown;
}
export interface SetupOperation {
  requestId: string;
  receiptId: string;
  label: string;
  state: 'pending' | 'accepted' | 'unknown' | 'error';
  detail: string;
  result?: unknown;
}
export interface Snapshot {
  open: boolean;
  items: TimelineItem[];
  hasOlder: boolean;
  loading: boolean;
  loadingOlder: boolean;
  stream: 'connecting' | 'connected' | 'disconnected';
  error: string | null;
  readiness: Readiness | null;
  checking: boolean;
  readinessError: string | null;
  draft: Readonly<ModuleDraftSnapshot>;
  submissions: Submission[];
  setup: SetupOperation[];
}
export interface AssistantActions {
  readonly draft: DraftReference;
  getSnapshot(): Snapshot;
  subscribe(listener: () => void): () => void;
  open(): void;
  close(): void;
  edit(text: string): void;
  send(): Promise<void>;
  inspectInput(requestId: string): Promise<void>;
  getClarification(messageId: string, clarificationId: string): ClarificationActions | undefined;
  loadOlder(): Promise<void>;
  reconnect(): void;
  refresh(): Promise<void>;
  inspectOperation(requestId: string): Promise<Operation | null>;
  dispose(): void;
}
