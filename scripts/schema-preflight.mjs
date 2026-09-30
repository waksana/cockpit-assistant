import assert from 'node:assert/strict';
import { mkdir, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';

export const applicationTables = ['messages', 'topic_messages', 'topics'];
export const schemaVersion = 3;
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
      async call() { throw new Error('Package schema preflight must not call the Host'); },
    },
    report(error) { throw error; },
    publish() {}, invalidate() {},
  };
}

export async function verifySchemaBoundary(activate, directory) {
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
