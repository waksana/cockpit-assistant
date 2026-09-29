import type { ModuleFrontendContext } from '@waksana/cockpit-module-sdk/frontend';
import type { ComponentType, CSSProperties } from 'react';
import type { AssistantActions, SetupOperation, Snapshot } from './contracts.ts';
import type { Role } from '../src/types.ts';
import type { TimelineItem } from '../src/ui-types.ts';
import { createMarkdown } from './markdown.ts';
import { createIcon } from './icons.ts';

const roleNames: Record<Role, string> = { coordinator: 'coordinator', memory: 'memory' };
const statusNames = {
  ready: '已就绪', unbound: '未绑定', unloaded: '未加载', invalid: '不可用', unknown: '状态未知',
  pending: '处理中', accepted: '已接受', error: '失败', calling: '调用中', rejected: '已拒绝',
  cancelled: '已取消', answered: '已回答', stale: '已过期', checking: '检查中',
};
const stateName = (state: string) => statusNames[state as keyof typeof statusNames] ?? state;
const json = (value: unknown) => JSON.stringify(value, null, 2);
type StatusTarget = Role | 'connection' | 'receipts';

export function topicStyle(topicId: string | null): CSSProperties {
  let hash = 0;
  for (const character of topicId ?? '') hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return { '--ca-topic-color': `color-mix(in srgb, var(--ck-color-accent) ${35 + hash % 56}%, var(--ck-color-text))` } as CSSProperties;
}

