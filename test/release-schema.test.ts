import { test } from 'node:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { activate } from '../src/index.ts';
import { build } from 'esbuild';
// @ts-expect-error Packaging helpers run directly in Node outside the TS bundle.
import { verifySchemaBoundary } from '../scripts/schema-preflight.mjs';

test('packaged offline 3/4/5-to-6 migration preserves history, inbox evidence and explicit watch edits', async () => {
  const directory = join(process.cwd(), 'node_modules/.cache', `assistant-schema-preflight-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  try {
    const migrationEntry = join(directory, 'migrate.mjs');
    await build({ entryPoints: ['scripts/migrate-entry.mjs'], outfile: migrationEntry,
      platform: 'node', format: 'esm', bundle: true, target: 'node24' });
    await verifySchemaBoundary(activate, directory, migrationEntry);
  }
  finally { await rm(directory, { recursive: true, force: true }); }
});
