import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, definitions, type Incoming, type Topic } from '../src/store.ts';

const incoming = (id: string): Incoming => ({ session_id: 'worker', native_id: id,
  kind: 'reply', text: `Result ${id}`, attachments: [{ type: 'file', path: '/synthetic/file' }], question: null });
const topic = (id = 'topic'): Topic => ({ id, title: id, content: 'A topic', archived: false, version: 1,
  session_id: 'worker', mapping_state: 'bound', mapping_error: null, creation_receipt: null });
test('fresh storage has only the small active model, never message mirrors or presentation state', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const tables = store.sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(row => row.name);
  assert.deepEqual(tables, Object.keys(definitions).sort());
  assert.equal(store.sql.prepare('PRAGMA user_version').get()!.user_version, 5);
});
test('opening old or incompatible data fails read-only without creating a replacement schema', () => {
  const root = mkdtempSync(join(tmpdir(), 'assistant-old-store-')), path = join(root, 'assistant.sqlite');
  try {
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE legacy(value TEXT); INSERT INTO legacy VALUES('Retain me'); PRAGMA user_version=4");
    db.close();
    const before = readFileSync(path);
    assert.throws(() => new Store(path), { code: 'MIGRATION_REQUIRED' });
    assert.deepEqual(readFileSync(path), before);
  } finally { rmSync(root, { recursive: true }); }
});
test('legacy delivery rows remain inert and do not register an unrelated session', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.saveTopic(topic());
  store.sql.exec(`INSERT INTO deliveries VALUES('old','front','input','topic','hash','old-target','calling',NULL,NULL,NULL,NULL,NULL,1)`);
  const before = store.sql.prepare('SELECT * FROM deliveries').all();
  store.recover();
  assert.deepEqual(store.sql.prepare('SELECT * FROM deliveries').all(), before);
  assert.equal(store.managed('old-target'), false);
  assert.equal(store.managed('worker'), true);
});
test('listing does not consume and exact resolution leaves later arrivals intact', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (const id of ['a', 'b']) store.enqueue(incoming(id));
  const first = store.inbox().slice(0, 1);
  assert.deepEqual(first.map(row => row.native_id), ['a']);
  assert.equal(store.inbox().length, 2);
  store.enqueue(incoming('c'));
  store.removeResolved(first.map(row => row.id));
  store.removeResolved(first.map(row => row.id));
  assert.deepEqual(store.inbox().map(row => row.native_id), ['b', 'c']);
  const second = store.inbox();
  assert.deepEqual(second.map(row => row.native_id), ['b', 'c']);
  store.removeResolved(second.map(row => row.id));
  assert.deepEqual(store.inbox(), []);
  assert.equal(store.enqueue(incoming('a')), false);
  assert.equal(JSON.stringify(store.sql.prepare('SELECT * FROM seen').all()).includes('Result a'), false);
});
test('specific IDs do not consume another pending entry and failed reads roll back', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.enqueuePointer('worker', 'a', 'reply'); store.enqueuePointer('worker', 'b', 'reply');
  const id = store.inbox()[0]!.id;
  store.sql.exec("CREATE TRIGGER refuse_consume BEFORE DELETE ON mailbox BEGIN SELECT RAISE(ABORT,'keep unread'); END");
  assert.throws(() => store.transaction(() => store.removeResolved([id])), /keep unread/);
  assert.equal(store.inbox().length, 2);
  store.sql.exec('DROP TRIGGER refuse_consume');
  store.transaction(() => store.removeResolved([id]));
  assert.deepEqual(store.inbox().map(row => row.native_id), ['b']);
});
test('explicit handling retains old mailbox bodies as inert history without a new body copy', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.enqueue(incoming('legacy'));
  const before = store.sql.prepare('SELECT * FROM mailbox').all(), id = store.inbox()[0]!.id;
  store.removeResolved([id]);
  assert.deepEqual(store.inbox(), []);
  assert.deepEqual(store.sql.prepare('SELECT * FROM mailbox').all(), before);
  assert.equal(store.reserveNotice(), null);
  assert.equal(store.enqueuePointer('worker', 'legacy', 'reply'), false);
});
test('duplicate native events never restore consumed replies; changed originals fail explicitly', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  assert.equal(store.enqueue(incoming('one')), true);
  assert.equal(store.enqueue(incoming('one')), false);
  store.removeResolved(store.inbox().map(row => row.id));
  assert.equal(store.enqueue(incoming('one')), false);
  assert.throws(() => store.enqueue({ ...incoming('one'), text: 'Changed native original' }), { code: 'NATIVE_ID_CONFLICT' });
});
test('pending native asks normalize omitted options without treating a real changed choice as identical', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const item: Incoming = { ...incoming('ask'), kind: 'ask', text: 'Choose', question: { requestId: 'ask', question: 'Choose' } };
  assert.equal(store.enqueue(item), true);
  assert.equal(store.enqueue({ ...item, question: { ...item.question!, choices: [], allowFreeform: true } }), false);
  assert.throws(() => store.enqueue({ ...item, question: { ...item.question!, choices: ['A'] } }), { code: 'NATIVE_ID_CONFLICT' });
});
test('reading during a notification send cannot restore an inbox row and late arrivals remain unnotified', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); store.enqueue(incoming('one'));
  const notification = store.reserveNotice()!;
  store.removeResolved(store.inbox().map(row => row.id));
  store.enqueue(incoming('two'));
  store.settleNotice(notification.id, 'notice-receipt', true);
  const remaining = store.inbox();
  assert.equal(remaining.length, 1); assert.equal(remaining[0]!.native_id, 'two');
  assert.equal(remaining[0]!.notice_state, 'pending');
});
test('restart preserves pending bodies and records interrupted effects as unknown without replay', () => {
  const directory = mkdtempSync(join(tmpdir(), 'assistant-store-')), path = join(directory, 'assistant.sqlite');
  let store = new Store(path);
  try {
    store.saveTopic(topic());
    store.sql.exec(`INSERT INTO deliveries VALUES('old','front','input','topic','hash','worker','unknown',NULL,NULL,NULL,NULL,'original uncertainty',1)`);
    store.enqueue(incoming('one')); store.reserveNotice();
    store.saveForegroundWake({ sessionId: 'original', state: 'loading', error: null });
    store.close(); store = new Store(path); store.recover();
    assert.equal(store.inbox()[0]!.text, 'Result one');
    assert.equal(store.inbox()[0]!.notice_state, 'unknown');
    assert.equal(store.sql.prepare('SELECT state FROM deliveries').get()!.state, 'unknown');
    assert.equal(store.sql.prepare('SELECT error FROM deliveries').get()!.error, 'original uncertainty');
    assert.equal(store.reserveNotice(), null);
    assert.deepEqual(store.foregroundWake(), { sessionId: 'original', state: 'unknown',
      error: 'Interrupted foreground load; inspect or load the original session through the Host, without automatic replay' });
    store.recover();
    assert.equal(store.foregroundWake()!.state, 'unknown');
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});
