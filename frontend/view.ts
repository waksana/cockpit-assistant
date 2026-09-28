import type { ModuleFrontendContext } from '@waksana/cockpit-module-sdk/frontend';
import type { ComponentType, CSSProperties, FormEvent, KeyboardEvent } from 'react';
import type { AssistantActions, SetupOperation, Snapshot } from './contracts.ts';
import type { Role } from '../src/types.ts';
import type { RoleReadiness, SessionInspection, TimelineItem } from '../src/ui-types.ts';
import { createMarkdown } from './markdown.ts';

const roleNames: Record<Role, string> = { coordinator: '编排者', memory: '记忆者' };
const statusNames = {
  ready: '已就绪', unbound: '未绑定', unloaded: '未加载', invalid: '不可用', unknown: '状态未知',
  pending: '处理中', accepted: '已接受', error: '失败', calling: '调用中', rejected: '已拒绝',
  cancelled: '已取消', answered: '已回答', stale: '已过期',
};
const stateName = (state: string) => statusNames[state as keyof typeof statusNames] ?? state;
const describeError = (error: unknown) => error instanceof Error ? error.message : String(error);
const json = (value: unknown) => JSON.stringify(value, null, 2);
const setupLabel = (label: string) => label.replace('coordinator', '编排者').replace('memory', '记忆者').replace('reception', '接待者');
const isUncertain = (operation: SetupOperation) => operation.state === 'pending' || operation.state === 'unknown';

export function topicStyle(topicId: string | null): CSSProperties {
  let hash = 0;
  for (const character of topicId ?? '') hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return { '--ca-topic-color': `color-mix(in srgb, var(--ck-color-accent) ${35 + hash % 56}%, var(--ck-color-text))` } as CSSProperties;
}

