declare module '@fixture/runtime' {
  export class ModuleRuntime {
    constructor(options?: { report?: (error: unknown) => void });
    start(): Promise<void>;
    stop(): void;
  }
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
