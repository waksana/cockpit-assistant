import { createHash } from 'node:crypto';
import { schema3Sql, schema4Sql } from '../migration-contract.mjs';

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

export function populateLegacy(db, version) {
  db.exec(version === 3 ? schema3Sql : schema4Sql);
  for (let i = 1; i <= 4; i++) db.prepare('INSERT INTO topics VALUES(?,?,?,?,?,?,?,?,?)').run(
    `topic-${i}`, `Original topic ${i}`, `Original scope ${i}\n第二行`, i === 4 ? 1 : 0, i + 2,
    `business-session-${i}`, 'bound', i === 3 ? 'Retained mapping diagnostic' : null,
    `{ "sessionId": "business-session-${i}", "original": true }`);
  for (const state of ['unbound', 'calling', 'unknown']) db.prepare('INSERT INTO topics VALUES(?,?,?,?,?,?,?,?,?)').run(
    `topic-${state}`, `Original ${state} topic`, 'Never create a replacement from this receipt', 0, 19,
    null, state, state === 'unbound' ? null : 'Creation outcome uncertain',
    state === 'unbound' ? null : '{ "createdId": "actual-uncertain-worker", "transport": "lost-ack" }');
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

export function verifyUnread(assert, db, version) {
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
