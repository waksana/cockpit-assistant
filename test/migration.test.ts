import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { inspect, migrate } from '../src/upgrade.ts';
import { legacySchemas } from '../src/legacy-schema.ts';
import { Store } from '../src/store.ts';
import type { Incoming } from '../src/store.ts';
// @ts-expect-error Independent release fixtures execute directly in Node.
import { preservedSchema, retainedRows, retainedDatabase, schema3Sql, schema4Sql, schema5Sql } from '../scripts/migration-contract.mjs';
// @ts-expect-error Synthetic, pinned old data is not part of the TS runtime.
import { populateLegacy, populateArchivedSchema5, legacyInbox, verifyUnread, verifyWatches } from '../scripts/fixtures/retained-data.mjs';

function root(): string {
  const path = join(process.cwd(), 'node_modules/.cache', `migration-api-${randomUUID()}`);
  mkdirSync(path, { recursive: true });
  return path;
}
function database(directory: string, version: 3 | 4 | 5) {
  const sql = new DatabaseSync(join(directory, 'assistant.sqlite'));
  populateLegacy(sql, version);
  return sql;
}
function contents(directory: string) {
  return Object.fromEntries(readdirSync(directory).sort().map(name => [name, readFileSync(join(directory, name))]));
}
const receipt = (phase: 'preflight' | 'apply', from: number, changed = false) => ({
  ok: true, phase, schema: changed ? 6 : from, from, to: 6, changed,
});

test('schema 3/4/5 fingerprints are independently pinned to the published SQL fixtures', () => {
  for (const [version, definition] of [[3, schema3Sql], [4, schema4Sql], [5, schema5Sql]] as const) {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(definition);
      const objects = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all();
      const hash = createHash('sha256').update(JSON.stringify(objects.map(row =>
        [row.type, row.name, String(row.sql).replace(/\s+/g, ' ').trim()]))).digest('hex');
      assert.equal(hash, legacySchemas[version].fingerprint);
      assert.deepEqual(preservedSchema(version).map((entry: { table: string }) => entry.table), legacySchemas[version].tables);
    } finally { db.close(); }
  }
});

for (const version of [3, 4, 5] as const) {
  test(`explicit ${version}-to-6 upgrade preserves every original column, row, mapping and receipt`, () => {
    const directory = root(), path = join(directory, 'assistant.sqlite');
    try {
      const sql = database(directory, version);
      for (const { table, columns } of preservedSchema(version))
        assert.deepEqual(sql.prepare(`PRAGMA table_info("${table}")`).all().map(column => column.name), columns);
      const before = retainedDatabase(sql);
      sql.close();
      const bytes = contents(directory);
      assert.throws(() => new Store(path), { code: 'MIGRATION_REQUIRED' });
      assert.deepEqual(contents(directory), bytes, 'Runtime construction must not perform a hidden upgrade');
      assert.deepEqual(inspect(directory), receipt('preflight', version));
      assert.deepEqual(contents(directory), bytes, 'Preflight must remain read-only');
      assert.deepEqual(migrate(directory), receipt('apply', version, true));
      const upgraded = contents(directory);
      assert.deepEqual(inspect(directory), receipt('preflight', 6));
      assert.deepEqual(migrate(directory), receipt('apply', 6));
      assert.deepEqual(contents(directory), upgraded, 'Repeated apply must not rewrite an upgraded database');
      const verify = new DatabaseSync(path, { readOnly: true });
      try {
        assert.deepEqual(retainedDatabase(verify, before), before);
        assert.equal(verify.prepare('PRAGMA user_version').get()!.user_version, 6);
        assert.equal(verify.prepare('PRAGMA foreign_key_check').get(), undefined);
        assert.equal(verify.prepare('SELECT count(*) AS n FROM topics WHERE session_id IS NOT NULL').get()!.n, 6);
        assert.equal(verify.prepare("SELECT mapping_state FROM topics WHERE id='topic-unknown'").get()!.mapping_state, 'unknown');
        assert.equal(verify.prepare("SELECT creation_receipt FROM topics WHERE id='topic-calling'").get()!.creation_receipt,
          '{ "createdId": "actual-uncertain-worker", "transport": "lost-ack" }');
        assert.deepEqual(verify.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
        ).all().map(row => row.name), [...new Set([...preservedSchema(version).map((entry: { table: string }) => entry.table),
          'deliveries', 'mailbox', 'seen', 'watches'])].sort());
        verifyUnread(assert, verify, version);
        verifyWatches(assert, verify);
      } finally { verify.close(); }
    } finally { rmSync(directory, { recursive: true }); }
  });
}

