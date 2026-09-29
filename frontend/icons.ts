import type { ModuleFrontendContext } from '@waksana/cockpit-module-sdk/frontend';

// Exact Lucide 1.46.0 nodes; distributed license: licenses/lucide.txt.
const nodes = {
  'arrow-left': [
    ['path', { d: 'm12 19-7-7 7-7', key: '1l729n' }],
    ['path', { d: 'M19 12H5', key: 'x3x0zl' }],
  ],
  'circle-check': [
    ['circle', { cx: '12', cy: '12', r: '10', key: '1mglay' }],
    ['path', { d: 'm16 9-5.5 5.5L8 12', key: 'xofnsj' }],
  ],
  'circle-minus': [
    ['circle', { cx: '12', cy: '12', r: '10', key: '1mglay' }],
    ['path', { d: 'M8 12h8', key: '1wcyev' }],
  ],
  'circle-pause': [
    ['circle', { cx: '12', cy: '12', r: '10', key: '1mglay' }],
    ['line', { x1: '10', x2: '10', y1: '15', y2: '9', key: 'c1nkhi' }],
    ['line', { x1: '14', x2: '14', y1: '15', y2: '9', key: 'h65svq' }],
  ],
  'circle-alert': [
    ['circle', { cx: '12', cy: '12', r: '10', key: '1mglay' }],
    ['line', { x1: '12', x2: '12', y1: '8', y2: '12', key: '1pkeuh' }],
    ['line', { x1: '12', x2: '12.01', y1: '16', y2: '16', key: '4dfq90' }],
  ],
  'circle-help': [
    ['circle', { cx: '12', cy: '12', r: '10', key: '1mglay' }],
    ['path', { d: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3', key: '1u773s' }],
    ['path', { d: 'M12 17h.01', key: 'p32p05' }],
  ],
  loader: [
    ['path', { d: 'M12 2v4', key: '3427ic' }],
    ['path', { d: 'm16.2 7.8 2.9-2.9', key: 'r700ao' }],
    ['path', { d: 'M18 12h4', key: 'wj9ykh' }],
    ['path', { d: 'm16.2 16.2 2.9 2.9', key: '1bxg5t' }],
    ['path', { d: 'M12 18v4', key: 'jadmvz' }],
    ['path', { d: 'm4.9 19.1 2.9-2.9', key: 'bwix9q' }],
    ['path', { d: 'M2 12h4', key: 'j09sii' }],
    ['path', { d: 'm4.9 4.9 2.9 2.9', key: 'giyufr' }],
  ],
  wifi: [
    ['path', { d: 'M12 20h.01', key: 'zekei9' }],
    ['path', { d: 'M2 8.82a15 15 0 0 1 20 0', key: 'dnpr2z' }],
    ['path', { d: 'M5 12.859a10 10 0 0 1 14 0', key: '1x1e6c' }],
    ['path', { d: 'M8.5 16.429a5 5 0 0 1 7 0', key: '1bycff' }],
  ],
  'wifi-off': [
    ['path', { d: 'M12 20h.01', key: 'zekei9' }],
    ['path', { d: 'M8.5 16.429a5 5 0 0 1 7 0', key: '1bycff' }],
    ['path', { d: 'M5 12.859a10 10 0 0 1 5.17-2.69', key: '1dl1wf' }],
    ['path', { d: 'M19 12.859a10 10 0 0 0-2.007-1.523', key: '4k23kn' }],
    ['path', { d: 'M2 8.82a15 15 0 0 1 4.177-2.643', key: '1grhjp' }],
    ['path', { d: 'M22 8.82a15 15 0 0 0-11.288-3.764', key: 'z3jwby' }],
    ['path', { d: 'm2 2 20 20', key: '1ooewy' }],
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
