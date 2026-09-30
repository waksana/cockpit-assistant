import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspect, migrate, SCHEMA3_PRESERVE } from '../src/migration.ts';

function root(): string {
  const path = join(process.cwd(), 'node_modules/.cache', `migration-api-${randomUUID()}`);
  mkdirSync(path, { recursive: true }); return path;
}
const schema3 = readFileSync(new URL('../scripts/fixtures/schema3.sql', import.meta.url), 'utf8');
function retained(sql: DatabaseSync) {
  return SCHEMA3_PRESERVE.map(({ table, columns }) =>
    sql.prepare(`SELECT ${columns.map(column => `"${column}"`).join(',')} FROM "${table}" ORDER BY id`).all());
}
test('standalone migration exports preserve every pinned schema-3 column and produce exact JSON receipts', () => {
  const directory = root(), path = join(directory, 'assistant.sqlite');
  try {
    const sql = new DatabaseSync(path);
    sql.exec(schema3);
    for (const { table, columns } of SCHEMA3_PRESERVE)
      assert.deepEqual(sql.prepare(`PRAGMA table_info("${table}")`).all().map(column => column.name), columns);
    sql.prepare('INSERT INTO topics VALUES(?,?,?,?,?,?,?,?,?)').run(
      'topic', 'Original title', 'Original content', 0, 4, 'real-worker', 'bound', null, '{"messageId":"receipt"}');
    sql.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'original', 1, 7, 'user', '  Original human text\n', '[]', null, null, null,
      1000, 0, 0, 'Retained diagnostic', 'input', 'fingerprint', null, null, null, null, 0, '[]');
    sql.prepare('INSERT INTO topic_messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'pending', 'original', 'topic', 'user', 'Do not replay this old pending split', 'real-worker',
      'pending', null, null, null, null, null, null, 1001);
    const before = retained(sql); sql.close();
    const bytes = readFileSync(path);
    assert.deepEqual(inspect(directory), { ok: true, phase: 'preflight', schema: 3, from: 3, to: 4, changed: false });
    assert.deepEqual(readFileSync(path), bytes);
    assert.deepEqual(migrate(directory), { ok: true, phase: 'apply', schema: 4, from: 3, to: 4, changed: true });
    assert.deepEqual(inspect(directory), { ok: true, phase: 'preflight', schema: 4, from: 4, to: 4, changed: false });
    assert.deepEqual(migrate(directory), { ok: true, phase: 'apply', schema: 4, from: 4, to: 4, changed: false });
    const verify = new DatabaseSync(path, { readOnly: true });
    try {
      assert.deepEqual(retained(verify), before);
      assert.equal(JSON.parse(String(verify.prepare('SELECT conversation FROM messages').get()!.conversation)).channel, 'legacy');
      assert.equal(verify.prepare('SELECT count(*) AS n FROM foreground_inputs').get()!.n, 0);
    } finally { verify.close(); }
  } finally { rmSync(directory, { recursive: true }); }
});
test('migration rejects missing/empty storage and linked paths without creating targets', () => {
  const directory = root(), path = join(directory, 'assistant.sqlite');
  try {
    for (const action of [inspect, migrate]) {
      assert.throws(() => action(directory), { code: 'ENOENT' });
      assert.equal(existsSync(path), false);
      assert.throws(() => action('relative'), { code: 'MIGRATION_PATH' });
    }
    const sql = new DatabaseSync(path); sql.close();
    const bytes = readFileSync(path);
    assert.throws(() => inspect(directory), { code: 'MIGRATION_TARGET' });
    assert.throws(() => migrate(directory), { code: 'MIGRATION_TARGET' });
    assert.deepEqual(readFileSync(path), bytes);
    rmSync(path); const source = join(directory, 'other.sqlite');
    const linked = new DatabaseSync(source); linked.exec(schema3); linked.close();
    symlinkSync(source, path);
    assert.throws(() => migrate(directory), { code: 'MIGRATION_TARGET' });
  } finally { rmSync(directory, { recursive: true }); }
});
test('invalid foreign-key storage is rejected by preflight without touching the source', () => {
  const directory = root(), path = join(directory, 'assistant.sqlite');
  try {
    const sql = new DatabaseSync(path); sql.exec(schema3);
    sql.exec('PRAGMA foreign_keys=OFF');
    sql.prepare('INSERT INTO topic_messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'orphan', 'missing-message', 'missing-topic', 'user', 'Original orphan', 'worker',
      'pending', null, null, null, null, null, null, 1000);
    sql.close(); const before = readFileSync(path);
    assert.throws(() => inspect(directory), { code: 'MIGRATION_INTEGRITY' });
    assert.throws(() => migrate(directory), { code: 'MIGRATION_INTEGRITY' });
    assert.deepEqual(readFileSync(path), before);
  } finally { rmSync(directory, { recursive: true }); }
});