for (const archive of [null, 3, 4] as const) {
  test(`schema 5${archive ? ` with schema-${archive} archive` : ''} imports watches once and never resets later edits`, () => {
    const directory = root(), path = join(directory, 'assistant.sqlite');
    try {
      const source = new DatabaseSync(path);
      if (archive) populateArchivedSchema5(source, archive);
      else populateLegacy(source, 5);
      const before = retainedDatabase(source); source.close();
      assert.deepEqual(migrate(directory), receipt('apply', 5, true));
      const edited = new Store(path);
      let after;
      try {
        verifyWatches(assert, edited.sql);
        assert.deepEqual(edited.watch('business-session-1'), {
          session_id: 'business-session-1', enabled: true, version: 1, updated_at: 0,
        });
        assert.equal(edited.managed('business-session-4'), true, 'Archived topics were managed by the old runtime');
        assert.deepEqual(retainedDatabase(edited.sql, before), before, 'Schema 5 active tables and all older archives are immutable');
        edited.transaction(() => {
          edited.saveWatch({ session_id: 'business-session-1', enabled: false, version: 11, updated_at: 3456 });
          edited.sql.exec("DELETE FROM watches WHERE session_id='business-session-2'");
          edited.saveWatch({ session_id: 'explicit-native-session', enabled: true, version: 3, updated_at: 3457 });
        });
        assert.equal(edited.managed('business-session-1'), false);
        assert.equal(edited.managed('explicit-native-session'), true);
        after = retainedDatabase(edited.sql);
      } finally { edited.close(); }
      const bytes = contents(directory);
      for (let i = 0; i < 2; i++) {
        assert.deepEqual(inspect(directory), receipt('preflight', 6));
        assert.deepEqual(migrate(directory), receipt('apply', 6));
        assert.deepEqual(contents(directory), bytes);
      }
      const checked = new Store(path);
      try {
        assert.equal(checked.managed('business-session-1'), false);
        assert.deepEqual(checked.watch('business-session-1'), {
          session_id: 'business-session-1', enabled: false, version: 11, updated_at: 3456,
        });
        assert.equal(checked.watch('business-session-2'), null);
        assert.equal(checked.managed('explicit-native-session'), true);
        assert.deepEqual(retainedDatabase(checked.sql), after);
        assert.deepEqual(retainedDatabase(checked.sql, before), before);
        verifyUnread(assert, checked.sql, 5);
      } finally { checked.close(); }
    } finally { rmSync(directory, { recursive: true }); }
  });
}

test('schema-5 migration preserves rowids, exact non-UTF8 text/blob bytes and the mailbox sequence high-water mark', () => {
  const directory = root(), path = join(directory, 'assistant.sqlite');
  try {
    const source = database(directory, 5);
    source.exec(`UPDATE topics SET content=CAST(X'ff00fe0d0a' AS TEXT),rowid=9223372036854775807 WHERE id='topic-shared';
      UPDATE seen SET rowid=-13 WHERE id='retained-bytes'`);
    const before = retainedDatabase(source); source.close();
    migrate(directory);
    const checked = new DatabaseSync(path, { readOnly: true });
    try {
      assert.deepEqual(retainedDatabase(checked, before), before);
      assert.equal(checked.prepare("SELECT hex(content) AS bytes FROM topics WHERE id='topic-shared'").get()!.bytes, 'FF00FE0D0A');
      assert.equal(checked.prepare("SELECT seq FROM sqlite_sequence WHERE name='mailbox'").get()!.seq, 9001);
    } finally { checked.close(); }
  } finally { rmSync(directory, { recursive: true }); }
});

