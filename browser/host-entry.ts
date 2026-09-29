import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from '@fixture/app';
import { ModuleRuntime } from '@fixture/runtime';
import { ModuleRuntimeProvider } from '@fixture/components';

window.fixtureNativeSends = 0;
if (new URL(location.href).searchParams.has('probes')) sessionStorage.setItem('fixture-probes', '1');
const runtime = new ModuleRuntime({
  draftSubmission: { check: () => undefined, send: async () => {
    window.fixtureNativeSends++;
    throw new Error('Native submission must never handle an Assistant input');
  } },
  report: error => console.error(error),
});
window.restartFixture = async () => { runtime.stop(); await runtime.start(); };
window.stopFixture = () => runtime.stop();
const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
// Production App owns all routes, focus ownership, navigation and ModulePages.
// Only Workspace's native-data presentation is replaced; there is one React root.
createRoot(root).render(h(ModuleRuntimeProvider, { runtime }, h(BrowserRouter, null, h(App))));
void runtime.start();
