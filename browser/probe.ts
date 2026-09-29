import type {
  DraftReference, DraftSchemaScope, CapturedDraftSend, ModuleDraft,
  ModuleFrontend, ModuleFrontendContext, NativeAttachmentDescriptor,
} from '@waksana/cockpit-module-sdk/frontend';

export const frontendApiVersion = 3;
type Item = { id: string; version: number; attachment: NativeAttachmentDescriptor };
type Files = { items: Item[] };
export interface Probe {
  add(name: string): void;
  addDescriptor(attachment: NativeAttachmentDescriptor): void;
  edit(text: string): void;
  capture(): void;
  sendCaptured(): Promise<unknown>;
  failAck: boolean;
  snapshot(): { text: string; items: Item[]; unconfirmed: boolean; submissionId?: string };
  revokedUpdate?: () => void;
  events: { boundary: string; identity?: unknown; origin?: unknown; attachment?: unknown }[];
}
declare global {
  interface Window {
    assistantProbe: Probe;
    restartFixture(): Promise<void>;
    fixtureNativeSends: number;
  }
}

export function activate(context: ModuleFrontendContext): ModuleFrontend {
  if (!new URL(location.href).searchParams.has('probes')) return { apiVersion: 3 };
  const { createElement: h, useSyncExternalStore } = context.react;
  let active: { reference: DraftReference; draft: ModuleDraft; scope: DraftSchemaScope<Files> } | undefined;
  let intent: CapturedDraftSend | undefined;
  const requireActive = () => {
    if (!active) throw new Error('No visible synthetic probe composer');
    return active;
  };
  const probe: Probe = {
    failAck: false, events: [],
    add(name) {
      probe.addDescriptor({ type: 'file', path: `/synthetic/${name}`, displayName: name });
    },
    addDescriptor(attachment) {
      requireActive().scope.update(current => ({ items: [...current.items, {
        id: crypto.randomUUID(), version: 1, attachment,
      }] }));
    },
    edit(text) { requireActive().draft.editText(text); },
    capture() { intent = requireActive().draft.captureSend(); },
    async sendCaptured() {
      if (!intent) throw new Error('No captured synthetic speech send');
      return intent.send(requireActive().draft.getSnapshot().revision);
    },
    snapshot() {
      const current = requireActive();
      const base = current.draft.getSnapshot();
      return { text: base.text, items: [...current.scope.getSnapshot().items],
        unconfirmed: base.unconfirmed, submissionId: base.submissionId };
    },
  };
  window.assistantProbe = probe;
  const files = context.state.registerDraft<Files>({
    id: 'synthetic-files', purposes: ['prompt'],
    create: () => ({ items: [] }),
    validate(value) {
      if (!value || typeof value !== 'object' || !('items' in value) || !Array.isArray(value.items)) {
        throw new Error('Invalid synthetic files');
      }
      return structuredClone(value) as Files;
    },
    hasContent: value => value.items.length > 0,
    project: value => ({ attachments: value.items.map(item => item.attachment) }),
    acknowledge(current, captured) {
      if (probe.failAck) throw new Error('Synthetic file ACK failure');
      return { items: current.items.filter(item => !captured.items.some(saved =>
        saved.id === item.id && saved.version === item.version)) };
    },
    persistence: {
      serialize: value => JSON.stringify(value),
      restore: ({ stored }) => stored.present ? JSON.parse(String(stored.value)) as Files : { items: [] },
    },
  });
  return {
    apiVersion: 3, writes: ['text'], sends: ['draft'],
    components: [{
      id: 'file-speech-composer', boundary: 'composer',
      wrap: Base => function ProbeComposer(props) {
        const scope = files.forDraft(props.draft)!;
        const draft = context.state.bindDraft(props.draft);
        if (!('sessionId' in props.draft)) {
          active = { reference: props.draft, scope, draft };
          probe.revokedUpdate = () => scope.update(current => ({ ...current }));
        }
        const state = useSyncExternalStore(scope.subscribe, scope.getSnapshot);
        const base = useSyncExternalStore(draft.subscribe, draft.getSnapshot);
        return h(Base, props, props.children,
          h('div', { 'data-testid': 'synthetic-enhancers',
            'data-native': String('sessionId' in props.draft),
            'data-selected-session': context.state.host.getSnapshot().sessionId ?? '' },
            h('button', { type: 'button', disabled: 'sessionId' in props.draft || !base.capabilities.attachments,
              onClick: () => probe.add('fixture.txt') }, '合成文件探针'),
            h('button', { type: 'button', disabled: 'sessionId' in props.draft, onClick: () => {
              probe.edit('合成语音文本'); probe.capture();
            } }, '合成语音捕获'),
            h('button', { type: 'button', disabled: 'sessionId' in props.draft,
              onClick: () => { void probe.sendCaptured(); } }, '合成语音发送'),
            h('output', { 'data-testid': 'synthetic-files' }, state.items.map(item => item.attachment.displayName).join(', '))));
      },
    }, {
      id: 'message-identity', boundary: 'message',
      wrap: Base => function ProbeMessage(props) {
        probe.events.push({ boundary: 'message', identity: props.identity, origin: props.origin });
        return h(Base, props);
      },
    }, {
      id: 'attachment-identity', boundary: 'attachment',
      wrap: Base => function ProbeAttachment(props) {
        probe.events.push({ boundary: 'attachment', origin: props.origin, attachment: props.attachment });
        return h(Base, props);
      },
    }],
  };
}
