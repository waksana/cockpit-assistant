import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';
import { buildRoleInstructions } from './role-instructions.mjs';

await buildRoleInstructions();

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  platform: 'node',
  format: 'esm',
  target: 'node24',
  bundle: true,
  sourcemap: true,
});
await build({
  entryPoints: ['scripts/migrate-entry.mjs'],
  outfile: 'dist/migrate.js',
  platform: 'node',
  format: 'esm',
  target: 'node24',
  bundle: true,
  sourcemap: true,
});
const web = await build({
  entryPoints: ['frontend/index.ts'], outfile: 'dist/web/index.js',
  platform: 'browser', format: 'esm', target: 'es2022', bundle: true,
  sourcemap: true, metafile: true,
});
if (Object.keys(web.metafile.inputs).some(path => /node_modules\/(react|react-dom)\//.test(path))) {
  throw new Error('Frontend must reuse host React, not bundle a runtime');
}
await copyFile('frontend/styles.css', 'dist/web/styles.css');
