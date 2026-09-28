import type { ActivateFrontend } from '@waksana/cockpit-module-sdk/frontend';
import { createStore } from './store.ts';
import { createDialog } from './view.ts';

export const activate: ActivateFrontend = context => {
  if (context.apiVersion !== 2 || context.globalComponentVersion !== 1 || context.menuVersion !== 1
    || context.uiVersion !== 1 || context.uiSurfaceVersion !== 1 || typeof context.createPortal !== 'function') {
    throw new Error('Assistant requires globalComponentVersion 1, menuVersion 1 and public UI/surfaces v1');
  }
  const store = context.state.register({
    id: 'conversation-state', create: () => createStore(context), dispose: service => service.dispose(),
  }).get();
  return {
    apiVersion: 2,
    menus: [{ id: 'open-assistant', menu: 'global', getState: () => ({ label: '助手' }), onSelect: () => store.open() }],
    globalComponents: [{ id: 'assistant-dialog', component: createDialog(context, store) }],
  };
};
