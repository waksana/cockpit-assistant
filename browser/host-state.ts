import { useSyncExternalStore } from 'react';

// App and its real route/module-view lifecycle run against synthetic state only.
const listeners = new Set<() => void>();
let state = {
  activeId: null as string | null,
  sessions: Object.freeze([]),
  snapshotReady: true,
  connState: 'open',
  init: () => {},
  setActiveId: (activeId: string | null) => {
    if (state.activeId === activeId) return;
    state = { ...state, activeId };
    listeners.forEach(listener => listener());
  },
  onModuleInvalidated: () => () => {},
  onModuleEvent: () => () => {},
  canSendDraft: () => { throw new Error('Native draft submission is outside this synthetic fixture'); },
  sendDraft: () => { throw new Error('Native draft submission is outside this synthetic fixture'); },
};
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useCockpit = Object.assign(
  <T,>(selector: (value: typeof state) => T): T => useSyncExternalStore(subscribe, () => selector(state)),
  {
  getState: () => state,
  subscribe,
});
