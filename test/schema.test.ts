import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Database, fingerprint, inspectSchema, legacyDefinitions, migrateSchema4 } from '../src/database.ts';
import { fixture, stageDelivery } from './fixtures.ts';

test('exact schema 3 migration preserves every legacy row, receipt, raw and mapping', async () => {
  const root = join(process.cwd(), 'node_modules/.cache', `schema4-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const path = join(root, 'assistant.sqlite'), sql = new DatabaseSync(path);
  try {
    for (const definition of Object.values(legacyDefinitions)) sql.exec(definition);
    sql.exec('PRAGMA user_version=3');
    const history = [{ id: 'clarification', question: 'Original?', choices: ['yes'], allowFreeform: false,
      createdAt: 2, answer: null, answeredAt: null, requestId: null }];
    sql.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'legacy', 1, 1, 'user', '  Original\ncompound text ', '[]', null, null, null, 1, 0, 0, null,
      'old-input', fingerprint({ requestId: 'old-input', text: '  Original\ncompound text ', attachments: [] }),
      null, null, null, null, 0, JSON.stringify(history));
    sql.prepare('INSERT INTO topics VALUES(?,?,?,?,?,?,?,?,?)').run('topic', 'Old', 'Content', 0, 1, 's1', 'bound', null, '{"native":"receipt"}');
    sql.prepare('INSERT INTO topic_messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'old-send', 'legacy', 'topic', 'user', 'Old faithful split', 's1', 'pending', null, null, null, null, null, null, 2);
    const before = Object.fromEntries(['messages', 'topics', 'topic_messages'].map(table =>
      [table, sql.prepare(`SELECT * FROM ${table}`).all()]));
    assert.equal(inspectSchema(sql), 3);
    assert.deepEqual(migrateSchema4(sql), { from: 3, to: 4, changed: true });
    assert.deepEqual(migrateSchema4(sql), { from: 4, to: 4, changed: false });
    for (const table of ['messages', 'topics', 'topic_messages']) {
      const rows = sql.prepare(`SELECT * FROM ${table}`).all();
      if (table === 'messages') for (const row of rows) delete row.conversation;
      assert.deepEqual(rows, before[table]);
    }
    assert.equal(sql.prepare('SELECT count(*) AS n FROM foreground_inputs').get()!.n, 0);
    sql.close();
    const f = fixture(path);
    try {
      await f.runtime.start();
      assert.equal(f.calls.some(c => ['prompt', 'session/new', 'respondAsk'].includes(c.name)), false);
      assert.equal(f.db.must('topic_messages', 'old-send').state, 'pending');
      assert.equal(f.db.must('messages', 'legacy').processed, false);
      assert.equal(f.service.receipt(f.db.input('old-input')!).topicMessages[0]!.id, 'old-send');
    } finally { f.close(); }
  } finally { try { sql.close(); } catch {} rmSync(root, { recursive: true }); }
});
test('schema inspection rejects unexpected targets without writes and migration refuses missing targets', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    assert.throws(() => migrateSchema4(sql), { code: 'MIGRATION_TARGET' });
    sql.exec('CREATE TABLE messages(id TEXT); PRAGMA user_version=3');
    assert.throws(() => inspectSchema(sql), { code: 'SCHEMA_TABLES' });
  } finally { sql.close(); }
});
test('incompatible storage is byte-preserved by constructor preflight', () => {
  const root = join(process.cwd(), 'node_modules/.cache', `schema-reject-${randomUUID()}`);
  mkdirSync(root, { recursive: true }); const path = join(root, 'old.sqlite');
  try {
    const sql = new DatabaseSync(path);
    sql.exec("CREATE TABLE messages(id TEXT,document TEXT); INSERT INTO messages VALUES('sentinel','raw'); PRAGMA user_version=2"); sql.close();
    const before = readFileSync(path);
    assert.throws(() => new Database(path), { code: 'SCHEMA_VERSION' });
    assert.deepEqual(readFileSync(path), before);
  } finally { rmSync(root, { recursive: true }); }
});
test('new dispatch preserves relational uniqueness and unknown calls never recover to pending', async () => {
  const f = fixture();
  try {
    assert.equal(inspectSchema(f.db.sql), 4);
    const delivery = stageDelivery(f), row = delivery.topicMessages[0]!;
    assert.throws(() => f.db.put('topic_messages', { ...row, id: 'duplicate' }), /UNIQUE/);
    f.db.put('topic_messages', { ...row, state: 'calling' });
    f.service.recover();
    const unknown = f.db.must('topic_messages', row.id);
    assert.equal(unknown.state, 'unknown');
    assert.throws(() => f.db.put('topic_messages', { ...unknown, state: 'pending' }), { code: 'TERMINAL_SEND' });
    await f.runtime.start();
    assert.equal(f.calls.some(c => c.name === 'prompt'), false);
  } finally { f.close(); }
});
