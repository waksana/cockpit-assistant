import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, ['scripts/browser-build.mjs', '--host-only'], { cwd: root, stdio: 'inherit' });
const host = resolve(process.env.COCKPIT_FIXTURE_HOST ?? join(root, 'node_modules/.cache/assistant-browser/host'));
const outfile = join(root, 'node_modules/.cache/assistant-browser/store-runtime.mjs');
const bundled = await build({
  entryPoints: [`${host}/apps/web/src/lib/moduleRuntime.ts`], outfile,
  bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', metafile: true,
  mainFields: ['module', 'main'],
  external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
  alias: {
    '@cockpit/module-api': `${host}/packages/module-api/src`,
    '@cockpit/protocol': `${host}/packages/protocol/src`,
  },
  plugins: [{
    name: 'synthetic-network-only',
    setup(builder) {
      builder.onResolve({ filter: /(^|\/)store(?:\.ts)?$/ }, args => {
        if (resolve(dirname(args.importer), args.path).replace(/\.ts$/, '') === `${host}/apps/web/src/net/store`) {
          return { path: join(root, 'browser/host-state.ts') };
        }
      });
      builder.onResolve({ filter: /^zod$/ }, () => ({ path: 'zod/v3', external: true }));
    },
  }],
});
for (const output of Object.values(bundled.metafile.outputs)) {
  for (const dependency of output.imports.filter(value => value.external)) {
    if (!/^(?:react(?:-dom)?(?:\/|$)|zod\/v3$|node:)/.test(dependency.path)) {
      throw new Error(`Host fixture leaked an unbundled non-React dependency: ${dependency.path}`);
    }
  }
}
if (Object.keys(bundled.metafile.inputs).some(path => /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?react(?:-dom)?\//.test(path))) {
  throw new Error('Store fixture must reuse the test process React runtime');
}
console.log('Pinned Host store fixture prepared once before parallel Node test workers');
