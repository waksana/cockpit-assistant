import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { buildRoleInstructions } from './role-instructions.mjs';

await buildRoleInstructions();
await rm('dist/web', { recursive: true, force: true });

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
