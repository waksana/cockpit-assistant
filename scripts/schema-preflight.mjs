import assert from 'node:assert/strict';
import { mkdir, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { schema3Sql, retainedRows } from './migration-contract.mjs';

export const applicationTables = ['foreground_inputs', 'inbox', 'messages', 'tool_actions', 'topic_messages', 'topics', 'workers'];
export const schemaVersion = 4;
const legacyTables = {
  1: ['topics', 'receptions', 'messages', 'anchors', 'questions', 'work', 'bindings',
    'deliveries', 'publications', 'memories', 'risks', 'routes', 'native', 'operations', 'exposures'],
  2: ['topics', 'messageTopics', 'batches', 'receptions', 'messages', 'questions', 'work',
    'bindings', 'deliveries', 'publications', 'memories', 'native', 'operations'],
  3: ['topics', 'messages', 'sessions', 'effects'],
};

function oldDatabase(path, version) {
  const db = new DatabaseSync(path);
  try {
    for (const name of legacyTables[version]) {
      db.exec(`CREATE TABLE "${name}" (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        document TEXT NOT NULL CHECK(json_valid(document))
      )`);
    }
    if (version !== 3) {
      db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      db.prepare('INSERT INTO meta VALUES (?, ?)').run('fixture', '"synthetic-only"');
    }
    db.prepare('INSERT INTO messages (id, document) VALUES (?, ?)').run(
      'original-fixture', JSON.stringify({ id: 'original-fixture', raw: 'Synthetic original must remain intact' }));
    db.exec(`PRAGMA user_version=${version}`);
  } finally { db.close(); }
}

function context(dataRoot, signal) {
  return {
    moduleId: 'assistant', apiVersion: 1, serviceReadyVersion: 1,
    dataRoot, apiBase: '/_modules/assistant/synthetic-preflight/api',
    config: {}, signal,
    host: {
      chatReadVersion: 1, askResponseVersion: 1, resourcePreparationVersion: 1,
      roleAssignmentVersion: 1, sessionDirectoryVersion: 1, sessionLoadVersion: 1,
      promptReceiptVersion: 1,
      toolScopeVersion: 1,
      async call() { throw new Error('Package schema preflight must not call the Host'); },
    },
    report(error) { throw error; },
    publish() {}, invalidate() {},
  };
}

export async function verifySchemaBoundary(activate, directory, migrationEntry) {
  const fresh = join(directory, 'fresh');
  await mkdir(fresh);
  const stop = new AbortController();
  const backend = await activate(context(fresh, stop.signal));
  try {
    const db = new DatabaseSync(join(fresh, 'assistant.sqlite'), { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, schemaVersion);
      assert.deepEqual(db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all().map(row => row.name), applicationTables);
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='view'").get().n, 0);
    } finally { db.close(); }
  } finally {
    stop.abort();
    backend.dispose?.();
    await setImmediate();
  }

  const upgradeRoot = join(directory, 'retained-schema3');
  await mkdir(upgradeRoot);
  const upgradePath = join(upgradeRoot, 'assistant.sqlite');
  let previous;
  const legacy = new DatabaseSync(upgradePath);
  try {
    legacy.exec(schema3Sql);
    legacy.prepare('INSERT INTO topics VALUES(?,?,?,?,?,?,?,?,?)').run(
      'old-topic', 'Existing topic', 'Keep its real worker', 0, 3, 'old-session', 'bound', null,
      JSON.stringify({ sessionId: 'old-session' }));
    legacy.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'old-user', 1, 7, 'user', '  Existing original\n', '[]', null, null, null,
      1000, 1, 0, null, 'old-input', 'original-fingerprint', null, null, null, null, 0, '[]');
    legacy.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'old-question', 2, 8, 'ask', 'Existing unanswered question?', '[]', 'old-session', null, null,
      1100, 0, 0, null, null, null, 'old-native-request', null, 1, 'pending', 1, '[]');
    legacy.prepare('INSERT INTO topic_messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'old-dispatch', 'old-user', 'old-topic', 'user', 'Previously accepted prompt',
      'old-session', 'accepted', 'prompt', null, null, 'old-receipt',
      JSON.stringify({ ok: true, messageId: 'old-receipt' }), null, 1001);
    previous = retainedRows(legacy);
  } finally { legacy.close(); }
  const beforePreflight = await readFile(upgradePath);
  const migrate = phase => JSON.parse(execFileSync(process.execPath,
    [migrationEntry, phase, upgradeRoot], { encoding: 'utf8' }));
  assert.deepEqual(migrate('preflight'), { ok: true, phase: 'preflight', schema: 3, from: 3, to: 4, changed: false });
  assert.deepEqual(await readFile(upgradePath), beforePreflight, 'Preflight must not modify the source database');
  assert.deepEqual(migrate('apply'), { ok: true, phase: 'apply', schema: 4, from: 3, to: 4, changed: true });
  assert.deepEqual(migrate('apply'), { ok: true, phase: 'apply', schema: 4, from: 4, to: 4, changed: false });
  const upgraded = new DatabaseSync(upgradePath, { readOnly: true });
  try {
    assert.deepEqual(retainedRows(upgraded), previous, 'Every schema-3 field, mapping and receipt must be preserved');
    assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 4);
    assert.equal(upgraded.prepare('PRAGMA foreign_key_check').get(), undefined);
    assert.ok(upgraded.prepare('SELECT conversation FROM messages').all()
      .every(row => JSON.parse(row.conversation).channel === 'legacy'));
  } finally { upgraded.close(); }

  for (const version of [1, 2, 3]) {
    const root = join(directory, `incompatible-${version}`);
    await mkdir(root);
    const path = join(root, 'assistant.sqlite');
    oldDatabase(path, version);
    const before = await readFile(path);
    const controller = new AbortController();
    try {
      await assert.rejects(() => activate(context(root, controller.signal)), /schema|table/i);
    } finally {
      controller.abort();
      await setImmediate();
    }
    assert.deepEqual(await readFile(path), before, `Rejected schema ${version} must remain byte-identical`);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      await assert.rejects(access(`${path}${suffix}`), { code: 'ENOENT' });
    }
  }
}