export function createPage(context: ModuleFrontendContext, store: AssistantActions, goHome: () => void): ComponentType {
  const { createElement: h, Fragment, useSyncExternalStore, useState, useRef, useLayoutEffect, useId } = context.react;
  const markdown = createMarkdown(context);
  const icon = createIcon(context);
  const Composer = context.components.get('composer');
  const PublicMessage = context.components.get('message');
  const Attachment = context.components.get('attachment');
  const button = (text: string, onClick: () => void, disabled = false, extra: Record<string, unknown> = {}) =>
    h('button', { type: 'button', className: 'ck-button', onClick, disabled, ...extra }, text);
  const choices = (item: TimelineItem) => item.question?.state === 'pending' && item.question.choices?.length
    ? h('div', { className: 'ca-choices', 'aria-label': '待回答问题的选项' },
      item.question.choices.map((choice, index) =>
        button(choice, () => store.edit(choice), false, { key: index }))) : null;

  function OperationCard({ operation }: { operation: SetupOperation }) {
    const [checking, setChecking] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const resultId = useId();
    const result = operation.result;
    return h('article', { className: 'ca-operation', 'aria-label': operation.label },
      h('p', { className: 'ca-operation-title' }, operation.label, ' · ', stateName(operation.state)),
      h('p', { className: operation.state === 'error' || operation.state === 'unknown' ? 'ck-danger' : 'ck-status-text',
        role: operation.state === 'error' || operation.state === 'unknown' ? 'alert' : 'status' }, operation.detail),
      h('dl', { className: 'ca-facts' },
        h('dt', null, '请求编号'), h('dd', null, operation.requestId),
        h('dt', null, '回执编号'), h('dd', null, operation.receiptId)),
      result !== undefined ? h('div', null,
        button(expanded ? '收起完整结果' : '展开完整结果', () => setExpanded(value => !value), false,
          { 'aria-expanded': expanded, 'aria-controls': resultId }),
        h('pre', { id: resultId, hidden: !expanded, className: 'ca-receipt' }, json(result))) : null,
      button(checking ? '正在检查…' : '检查操作状态', () => {
        if (checking) return;
        setChecking(true);
        void store.inspectOperation(operation.requestId).finally(() => setChecking(false));
      }, checking));
  }

  function SubmissionCard({ submission }: { submission: Snapshot['submissions'][number] }) {
    const [checking, setChecking] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const receiptId = useId();
    return h('article', { className: 'ca-operation', 'aria-label': '发送回执' },
      h('p', null, '发送 · ', stateName(submission.state)),
      h('p', { className: submission.state === 'error' || submission.state === 'unknown' ? 'ck-danger' : 'ck-status-text',
        role: submission.state === 'error' || submission.state === 'unknown' ? 'alert' : 'status' }, submission.detail),
      h('p', { className: 'ck-status-text ca-wrap' }, '请求编号：', submission.requestId),
      submission.receipt ? h('div', null,
        button(expanded ? '收起完整回执' : '展开完整回执', () => setExpanded(value => !value), false,
          { 'aria-expanded': expanded, 'aria-controls': receiptId }),
        h('pre', { id: receiptId, hidden: !expanded, className: 'ca-receipt' }, json(submission.receipt))) : null,
      button(checking ? '正在检查…' : '检查发送回执', () => {
        if (checking) return;
        setChecking(true);
        void store.inspectInput(submission.requestId).finally(() => setChecking(false));
      }, checking));
  }

  function Message({ item, startsTopic }: { item: TimelineItem; startsTopic: boolean }) {
    const speaker = item.speaker === 'user' ? '你' : item.speaker === 'assistant' ? '助手' : '系统';
    const title = item.topicId ? item.topicTitle || '未命名话题' : '系统';
    const date = new Date(item.createdAt);
    const validDate = !Number.isNaN(date.getTime());
    return h('article', { className: 'ca-message', 'data-ca-item': item.id, style: topicStyle(item.topicId),
      'aria-label': `${title} · ${speaker}` },
      startsTopic ? h('h3', { className: 'ca-topic-heading' }, title) : null,
      h('div', { className: 'ca-message-meta ck-status-text' },
        h('strong', null, speaker),
        h('span', { className: 'ca-wrap' }, '来源：', item.sessionId ?? (item.speaker === 'user' ? '助手输入' : '系统')),
        h('time', { dateTime: validDate ? date.toISOString() : undefined }, validDate ? date.toLocaleString('zh-CN') : '时间未知')),
      h(PublicMessage, { identity: { owner: 'assistant', id: item.id,
        kind: 'message', role: item.speaker }, complete: true },
      markdown(item.text),
      ...(item.attachments ?? []).map((attachment, index) => {
        const label = attachment.displayName ?? (attachment.type === 'blob' ? attachment.mimeType
          : attachment.type === 'selection' ? attachment.filePath : attachment.path);
        return h(Attachment, { key: index, index, attachment, label,
          children: h('p', { className: 'ca-wrap' }, label) });
      })),
      item.question ? h('p', { className: 'ck-status-text' },
        '提问状态：', stateName(item.question.state),
        item.question.allowFreeform === false ? ' · 仅接受列出的选项' : null) : null,
      choices(item));
  }

  function Conversation({ snapshot }: { snapshot: Snapshot }) {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const nearBottom = useRef(true);
    const initialized = useRef(false);
    const previous = useRef<TimelineItem[]>([]);
    const anchor = useRef<{ id: string; offset: number } | null>(null);
    const [statusOpen, setStatusOpen] = useState<StatusTarget | null>(null);
    const statusControls = useRef<Partial<Record<StatusTarget, HTMLButtonElement | null>>>({});
    const [unread, setUnread] = useState(0);
    const id = useId();
    const readAnchor = () => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const top = scroller.getBoundingClientRect().top;
      const first = Array.from(scroller.querySelectorAll<HTMLElement>('[data-ca-item]'))
        .find(element => element.getBoundingClientRect().bottom > top);
      anchor.current = first ? { id: first.dataset.caItem!, offset: first.getBoundingClientRect().top - top } : null;
    };
    const bottom = () => {
      const scroller = scrollerRef.current;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      nearBottom.current = true;
      setUnread(0);
      readAnchor();
    };
    useLayoutEffect(() => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const old = previous.current;
      previous.current = snapshot.items;
      if (!initialized.current && !snapshot.loading) {
        initialized.current = true;
        if (nearBottom.current) bottom();
        else readAnchor();
        return;
      }
      const oldFirst = old[0]?.sequence;
      const oldLast = old.at(-1)?.sequence;
      const prepended = oldFirst !== undefined && (snapshot.items[0]?.sequence ?? oldFirst) < oldFirst;
      const appended = oldLast === undefined ? 0 : snapshot.items.filter(item => item.sequence > oldLast).length;
      if (prepended && anchor.current) {
        const saved = anchor.current;
        const target = Array.from(scroller.querySelectorAll<HTMLElement>('[data-ca-item]'))
          .find(element => element.dataset.caItem === saved.id);
        if (target) scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - saved.offset;
        readAnchor();
      }
      if (appended > 0) {
        if (nearBottom.current) bottom();
        else setUnread(count => count + appended);
      }
    }, [snapshot.items, snapshot.loading]);
    useLayoutEffect(() => {
      const content = contentRef.current;
      if (!content || typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(() => {
        if (initialized.current && nearBottom.current) bottom();
      });
      observer.observe(content);
      if (scrollerRef.current) observer.observe(scrollerRef.current);
      return () => observer.disconnect();
    }, []);

    const rolesReady = (['coordinator', 'memory'] as const).every(role =>
      snapshot.readiness?.roles.some(entry => entry.role === role && entry.status === 'ready'));
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
      h('button', { key: target, type: 'button',
        className: target === 'coordinator' || target === 'memory' ? 'ck-button ca-role-control' : 'ck-icon-button', title: label,
        ref: (element: HTMLButtonElement | null) => { statusControls.current[target] = element; },
        'aria-label': label, 'aria-expanded': statusOpen === target, 'aria-controls': `${id}-status`,
        'data-status': status, onClick: () => setStatusOpen(current => current === target ? null : target) },
      icon(target === 'connection' ? snapshot.stream === 'connected' ? 'wifi'
        : snapshot.stream === 'connecting' ? 'loader' : 'wifi-off'
        : target === 'receipts' ? 'circle-help' : statusIcon(status)),
      target === 'coordinator' || target === 'memory' ? h('span', null, target) : null);
    const selectedRole = statusOpen === 'coordinator' || statusOpen === 'memory' ? statusOpen : null;
    const selectedReadiness = snapshot.readiness?.roles.find(entry => entry.role === selectedRole);
    const connectionLabel = snapshot.stream === 'connected' ? '实时连接：已连接'
      : snapshot.stream === 'connecting' ? '实时连接：正在连接' : '实时连接：已断开';
    const localStatus = () => {
      if (selectedRole) return h(Fragment, null,
        h('strong', null, roleNames[selectedRole], ' · ', stateName(roleState(selectedRole))),
        selectedReadiness?.sessionId ? h('p', { className: 'ca-wrap' }, '会话：', selectedReadiness.sessionId) : null,
        selectedReadiness?.detail ? h('p', { className: 'ca-wrap' }, selectedReadiness.detail) : null,
        roleState(selectedRole) === 'unbound' ? h('p', null,
          '在 Cockpit 创建会话或添加角色时选择 ', selectedRole, '；保存后会自动登记，登记不代表就绪。') : null,
        snapshot.readinessError ? h('p', { role: 'alert', className: 'ck-danger ca-wrap' }, snapshot.readinessError) : null,
        button(snapshot.checking ? '正在检查…' : '刷新就绪状态', () => { void store.refresh(); }, snapshot.checking),
        ...snapshot.setup.map(operation => h(OperationCard, { key: operation.requestId, operation })));
      if (statusOpen === 'connection') return h(Fragment, null,
        h('strong', null, connectionLabel),
        snapshot.error ? h('p', { role: 'alert', className: 'ck-danger ca-wrap' }, snapshot.error) : null,
        button('重新连接', () => store.reconnect(), snapshot.loading || snapshot.stream === 'connecting'));
      if (statusOpen === 'receipts') return h(Fragment, null,
        ...snapshot.submissions.map(submission => h(SubmissionCard, { key: submission.requestId, submission })));
      return null;
    };
    return h('section', { className: 'ca-page', 'aria-labelledby': `${id}-title` },
      h('header', { className: 'ca-header' },
        h('a', { className: 'ck-icon-button', title: '返回 Cockpit', href: '/',
          'aria-label': '返回 Cockpit', onClick: (event: { button: number; metaKey: boolean; ctrlKey: boolean;
            shiftKey: boolean; altKey: boolean; preventDefault(): void }) => {
            if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
              event.preventDefault(); goHome();
            }
          } }, icon('arrow-left')),
        h('h1', { id: `${id}-title`, className: 'ck-heading' }, '助手'),
        h('div', { className: 'ca-status-controls' },
        ...(['coordinator', 'memory'] as const).map(role =>
          statusButton(role, `${role}：${stateName(roleState(role))}`, roleState(role))),
        statusButton('connection', connectionLabel, snapshot.stream),
        snapshot.submissions.length ? statusButton('receipts', '发送回执',
          unresolvedSend ? 'unknown' : 'accepted') : null)),
      statusOpen ? h('section', { id: `${id}-status`, className: 'ca-status-detail', 'aria-label': '状态详情',
        onKeyDown: (event: { key: string }) => {
          if (event.key === 'Escape') { statusControls.current[statusOpen]?.focus(); setStatusOpen(null); }
        } },
        localStatus()) : null,
      h('div', { className: 'ca-scroller', ref: scrollerRef, onScroll: () => {
        const scroller = scrollerRef.current;
        if (!scroller) return;
        nearBottom.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 48;
        if (nearBottom.current) setUnread(0);
        readAnchor();
      } },
      h('div', { ref: contentRef, className: 'ca-content' },
        h('section', { className: 'ca-timeline', 'aria-label': '对话记录', 'aria-busy': snapshot.loading || snapshot.loadingOlder },
          snapshot.error && snapshot.stream !== 'disconnected' && statusOpen !== 'connection'
            ? h('p', { role: 'alert', className: 'ck-danger ca-wrap' }, snapshot.error) : null,
          snapshot.hasOlder ? button(snapshot.loadingOlder ? '正在加载…' : '加载更早消息', () => {
            readAnchor(); void store.loadOlder();
          }, snapshot.loadingOlder) : null,
          snapshot.loading ? h('span', { role: 'status', 'aria-label': '正在加载对话' }, icon('loader')) : null,
          ...snapshot.items.map((item, index) => h(Message, { key: item.id, item,
            startsTopic: index === 0 || snapshot.items[index - 1]?.topicId !== item.topicId }))),
        snapshot.submissions.some(submission => submission.state === 'error' || submission.state === 'unknown')
          && statusOpen !== 'receipts' ? h('div', { role: 'alert', className: 'ck-danger' },
            '发送尚未确认。', button('检查发送回执', () => setStatusOpen('receipts'))) : null)),
      h('footer', { className: 'ca-composer' },
        unread > 0 ? button(`${unread} 条新消息，查看最新`, bottom, false, { className: 'ck-button ca-new-messages' }) : null,
        h('div', null,
          h(Composer, { draft: store.draft, operation: 'prompt', disabled: !snapshot.draft.editable,
              busy: snapshot.draft.pending, placeholder: '输入消息…', submitLabel: '发送',
              sendBlocked: !snapshot.draft.submittable, onTextChange: store.edit, onSubmit: send }),
          snapshot.draft.unconfirmed ? button('恢复原提交确认', () => { void store.inspectInput(''); }, snapshot.draft.pending) : null)));
  }

  return function AssistantPage() {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    useLayoutEffect(() => { store.open(); return () => store.close(); }, []);
    return h(Conversation, { snapshot });
  };
}
