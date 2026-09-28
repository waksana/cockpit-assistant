import type { ModuleFrontendContext } from '@waksana/cockpit-module-sdk/frontend';

// Exact Lucide 1.46.0 nodes; distributed license: licenses/lucide.txt.
const nodes = {
  'arrow-left': [
    ['path', { d: 'm12 19-7-7 7-7', key: '1l729n' }],
    ['path', { d: 'M19 12H5', key: 'x3x0zl' }],
  ],
  settings: [
    ['path', {
      d: 'M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915',
      key: '1i5ecw',
    }],
    ['circle', { cx: '12', cy: '12', r: '3', key: '1v7zrd' }],
  ],
} as const;

export function createIcon(context: ModuleFrontendContext) {
  const h = context.react.createElement;
  return (name: keyof typeof nodes) => h('svg', {
    className: 'ck-icon ck-icon-lg', viewBox: '0 0 24 24', width: 24, height: 24,
    fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': true, focusable: 'false',
  }, ...nodes[name].map(([tag, attributes]) => h(tag, attributes)));
}
