import { createElement as h, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AnchoredMenu } from '@fixture/menu';
import { Composer } from '@fixture/composer';
import { ComposerCard, ComposerSurface } from '@fixture/composer-surface';
import { SessionDraft } from '@fixture/draft';

const nativeDraft = new SessionDraft('synthetic-selected-session', localStorage);
export function Workspace() {
  const trigger = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const { sessionId } = useParams();
  const navigate = useNavigate();
  return h('div', { className: 'fixture-workspace' },
    h('header', { className: 'fixture-header' },
      h('strong', null, 'Cockpit'),
      h('button', { ref: trigger, type: 'button', className: 'ck-button',
        'aria-label': '全局菜单', 'aria-haspopup': 'menu', 'aria-expanded': menu,
        onClick: () => setMenu(!menu) }, '☰'),
      menu ? h(AnchoredMenu, { triggerRef: trigger, items: [], label: '全局菜单',
        moduleTarget: { menu: 'global' }, onClose: () => setMenu(false) }) : null),
    h('main', { 'data-testid': sessionId ? 'selected-session' : 'empty-homepage', style: { padding: 0 } },
      h('h1', null, sessionId ? '合成会话' : '没有选择会话'),
      sessionId ? h(ComposerSurface, null, h(ComposerCard, null, h(Composer, { draft: nativeDraft, onSend: async () => {
        window.fixtureNativeSends++;
        throw new Error('Native submission forbidden in browser fixture');
      } }))) : h('button', { type: 'button', className: 'ck-button',
        onClick: () => { void navigate('/session/synthetic-selected-session'); } }, '选择合成会话')));
}
export const ManageWorkspace = Workspace;