test('schema-4 unread is readable once; consumed and migrated native identities cannot re-enter or notify', () => {
  const directory = root(), path = join(directory, 'assistant.sqlite');
  try {
    const old = database(directory, 4); old.close();
    migrate(directory);
    const store = new Store(path);
    try {
      const archive = retainedRows(store.sql, 4);
      verifyUnread(assert, store.sql, 4);
      const items: Incoming[] = legacyInbox.map((item: {
        sessionId: string; nativeId: string; kind: string; body: string | null;
        attachments: Incoming['attachments'] | null; question: Incoming['question'];
      }) => ({
        session_id: item.sessionId, native_id: item.nativeId, kind: item.kind === 'result' ? 'reply' : 'ask',
        text: item.body ?? 'A consumed original must never be restored', attachments: item.attachments ?? [],
        question: item.question ?? (item.kind === 'ask' ? {
          requestId: item.nativeId, question: 'A consumed original must never be restored',
        } : null),
      }));
      for (const item of items) assert.equal(store.enqueue(item), false);
      assert.throws(() => store.enqueue({ ...items[0]!, text: 'Changed unread original' }), { code: 'NATIVE_ID_CONFLICT' });
      assert.equal(store.reserveNotice(), null, 'Migration must not schedule notifications or business work');
      const expected = store.inbox();
      assert.equal(expected.length, legacyInbox.filter((item: { body: string | null }) => item.body !== null).length);
      assert.deepEqual(store.inbox(), expected, 'Listing preserved rows does not consume them');
      store.transaction(() => store.removeResolved(expected.map(item => item.id)));
      assert.deepEqual(store.inbox(), [], 'Handled legacy rows leave the active inbox');
      assert.equal(store.sql.prepare('SELECT COUNT(*) AS count FROM mailbox').get()!.count, expected.length,
        'Original legacy bodies remain in-place as inert history, never copied into a new mirror');
      store.removeResolved(expected.map(item => item.id));
      assert.deepEqual(store.inbox(), []);
      for (const item of items) assert.equal(store.enqueue(item), false);
      assert.equal(store.reserveNotice(), null);
      assert.deepEqual(retainedRows(store.sql, 4), archive, 'Active operations never rewrite the old inbox or other archives');
    } finally { store.close(); }
  } finally { rmSync(directory, { recursive: true }); }
});

test('fresh schema 6 creates an empty watch registry and repeated apply changes nothing', () => {
  const directory = root(), path = join(directory, 'assistant.sqlite');
  try {
    const store = new Store(path);
    try {
      assert.deepEqual(store.sql.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
      ).all().map(row => row.name), ['deliveries', 'mailbox', 'seen', 'topics', 'watches']);
      assert.equal(store.sql.prepare('SELECT count(*) AS n FROM watches').get()!.n, 0);
      assert.equal(store.managed('unregistered-native-session'), false);
    } finally { store.close(); }
    const bytes = contents(directory);
    assert.deepEqual(inspect(directory), receipt('preflight', 6));
    assert.deepEqual(migrate(directory), receipt('apply', 6));
    assert.deepEqual(contents(directory), bytes);
  } finally { rmSync(directory, { recursive: true }); }
});

test('migration rejects missing, empty and linked storage without creating targets', () => {
  const directory = root(), path = join(directory, 'assistant.sqlite');
  try {
    for (const action of [inspect, migrate]) {
      assert.throws(() => action(directory), { code: 'ENOENT' });
      assert.equal(existsSync(path), false);
      assert.throws(() => action('relative'), { code: 'MIGRATION_PATH' });
    }
    const sql = new DatabaseSync(path); sql.close();
    const bytes = contents(directory);
    for (const action of [inspect, migrate]) assert.throws(() => action(directory), { code: 'MIGRATION_TARGET' });
    assert.deepEqual(contents(directory), bytes);
    rmSync(path);
    const source = join(directory, 'other.sqlite'), linked = new DatabaseSync(source);
    linked.exec(schema3Sql); linked.close();
    symlinkSync(source, path);
    for (const action of [inspect, migrate]) assert.throws(() => action(directory), { code: 'MIGRATION_TARGET' });
    const linkedRoot = join(directory, 'linked-root');
    symlinkSync(directory, linkedRoot);
    for (const action of [inspect, migrate]) assert.throws(() => action(linkedRoot), { code: 'MIGRATION_PATH' });
  } finally { rmSync(directory, { recursive: true }); }
});