export function createDialog(context: ModuleFrontendContext, store: AssistantActions): ComponentType {
  const { createElement: h, Fragment, useSyncExternalStore, useState, useRef, useLayoutEffect, useEffect, useId } = context.react;
  const markdown = createMarkdown(context);
  const button = (text: string, onClick: () => void, disabled = false, extra: Record<string, unknown> = {}) =>
    h('button', { type: 'button', className: 'ck-button', onClick, disabled, ...extra }, text);
  const field = (label: string, value: string, setValue: (value: string) => void, placeholder?: string) =>
    h('label', { className: 'ca-field' }, h('span', null, label),
      h('input', { className: 'ck-input', value, placeholder,
        onChange: (event: { currentTarget: HTMLInputElement }) => setValue(event.currentTarget.value) }));
  const choices = (item: TimelineItem) => item.question?.state === 'pending' && item.question.choices?.length
    ? h('div', { className: 'ca-choices', 'aria-label': '待回答问题的选项' },
      item.question.choices.map((choice, index) => button(choice, () => {
        store.reply(item); store.edit(choice);
      }, !item.anchorId, { key: index }))) : null;

  function SessionForm({ role, readiness, snapshot }: {
    role?: Role; readiness?: RoleReadiness; snapshot: Snapshot;
  }) {
    const [cwd, setCwd] = useState('');
    const [sessionId, setSessionId] = useState('');
    const [label, setLabel] = useState('');
    const [inspection, setInspection] = useState<SessionInspection | null>(null);
    const [inspectionEpoch, setInspectionEpoch] = useState<number | null>(null);
    const [inspecting, setInspecting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const generation = useRef(0);
    const mounted = useRef(true);
    useEffect(() => {
      mounted.current = true;
      return () => { mounted.current = false; ++generation.current; };
    }, []);
    const changeId = (value: string) => {
      ++generation.current;
      setSessionId(value); setInspection(null); setInspectionEpoch(null); setInspecting(false); setError(null);
    };
    const inspect = async () => {
      const target = sessionId.trim();
      if (!target || inspecting) return;
      const request = ++generation.current;
      const epoch = readiness?.epoch ?? null;
      setInspecting(true); setInspection(null); setInspectionEpoch(null); setError(null);
      try {
        const result = await store.inspectSession(target);
        if (mounted.current && generation.current === request) {
          if (result.sessionId !== target) throw new Error('检查返回了不同的会话，请重新检查');
          setInspection(result); setInspectionEpoch(epoch);
        }
      } catch (failure) {
        if (mounted.current && generation.current === request) setError(describeError(failure));
      } finally {
        if (mounted.current && generation.current === request) setInspecting(false);
      }
    };
    const bindLabel = role ? `绑定${role}` : '接入接待者';
    const createBlocked = snapshot.setup.some(operation => operation.receiptId.startsWith('create:') && isUncertain(operation));
    const bindBlocked = snapshot.setup.some(operation => operation.label === bindLabel && isUncertain(operation));
    const epochChanged = !!role && inspection !== null && inspectionEpoch !== readiness?.epoch;
    const canBind = !!inspection && inspection.sessionId === sessionId.trim() && !!inspection.modelId
      && inspection.loaded && inspection.rolesNeedReload === false
      && !snapshot.checking && !snapshot.readinessError && !!readiness && !epochChanged && !bindBlocked;
    const canEnroll = !!inspection && inspection.sessionId === sessionId.trim() && !bindBlocked;
    return h('section', { className: 'ca-setup-form', 'aria-label': `${role ? roleNames[role] : '接待者'}设置` },
      h('h3', { className: 'ck-heading' }, role ? roleNames[role] : '接待者'),
      h('form', { className: 'ca-form-row', onSubmit: (event: FormEvent) => {
        event.preventDefault();
        if (cwd.trim() && !createBlocked) void store.createSession(cwd.trim(), role);
      } },
      field('新会话工作目录', cwd, setCwd, '绝对路径'),
      h('button', { type: 'submit', className: 'ck-button', disabled: !cwd.trim() || createBlocked }, '创建会话')),
      h('p', { className: 'ck-input-hint' }, role
        ? '创建不会自动绑定。请从操作回执复制会话编号，检查实际模型后明确绑定。'
        : '创建普通会话不会自动接入。请检查会话后明确接入接待者。'),
      h('form', { className: 'ca-form-row', onSubmit: (event: FormEvent) => { event.preventDefault(); void inspect(); } },
        field('已有会话编号', sessionId, changeId),
        h('button', { type: 'submit', className: 'ck-button', disabled: !sessionId.trim() || inspecting }, inspecting ? '正在检查…' : '检查会话')),
      error ? h('p', { role: 'alert', className: 'ck-danger ca-wrap' }, error) : null,
      inspection ? h('div', { className: 'ca-inspection' },
        h('dl', { className: 'ca-facts' },
          h('dt', null, '会话编号'), h('dd', null, inspection.sessionId),
          h('dt', null, '实际模型（只读）'), h('dd', null, inspection.modelId ?? '未知'),
          h('dt', null, '工作目录'), h('dd', null, inspection.cwd),
          h('dt', null, '加载状态'), h('dd', null, inspection.loaded ? '已加载' : '未加载'),
          h('dt', null, '会话状态'), h('dd', null, inspection.status),
          h('dt', null, '角色配置'), h('dd', null, inspection.rolesNeedReload === null ? '未知'
            : inspection.rolesNeedReload ? '需要重新加载' : '无需重新加载'),
          role ? h(Fragment, null, h('dt', null, '检查时绑定版本'), h('dd', null, inspectionEpoch ?? '未知')) : null),
        role && !inspection.loaded
          ? h('p', { className: 'ck-input-hint' }, '请先在 Cockpit 中明确加载此会话，然后重新检查。助手不会自动加载。') : null,
        role && inspection.rolesNeedReload === true
          ? h('p', { className: 'ck-input-hint' }, '请先在 Cockpit 中重新加载会话以应用角色配置，然后重新检查。助手不会自动修复。') : null,
        role && inspection.rolesNeedReload === null
          ? h('p', { className: 'ck-input-hint' }, '角色配置是否已应用尚不明确，请先在 Cockpit 中确认后重新检查。') : null,
        epochChanged ? h('p', { className: 'ck-status-text' }, '绑定状态已改变，请重新检查会话后绑定。') : null,
        role ? button(`明确绑定为${roleNames[role]}`, () => {
          if (canBind && inspection.modelId && inspectionEpoch !== null) {
            void store.bind(role, inspection.sessionId, inspection.modelId, inspectionEpoch);
          }
        }, !canBind) : h(Fragment, null,
          field('接待者名称', label, setLabel),
          button('明确接入接待者', () => {
            if (canEnroll) void store.enroll(inspection.sessionId, label.trim() || inspection.sessionId);
          }, !canEnroll))) : null);
  }

  function OperationCard({ operation }: { operation: SetupOperation }) {
    const [checking, setChecking] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const resultId = useId();
    const result = operation.result;
    const payload = result && typeof result === 'object' && 'result' in result ? result.result : result;
    const createdId = operation.receiptId.startsWith('create:') && payload && typeof payload === 'object'
      && 'sessionId' in payload && typeof payload.sessionId === 'string' ? payload.sessionId : null;
    return h('article', { className: 'ca-operation', 'aria-label': setupLabel(operation.label) },
      h('p', { className: 'ca-operation-title' }, setupLabel(operation.label), ' · ', stateName(operation.state)),
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
      markdown(item.text),
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
    const composing = useRef(false);
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

    const receptions = snapshot.readiness?.receptions.filter(entry => entry.kind === 'reception') ?? [];
    const receptionReady = receptions.some(entry => entry.enabled && entry.availability === 'loaded');
    const rolesReady = (['coordinator', 'memory'] as const).every(role =>
      snapshot.readiness?.roles.some(entry => entry.role === role && entry.status === 'ready'));
    const unresolvedSend = snapshot.submissions.some(entry => entry.state === 'pending' || entry.state === 'unknown');
    const pendingQuestion = snapshot.draft.reply?.question?.state === 'pending' ? snapshot.draft.reply.question : null;
    const choiceRequired = pendingQuestion?.allowFreeform === false;
    const validAnswer = !choiceRequired || !!pendingQuestion?.choices?.includes(snapshot.draft.text);
    const canSend = !!snapshot.readiness?.canSend && rolesReady && receptionReady && !snapshot.checking
      && !snapshot.readinessError && !unresolvedSend && !!snapshot.draft.text.trim() && validAnswer;
    const send = () => { if (canSend) void store.send(); };
    const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
      event.preventDefault();
      send();
    };
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
        h('h2', { id: `${id}-title`, className: 'ck-heading' }, '助手'),
        h('div', { className: 'ck-actions' },
          button(settingsOpen ? '收起设置' : '展开设置', () => setSettingsOpen(open => !open), false,
            { 'aria-expanded': settingsOpen, 'aria-controls': `${id}-settings` }),
          button('关闭', () => store.close(), false, { autoFocus: true }))),
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
          h('p', { className: 'ck-status-text' }, receptionReady ? '接待者：已有启用且加载的会话' : '接待者：尚无启用且加载的会话'),
          snapshot.readinessError ? h('p', { role: 'alert', className: 'ck-danger ca-wrap' }, snapshot.readinessError) : null,
          button(snapshot.checking ? '正在检查…' : '刷新就绪状态', () => { void store.refresh(); }, snapshot.checking)),
        h('section', { id: `${id}-settings`, hidden: !settingsOpen, className: 'ca-settings', 'aria-label': '设置' },
          settingsOpen ? h(Fragment, null,
            ...(['coordinator', 'memory'] as const).map(role => h(SessionForm, { key: role, role, snapshot,
              readiness: snapshot.readiness?.roles.find(entry => entry.role === role) })),
            h(SessionForm, { key: 'reception', snapshot }),
            receptions.length ? h('section', { className: 'ca-setup-form' },
              h('h3', { className: 'ck-heading' }, '接待者状态'),
              h('ul', { className: 'ca-receptions' }, receptions.map(entry => h('li', { key: entry.id },
                h('strong', null, entry.label), h('p', { className: 'ca-wrap' }, entry.id),
                h('p', null, entry.enabled ? '已启用' : '未启用', ' · ',
                  entry.availability === 'loaded' ? '已加载' : entry.availability === 'unloaded' ? '未加载'
                    : entry.availability === 'missing' ? '会话不存在' : '状态未知'),
                entry.gap ? h('p', { className: 'ck-status-text ca-wrap' }, entry.gap) : null)))) : null) : null),
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
        snapshot.draft.reply ? h('section', { className: 'ca-reply', 'aria-label': '当前回复引用' },
          h('h3', { className: 'ck-heading' }, '正在回复：',
            snapshot.draft.reply.topicId ? snapshot.draft.reply.topicTitle || '未命名话题' : '系统'),
          h('p', { className: 'ck-status-text ca-wrap' }, '来源：', snapshot.draft.reply.sessionId ?? '系统',
            ' · 引用：', snapshot.draft.reply.anchorId ?? snapshot.draft.reply.id),
          markdown(snapshot.draft.reply.text),
          !snapshot.items.some(item => item.id === snapshot.draft.reply?.id)
            ? choices(snapshot.draft.reply) : null) : null,
        snapshot.submissions.length ? h('section', { className: 'ca-operations', 'aria-label': '发送回执' },
          ...snapshot.submissions.map(submission => h(SubmissionCard, { key: submission.requestId, submission }))) : null)),
      h('footer', { className: 'ca-composer' },
        unread > 0 ? button(`${unread} 条新消息，查看最新`, bottom, false, { className: 'ck-button ca-new-messages' }) : null,
        snapshot.draft.reply ? h('div', { className: 'ca-reply' },
          h('div', { className: 'ca-reply-heading' },
            h('strong', null, '已选择回复引用'),
            button('取消回复', () => store.reply(null))),
          choiceRequired ? h('p', { className: 'ck-input-hint' }, '此问题仅接受消息中列出的选项。') : null) : null,
        h('form', { onSubmit: (event: FormEvent) => { event.preventDefault(); send(); } },
          h('label', { htmlFor: `${id}-draft`, className: 'ck-input-hint' }, '消息'),
          h('div', { className: 'ca-compose-row' },
            h('textarea', { id: `${id}-draft`, className: 'ck-input ca-draft', rows: 3, value: snapshot.draft.text,
              placeholder: '输入消息…', 'aria-describedby': `${id}-send-hint`,
              onChange: (event: { currentTarget: HTMLTextAreaElement }) => store.edit(event.currentTarget.value),
              onCompositionStart: () => { composing.current = true; }, onCompositionEnd: () => { composing.current = false; },
              onKeyDown: keyDown }),
            h('button', { type: 'submit', className: 'ck-button ck-primary', disabled: !canSend }, '发送')),
          h('p', { id: `${id}-send-hint`, className: 'ck-input-hint' },
            unresolvedSend ? '上次发送尚未确认，请检查发送回执；不会自动重发。'
              : !rolesReady || !receptionReady || !snapshot.readiness?.canSend || snapshot.readinessError
                ? '两位助手均就绪且有启用、已加载的接待者后才能发送。草稿仍可编辑。'
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
