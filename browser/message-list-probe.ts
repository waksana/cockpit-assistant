import type { ModuleFrontend, ModuleFrontendContext } from '@waksana/cockpit-module-sdk/frontend';

export const frontendApiVersion = 3;

declare global {
  interface Window {
    messageListProbe: { activate(): void; disposed: boolean };
    revokeMessageListProbe(): void;
  }
}

export async function activate(context: ModuleFrontendContext): Promise<ModuleFrontend> {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  window.messageListProbe = { activate: release, disposed: false };
  await gate;
  return {
    apiVersion: 3,
    components: [{
      id: 'late-message-list', boundary: 'messageList',
      wrap: Base => function LateMessageList(props) {
        const attributes = { ...props, 'data-testid': 'late-message-list' };
        return context.react.createElement(Base, attributes);
      },
    }],
    dispose() { window.messageListProbe.disposed = true; },
  };
}