test('unpublished schemas, altered constraints, indexes, extra drafts and triggers are rejected unchanged', () => {
  const watchTable = `CREATE TABLE watches (session_id TEXT PRIMARY KEY NOT NULL,
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), version INTEGER NOT NULL CHECK(version > 0), updated_at INTEGER NOT NULL)`;
  const invalid = [
    ...[1, 2, 0, 99].map(version => `CREATE TABLE old_draft(id TEXT, body TEXT);
      INSERT INTO old_draft VALUES('someone-else','Keep this draft'); PRAGMA user_version=${version}`),
    'CREATE TABLE topics(id TEXT); CREATE TABLE messages(id TEXT); CREATE TABLE sessions(id TEXT); CREATE TABLE effects(id TEXT); PRAGMA user_version=3',
    `${schema3Sql} ALTER TABLE topics ADD COLUMN new_draft TEXT`,
    schema4Sql.replace(/ALTER TABLE messages ADD COLUMN conversation[^\n]+\n/, ''),
    `${schema4Sql} ALTER TABLE inbox ADD COLUMN draft TEXT`,
    `${schema4Sql} DROP INDEX messages_revision`,
    `${schema4Sql} CREATE TABLE someone_elses_draft(id TEXT,body TEXT); INSERT INTO someone_elses_draft VALUES('draft','Must survive')`,
    `${schema4Sql} CREATE VIEW altered AS SELECT * FROM messages`,
    `${schema4Sql} CREATE TRIGGER changed AFTER INSERT ON inbox BEGIN DELETE FROM messages; END`,
    `${schema4Sql} CREATE TABLE sqliteExtraDraft(body TEXT); INSERT INTO sqliteExtraDraft VALUES('Keep me')`,
    schema5Sql.replace("CHECK(state IN ('calling','accepted','rejected','unknown'))", ''),
    `${schema5Sql} ALTER TABLE seen ADD COLUMN checkpoint TEXT`,
    `${schema5Sql} DROP TABLE deliveries`,
    `${schema5Sql} CREATE INDEX unexpected ON seen(created_at)`,
    `${schema5Sql} CREATE VIEW unexpected AS SELECT * FROM mailbox`,
    `${schema5Sql} CREATE TRIGGER changed AFTER INSERT ON seen BEGIN DELETE FROM topics; END`,
    `${schema5Sql} ${watchTable}`,
    `${schema5Sql} PRAGMA user_version=6`,
    `${schema5Sql} ${watchTable.replace('CHECK(version > 0)', 'CHECK(version >= 0)')}; PRAGMA user_version=6`,
    `${schema5Sql} ${watchTable}; PRAGMA user_version=6; CREATE INDEX unexpected ON watches(enabled)`,
    `${schema5Sql} ${watchTable}; PRAGMA user_version=6; CREATE TRIGGER watches AFTER INSERT ON seen BEGIN DELETE FROM topics; END`,
  ];
  for (const definition of invalid) {
    const directory = root(), path = join(directory, 'assistant.sqlite');
    try {
      const sql = new DatabaseSync(path); sql.exec(definition); sql.close();
      const before = contents(directory);
      for (const action of [inspect, migrate]) assert.throws(() => action(directory), /schema|layout/i);
      assert.deepEqual(contents(directory), before);
    } finally { rmSync(directory, { recursive: true }); }
  }
});

test('nonempty WALs and journals or linked SQLite sidecars are refused without touching the source', () => {
  const directory = root(), path = join(directory, 'assistant.sqlite');
  try {
    const sql = new DatabaseSync(path);
    try {
      sql.exec('PRAGMA journal_mode=WAL');
      populateLegacy(sql, 5);
      const before = contents(directory);
      for (const action of [inspect, migrate]) assert.throws(() => action(directory), { code: 'MIGRATION_WAL' });
      assert.deepEqual(contents(directory), before);
    } finally { sql.close(); }
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const sidecar = `${path}${suffix}`;
      symlinkSync(join(directory, 'missing-sidecar'), sidecar);
      try {
        const bytes = readFileSync(path);
        for (const action of [inspect, migrate]) assert.throws(() => action(directory), { code: 'MIGRATION_PATH' });
        assert.deepEqual(readFileSync(path), bytes);
      } finally { rmSync(sidecar); }
    }
    writeFileSync(`${path}-journal`, 'Uncheckpointed rollback journal');
    const before = contents(directory);
    for (const action of [inspect, migrate]) assert.throws(() => action(directory), { code: 'MIGRATION_WAL' });
    assert.deepEqual(contents(directory), before);
  } finally { rmSync(directory, { recursive: true }); }
});

test('preflight of a checkpointed schema 5 leaves the database and empty WAL byte-for-byte unchanged', () => {
  const directory = root(), path = join(directory, 'assistant.sqlite');
  try {
    const sql = database(directory, 5); sql.close();
    writeFileSync(`${path}-wal`, '');
    const before = contents(directory);
    assert.deepEqual(inspect(directory), receipt('preflight', 5));
    assert.deepEqual(contents(directory), before);
  } finally { rmSync(directory, { recursive: true }); }
});

