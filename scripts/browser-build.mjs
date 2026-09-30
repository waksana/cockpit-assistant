import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareReleases } from '../browser/release-fixtures.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const output = join(root, 'node_modules/.cache/assistant-browser');
export const hostRevision = 'e54d3d160852d0ea78b18184de84f160f8aad519';
export const host = process.env.COCKPIT_FIXTURE_HOST
  ? resolve(process.env.COCKPIT_FIXTURE_HOST) : join(output, 'host');
const require = createRequire(import.meta.url);
const dependencyPaths = [root, ...(process.env.COCKPIT_BROWSER_DEPENDENCIES
  ? [process.env.COCKPIT_BROWSER_DEPENDENCIES] : [])];
const dependency = name => require.resolve(name, { paths: dependencyPaths });
const git = args => execFileSync('git', ['-C', host, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

await mkdir(output, { recursive: true });
if (!process.env.COCKPIT_FIXTURE_HOST) {
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
} else {
  await access(join(host, 'apps/web/src/lib/moduleRuntime.ts'));
  console.warn(`Development-only unpinned host override: ${host}`);
}
const dependenciesRevision = join(output, 'host-dependencies-revision');
let prepareDependencies = false;
try {
  await access(join(host, 'apps/web/node_modules/react-markdown/package.json'));
  await access(join(host, 'apps/web/node_modules/remark-gfm/package.json'));
  if (!process.env.COCKPIT_FIXTURE_HOST) {
    prepareDependencies = await readFile(dependenciesRevision, 'utf8') !== hostRevision;
  }
} catch {
  prepareDependencies = true;
}
if (prepareDependencies) {
  if (process.env.COCKPIT_FIXTURE_HOST) {
    throw new Error('Prepare the development host web dependencies before using its override');
  }
  const scratch = join(output, 'runtime');
  await mkdir(scratch, { recursive: true });
  execFileSync('pnpm', ['--dir', host, '--filter', '@cockpit/web...', 'install',
    '--prod', '--frozen-lockfile', '--ignore-scripts', '--store-dir', join(output, 'pnpm-store')], {
    stdio: 'inherit', env: { ...process.env, TMPDIR: scratch, CI: 'true' },
  });
  if (git(['status', '--porcelain'])) throw new Error('Host dependency preparation changed tracked fixture source');
  await writeFile(dependenciesRevision, hostRevision);
}
if (process.argv.includes('--host-only')) process.exit(0);
const web = join(host, 'apps/web/src');
const sass = require(dependency('sass'));
const stylesheet = sass.compile(join(web, 'styles/index.scss'), { style: 'expanded', sourceMap: false });
await writeFile(join(output, 'host.css'), stylesheet.css);

const aliases = {
  '@fixture/app': join(web, 'App.tsx'),
  '@fixture/runtime': join(web, 'lib/moduleRuntime.ts'),
  '@fixture/components': join(web, 'components/ModuleComponents.tsx'),
  '@fixture/menu': join(web, 'components/AnchoredMenu.tsx'),
  '@fixture/composer': join(web, 'components/Composer.tsx'),
  '@fixture/composer-surface': join(web, 'components/ComposerSurface.tsx'),
  '@fixture/thread-transcript': join(web, 'features/thread/ThreadTranscript.tsx'),
  '@fixture/draft': join(web, 'lib/textDraft.ts'),
  '@cockpit/protocol': join(host, 'packages/protocol/src'),
  '@cockpit/module-api': join(host, 'packages/module-api/src'),
  'lucide-react': dependency('lucide-react'),
  react: dirname(dependency('react/package.json')),
  'react-dom': dirname(dependency('react-dom/package.json')),
  'react-router-dom': dependency('react-router-dom'),
};
const fixtureBuild = await build({
  absWorkingDir: root, entryPoints: ['browser/host-entry.ts'],
  outfile: join(output, 'host.js'), bundle: true, platform: 'browser',
  format: 'esm', target: 'es2022', jsx: 'automatic', sourcemap: true, metafile: true,
  alias: aliases,
  plugins: [{
    name: 'synthetic-host-state-only',
    setup(builder) {
      builder.onResolve({ filter: /(?:features\/workspace\/Workspace|components\/ManageWorkspace)$/ }, args => {
        if (args.importer === join(web, 'App.tsx')) return { path: join(root, 'browser/host-workspace.ts') };
      });
      builder.onResolve({ filter: /(^|\/)store(?:\.ts)?$/ }, args => {
        if (args.importer.startsWith(web)
          && resolve(dirname(args.importer), args.path).replace(/\.ts$/, '') === join(web, 'net/store')) {
          return { path: join(root, 'browser/host-state.ts') };
        }
      });
      builder.onResolve({ filter: /^zod$/ }, args => {
        // This pinned host uses Zod 3. The module's production bundle uses Zod 4.
        if (args.importer.startsWith(host)) return { path: dependency('zod/v3') };
      });
    },
  }],
});
if (Object.keys(fixtureBuild.metafile.inputs).some(path => path.endsWith('/apps/web/src/net/store.ts'))) {
  throw new Error('Browser fixture must not bundle the production native store');
}
await build({
  absWorkingDir: root, entryPoints: ['browser/probe.ts'], outfile: join(output, 'probe.js'),
  bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
});
await build({
  absWorkingDir: root, entryPoints: ['browser/message-list-probe.ts'], outfile: join(output, 'message-list-probe.js'),
  bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
});
await readFile(join(root, 'dist/web/index.js'));
await readFile(join(root, 'dist/web/styles.css'));
await prepareReleases(output);
console.log(`Assistant browser fixture ready: ${process.env.COCKPIT_FIXTURE_HOST
  ? `development host ${host}` : `pinned public host ${hostRevision}`}; production dist/web assets`);
