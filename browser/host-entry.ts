import { createElement as h, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ModuleRuntime } from '@fixture/runtime';
import { ModuleRuntimeProvider, ModuleGlobalComponents } from '@fixture/components';
import { AnchoredMenu } from '@fixture/menu';

const runtime = new ModuleRuntime({ report: error => {
  console.error(error);
  const report = document.createElement('p');
  report.setAttribute('role', 'alert');
  report.textContent = String(error);
  document.body.append(report);
} });

function EmptyHomepage() {
  const trigger = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const [selected, setSelected] = useState(false);
  const [draft, setDraft] = useState('');
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
      selected ? h('label', null, 'Cockpit 草稿',
        h('textarea', { value: draft, onChange: (event: { currentTarget: HTMLTextAreaElement }) => setDraft(event.currentTarget.value) }))
        : h('button', { type: 'button', className: 'ck-button', onClick: () => setSelected(true) }, '选择合成会话')),
    h(ModuleGlobalComponents));
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
createRoot(root).render(h(EmptyHomepage));
void runtime.start();
