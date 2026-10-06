import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { schema3Sql, schema4Sql, schema5Sql } from '../migration-contract.mjs';

const fingerprint = value => {
  const stable = v => Array.isArray(v) ? v.map(stable) : v !== null && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)])) : v;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
};
const question = { requestId: 'pending-native-question', question: '  Keep this native question?\n',
  choices: ['Keep', 'Wait'], allowFreeform: false };
const inbox = (nativeId, patch = {}) => {
  const value = {
    sessionId: 'business-session-1', nativeId, eventId: `event-${nativeId}`, interactionId: `turn-${nativeId}`,
    kind: 'result', body: `  Original ${nativeId}\r\n第二行\u0000`,
    attachments: [{ type: 'file', path: '/synthetic/retained.txt', displayName: 'Retained file' }],
    question: null, topicIds: ['topic-1'], candidateTopicIds: ['topic-1', 'topic-2'],
    attribution: 'native-dispatch', dispatchIds: ['dispatch-accepted'], createdAt: 1200,
    observedAfterSequence: 99, reads: [], presentations: [],
    presented: null, notificationId: null, askState: null, ...patch,
  };
  return { ...value, id: fingerprint([value.sessionId, value.kind, value.nativeId]),
    hash: value.body === null ? 'retained-consumed-original-hash'
      : fingerprint(value.question ?? [value.body, value.attachments]) };
};
export const legacyInbox = [
  inbox('unread-result'),
  inbox(question.requestId, { sessionId: 'business-session-2', kind: 'ask', body: question.question,
    eventId: null, interactionId: null, attachments: [], question, askState: 'pending',
    notificationId: 'notice-accepted', attribution: 'unknown', topicIds: [], dispatchIds: [] }),
  inbox('question-defaults', { sessionId: 'business-session-3', kind: 'ask', body: 'Keep optional fields absent?',
    eventId: null, interactionId: null, attachments: [], question: {
      requestId: 'question-defaults', question: 'Keep optional fields absent?',
    }, askState: 'unknown', notificationId: 'notice-unknown' }),
  inbox('attachment-only', { sessionId: 'business-session-4', body: '', attachments: [
    { type: 'blob', displayName: 'Synthetic text', mimeType: 'text/plain', data: 'c3ludGhldGlj' },
    { type: 'selection', filePath: '/synthetic/file.txt', displayName: 'Selection',
      text: 'Exact original selection', selection: { start: { line: 0, character: 0 }, end: { line: 1, character: 2 } } },
  ], notificationId: 'notice-calling' }),
  inbox('read-not-presented', { reads: [{ sessionId: 'foreground', interactionId: 'native-turn', afterSequence: 110 }],
    presentations: [{ actionId: 'declaration', sessionId: 'foreground', interactionId: 'native-turn',
      textHash: 'declared-hash', afterSequence: 112, state: 'pending' }], notificationId: 'notice-rejected' }),
  inbox('consumed-result', { body: null, attachments: null, question: null,
    presented: { sessionId: 'foreground', responseId: 'displayed-result', responseHash: 'display-hash' },
    reads: [{ sessionId: 'foreground', interactionId: 'display-turn', afterSequence: 114 }], notificationId: 'notice-accepted' }),
  inbox('consumed-question', { sessionId: 'business-session-2', kind: 'ask', body: null, attachments: null, question: null,
    askState: 'answered', presented: { sessionId: 'foreground', responseId: 'displayed-question', responseHash: 'question-hash' },
    eventId: null, interactionId: null, notificationId: 'notice-accepted' }),
];
export const legacyNotices = [
  { id: 'notice-accepted', state: 'accepted', receipt: 'actual-accepted-native-receipt' },
  { id: 'notice-unknown', state: 'unknown', receipt: 'actual-uncertain-native-receipt' },
  { id: 'notice-calling', state: 'calling', receipt: null },
  { id: 'notice-rejected', state: 'rejected', receipt: null },
].map(notice => ({
  kind: 'notification', sessionId: 'foreground', messageId: null, text: 'An already attempted synthetic notice',
  fingerprint: 'notice-fingerprint', interactionId: 'notice-interaction', dispatchHash: null,
  result: { ok: false, partialReceipt: notice.receipt, diagnostic: 'Retain the actual acknowledgement' },
  inboxIds: legacyInbox.filter(item => item.notificationId === notice.id).map(item => item.id), historySessionIds: [],
  ...notice,
}));

