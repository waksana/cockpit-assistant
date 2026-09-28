import type { InputReceipt, Readiness, SessionInspection, TimelineItem } from '../src/ui-types.ts';
import type { Operation, Role } from '../src/types.ts';

export interface Draft { text: string; reply: TimelineItem | null; revision: number }
export interface Submission {
  requestId: string;
  text: string;
  replyTo?: string;
  revision: number;
  state: 'pending' | 'accepted' | 'unknown' | 'error';
  detail: string;
  receipt?: InputReceipt;
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
  draft: Draft;
  submissions: Submission[];
  setup: SetupOperation[];
}
export interface AssistantActions {
  getSnapshot(): Snapshot;
  subscribe(listener: () => void): () => void;
  open(): void;
  close(): void;
  edit(text: string): void;
  reply(item: TimelineItem | null): void;
  send(): Promise<void>;
  inspectInput(requestId: string): Promise<void>;
  loadOlder(): Promise<void>;
  reconnect(): void;
  refresh(): Promise<void>;
  inspectSession(sessionId: string): Promise<SessionInspection>;
  createSession(cwd: string, role?: Role): Promise<void>;
  bind(role: Role, sessionId: string, expectedModelId: string, expectedEpoch: number): Promise<void>;
  enroll(sessionId: string, label: string): Promise<void>;
  inspectOperation(requestId: string): Promise<Operation | null>;
  dispose(): void;
}
