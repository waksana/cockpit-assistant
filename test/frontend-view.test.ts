import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConversationFrameProps, ConversationHeaderProps, ConversationTranscriptProps, ModuleFrontendContext } from '@waksana/cockpit-module-sdk/frontend';
import type { AssistantActions, Snapshot } from '../frontend/contracts.ts';
import { createPage } from '../frontend/view.ts';
import { activate } from '../frontend/index.ts';
import type { TimelineItem } from '../src/ui-types.ts';

const presentation = {
  conversationFrame: ({ header, notices, composer, children }: ConversationFrameProps) =>
    React.createElement(React.Fragment, null, header, children, notices, composer),
  conversationHeader: ({ leading, title, actions }: ConversationHeaderProps) =>
    React.createElement('header', null, leading, title, actions),
  conversationTranscript: ({ children }: ConversationTranscriptProps) => React.createElement('main', null, children),
};
const conversation: ModuleFrontendContext['conversation'] = {
  useScroll: ({ items }) => ({ items, prependHeld: false, viewport: null, content: null,
    viewportRef: () => {}, contentRef: () => {}, awayFromBottom: false, hasNewContent: false,
    isFollowing: () => true, follow: () => {}, changed: () => {} }),
};

test('activation rejects a host without the shared conversation capability before opening its store', () => {
  const oldHost = {
    apiVersion: 3, publicComponentsVersion: 1, draftOwnerVersion: 1, draftSubmissionVersion: 2,
    pageVersion: 1, messagePresentationVersion: 1, menuVersion: 1, uiVersion: 1, uiSurfaceVersion: 1,
  } as unknown as ModuleFrontendContext;
  assert.throws(() => activate(oldHost), /message\/conversation presentation v1/);
});

test('only a new local draft submission follows, not passive settlement of its existing transaction', () => {
  const refs: { current: unknown }[] = [];
  let refIndex = 0;
  let follows = 0;
  const snapshot = {
    items: [], loading: false, hasOlder: false, loadingOlder: false, stream: 'connected',
    checking: false, readiness: null, readinessError: null, error: null, setup: [],
    draft: { editable: true, pending: false, unconfirmed: false, hasContent: false,
      submittable: true, blocks: [], submissionId: undefined },
  } as unknown as Snapshot;
  const components = { ...presentation, chatMessage: () => null, composer: () => null, button: () => null };
  const context = {
    react: { ...React,
      useRef: (initial: unknown) => refs[refIndex++] ??= { current: initial },
      useLayoutEffect: (effect: () => void) => effect(),
    },
    conversation: { useScroll: (options: Parameters<typeof conversation.useScroll>[0]) =>
      ({ ...conversation.useScroll(options), follow: () => { follows++; } }) },
    components: { get: (name: keyof typeof components) => components[name] },
  } as unknown as ModuleFrontendContext;
  const store = { getSnapshot: () => snapshot, subscribe: () => () => {}, draft: {},
    open: () => {}, close: () => {} } as unknown as AssistantActions;
  const Page = createPage(context, store, () => {});
  const render = (pending: boolean, submissionId?: string) => {
    snapshot.draft = { ...snapshot.draft, pending, submissionId };
    refIndex = 0;
    renderToStaticMarkup(React.createElement(Page));
  };
  render(false);
  render(true, 'first-local-submission');
  assert.equal(follows, 1);
  render(false, 'first-local-submission');
  render(true, 'first-local-submission');
  assert.equal(follows, 1, 'receipt reconciliation must preserve the reader position');
  render(false);
  render(true, 'second-local-submission');
  assert.equal(follows, 2);
});