const currentItem = (sequence, session, native, patch = {}) => ({
  sequence, id: `event:${fingerprint([session, patch.kind ?? 'reply', native])}`,
  session_id: session, native_id: native, kind: 'reply', text: '', attachments: '[]', question: null,
  created_at: 2000 + sequence, notice_state: 'pending', notice_id: null, notification_receipt: null, ...patch,
});
export const schema5Mailbox = [
  currentItem(17, 'business-session-1', 'retained-reply-pointer'),
  currentItem(33, 'business-session-2', 'retained-ask-pointer', {
    kind: 'ask', notice_state: 'unknown', notice_id: 'unknown-wake', notification_receipt: 'lost-ack-native-receipt',
  }),
  currentItem(59, 'business-session-4', 'retained-archived-body', {
    text: '  Archived original body\r\n第二行\u0000',
    attachments: '[ { "type": "file", "path": "/synthetic/archived.txt", "displayName": "Exact original" } ]',
    notice_state: 'notified', notice_id: 'accepted-wake', notification_receipt: 'accepted-native-receipt',
  }),
  currentItem(77, 'mailbox-only-session', question.requestId, {
    kind: 'ask', text: question.question, question: JSON.stringify(question, null, 1),
    attachments: '[ { "type":"blob", "displayName":"Original attachment", "mimeType":"text/plain", "data":"a2VlcA==" } ]',
    notice_state: 'calling', notice_id: 'interrupted-wake',
  }),
];
const completePosition = {
  query: { source: 'persisted', direction: 'backward', since: 'original-since-token', limit: 16, max_bytes: 8192, scan_pages: 4 },
  nextQuery: null, boundaryEventId: 'original-complete-boundary', hostCheckpoint: 'original-host-checkpoint',
  coverage: 'since-checkpoint',
};
const oldCheckpoint = { version: 'original-checkpoint-version', receiptId: 'previous-read', position: completePosition, readAt: 1900 };
const pendingReceipt = {
  id: 'retained-unresolved-read', owner: 'foreground', inboxIds: schema5Mailbox.slice(0, 2).map(item => item.id),
  readAt: 2100, sources: [{ sessionId: 'business-session-1', checkpoint: oldCheckpoint },
    { sessionId: 'business-session-2', checkpoint: null }],
  progress: [{ sessionId: 'business-session-1', readIds: [], complete: false, gap: 'Keep the interrupted native read',
    readAt: 2101, position: { ...completePosition,
      nextQuery: { ...completePosition.query, cursor: 'original-fragment-continuation' } } }],
  disposition: 'unresolved', decidedAt: null,
};
const archivedReceipt = {
  id: 'retained-handled-read', owner: 'foreground', inboxIds: [schema5Mailbox[2].id], readAt: 2102,
  sources: [{ sessionId: 'business-session-4', checkpoint: null }],
  progress: [{ sessionId: 'business-session-4', readIds: [schema5Mailbox[2].id], complete: true,
    gap: null, readAt: 2103, position: completePosition }], disposition: 'silent', decidedAt: 2104,
};
export const schema5Evidence = [
  ['foreground-wake', JSON.stringify({ sessionId: 'foreground', state: 'unknown', error: 'Lost load acknowledgement; do not replay' }, null, 1), 2090],
  [`evidence:checkpoint:${fingerprint(['foreground', 'business-session-1'])}`, JSON.stringify(oldCheckpoint, null, 1), 1900],
  [`evidence:inbox-read:${pendingReceipt.id}`, JSON.stringify(pendingReceipt, null, 1), 2101],
  [`evidence:inbox-range:${fingerprint(['foreground', pendingReceipt.inboxIds])}`, JSON.stringify({ id: pendingReceipt.id }), 2100],
  [`evidence:inbox-read:${archivedReceipt.id}`, JSON.stringify(archivedReceipt, null, 1), 2104],
  [`inbox-archived:${schema5Mailbox[2].id}`, 'handled-legacy-row', 2104],
  [`handled:${fingerprint(['business-session-4', 'retained-archived-event'])}`, 'retained-handling-proof', 2104],
  [`event:${fingerprint(['business-session-1', 'reply', 'consumed-original'])}`, null, 1880],
  ['retained-bytes', Buffer.from([0, 255, 254, 128, 13, 10]), 9223372036854775807n],
  ...schema5Mailbox.slice(0, 2).map(item => [`evidence:source:${item.id}`, JSON.stringify({
    eventId: `source-${item.native_id}`, timestamp: '2026-01-01T00:00:00.001Z', type: `${item.kind}.message`,
  }, null, 1), item.created_at]),
];

