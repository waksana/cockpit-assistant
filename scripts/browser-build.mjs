import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const output = join(root, 'node_modules/.cache/assistant-browser');
export const hostRevision = '0dcfd6688b4c01b3f29776ee804b901612a6ae9b';
const host = join(output, 'host');
const require = createRequire(import.meta.url);
const dependencyPaths = [root, ...(process.env.COCKPIT_BROWSER_DEPENDENCIES
  ? [process.env.COCKPIT_BROWSER_DEPENDENCIES] : [])];
const dependency = name => require.resolve(name, { paths: dependencyPaths });
const git = args => execFileSync('git', ['-C', host, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

await mkdir(host, { recursive: true });
try { await access(join(host, '.git')); } catch { git(['init', '--quiet']); }
let revision;
try { revision = git(['rev-parse', 'HEAD']); } catch { /* First fixture checkout. */ }
if (revision !== hostRevision) {
  if (git(['status', '--porcelain'])) throw new Error('Refusing to overwrite a modified host fixture');
  git(['fetch', '--quiet', '--depth=1', process.env.COCKPIT_FIXTURE_SOURCE
    ?? 'https://github.com/waksana/cockpit.git', hostRevision]);
  git(['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
}
if (git(['rev-parse', 'HEAD']) !== hostRevision || git(['status', '--porcelain'])) {
  throw new Error('Browser tests require the exact clean, pinned public host fixture');
}
if (process.argv.includes('--host-only')) process.exit(0);
const web = join(host, 'apps/web/src');
const sass = require(dependency('sass'));
const stylesheet = sass.compile(join(web, 'styles/index.scss'), { style: 'expanded', sourceMap: false });
await writeFile(join(output, 'host.css'), stylesheet.css);

const aliases = {
  '@fixture/runtime': join(web, 'lib/moduleRuntime.ts'),
  '@fixture/components': join(web, 'components/ModuleComponents.tsx'),
  '@fixture/menu': join(web, 'components/AnchoredMenu.tsx'),
  '@fixture/composer': join(web, 'components/Composer.tsx'),
  '@fixture/draft': join(web, 'lib/textDraft.ts'),
  '@cockpit/protocol': join(host, 'packages/protocol/src/index.ts'),
  '@cockpit/module-api': join(root, 'node_modules/@waksana/cockpit-module-sdk'),
  'lucide-react': dependency('lucide-react'),
  react: dirname(dependency('react/package.json')),
  'react-dom': dirname(dependency('react-dom/package.json')),
};
await build({
  absWorkingDir: root, entryPoints: ['browser/host-entry.ts'],
  outfile: join(output, 'host.js'), bundle: true, platform: 'browser',
  format: 'esm', target: 'es2022', jsx: 'automatic', sourcemap: true,
  alias: aliases,
  plugins: [{
    name: 'synthetic-host-state-only',
    setup(builder) {
      builder.onResolve({ filter: /(^|\/)net\/store$/ }, args => {
        if (args.importer.startsWith(web)) return { path: join(root, 'browser/host-state.ts') };
      });
      builder.onResolve({ filter: /^zod$/ }, args => {
        // This pinned host uses Zod 3. The module's production bundle uses Zod 4.
        if (args.importer.startsWith(host)) return { path: dependency('zod/v3') };
      });
    },
  }],
});
await build({
  absWorkingDir: root, entryPoints: ['browser/probe.ts'], outfile: join(output, 'probe.js'),
  bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
});
await readFile(join(root, 'dist/web/index.js'));
await readFile(join(root, 'dist/web/styles.css'));
console.log(`Assistant browser fixture ready: public host ${hostRevision}; production dist/web assets`);
