import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspect, migrate } from '../src/upgrade.ts';
import { Store } from '../src/store.ts';
import type { Incoming } from '../src/store.ts';
// @ts-expect-error Independent release fixtures execute directly in Node.
import { preservedSchema, retainedRows, schema3Sql, schema4Sql } from '../scripts/migration-contract.mjs';
// @ts-expect-error Synthetic, pinned old data is not part of the TS runtime.
import { populateLegacy, legacyInbox, verifyUnread } from '../scripts/fixtures/retained-data.mjs';

function root(): string {
  const path = join(process.cwd(), 'node_modules/.cache', `migration-api-${randomUUID()}`);
  mkdirSync(path, { recursive: true });
  return path;
}
function database(directory: string, version: 3 | 4) {
  const sql = new DatabaseSync(join(directory, 'assistant.sqlite'));
  populateLegacy(sql, version);
  return sql;
}
function contents(directory: string) {
  return Object.fromEntries(readdirSync(directory).sort().map(name => [name, readFileSync(join(directory, name))]));
}
const receipt = (phase: 'preflight' | 'apply', from: number, changed = false) => ({
  ok: true, phase, schema: changed ? 5 : from, from, to: 5, changed,
});
for (const version of [3, 4] as const) {
  test(`explicit ${version}-to-5 upgrade preserves every original column, row, mapping and receipt`, () => {
    const directory = root(), path = join(directory, 'assistant.sqlite');
    try {
      const sql = database(directory, version);
      for (const { table, columns } of preservedSchema(version))
        assert.deepEqual(sql.prepare(`PRAGMA table_info("${table}")`).all().map(column => column.name), columns);
      const before = retainedRows(sql, version);
      sql.close();
      const bytes = contents(directory);
      assert.throws(() => new Store(path), { code: 'MIGRATION_REQUIRED' });
      assert.deepEqual(contents(directory), bytes, 'Runtime construction must not perform a hidden upgrade');
      assert.deepEqual(inspect(directory), receipt('preflight', version));
      assert.deepEqual(contents(directory), bytes, 'Preflight must remain read-only');
      assert.deepEqual(migrate(directory), receipt('apply', version, true));
      const upgraded = contents(directory);
      assert.deepEqual(inspect(directory), receipt('preflight', 5));
      assert.deepEqual(migrate(directory), receipt('apply', 5));
      assert.deepEqual(contents(directory), upgraded, 'Repeated apply must not rewrite an upgraded database');
      const verify = new DatabaseSync(path, { readOnly: true });
      try {
        assert.deepEqual(retainedRows(verify, version), before);
        assert.equal(verify.prepare('PRAGMA user_version').get()!.user_version, 5);
        assert.equal(verify.prepare('PRAGMA foreign_key_check').get(), undefined);
        assert.equal(verify.prepare('SELECT count(*) AS n FROM topics WHERE session_id IS NOT NULL').get()!.n, 4);
        assert.equal(verify.prepare("SELECT mapping_state FROM topics WHERE id='topic-unknown'").get()!.mapping_state, 'unknown');
        assert.equal(verify.prepare("SELECT creation_receipt FROM topics WHERE id='topic-calling'").get()!.creation_receipt,
          '{ "createdId": "actual-uncertain-worker", "transport": "lost-ack" }');
        assert.deepEqual(verify.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
        ).all().map(row => row.name), [...preservedSchema(version).map((entry: { table: string }) => entry.table),
          'deliveries', 'mailbox', 'seen'].sort());
        verifyUnread(assert, verify, version);
      } finally { verify.close(); }
    } finally { rmSync(directory, { recursive: true }); }
  });
}

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

test('fresh schema 5 has only four active tables and repeated apply changes nothing', () => {
  const directory = root(), path = join(directory, 'assistant.sqlite');
  try {
    const store = new Store(path);
    try {
      assert.deepEqual(store.sql.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
      ).all().map(row => row.name), ['deliveries', 'mailbox', 'seen', 'topics']);
    } finally { store.close(); }
    const bytes = contents(directory);
    assert.deepEqual(inspect(directory), receipt('preflight', 5));
    assert.deepEqual(migrate(directory), receipt('apply', 5));
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

for (const fault of ['write-error', 'legacy-value', 'unread-value'] as const) {
  test(`transaction rolls back every DDL and row when ${fault} verification fails`, t => {
    const directory = root(), path = join(directory, 'assistant.sqlite');
    const exec = DatabaseSync.prototype.exec;
    try {
      const sql = database(directory, 4), rows = retainedRows(sql, 4); sql.close();
      const bytes = contents(directory);
      const mock = t.mock.method(DatabaseSync.prototype, 'exec', function(this: DatabaseSync, statement: string) {
        exec.call(this, statement);
        if (statement !== 'PRAGMA user_version=5') return;
        if (fault === 'write-error') throw new Error('Synthetic write failure');
        exec.call(this, fault === 'legacy-value'
          ? "UPDATE tool_actions SET result='{\"unexpected\":\"rewrite\"}'"
          : "UPDATE mailbox SET text='Unexpected changed unread body' WHERE sequence=1");
      });
      assert.throws(() => migrate(directory), fault === 'write-error' ? /Synthetic write failure/
        : fault === 'legacy-value' ? /legacy column, row or original value/ : /unconsumed body/);
      mock.mock.restore();
      assert.deepEqual(contents(directory), bytes, 'Failed transactions must leave the original database bytes intact');
      const verify = new DatabaseSync(path, { readOnly: true });
      try {
        assert.deepEqual(retainedRows(verify, 4), rows);
        assert.equal(verify.prepare('PRAGMA user_version').get()!.user_version, 4);
        assert.equal(verify.prepare("SELECT name FROM sqlite_master WHERE name='mailbox'").get(), undefined);
      } finally { verify.close(); }
    } finally { rmSync(directory, { recursive: true }); }
  });
}