function populateSchema5Rows(db) {
  for (const state of ['calling', 'accepted', 'rejected', 'unknown']) db.prepare(
    'INSERT INTO deliveries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(`delivery-${state}`, 'foreground', `source-${state}`, 'topic-1', `original-${state}-fingerprint`,
    'delivery-only-session', state, state === 'rejected' ? 'ask' : 'prompt',
    state === 'rejected' ? 'original-native-request' : null, `${state}-native-receipt`,
    `{ "state": "${state}", "unchanged": true }`, `Original ${state} diagnostic`, 1800);
  const insert = db.prepare('INSERT INTO mailbox VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const item of schema5Mailbox) {
    insert.run(...Object.values(item));
    const oldQuestion = item.question === null ? null : JSON.parse(item.question);
    const canonicalQuestion = oldQuestion === null ? null : {
      ...oldQuestion, choices: oldQuestion.choices ?? [], allowFreeform: oldQuestion.allowFreeform ?? true,
    };
    db.prepare('INSERT INTO seen VALUES(?,?,?)').run(item.id,
      fingerprint([item.text, JSON.parse(item.attachments), canonicalQuestion]), item.created_at);
  }
  db.exec("UPDATE sqlite_sequence SET seq=9001 WHERE name='mailbox'");
  for (const row of schema5Evidence) db.prepare('INSERT INTO seen VALUES(?,?,?)').run(...row);
}

