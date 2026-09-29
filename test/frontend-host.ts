import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModuleFrontendContext } from '@waksana/cockpit-module-sdk/frontend';

// Bundle the pinned real runtime; no production import reaches into host internals.
execFileSync(process.execPath, ['scripts/browser-build.mjs', '--host-only'], { cwd: resolve('.') });
const host = resolve('node_modules/.cache/assistant-browser/host');
const outfile = resolve('node_modules/.cache/assistant-browser/store-runtime.mjs');
await build({
  entryPoints: [`${host}/apps/web/src/lib/moduleRuntime.ts`], outfile,
  bundle: true, platform: 'node', format: 'esm', packages: 'external',
  alias: {
    '@cockpit/module-api': resolve('node_modules/@waksana/cockpit-module-sdk'),
    '@cockpit/protocol': `${host}/packages/protocol/src/index.ts`,
  },
  plugins: [{
    name: 'synthetic-network-only',
    setup(builder) {
      builder.onResolve({ filter: /(^|\/)net\/store$/ }, () => ({ path: resolve('browser/host-state.ts') }));
      builder.onResolve({ filter: /^zod$/ }, () => ({ path: 'zod/v3', external: true }));
    },
  }],
});
const { ModuleRuntime } = await import(pathToFileURL(outfile).href);

export async function hostState() {
  let activate = (_context: ModuleFrontendContext): object => ({});
  const values = new Map<string, string>();
  const errors: unknown[] = [];
  const digest = 'a'.repeat(64);
  const runtime = new ModuleRuntime({
    pageUrl: 'http://fixture.invalid/',
    fetch: async () => Response.json({ modules: [{
      id: 'assistant', name: 'Assistant', version: '0.1.0', digest, config: {}, styles: [],
      apiBase: `/_modules/assistant/${digest}/api`, entry: `/_modules/assets/assistant/${digest}/index.js`,
    }], errors: [] }),
    load: async () => ({ frontendApiVersion: 3, activate: (value: ModuleFrontendContext) => activate(value) }),
    report: (error: unknown) => errors.push(error),
    draftStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
  });
  // State registration is activation-only, so callers construct stores inside activate.
  return {
    async activate<T>(create: (context: ModuleFrontendContext) => T): Promise<T> {
      let result!: T;
      activate = value => {
        result = create(value);
        return { apiVersion: 3 };
      };
      await runtime.start();
      if (errors.length) throw new AggregateError(errors, 'Real host fixture activation failed');
      return result;
    },
    stop: () => runtime.stop(),
    values, errors,
  };
}
