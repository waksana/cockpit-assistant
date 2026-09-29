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
  cancelled: '已取消', answered: '已回答', stale: '已过期',
};
const stateName = (state: string) => statusNames[state as keyof typeof statusNames] ?? state;
const json = (value: unknown) => JSON.stringify(value, null, 2);

export function topicStyle(topicId: string | null): CSSProperties {
  let hash = 0;
  for (const character of topicId ?? '') hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return { '--ca-topic-color': `color-mix(in srgb, var(--ck-color-accent) ${35 + hash % 56}%, var(--ck-color-text))` } as CSSProperties;
}

export function createDialog(context: ModuleFrontendContext, store: AssistantActions): ComponentType {
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
      item.question.choices.map((choice, index) => button(choice, () => {
        store.reply(item); store.edit(choice);
      }, !item.anchorId, { key: index }))) : null;

  function OperationCard({ operation }: { operation: SetupOperation }) {
    const [checking, setChecking] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const resultId = useId();
    const result = operation.result;
    const payload = result && typeof result === 'object' && 'result' in result ? result.result : result;
    const createdId = operation.receiptId.startsWith('create:') && payload && typeof payload === 'object'
      && 'sessionId' in payload && typeof payload.sessionId === 'string' ? payload.sessionId : null;
    return h('article', { className: 'ca-operation', 'aria-label': operation.label },
      h('p', { className: 'ca-operation-title' }, operation.label, ' · ', stateName(operation.state)),
      h('p', { className: operation.state === 'error' || operation.state === 'unknown' ? 'ck-danger' : 'ck-status-text',
        role: operation.state === 'error' || operation.state === 'unknown' ? 'alert' : 'status' }, operation.detail),
      h('dl', { className: 'ca-facts' },
        h('dt', null, '请求编号'), h('dd', null, operation.requestId),
        h('dt', null, '回执编号'), h('dd', null, operation.receiptId),
        createdId ? h(Fragment, null, h('dt', null, '创建的会话编号'), h('dd', null, createdId)) : null),
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
      choices(item),
      item.anchorId ? button('回复', () => store.reply(item)) : null);
  }

  function OpenDialog({ snapshot }: { snapshot: Snapshot }) {
    const dialogRef = useRef<HTMLDialogElement>(null);
    const scrollerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const nearBottom = useRef(true);
    const initialized = useRef(false);
    const previous = useRef<TimelineItem[]>([]);
    const anchor = useRef<{ id: string; offset: number } | null>(null);
    const [settingsOpen, setSettingsOpen] = useState(false);
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
      const dialog = dialogRef.current;
      if (dialog && !dialog.open) dialog.showModal();
      return () => { if (dialog?.open) dialog.close(); };
    }, []);
    useLayoutEffect(() => {
      if (settingsOpen && scrollerRef.current) {
        nearBottom.current = false;
        scrollerRef.current.scrollTop = 0;
        readAnchor();
      }
    }, [settingsOpen]);
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
    const pendingQuestion = snapshot.reply?.question?.state === 'pending' ? snapshot.reply.question : null;
    const choiceRequired = pendingQuestion?.allowFreeform === false;
    const validAnswer = !choiceRequired || !!pendingQuestion?.choices?.includes(snapshot.draft.text);
    const canSend = !!snapshot.readiness?.canSend && rolesReady && !snapshot.checking
      && !snapshot.readinessError && !unresolvedSend && snapshot.draft.hasContent && validAnswer
      && snapshot.draft.submittable && !snapshot.draft.blocks.length;
    const send = () => { if (canSend) void store.send(); };
    const roleStatus = (role: Role) => {
      const readiness = snapshot.readiness?.roles.find(entry => entry.role === role);
      return h('div', { key: role, className: 'ca-role-status' },
        h('strong', null, roleNames[role]),
        h('span', { className: 'ck-badge' }, readiness ? stateName(readiness.status) : snapshot.checking ? '检查中' : '状态未知'),
        readiness?.sessionId ? h('span', { className: 'ck-status-text ca-wrap' }, '会话：', readiness.sessionId) : null,
        readiness?.modelId ? h('span', { className: 'ck-status-text ca-wrap' }, '模型：', readiness.modelId) : null,
        readiness?.detail ? h('span', { className: 'ck-status-text ca-wrap' }, readiness.detail) : null);
    };
    return context.createPortal(
      h('dialog', { ref: dialogRef, className: 'ck-surface ck-modal ca-dialog', 'aria-labelledby': `${id}-title`,
        onCancel: (event: { preventDefault(): void }) => { event.preventDefault(); store.close(); },
        onClose: () => { if (store.getSnapshot().open) store.close(); } },
      h('header', { className: 'ca-header' },
        h('button', { type: 'button', className: 'ck-icon-button', title: '返回 Cockpit',
          'aria-label': '返回 Cockpit', onClick: () => store.close(), autoFocus: true }, icon('arrow-left')),
        h('h2', { id: `${id}-title`, className: 'ck-heading' }, '助手'),
        h('button', { type: 'button', className: 'ck-icon-button', title: '设置', 'aria-label': '设置',
          'aria-expanded': settingsOpen, 'aria-controls': `${id}-settings`,
          onClick: () => setSettingsOpen(open => !open) }, icon('settings'))),
      h('div', { className: 'ca-scroller', ref: scrollerRef, onScroll: () => {
        const scroller = scrollerRef.current;
        if (!scroller) return;
        nearBottom.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 48;
        if (nearBottom.current) setUnread(0);
        readAnchor();
      } },
      h('div', { ref: contentRef, className: 'ca-content' },
        h('section', { className: 'ca-readiness', 'aria-label': '助手就绪状态', 'aria-busy': snapshot.checking },
          roleStatus('coordinator'), roleStatus('memory'),
          snapshot.readinessError ? h('p', { role: 'alert', className: 'ck-danger ca-wrap' }, snapshot.readinessError) : null,
          button(snapshot.checking ? '正在检查…' : '刷新就绪状态', () => { void store.refresh(); }, snapshot.checking)),
        h('section', { id: `${id}-settings`, hidden: !settingsOpen, className: 'ca-settings', 'aria-label': '设置' },
          settingsOpen ? h(Fragment, null,
            h('h3', { className: 'ck-heading' }, '角色设置'),
            h('p', null, '在 Cockpit 创建会话或添加角色时选择 coordinator 或 memory，保存角色后会自动登记。登记不代表角色已就绪。'),
            h('p', null, '打开助手时会检查最新状态，仅加载已登记且未加载的内部角色会话；不会创建或替换会话、重载已加载会话或更改模型。'),
            h('p', null, '所有普通会话都会自动观察，无需单独接入。刷新只读取状态；未加载会话的冷加载包含宿主正常的原生工具初始化，但助手不会额外修复资源、强制重载或自动启用被禁用的资源。已加载会话的待生效角色或禁用资源请在 Cockpit 中处理后刷新状态。'),
            h('p', { className: 'ck-input-hint' }, '加载结果未知时请检查操作回执，不会自动重复请求。')) : null),
        snapshot.setup.length ? h('section', { className: 'ca-operations', 'aria-label': '设置操作回执' },
          h('h3', { className: 'ck-heading' }, '设置操作回执'),
          ...snapshot.setup.map(operation => h(OperationCard, { key: operation.requestId, operation }))) : null,
        h('section', { className: 'ca-timeline', 'aria-label': '对话记录', 'aria-busy': snapshot.loading || snapshot.loadingOlder },
          h('div', { className: 'ca-timeline-header' }, h('h3', { className: 'ck-heading' }, '对话记录'),
            h('span', { className: 'ck-status-text' }, snapshot.stream === 'connected' ? '实时连接已建立'
              : snapshot.stream === 'connecting' ? '正在连接' : '实时连接已断开'),
            snapshot.stream === 'disconnected' ? button('重新连接', () => store.reconnect(), snapshot.loading) : null),
          snapshot.error ? h('p', { role: 'alert', className: 'ck-danger ca-wrap' }, snapshot.error) : null,
          snapshot.hasOlder ? button(snapshot.loadingOlder ? '正在加载…' : '加载更早消息', () => {
            readAnchor(); void store.loadOlder();
          }, snapshot.loadingOlder) : null,
          snapshot.loading ? h('p', { role: 'status' }, '正在加载对话…') : null,
          !snapshot.loading && !snapshot.items.length && !snapshot.error ? h('p', { className: 'ck-text-secondary' }, '暂无对话。可先设置助手，输入内容会保留在草稿中。') : null,
          ...snapshot.items.map((item, index) => h(Message, { key: item.id, item,
            startsTopic: index === 0 || snapshot.items[index - 1]?.topicId !== item.topicId }))),
        snapshot.reply ? h('section', { className: 'ca-reply', 'aria-label': '当前回复引用' },
          h('h3', { className: 'ck-heading' }, '正在回复：',
            snapshot.reply.topicId ? snapshot.reply.topicTitle || '未命名话题' : '系统'),
          h('p', { className: 'ck-status-text ca-wrap' }, '来源：', snapshot.reply.sessionId ?? '系统',
            ' · 引用：', snapshot.reply.anchorId ?? snapshot.reply.id),
          markdown(snapshot.reply.text),
          !snapshot.items.some(item => item.id === snapshot.reply?.id)
            ? choices(snapshot.reply) : null) : null,
        snapshot.submissions.length ? h('section', { className: 'ca-operations', 'aria-label': '发送回执' },
          ...snapshot.submissions.map(submission => h(SubmissionCard, { key: submission.requestId, submission }))) : null)),
      h('footer', { className: 'ca-composer' },
        unread > 0 ? button(`${unread} 条新消息，查看最新`, bottom, false, { className: 'ck-button ca-new-messages' }) : null,
        snapshot.reply ? h('div', { className: 'ca-reply' },
          h('div', { className: 'ca-reply-heading' },
            h('strong', null, '已选择回复引用'),
            button('取消回复', () => store.reply(null))),
          choiceRequired ? h('p', { className: 'ck-input-hint' }, '此问题仅接受消息中列出的选项。') : null) : null,
        h('div', null,
          choiceRequired ? h('div', { className: 'ca-choices' },
            h('p', null, '已选：', validAnswer ? snapshot.draft.text : '请选择问题中的选项'),
            button('发送选项', send, !canSend))
            : h(Composer, { draft: store.draft, operation: 'prompt', disabled: !snapshot.draft.editable,
              busy: snapshot.draft.pending, placeholder: '输入消息…', submitLabel: '发送',
              sendBlocked: !snapshot.draft.submittable, onTextChange: store.edit, onSubmit: send }),
          snapshot.draft.unconfirmed ? button('恢复原提交确认', () => { void store.inspectInput(''); }, snapshot.draft.pending) : null,
          h('p', { id: `${id}-send-hint`, className: 'ck-input-hint' },
            unresolvedSend ? '上次发送尚未确认，请检查发送回执；不会自动重发。'
              : !rolesReady || !snapshot.readiness?.canSend || snapshot.readinessError
                ? 'coordinator 和 memory 均就绪后才能发送。草稿仍可编辑。'
                : snapshot.checking ? '正在检查就绪状态，草稿仍可编辑。'
                  : !validAnswer ? '请选择此问题允许的选项。'
                    : 'Enter 发送，Shift+Enter 换行。关闭窗口会保留草稿。')))),
      document.body);
  }

  return function AssistantDialog() {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    return snapshot.open ? h(OpenDialog, { snapshot }) : null;
  };
}
