import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { retainedRows } from './migration-contract.mjs';
import { populateLegacy, verifyUnread } from './fixtures/retained-data.mjs';

export const applicationTables = ['deliveries', 'mailbox', 'seen', 'topics'];
export const schemaVersion = 5;
function context(dataRoot, signal) {
  return { moduleId: 'assistant', apiVersion: 1, serviceReadyVersion: 1,
    dataRoot, apiBase: '/_modules/assistant/fixture/api', config: {}, signal,
    host: { chatReadVersion: 1, askResponseVersion: 1, roleAssignmentVersion: 1, sessionLoadVersion: 1,
      promptReceiptVersion: 1, toolScopeVersion: 1, promptOriginVersion: 1, roleResourcePolicyVersion: 1,
      async call() { throw new Error('Schema preflight must not call the Host'); } },
    report(error) { throw error; }, publish() {}, invalidate() {},
  };
}
export async function verifySchemaBoundary(activate, directory, migrationEntry) {
  const fresh = join(directory, 'fresh');
  await mkdir(fresh);
  const controller = new AbortController(), backend = await activate(context(fresh, controller.signal));
  controller.abort(); backend.dispose?.(); await setImmediate();
  const sql = new DatabaseSync(join(fresh, 'assistant.sqlite'), { readOnly: true });
  try {
    assert.equal(sql.prepare('PRAGMA user_version').get().user_version, schemaVersion);
    assert.deepEqual(sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name")
      .all().map(row => row.name), applicationTables);
  } finally { sql.close(); }
  for (const version of [3, 4]) {
    const dataRoot = join(directory, `published-${version}`), path = join(dataRoot, 'assistant.sqlite');
    await mkdir(dataRoot);
    const old = new DatabaseSync(path); populateLegacy(old, version);
    const before = retainedRows(old, version); old.close();
    const bytes = await readFile(path);
    await assert.rejects(() => activate(context(dataRoot, new AbortController().signal)), /explicit preserved-data migration/);
    const run = phase => JSON.parse(execFileSync(process.execPath, [migrationEntry, phase, dataRoot], { encoding: 'utf8' }));
    assert.deepEqual(run('preflight'), { ok: true, phase: 'preflight', schema: version, from: version, to: 5, changed: false });
    assert.deepEqual(await readFile(path), bytes);
    assert.deepEqual(run('apply'), { ok: true, phase: 'apply', schema: 5, from: version, to: 5, changed: true });
    const migrated = await readFile(path);
    assert.deepEqual(run('apply'), { ok: true, phase: 'apply', schema: 5, from: 5, to: 5, changed: false });
    assert.deepEqual(await readFile(path), migrated);
    const checked = new DatabaseSync(path, { readOnly: true });
    try {
      assert.deepEqual(retainedRows(checked, version), before);
      verifyUnread(assert, checked, version);
    } finally { checked.close(); }
  }
  for (const version of [1, 2, 3, 4]) {
    const dataRoot = join(directory, `incompatible-${version}`), path = join(dataRoot, 'assistant.sqlite');
    await mkdir(dataRoot);
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE messages(id TEXT,raw TEXT); INSERT INTO messages VALUES('original','Retain this draft'); PRAGMA user_version=${version}`);
    old.close();
    const bytes = await readFile(path);
    await assert.rejects(() => activate(context(dataRoot, new AbortController().signal)), /migration|schema|table/i);
    assert.throws(() => execFileSync(process.execPath, [migrationEntry, 'apply', dataRoot], { stdio: 'pipe' }));
    assert.deepEqual(await readFile(path), bytes);
  }
}
