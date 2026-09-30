import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activate } from '../src/index.ts';
import { build } from 'esbuild';
// @ts-expect-error Packaging helpers run directly in Node outside the TS bundle.
import { verifySchemaBoundary } from '../scripts/schema-preflight.mjs';

test('packaged migration preserves every schema-3 field and refuses incompatible older layouts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-schema-preflight-'));
  try {
    const migrationEntry = join(directory, 'migrate.mjs');
    await build({ entryPoints: ['scripts/migrate-entry.mjs'], outfile: migrationEntry,
      platform: 'node', format: 'esm', bundle: true, target: 'node24' });
    await verifySchemaBoundary(activate, directory, migrationEntry);
  }
  finally { await rm(directory, { recursive: true, force: true }); }
});