export function populateLegacy(db, version) {
  const published = { 3: schema3Sql, 4: schema4Sql, 5: schema5Sql };
  if (!Object.hasOwn(published, version)) throw new Error('Unknown published fixture');
  db.exec(published[version]);
  for (let i = 1; i <= 4; i++) db.prepare('INSERT INTO topics VALUES(?,?,?,?,?,?,?,?,?)').run(
    `topic-${i}`, `Original topic ${i}`, `Original scope ${i}\n第二行`, i === 4 ? 1 : 0, i + 2,
    `business-session-${i}`, 'bound', i === 3 ? 'Retained mapping diagnostic' : null,
    `{ "sessionId": "business-session-${i}", "original": true }`);
  for (const state of ['unbound', 'calling', 'unknown']) db.prepare('INSERT INTO topics VALUES(?,?,?,?,?,?,?,?,?)').run(
    `topic-${state}`, `Original ${state} topic`, 'Never create a replacement from this receipt', 0, 19,
    null, state, state === 'unbound' ? null : 'Creation outcome uncertain',
    state === 'unbound' ? null : '{ "createdId": "actual-uncertain-worker", "transport": "lost-ack" }');
  db.prepare('INSERT INTO topics VALUES(?,?,?,?,?,?,?,?,?)').run(
    'topic-shared', 'Another original topic', 'One native session, not a second subscription', 1, 27,
    'business-session-1', 'bound', null, null);
  db.prepare('INSERT INTO topics VALUES(?,?,?,?,?,?,?,?,?)').run(
    'topic-empty', 'Original empty binding', 'Never infer a native identity', 0, 28, '', 'bound', null, null);
  if (version === 5) { populateSchema5Rows(db); return; }
  const addMessage = values => {
    const row = version === 4 ? [...values, JSON.stringify({
      channel: values[3] === 'user' ? 'user' : 'assistant', targetSessionId: 'foreground', rootId: `root-${values[0]}`,
    })] : values;
    db.prepare(`INSERT INTO messages VALUES(${row.map(() => '?').join(',')})`).run(...row);
  };
  let sequence = 0;
  for (const state of ['pending', 'calling', 'accepted', 'rejected', 'unknown', 'cancelled']) {
    const id = `user-${state}`; sequence++;
    addMessage([id, sequence, sequence + 7, 'user', `  Original user ${state}\nDo not replay\u0000`,
      '[ { "type":"file", "path":"/synthetic/original.txt" } ]', null, null, null, 1000 + sequence,
      state === 'accepted' ? 1 : 0, state === 'cancelled' ? 1 : 0, `Original ${state} diagnostic`,
      `request-${state}`, `fingerprint-${state}`, null, null, null, null, 0,
      '[ { "id":"clarification", "question":"Keep?", "answer":"Yes", "createdAt":10, "answeredAt":20 } ]']);
    db.prepare('INSERT INTO topic_messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      `dispatch-${state}`, id, 'topic-1', 'user', `Previously split ${state} prompt`, 'business-session-1', state,
      state === 'rejected' ? 'ask' : 'prompt', state === 'rejected' ? 'native-request' : null,
      state === 'rejected' ? 1 : null, state === 'accepted' || state === 'unknown' ? `native-${state}-receipt` : null,
      state === 'pending' ? null : `{ "ok": ${state === 'accepted'}, "originalState": "${state}" }`,
      state === 'unknown' || state === 'rejected' ? `Original ${state} error` : null, 1100 + sequence);
  }
  for (const state of ['pending', 'stale', 'answered', 'unknown']) {
    sequence++;
    addMessage([`ask-${state}`, sequence, 20 + sequence, 'ask', `Original ${state} question?`, '[]',
      'business-session-2', `ask-message-${state}`, `ask-event-${state}`, 1200 + sequence, 0, 0, null, null, null,
      `ask-request-${state}`, state === 'unknown' ? null : '[ "Yes", "No" ]',
      state === 'unknown' ? null : state === 'pending' ? 0 : 1, state, 3, '[]']);
  }
  sequence++;
  addMessage(['reply', sequence, 9223372036854775807n, 'reply', 'Original native reply\n', '[]', 'business-session-3',
    'original-native-message', 'original-native-event', 1300, 1, 0, 'Retained original reply', null, null,
    null, null, null, null, 0, '[]']);
  db.prepare('INSERT INTO topic_messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'reply-association', 'reply', 'topic-3', 'session', null, 'business-session-3',
    null, null, null, null, null, null, null, 1301);
  if (version === 3) return;
  const payload = (table, row) => db.prepare(`INSERT INTO ${table}(id,payload) VALUES(?,?)`).run(
    row.id, JSON.stringify(row, null, 1));
  for (const row of legacyInbox) payload('inbox', row);
  for (const row of legacyNotices) payload('foreground_inputs', row);
  payload('foreground_inputs', { id: 'pending-human-input', kind: 'human', sessionId: 'foreground',
    messageId: 'user-pending', text: 'Never replay this old HTTP input', state: 'pending', receipt: null,
    fingerprint: 'pending-input-fingerprint', dispatchHash: 'split-hash', interactionId: null,
    result: { original: true }, inboxIds: [], historySessionIds: ['business-session-4'] });
  payload('foreground_inputs', { id: 'pending-organizer-input', kind: 'organizer', sessionId: 'organizer',
    text: 'Never replay old organization', state: 'pending', receipt: null });
  for (let i = 1; i <= 4; i++) payload('workers', {
    id: `business-session-${i}`, registeredBy: `native-role-receipt-${i}`, parentSessionId: i === 4 ? 'business-session-1' : null,
  });
  db.prepare('INSERT INTO tool_actions VALUES(?,?,?)').run(
    'old-tool-call', 'original-tool-fingerprint', '{ "declared": true, "messageId": "original-tool-receipt", "result": ["keep", null, 2] }');
}

