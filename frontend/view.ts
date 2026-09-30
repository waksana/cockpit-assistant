import type { ModuleFrontendContext } from '@waksana/cockpit-module-sdk/frontend';
import type { ComponentType } from 'react';
import type { AssistantActions, Snapshot } from './contracts.ts';
import type { Role } from '../src/types.ts';
import type { TimelineItem } from '../src/ui-types.ts';
import { createIcon } from './icons.ts';
import { conversationItems } from './timeline.ts';
import type { Clarification } from './clarification.ts';

const statusNames = {
  ready: '已就绪', unbound: '未绑定', unloaded: '未加载', invalid: '不可用', unknown: '状态未知',
  ambiguous: '多个候选',
  pending: '处理中', accepted: '已接受', error: '失败', calling: '调用中', rejected: '已拒绝',
  cancelled: '已取消', answered: '已回答', stale: '已过期', checking: '检查中',
};
const stateName = (state: string) => statusNames[state as keyof typeof statusNames] ?? state;
type StatusTarget = 'coordinator' | 'connection';
const itemKey = (item: TimelineItem) => `message:${item.id}`;

export function createPage(context: ModuleFrontendContext, store: AssistantActions, goHome: () => void): ComponentType {
  const { createElement: h, Fragment, useSyncExternalStore, useState, useRef, useLayoutEffect, useId, useMemo } = context.react;
  const icon = createIcon(context);
  const Composer = context.components.get('composer');
  const Frame = context.components.get('conversationFrame');
  const Header = context.components.get('conversationHeader');
  const Transcript = context.components.get('conversationTranscript');
  const ChatMessage = context.components.get('chatMessage');
  const Button = context.components.get('button');
  const ComposerEditor = context.components.get('composerEditor');
  const button = (text: string, onClick: () => void, disabled = false, extra: Record<string, unknown> = {}) =>
    h(Button, { type: 'button', onClick, disabled, ...extra }, text);
  function ClarificationCard({ messageId, value }: { messageId: string; value: Clarification }) {
    const client = store.getClarification(messageId, value.id);
    if (!client) throw new Error('澄清答复输入尚未准备');
    const draft = useSyncExternalStore(client.draft.subscribe, client.draft.getSnapshot, client.draft.getSnapshot);
    const question = client.question;
    const answered = question.answer !== null;
    const disabled = answered || draft.pending || draft.unconfirmed || !draft.editable;
    const pendingLabel = draft.pending ? '正在保存答复…' : draft.unconfirmed ? '答复状态未确认，已保留原提交'
      : !draft.editable && !answered ? '待核对已保存的答复' : '等待补充';
    return h('section', { className: 'ca-clarification', role: 'group',
      'aria-label': answered ? '已完成的澄清' : '需要澄清', 'aria-busy': draft.pending,
      'data-ca-clarification': value.id, 'data-state': answered ? 'answered' : 'pending' },
    h('div', { className: 'ca-clarification-heading' },
      h('strong', null, '需要澄清'),
      h('span', { role: 'status' }, answered ? '已补充' : pendingLabel)),
    h(ChatMessage, { identity: { owner: 'assistant', id: `clarification:${messageId}:${value.id}`, kind: 'ask' },
      complete: true, role: 'assistant', timestamp: value.createdAt, showTimestamp: false,
      previous: { role: 'assistant', timestamp: value.createdAt }, body: question.question }),
    answered ? h(ChatMessage, {
      identity: { owner: 'assistant', id: `clarification-answer:${messageId}:${value.id}`, kind: 'message', role: 'user' },
      complete: true, role: 'user', timestamp: question.answeredAt ?? value.createdAt, showTimestamp: false,
      previous: { role: 'user', timestamp: question.answeredAt ?? value.createdAt }, body: question.answer ?? '',
    }) : h(Fragment, null,
      question.choices.length ? h('div', { className: 'ca-clarification-choices' },
        ...question.choices.map(choice => button(choice, () => { void client.choose(choice); }, disabled, { key: choice }))) : null,
      question.allowFreeform ? h(ComposerEditor, { draft: client.draft, operation: 'ask',
        disabled, busy: draft.pending, placeholder: '补充这条消息…', submitLabel: '提交补充',
        sendBlocked: !draft.hasContent || !draft.submittable || draft.blocks.length > 0 || disabled,
        onTextChange: client.edit, onSubmit: () => { void client.submit(); } }) : null),
    client.error ? h('p', { role: 'alert', className: 'ck-danger ca-wrap' }, client.error) : null);
  }
  function Message({ item, previous }: { item: TimelineItem; previous?: TimelineItem }) {
    const role = item.speaker === 'user' ? 'user' : 'assistant';
    const body = item.question?.choices?.length
      ? `${item.text}\n\n${item.question.choices.map(choice => `- ${choice.replace(/\n/g, '\n  ')}`).join('\n')}`
      : item.text;
    return h(ChatMessage, { 'data-ca-item': item.id,
      'data-ca-message-id': item.id,
      identity: { owner: 'assistant', id: itemKey(item),
      kind: 'message', role }, complete: true, role, timestamp: item.createdAt,
      header: role === 'assistant' && item.topicTitle
        ? h('h3', { className: 'ca-topic-heading' }, item.topicTitle) : undefined,
      body, attachments: item.attachments,
      previous: previous ? { role: previous.speaker === 'user' ? 'user' : 'assistant',
        timestamp: previous.createdAt } : undefined,
    }, ...(item.diagnostic ? [h('p', { key: 'diagnostic', role: 'alert', className: 'ck-danger ca-wrap' }, item.diagnostic)] : []),
    ...(item.clarifications ?? []).map(value =>
      h(ClarificationCard, { key: value.id, messageId: item.id, value })),
    ...(item.deliveryIssues ?? []).map(issue => h('p', {
      key: issue.topicMessageId, role: 'alert', className: 'ck-danger ca-wrap',
    }, issue.detail)));
  }

  function Conversation({ snapshot }: { snapshot: Snapshot }) {
    const items = useMemo(() => conversationItems(snapshot.items), [snapshot.items]);
    const scroll = context.conversation.useScroll({ key: 'assistant', items, itemKey });
    const { viewport, content, changed, follow } = scroll;
    const previous = useRef<readonly TimelineItem[] | null>(null);
    const lastSubmission = useRef(snapshot.draft.submissionId);
    const [statusOpen, setStatusOpen] = useState<StatusTarget | null>(null);
    const statusControls = useRef<Partial<Record<StatusTarget, HTMLButtonElement | null>>>({});
    const id = useId();
    useLayoutEffect(() => {
      if (!viewport || !content) return;
      const old = previous.current;
      if (!snapshot.loading) previous.current = items;
      changed({ contentReady: !snapshot.loading && scroll.items.length > 0,
        newContent: !snapshot.loading && old !== null && items.some(item =>
          item.sequence > (old.at(-1)?.sequence ?? -1) && !old.some(prior => itemKey(prior) === itemKey(item))) });
    }, [items, scroll.items, snapshot.loading, viewport, content, changed]);
    useLayoutEffect(() => {
      const submission = snapshot.draft.submissionId;
      if (!submission) return;
      // Recovering an existing transaction is passive, not a new local send.
      if (snapshot.draft.pending && submission !== lastSubmission.current) follow();
      lastSubmission.current = submission;
    }, [snapshot.draft.pending, snapshot.draft.submissionId, follow]);

    const rolesReady = snapshot.readiness?.roles.some(entry =>
      entry.role === 'coordinator' && entry.status === 'ready');
    const unresolvedSend = snapshot.draft.pending || snapshot.draft.unconfirmed;
    const canSend = !!snapshot.readiness?.canSend && rolesReady && !snapshot.checking
      && !snapshot.readinessError && !unresolvedSend && snapshot.draft.hasContent
      && snapshot.draft.submittable && !snapshot.draft.blocks.length;
    const send = () => { if (canSend) void store.send(); };
    const roleState = (role: Role) => snapshot.checking ? 'checking' : snapshot.readinessError ? 'error'
      : snapshot.readiness?.roles.find(entry => entry.role === role)?.status ?? 'unknown';
    const statusIcon = (status: string) => status === 'ready' || status === 'connected' ? 'circle-check'
      : status === 'checking' || status === 'connecting' || status === 'pending' ? 'loader'
        : status === 'unbound' ? 'circle-minus' : status === 'unloaded' ? 'circle-pause'
          : status === 'invalid' || status === 'error' ? 'circle-alert' : 'circle-help';
    const statusButton = (target: StatusTarget, label: string, status: string) =>
      h(Button, { key: target, type: 'button',
        appearance: target === 'connection' ? 'icon' : 'button',
        className: target === 'connection' ? undefined : 'ca-role-control', title: label,
        ref: (element: HTMLButtonElement | null) => { statusControls.current[target] = element; },
        'aria-label': label, 'aria-expanded': statusOpen === target, 'aria-controls': `${id}-status`,
        ...{ 'data-status': status }, onClick: () => setStatusOpen(current => current === target ? null : target) },
      icon(target === 'connection' ? snapshot.stream === 'connected' ? 'wifi'
        : snapshot.stream === 'connecting' ? 'loader' : 'wifi-off'
        : statusIcon(status)),
      target === 'coordinator' ? h('span', null, target) : null);
    const selectedRole = statusOpen === 'coordinator' ? statusOpen : null;
    const selectedReadiness = snapshot.readiness?.roles.find(entry => entry.role === selectedRole);
    const connectionLabel = snapshot.stream === 'connected' ? '实时连接：已连接'
      : snapshot.stream === 'connecting' ? '实时连接：正在连接' : '实时连接：已断开';
    const localStatus = () => {
      if (selectedRole) return h(Fragment, null,
        h('strong', null, selectedRole, ' · ', stateName(roleState(selectedRole))),
        selectedReadiness?.sessionId ? h('p', { className: 'ca-wrap' }, '会话：', selectedReadiness.sessionId) : null,
        selectedReadiness?.detail ? h('p', { className: 'ca-wrap' }, selectedReadiness.detail) : null,
        roleState(selectedRole) === 'unbound' ? h('p', null,
          '在 Cockpit 创建会话或添加角色时选择 ', selectedRole, '；保存后会自动登记，登记不代表就绪。') : null,
        snapshot.readinessError ? h('p', { role: 'alert', className: 'ck-danger ca-wrap' }, snapshot.readinessError) : null,
        button(snapshot.checking ? '正在检查…' : '刷新就绪状态', () => { void store.refresh(); }, snapshot.checking),
        ...snapshot.setup.filter(operation => operation.state !== 'accepted').map(operation =>
          h('p', { key: operation.requestId,
            role: operation.state === 'pending' ? 'status' : 'alert' },
          operation.state === 'pending' ? '正在准备角色会话…' : '角色会话尚未就绪，请刷新就绪状态。')));
      if (statusOpen === 'connection') return h(Fragment, null,
        h('strong', null, connectionLabel),
        snapshot.error ? h('p', { role: 'alert', className: 'ck-danger ca-wrap' }, snapshot.error) : null,
        button('重新连接', () => store.reconnect(), snapshot.loading || snapshot.stream === 'connecting'));
      return null;
    };
    return h('section', { className: 'ca-page', 'aria-labelledby': `${id}-title` },
      h(Frame, { header: h(Fragment, null, h(Header, { className: 'ca-header',
        leading: h('a', { className: 'ck-icon-button', title: '返回 Cockpit', href: '/',
          'aria-label': '返回 Cockpit', onClick: (event: { button: number; metaKey: boolean; ctrlKey: boolean;
            shiftKey: boolean; altKey: boolean; preventDefault(): void }) => {
            if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
              event.preventDefault(); goHome();
            }
          } }, icon('arrow-left')),
        title: h('h1', { id: `${id}-title`, className: 'ck-heading' }, '助手'),
        actions: h('div', { className: 'ca-status-controls' },
        statusButton('coordinator', `coordinator：${stateName(roleState('coordinator'))}`, roleState('coordinator')),
        statusButton('connection', connectionLabel, snapshot.stream)) }),
      statusOpen ? h('section', { id: `${id}-status`, className: 'ca-status-detail', 'aria-label': '状态详情',
        onKeyDown: (event: { key: string }) => {
          if (event.key === 'Escape') { statusControls.current[statusOpen]?.focus(); setStatusOpen(null); }
        } },
        localStatus()) : null),
        notices: h(Fragment, null,
          snapshot.draft.unconfirmed ? h('p', { role: 'status', className: 'ck-status-text' },
            '暂时无法确认发送状态，草稿已保留。连接恢复后会自动确认，不会重复发送。') : null,
          snapshot.error && statusOpen !== 'connection'
            ? h('p', { role: 'alert', className: 'ck-danger ca-wrap' }, snapshot.error) : null),
        composer: h(Composer, { draft: store.draft, operation: 'prompt', disabled: !snapshot.draft.editable,
          busy: snapshot.draft.pending, placeholder: '输入消息…', submitLabel: '发送',
          sendBlocked: !snapshot.draft.submittable, onTextChange: store.edit, onSubmit: send }),
      }, h(Transcript, { className: 'ca-scroller', viewportRef: scroll.viewportRef, contentRef: scroll.contentRef,
        awayFromBottom: scroll.awayFromBottom, hasNewContent: scroll.hasNewContent, onFollow: follow,
        role: 'region', 'aria-label': '对话记录', 'aria-busy': snapshot.loading || snapshot.loadingOlder,
        before: h(Fragment, null,
          // Keep control geometry until the gesture-held history prefix is rendered.
          snapshot.hasOlder || scroll.prependHeld ? button(snapshot.loadingOlder ? '正在加载…' : '加载更早消息',
            () => { void store.loadOlder(); }, !snapshot.hasOlder || snapshot.loading || snapshot.loadingOlder) : null,
          snapshot.loading ? h('span', { role: 'status', 'aria-label': '正在加载对话' }, icon('loader')) : null),
      }, ...scroll.items.map((item, index) => h(Message, { key: itemKey(item), item, previous: scroll.items[index - 1] })))));
  }

  return function AssistantPage() {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    useLayoutEffect(() => { store.open(); return () => store.close(); }, []);
    return h(Conversation, { snapshot });
  };
}
