import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  platform: 'node',
  format: 'esm',
  target: 'node24',
  bundle: true,
  sourcemap: true,
});
