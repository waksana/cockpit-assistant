import { accessSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModuleFrontendContext } from '@waksana/cockpit-module-sdk/frontend';

const outfile = resolve('node_modules/.cache/assistant-browser/store-runtime.mjs');
try { accessSync(outfile); }
catch (error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    throw new Error('Run npm run test:prepare before focused frontend tests');
  }
  throw error;
}
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