test('shared Chat rows show original user once and colored reply headings without receipt controls', () => {
  const messages: Record<string, unknown>[] = [];
  const composers: Record<string, unknown>[] = [];
  let buttons = 0;
  const components = {
    ...presentation,
    chatMessage: (props: Record<string, unknown>) => {
      messages.push(props);
      return React.createElement('article', null, props.header as React.ReactNode, String(props.body));
    },
    messageList: ({ children }: { children?: React.ReactNode }) => React.createElement('main', null, children),
    composer: (props: Record<string, unknown>) => { composers.push(props); return React.createElement('textarea'); },
    button: ({ appearance, ...props }: React.ComponentPropsWithRef<'button'> & { appearance?: string }) => {
      buttons++;
      return React.createElement('button', { ...props,
        className: [appearance === 'icon' ? 'ck-icon-button' : 'ck-button', props.className].filter(Boolean).join(' ') });
    },
  };
  const item = (id: string, speaker: TimelineItem['speaker'], text: string): TimelineItem => ({
    id, sequence: id === 'user' ? 1 : 2, type: 'message', messageId: id, topicId: 'topic',
    topicTitle: 'Weather', topicColor: '#2563eb', text, attachments: [], sources: [], createdAt: 1,
    speaker, sessionId: null, question: null,
  });

  const user = item('user', 'user', 'Weather and code, please');
  const answer = item('answer', 'assistant', 'Original full answer');
  const snapshot = {
    items: [user, answer, user], loading: false, hasOlder: false, loadingOlder: false,
    stream: 'connected', checking: false, readiness: null, readinessError: null, error: null,
    draft: { editable: true, pending: false, unconfirmed: true, hasContent: true, submittable: false, blocks: [] },
    submissions: [{ requestId: 'private-request-id', state: 'unknown', receipt: { secret: 'internal-json' } }],
    setup: [],
  } as unknown as Snapshot;
  const store = { getSnapshot: () => snapshot, subscribe: () => () => {}, draft: {} } as unknown as AssistantActions;
  const used: string[] = [];
  const context = { react: React, conversation,
    components: { get: (name: keyof typeof components) => { used.push(name); return components[name]; } } } as unknown as ModuleFrontendContext;
  const html = renderToStaticMarkup(React.createElement(createPage(context, store, () => {})));
  assert.equal(messages.length, 2);
  assert.equal(composers.length, 1);
  assert.equal(composers[0]?.sendBlocked, true);
  assert.equal(buttons, 3);
  assert.deepEqual(used, ['composer', 'conversationFrame', 'conversationHeader', 'conversationTranscript', 'chatMessage', 'button']);
  assert.equal(messages[0]?.header, undefined, 'user originals never receive a topic header');
  assert.ok(messages[1]?.header, 'topic heading belongs inside the shared row, not a surrounding wrapper');
  assert.deepEqual(messages.map(message => message.body), [user.text, answer.text]);
  assert.equal((html.match(/ca-topic-heading/g) ?? []).length, 1);
  assert.match(html, /border-inline-start-color:#2563eb/);
  assert.match(html, />Weather<\/h3>/);
  assert.match(html, /草稿已保留/);
  assert.doesNotMatch(html, /发送回执|请求编号|展开完整|检查操作|恢复原提交|private-request-id|internal-json/);
});

test('question and original options remain ordinary Chat Markdown without a decision or quick-fill path', () => {
  for (const state of ['pending', 'answered', 'stale', 'unknown'] as const) {
    const messages: Record<string, unknown>[] = [];
    const components = {
      ...presentation,
      chatMessage: (props: Record<string, unknown>) => {
        messages.push(props);
        return React.createElement('article', null, String(props.body));
      },
      messageList: ({ children }: { children?: React.ReactNode }) => React.createElement('main', null, children),
      composer: () => React.createElement('textarea'),
      button: () => React.createElement('button'),
    };
    const question: TimelineItem = {
      id: 'question', sequence: 1, type: 'question', messageId: 'native-question', topicId: null,
      topicTitle: null, topicColor: null, text: 'Choose a route', attachments: [], sources: [], createdAt: 1,
      speaker: 'assistant', sessionId: null,
      question: { state, stateVersion: 1, choices: ['Train', 'Plane\nwith luggage'], allowFreeform: false },
    };
    const snapshot = {
      items: [question], loading: false, hasOlder: false, loadingOlder: false,
      stream: 'connected', checking: false, readiness: null, readinessError: null, error: null,
      draft: { editable: true, pending: false, unconfirmed: false, hasContent: false, submittable: true, blocks: [] },
      setup: [],
    } as unknown as Snapshot;
    const store = { getSnapshot: () => snapshot, subscribe: () => () => {}, draft: {} } as unknown as AssistantActions;
    const context = { react: React, conversation, components: { get: (name: keyof typeof components) => components[name] } } as unknown as ModuleFrontendContext;
    const html = renderToStaticMarkup(React.createElement(createPage(context, store, () => {})));
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.body, 'Choose a route\n\n- Train\n- Plane\n  with luggage');
    assert.equal(messages[0]?.children, undefined);
    assert.equal((html.match(/<button/g) ?? []).length, 3, 'only global role/connection controls remain');
    assert.doesNotMatch(html, /ca-choices|decision-card|发送选项/);
  }
});
