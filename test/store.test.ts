import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
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
test('one native input freezes its whole split without persisting user or dispatched prompt bodies', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.saveTopic(topic()); store.saveTopic(topic('second'));
  const items = [{ topicId: 'topic', prompt: 'Sensitive original prompt that is not a mirror' }];
  const first = store.begin('assistant', 'native-user', items);
  assert.equal(first.fresh, true);
  assert.equal(first.deliveries.length, 1);
  const row = first.deliveries[0]!;
  store.finish({ ...row, state: 'accepted', mode: 'prompt', native_message_id: 'real-receipt', result: { ok: true } });
  assert.equal(store.begin('assistant', 'native-user', items).fresh, false);
  assert.throws(() => store.begin('assistant', 'native-user', [{ topicId: 'second', prompt: 'Extra business' }]),
    { code: 'FROZEN_DISPATCH' });
  assert.equal(JSON.stringify(store.deliveries('assistant', 'native-user')).includes(items[0]!.prompt), false);
  assert.throws(() => store.finish({ ...row, state: 'rejected' }), { code: 'SETTLED_DELIVERY' });
  assert.equal(store.managed('worker'), true);
});
test('invalid multi-topic splits roll back every proposed row', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); store.saveTopic(topic());
  assert.throws(() => store.begin('assistant', 'native-user', [
    { topicId: 'topic', prompt: 'One' }, { topicId: 'missing', prompt: 'Two' },
  ]), { code: 'TOPIC_NOT_FOUND' });
  assert.deepEqual(store.deliveries('assistant', 'native-user'), []);
});
test('read consumes only returned entries and leaves later arrivals and unread pages intact', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (const id of ['a', 'b']) store.enqueue(incoming(id));
  const first = store.take('assistant:read1', 1);
  assert.deepEqual(first.items.map(row => row.native_id), ['a']);
  assert.equal(first.hasMore, true);
  store.enqueue(incoming('c'));
  const replay = store.take('assistant:read1', 1);
  assert.equal(replay.alreadyRead, true);
  assert.deepEqual(replay.items, []);
  assert.deepEqual(store.inbox().map(row => row.native_id), ['b', 'c']);
  const second = store.take('assistant:read2', 100);
  assert.deepEqual(second.items.map(row => row.native_id), ['b', 'c']);
  assert.equal(second.hasMore, false);
  assert.deepEqual(store.inbox(), []);
  assert.equal(store.enqueue(incoming('a')), false);
  assert.equal(JSON.stringify(store.sql.prepare('SELECT * FROM seen').all()).includes('Result a'), false);
});
test('specific IDs do not consume another pending entry and failed reads roll back', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.enqueue(incoming('a')); store.enqueue(incoming('b'));
  const id = store.inbox()[0]!.id;
  store.sql.exec("CREATE TRIGGER refuse_consume BEFORE DELETE ON mailbox BEGIN SELECT RAISE(ABORT,'keep unread'); END");
  assert.throws(() => store.take('failed-read', 100, [id]), /keep unread/);
  assert.equal(store.inbox().length, 2);
  store.sql.exec('DROP TRIGGER refuse_consume');
  const read = store.take('failed-read', 100, [id]);
  assert.equal(read.items.length, 1);
  assert.deepEqual(store.inbox().map(row => row.native_id), ['b']);
  assert.throws(() => store.take('failed-read', 1), { code: 'IDEMPOTENCY_CONFLICT' });
});
test('duplicate native events never restore consumed replies; changed originals fail explicitly', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  assert.equal(store.enqueue(incoming('one')), true);
  assert.equal(store.enqueue(incoming('one')), false);
  store.take('read', 50);
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
  store.take('read', 100);
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
    store.saveTopic(topic()); store.begin('assistant', randomUUID(), [{ topicId: 'topic', prompt: 'Work' }]);
    store.enqueue(incoming('one')); store.reserveNotice();
    store.saveForegroundWake({ sessionId: 'original', state: 'loading', error: null });
    store.close(); store = new Store(path); store.recover();
    assert.equal(store.inbox()[0]!.text, 'Result one');
    assert.equal(store.inbox()[0]!.notice_state, 'unknown');
    assert.equal(store.sql.prepare('SELECT state FROM deliveries').get()!.state, 'unknown');
    assert.equal(store.reserveNotice(), null);
    assert.deepEqual(store.foregroundWake(), { sessionId: 'original', state: 'unknown',
      error: 'Interrupted foreground load; inspect or load the original session through the Host, without automatic replay' });
    store.recover();
    assert.equal(store.foregroundWake()!.state, 'unknown');
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});
