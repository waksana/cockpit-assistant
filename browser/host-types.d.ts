declare module '@fixture/runtime' {
  import type { HostSnapshot } from '@waksana/cockpit-module-sdk/frontend';
  export class ModuleRuntime {
    constructor(options?: { report?: (error: unknown) => void;
      draftSubmission?: { check(): undefined; send(): Promise<boolean> } });
    start(): Promise<void>;
    stop(): void;
    updateView(view: HostSnapshot): void;
    getSnapshot(): readonly { asset: { id: string } }[];
    unregister(module: { asset: { id: string } }): void;
  }
}
declare module '@fixture/app' {
  import type { ComponentType } from 'react';
  const App: ComponentType;
  export default App;
}
declare module '@fixture/draft' {
  export class SessionDraft { constructor(sessionId: string, storage?: Storage); }
}
declare module '@fixture/composer' {
  import type { ComponentType } from 'react';
  import type { SessionDraft } from '@fixture/draft';
  export const Composer: ComponentType<{ draft: SessionDraft; onSend(): Promise<boolean> }>;
}
declare module '@fixture/composer-surface' {
  import type { ComponentType, ReactNode } from 'react';
  export const ComposerSurface: ComponentType<{ children?: ReactNode }>;
  export const ComposerCard: ComponentType<{ children?: ReactNode }>;
}
declare module '@fixture/thread-transcript' {
  import type { ComponentType, RefObject } from 'react';
  export const ThreadTranscript: ComponentType<{
    session: {
      sessionId: string; messages: unknown[]; status: string; materialized: boolean;
      hasMore: boolean; loadingHistory: boolean; cwd: string;
    };
    messages: unknown[];
    scrollRef: RefObject<HTMLDivElement | null>;
    contentRef: RefObject<HTMLDivElement | null>;
    awayFromBottom: boolean; hasNewContent: boolean; onFollow(): void;
  }>;
}
declare module '@fixture/components' {
  import type { ComponentType, ReactNode } from 'react';
  import type { ModuleRuntime } from '@fixture/runtime';
  export const ModuleRuntimeProvider: ComponentType<{ runtime: ModuleRuntime; children?: ReactNode }>;
  export const ModuleGlobalComponents: ComponentType;
}
declare module '@fixture/menu' {
  import type { ComponentType, RefObject } from 'react';
  export const AnchoredMenu: ComponentType<{
    triggerRef: RefObject<HTMLElement | null>;
    items: { label: string; onClick: () => void }[];
    onClose: () => void;
    label: string;
    moduleTarget: { menu: 'global' };
  }>;
}
