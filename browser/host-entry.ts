import { createElement as h, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ModuleRuntime } from '@fixture/runtime';
import { ModuleRuntimeProvider, ModuleGlobalComponents } from '@fixture/components';
import { AnchoredMenu } from '@fixture/menu';
import { Composer } from '@fixture/composer';
import { SessionDraft } from '@fixture/draft';

window.fixtureNativeSends = 0;
const rejectNative = async () => {
  window.fixtureNativeSends++;
  throw new Error('Native submission must never handle an Assistant input');
};
const nativeDraft = new SessionDraft('synthetic-selected-session', localStorage);
const runtime = new ModuleRuntime({ draftSubmission: { check: () => undefined, send: rejectNative }, report: error => {
  console.error(error);
  const report = document.createElement('p');
  report.setAttribute('role', 'alert');
  report.textContent = String(error);
  document.body.append(report);
} });
window.restartFixture = async () => { runtime.stop(); await runtime.start(); };

function EmptyHomepage() {
  const trigger = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const [selected, setSelected] = useState(false);
  return h(ModuleRuntimeProvider, { runtime },
    h('header', { className: 'fixture-header' },
      h('strong', null, 'Cockpit'),
      h('button', { ref: trigger, type: 'button', className: 'ck-button',
        'aria-label': '全局菜单', 'aria-haspopup': 'menu', 'aria-expanded': menu,
        onClick: () => setMenu(!menu) }, '☰'),
      menu ? h(AnchoredMenu, { triggerRef: trigger, items: [], label: '全局菜单',
        moduleTarget: { menu: 'global' }, onClose: () => setMenu(false) }) : null),
    h('main', { 'data-testid': selected ? 'selected-session' : 'empty-homepage' },
      h('h1', null, selected ? '合成会话' : '没有选择会话'),
      selected ? h(Composer, { draft: nativeDraft, onSend: rejectNative })
        : h('button', { type: 'button', className: 'ck-button', onClick: () => {
          runtime.updateView({ sessionId: 'synthetic-selected-session', visible: true, connected: true });
          setSelected(true);
        } }, '选择合成会话')),
    h(ModuleGlobalComponents));
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
createRoot(root).render(h(EmptyHomepage));
void runtime.start();
