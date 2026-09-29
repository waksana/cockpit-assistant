import { createElement as h, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AnchoredMenu } from '@fixture/menu';
import { Composer } from '@fixture/composer';
import { ComposerCard, ComposerSurface } from '@fixture/composer-surface';
import { SessionDraft } from '@fixture/draft';
import { ThreadTranscript } from '@fixture/thread-transcript';
import { chatReference } from './chat-reference.ts';

const nativeDraft = new SessionDraft('synthetic-selected-session', localStorage);
const referenceSession = {
  sessionId: 'synthetic-selected-session', messages: chatReference, status: 'idle',
  materialized: true, hasMore: false, loadingHistory: false, cwd: '/synthetic/reference',
};
export function Workspace() {
  const trigger = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const withTranscript = new URL(location.href).searchParams.has('transcript');
  return h('div', { className: 'fixture-workspace',
    style: withTranscript ? { height: '100%', display: 'flex', flexDirection: 'column' } : undefined },
    h('header', { className: 'fixture-header' },
      h('strong', null, 'Cockpit'),
      h('button', { ref: trigger, type: 'button', className: 'ck-button',
        'aria-label': '全局菜单', 'aria-haspopup': 'menu', 'aria-expanded': menu,
        onClick: () => setMenu(!menu) }, '☰'),
      menu ? h(AnchoredMenu, { triggerRef: trigger, items: [], label: '全局菜单',
        moduleTarget: { menu: 'global' }, onClose: () => setMenu(false) }) : null),
    h('main', { 'data-testid': sessionId ? 'selected-session' : 'empty-homepage',
      className: withTranscript && sessionId ? 'chat' : undefined, style: { padding: 0 } },
      withTranscript && sessionId ? h(ThreadTranscript, {
        session: referenceSession, messages: chatReference, scrollRef, contentRef,
        awayFromBottom: false, hasNewContent: false, onFollow: () => {},
      }) : h('h1', null, sessionId ? '合成会话' : '没有选择会话'),
      sessionId ? h(ComposerSurface, null, h(ComposerCard, null, h(Composer, { draft: nativeDraft, onSend: async () => {
        window.fixtureNativeSends++;
        throw new Error('Native submission forbidden in browser fixture');
      } }))) : h('button', { type: 'button', className: 'ck-button',
        onClick: () => { void navigate(`/session/synthetic-selected-session${withTranscript ? '?transcript=1' : ''}`); } }, '选择合成会话')));
}
export const ManageWorkspace = Workspace;