test('invalid foreign keys and malformed unread content are refused before any write', () => {
  for (const mutate of [
    (sql: DatabaseSync) => {
      sql.exec('PRAGMA foreign_keys=OFF');
      sql.prepare('INSERT INTO topic_messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        'orphan', 'missing-message', 'missing-topic', 'user', 'Original orphan', 'worker',
        'pending', null, null, null, null, null, null, 1000);
    },
    (sql: DatabaseSync) => sql.exec(`UPDATE inbox SET payload=json_set(payload,'$.body',23) WHERE rowid=1`),
    (sql: DatabaseSync) => sql.exec(`UPDATE inbox SET payload=json_set(payload,'$.attachments',json('[{"type":"unknown"}]')) WHERE rowid=1`),
    (sql: DatabaseSync) => sql.exec(`UPDATE inbox SET payload=json_set(payload,'$.question.requestId','changed-question') WHERE rowid=2`),
    (sql: DatabaseSync) => sql.exec(`INSERT INTO inbox SELECT 'duplicate',json_set(payload,'$.id','duplicate') FROM inbox WHERE rowid=1`),
  ]) {
    const directory = root();
    try {
      const sql = database(directory, 4); mutate(sql); sql.close();
      const before = contents(directory);
      for (const action of [inspect, migrate]) assert.throws(() => action(directory));
      assert.deepEqual(contents(directory), before);
    } finally { rmSync(directory, { recursive: true }); }
  }
});

for (const [version, fault] of [
  [4, 'write-error'], [4, 'legacy-value'], [4, 'unread-value'],
  [5, 'write-error'], [5, 'legacy-value'], [5, 'sequence-value'], [5, 'watch-value'], [5, 'text-bytes'],
] as const) {
  test(`schema ${version} transaction rolls back every DDL and row when ${fault} verification fails`, t => {
    const directory = root(), path = join(directory, 'assistant.sqlite');
    const exec = DatabaseSync.prototype.exec;
    try {
      const sql = database(directory, version);
      if (fault === 'text-bytes') sql.exec("UPDATE topics SET content=CAST(X'80' AS TEXT) WHERE id='topic-1'");
      const rows = retainedDatabase(sql); sql.close();
      const bytes = contents(directory);
      const mock = t.mock.method(DatabaseSync.prototype, 'exec', function(this: DatabaseSync, statement: string) {
        exec.call(this, statement);
        if (statement !== 'PRAGMA user_version=6') return;
        if (fault === 'write-error') throw new Error('Synthetic write failure');
        const mutations = {
          'legacy-value': version === 4 ? "UPDATE tool_actions SET result='{\"unexpected\":\"rewrite\"}'"
            : "UPDATE seen SET fingerprint='Unexpected lost evidence' WHERE id='foreground-wake'",
          'unread-value': "UPDATE mailbox SET text='Unexpected changed unread body' WHERE sequence=1",
          'sequence-value': "UPDATE sqlite_sequence SET seq=99 WHERE name='mailbox'",
          'watch-value': "UPDATE watches SET enabled=0 WHERE session_id='business-session-1'",
          'text-bytes': "UPDATE topics SET content=CAST(X'81' AS TEXT) WHERE id='topic-1'",
        };
        exec.call(this, mutations[fault]);
      });
      assert.throws(() => migrate(directory), fault === 'write-error' ? /Synthetic write failure/
        : fault === 'unread-value' ? /unconsumed body/
          : fault === 'watch-value' ? /distinct nonempty topic session IDs/ : /legacy column, row or original value/);
      mock.mock.restore();
      assert.deepEqual(contents(directory), bytes, 'Failed transactions must leave the original database bytes intact');
      const verify = new DatabaseSync(path, { readOnly: true });
      try {
        assert.deepEqual(retainedDatabase(verify), rows);
        assert.equal(verify.prepare('PRAGMA user_version').get()!.user_version, version);
        assert.equal(verify.prepare("SELECT name FROM sqlite_master WHERE name='watches'").get(), undefined);
        if (version === 4) assert.equal(verify.prepare("SELECT name FROM sqlite_master WHERE name='mailbox'").get(), undefined);
      } finally { verify.close(); }
    } finally { rmSync(directory, { recursive: true }); }
  });
}
