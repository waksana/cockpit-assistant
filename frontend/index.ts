import type { ActivateFrontend } from '@waksana/cockpit-module-sdk/frontend';
import { createStore } from './store.ts';
import { createPage } from './view.ts';

export const frontendApiVersion = 3;
export const activate: ActivateFrontend = context => {
  if (context.apiVersion !== 3 || context.publicComponentsVersion !== 1 || context.draftOwnerVersion !== 1
    || context.draftSubmissionVersion !== 2 || context.pageVersion !== 1 || context.messagePresentationVersion !== 1 || context.menuVersion !== 1
    || context.uiVersion !== 1 || context.uiSurfaceVersion !== 1) {
    throw new Error('Assistant requires frontend API v3, module pages/navigation v1, message presentation v1, public components/owner drafts v1, draft submission v2 and public UI/surfaces v1');
  }
  const store = context.state.register({
    id: 'conversation-state', create: () => createStore(context), dispose: service => service.dispose(),
  }).get();
  return {
    apiVersion: 3,
    menus: [{ id: 'open-assistant', menu: 'global', getState: () => ({ label: '助手' }),
      onSelect: () => context.navigation.navigate('main') }],
    pages: [{ id: 'main', component: createPage(context, store, () => context.navigation.home()) }],
  };
};
