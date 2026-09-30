import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activate } from '../src/index.ts';
// @ts-expect-error Packaging helpers run directly in Node outside the TS bundle.
import { verifySchemaBoundary } from '../scripts/schema-preflight.mjs';

test('activation refuses real legacy schema shapes without creating target tables or mutating originals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-schema-preflight-'));
  try { await verifySchemaBoundary(activate, directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
