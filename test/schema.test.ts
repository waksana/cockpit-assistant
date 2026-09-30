import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Database } from '../src/database.ts';
import { fixture, stageDelivery } from './fixtures.ts';

const directory = () => {
  const path = join(process.cwd(), 'node_modules/.cache', `assistant-schema-${randomUUID()}`);
  mkdirSync(path, { recursive: true }); return path;
};
test('schema 3 has exactly three structured application tables and constrained associations', () => {
  const f = fixture();
  try {
    assert.deepEqual(f.db.sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all().map(row => row.name), ['messages','topic_messages','topics']);
    for (const name of ['messages','topic_messages','topics']) {
      assert.equal(f.db.sql.prepare(`PRAGMA table_info(${name})`).all().some(row => row.name === 'document'), false);
    }
    const rows = stageDelivery(f).topicMessages;
    assert.throws(() => f.db.put('topic_messages', { ...rows[0]!, id: 'duplicate' }), /UNIQUE/);
    assert.throws(() => f.db.put('topic_messages', { ...rows[0]!, id: 'invalid-session',
      topicId: 'missing', origin: 'session', state: null }), /origin and source identity/);
    assert.throws(() => f.db.put('topic_messages', { ...rows[0]!, id: 'invalid-prompt', prompt: null }), /CHECK/);
  } finally { f.close(); }
});
for (const version of [0,1,2,3]) test(`existing incompatible schema ${version} is rejected without touching data or creating anything`, () => {
  const root = directory(), path = join(root, 'old.sqlite');
  try {
    const sql = new DatabaseSync(path);
    sql.exec(`CREATE TABLE messages(id TEXT PRIMARY KEY, document TEXT); INSERT INTO messages VALUES('sentinel','original');
      CREATE TABLE topics(id TEXT PRIMARY KEY, document TEXT); PRAGMA user_version=${version}`);
    if (version === 3) sql.exec('CREATE TABLE sessions(id TEXT); CREATE TABLE effects(id TEXT)');
    sql.close();
    const before = readFileSync(path);
    assert.throws(() => new Database(path), /requires|must exactly match/);
    assert.deepEqual(readFileSync(path), before);
    const verify = new DatabaseSync(path);
    assert.equal(verify.prepare('PRAGMA user_version').get()!.user_version, version);
    assert.equal(verify.prepare('SELECT document FROM messages').get()!.document, 'original');
    assert.equal(verify.prepare("SELECT name FROM sqlite_master WHERE name='topic_messages'").get(), undefined);
    verify.close();
  } finally { rmSync(root, { recursive: true }); }
});
test('schema 3 with the right table names but wrong columns is strictly rejected', () => {
  const root = directory(), path = join(root, 'wrong.sqlite');
  try {
    const sql = new DatabaseSync(path);
    sql.exec('CREATE TABLE messages(id TEXT); CREATE TABLE topic_messages(id TEXT); CREATE TABLE topics(id TEXT); PRAGMA user_version=3');
    sql.close();
    const before = readFileSync(path);
    assert.throws(() => new Database(path), /must exactly match/);
    assert.deepEqual(readFileSync(path), before);
  } finally { rmSync(root, { recursive: true }); }
});
for (const mode of [null, 'prompt'] as const) test(`compatible database preserves originals and does not repeat crashed ${mode ?? 'load preparation'}`, async () => {
  const root = directory(), path = join(root, 'new.sqlite');
  let f = fixture(path);
  try {
    const result = stageDelivery(f);
    f.db.put('topic_messages', { ...result.topicMessages[0]!, state: 'calling', sessionId: 's1', mode });
    f.close();
    f = fixture(path);
    f.service.recover();
    const row = f.db.topicMessages(result.message.id)[0]!;
    assert.equal(row.state, 'unknown');
    assert.equal(f.db.must('messages', result.message.id).raw, 'Original compound input');
    assert.equal(f.db.must('messages', result.message.id).processed, true);
    assert.throws(() => f.db.put('topic_messages', { ...row, state: 'pending' }), /cannot be repeated/);
    f.metas.get('s1')!.loaded = false;
    await f.runtime.start();
    assert.equal(f.calls.some(call => call.name === 'session/load' || call.name === 'prompt'), false);
    assert.ok(f.errors.some(error => (error as { topicMessageId?: string }).topicMessageId === row.id));
  } finally { f.close(); rmSync(root, { recursive: true }); }
});
