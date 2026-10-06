import assert from 'node:assert/strict';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { retainedDatabase, schema6Migrations } from './migration-contract.mjs';
import { populateLegacy, populateArchivedSchema5, verifyUnread, verifyWatches } from './fixtures/retained-data.mjs';

export const applicationTables = ['deliveries', 'mailbox', 'seen', 'topics', 'watches'];
export const schemaVersion = 6;
function context(dataRoot, signal) {
  return { moduleId: 'assistant', apiVersion: 1, serviceReadyVersion: 1, shutdownVersion: 1,
    stopping: new AbortController().signal,
    dataRoot, apiBase: '/_modules/assistant/fixture/api', config: {}, signal,
    host: { chatReadVersion: 1, askResponseVersion: 1, roleAssignmentVersion: 1, roleAvailabilityVersion: 1, sessionLoadVersion: 1,
      promptReceiptVersion: 1, sessionDirectoryVersion: 1, toolScopeVersion: 1, promptOriginVersion: 1, roleResourcePolicyVersion: 1,
      async call() { throw new Error('Schema preflight must not call the Host'); } },
    report(error) { throw error; }, publish() {}, invalidate() {},
  };
}
export async function verifySchemaBoundary(activate, directory, migrationEntry) {
  const fresh = join(directory, 'fresh');
  await mkdir(fresh);
  const controller = new AbortController(), backend = await activate(context(fresh, controller.signal));
  await backend.onStop(); controller.abort(); await backend.dispose?.(); await setImmediate();
  const sql = new DatabaseSync(join(fresh, 'assistant.sqlite'), { readOnly: true });
  try {
    assert.equal(sql.prepare('PRAGMA user_version').get().user_version, schemaVersion);
    assert.deepEqual(sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name")
      .all().map(row => row.name), applicationTables);
    assert.equal(sql.prepare('SELECT count(*) AS n FROM watches').get().n, 0,
      'Fresh stores must not implicitly watch any native sessions');
  } finally { sql.close(); }
  const recent = new DatabaseSync(join(fresh, 'recent.sqlite'), { readOnly: true });
  try {
    assert.equal(recent.prepare('PRAGMA user_version').get().user_version, 1);
    assert.ok(recent.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'").all().length > 0,
      'The packaged backend creates its declared independent recent cache');
  } finally { recent.close(); }
  for (const [version, archive] of [[3, null], [4, null], [5, null], [5, 3], [5, 4]]) {
    const dataRoot = join(directory, `published-${version}${archive ? `-archive-${archive}` : ''}`), path = join(dataRoot, 'assistant.sqlite');
    await mkdir(dataRoot);
    const old = new DatabaseSync(path);
    if (archive) populateArchivedSchema5(old, archive);
    else populateLegacy(old, version);
    const before = retainedDatabase(old); old.close();
    const bytes = await readFile(path);
    await assert.rejects(() => activate(context(dataRoot, new AbortController().signal)), /explicit preserved-data migration/);
    assert.deepEqual(await readFile(path), bytes, 'Runtime loading must never upgrade an old schema');
    const declared = schema6Migrations.find(migration => migration.from === version);
    assert.equal(!!declared, version === 5, 'Only schema 5 has a deployment-declared migration');
    const run = (phase, validateDeclaration = true) => {
      const hook = validateDeclaration ? declared?.[phase] : undefined;
      if (hook) assert.equal(hook.entry, 'dist/migrate.js');
      const args = hook ? hook.args.map(arg => {
        if (typeof arg === 'string') return arg;
        assert.deepEqual(arg, { path: 'data' });
        return dataRoot;
      }) : [phase, dataRoot];
      const result = JSON.parse(execFileSync(process.execPath, [migrationEntry, ...args], { encoding: 'utf8' }));
      if (hook)
        for (const [key, value] of Object.entries(hook.expected)) assert.equal(result[key], value, key);
      return result;
    };
    assert.deepEqual(run('preflight'), { ok: true, phase: 'preflight', schema: version, from: version, to: 6, changed: false });
    assert.deepEqual(await readFile(path), bytes);
    const injectFailure = `
      import { DatabaseSync } from 'node:sqlite';
      import { pathToFileURL } from 'node:url';
      const [entry, root] = process.argv.slice(1);
      const exec = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function(statement) {
        exec.call(this, statement);
        if (statement === 'PRAGMA user_version=6') throw new Error('Synthetic packaged migration failure');
      };
      process.argv = [process.execPath, entry, 'apply', root];
      await import(pathToFileURL(entry).href);
    `;
    assert.throws(() => execFileSync(process.execPath,
      ['--input-type=module', '-e', injectFailure, migrationEntry, dataRoot], { stdio: 'pipe' }),
    /Synthetic packaged migration failure/);
    assert.deepEqual(await readFile(path), bytes, 'A packaged apply failure must roll back all DDL, imports and schema changes');
    assert.deepEqual(run('apply'), { ok: true, phase: 'apply', schema: 6, from: version, to: 6, changed: true });
    const migrated = await readFile(path);
    assert.deepEqual(run('apply'), { ok: true, phase: 'apply', schema: 6, from: 6, to: 6, changed: false });
    assert.deepEqual(await readFile(path), migrated);
    const checked = new DatabaseSync(path, { readOnly: true });
    try {
      assert.deepEqual(retainedDatabase(checked, before), before);
      verifyUnread(assert, checked, version);
      verifyWatches(assert, checked);
    } finally { checked.close(); }
    const editing = new DatabaseSync(path);
    let edited;
    try {
      editing.exec(`UPDATE watches SET enabled=0,version=7,updated_at=2200 WHERE session_id='business-session-1';
        DELETE FROM watches WHERE session_id='business-session-2';
        INSERT INTO watches VALUES('explicit-watch-session',0,3,2201)`);
      edited = retainedDatabase(editing);
    } finally { editing.close(); }
    const editedBytes = await readFile(path);
    assert.deepEqual(run('preflight', false), { ok: true, phase: 'preflight', schema: 6, from: 6, to: 6, changed: false });
    assert.deepEqual(run('apply'), { ok: true, phase: 'apply', schema: 6, from: 6, to: 6, changed: false });
    assert.deepEqual(await readFile(path), editedBytes, 'Repeated apply must never reimport disabled or removed watches');
    await assert.rejects(lstat(join(dataRoot, 'recent.sqlite')), { code: 'ENOENT' });
    const stopping = new AbortController(), upgraded = await activate(context(dataRoot, stopping.signal));
    await upgraded.onStop(); stopping.abort(); await upgraded.dispose?.(); await setImmediate();
    const created = new DatabaseSync(join(dataRoot, 'recent.sqlite'), { readOnly: true });
    try { assert.equal(created.prepare('PRAGMA user_version').get().user_version, 1); }
    finally { created.close(); }
    const preserved = new DatabaseSync(path, { readOnly: true });
    try {
      assert.deepEqual(retainedDatabase(preserved), edited);
      assert.deepEqual(retainedDatabase(preserved, before), before);
      verifyUnread(assert, preserved, version);
    } finally { preserved.close(); }
  }
  for (const version of [1, 2, 3, 4, 5, 6]) {
    const dataRoot = join(directory, `incompatible-${version}`), path = join(dataRoot, 'assistant.sqlite');
    await mkdir(dataRoot);
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE messages(id TEXT,raw TEXT); INSERT INTO messages VALUES('original','Retain this draft'); PRAGMA user_version=${version}`);
    old.close();
    const bytes = await readFile(path);
    await assert.rejects(() => activate(context(dataRoot, new AbortController().signal)), /migration|schema|table/i);
    for (const phase of ['preflight', 'apply'])
      assert.throws(() => execFileSync(process.execPath, [migrationEntry, phase, dataRoot], { stdio: 'pipe' }));
    assert.deepEqual(await readFile(path), bytes);
  }
}