export function populateArchivedSchema5(db, archiveVersion) {
  if (archiveVersion !== 3 && archiveVersion !== 4) throw new Error('Unknown archive fixture');
  populateLegacy(db, archiveVersion);
  const published = new DatabaseSync(':memory:');
  try {
    published.exec(schema5Sql);
    for (const name of ['deliveries', 'mailbox', 'seen'])
      db.exec(published.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name).sql);
  } finally { published.close(); }
  populateSchema5Rows(db);
  db.exec('PRAGMA user_version=5');
}

export function verifyWatches(assert, db) {
  assert.deepEqual(db.prepare('SELECT * FROM watches ORDER BY session_id').all().map(row => ({ ...row })),
    [1, 2, 3, 4].map(id => ({ session_id: `business-session-${id}`, enabled: 1, version: 1, updated_at: 0 })));
}

export function verifyUnread(assert, db, version) {
  if (version === 5) {
    assert.deepEqual(db.prepare('SELECT * FROM mailbox ORDER BY sequence').all().map(row => ({ ...row })), schema5Mailbox);
    for (const [id, value, at] of schema5Evidence) {
      const statement = db.prepare('SELECT * FROM seen WHERE id=?'); statement.setReadBigInts(true);
      const row = statement.get(id);
      assert.equal(row.id, id);
      assert.deepEqual(row.fingerprint instanceof Uint8Array ? Buffer.from(row.fingerprint) : row.fingerprint, value);
      assert.equal(row.created_at, BigInt(at));
    }
    assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='mailbox'").get().seq, 9001);
    assert.deepEqual(db.prepare('SELECT state FROM deliveries ORDER BY rowid').all().map(row => row.state),
      ['calling', 'accepted', 'rejected', 'unknown']);
    return;
  }
  const items = db.prepare('SELECT * FROM mailbox ORDER BY sequence').all();
  const seen = db.prepare('SELECT * FROM seen ORDER BY rowid').all();
  const expected = version === 4 ? legacyInbox.filter(item => item.body !== null) : [];
  assert.equal(db.prepare('SELECT count(*) AS n FROM deliveries').get().n, 0);
  assert.equal(items.length, expected.length);
  assert.equal(seen.length, version === 4 ? legacyInbox.length : 0);
  for (const old of expected) {
    const item = items.find(item => item.session_id === old.sessionId && item.native_id === old.nativeId);
    assert.ok(item, `Unread ${old.nativeId} must remain actively readable`);
    assert.equal(item.text, old.body);
    assert.equal(item.kind, old.kind === 'result' ? 'reply' : 'ask');
    assert.equal(item.created_at, old.createdAt);
    assert.deepEqual(JSON.parse(item.attachments), old.attachments);
    assert.deepEqual(item.question === null ? null : JSON.parse(item.question), old.question);
    const notice = legacyNotices.find(notice => notice.id === old.notificationId);
    assert.equal(item.notice_state, notice?.state === 'accepted' && notice.receipt ? 'notified' : 'unknown');
    assert.equal(item.notice_id, old.notificationId);
    assert.equal(item.notification_receipt, notice?.receipt ?? null);
    const identity = seen.find(row => row.id === item.id);
    assert.ok(identity);
    assert.match(identity.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(identity.created_at, old.createdAt);
  }
  assert.equal(items.filter(item => item.notice_state === 'pending' || item.notice_state === 'calling').length, 0);
  assert.equal(seen.filter(row => row.fingerprint === null).length,
    version === 4 ? legacyInbox.filter(item => item.body === null).length : 0);
}
