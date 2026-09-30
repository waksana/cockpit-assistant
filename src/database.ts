import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { ForegroundInput, InboxItem, Message, Table, Tables, Topic, TopicMessage, Worker } from './types.ts';
import { requireFact } from './errors.ts';
import { attachmentsSchema } from './attachments.ts';
import { questionIdentity } from './question.ts';

export const SCHEMA_VERSION = 4;
export const legacyDefinitions = {
  messages: `CREATE TABLE messages (
    id TEXT PRIMARY KEY NOT NULL, sequence INTEGER NOT NULL UNIQUE, revision INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('user','reply','ask')), raw TEXT NOT NULL,
    attachments TEXT NOT NULL CHECK(json_valid(attachments)),
    source_session_id TEXT, native_message_id TEXT, native_event_id TEXT,
    created_at INTEGER NOT NULL, processed INTEGER NOT NULL CHECK(processed IN (0,1)),
    excluded INTEGER NOT NULL CHECK(excluded IN (0,1)), diagnostic TEXT,
    input_request_id TEXT UNIQUE, input_fingerprint TEXT,
    question_request_id TEXT,
    question_choices TEXT CHECK(question_choices IS NULL OR (json_valid(question_choices) AND json_type(question_choices)='array')),
    question_allow_freeform INTEGER CHECK(question_allow_freeform IN (0,1)),
    question_state TEXT CHECK(question_state IN ('pending','stale','answered','unknown')),
    question_version INTEGER NOT NULL CHECK(question_version>=0),
    clarification_history TEXT NOT NULL CHECK(json_valid(clarification_history)),
    UNIQUE(source_session_id,native_message_id),
    UNIQUE(source_session_id,native_event_id), UNIQUE(source_session_id,question_request_id),
    CHECK((kind='user' AND source_session_id IS NULL AND input_request_id IS NOT NULL AND input_fingerprint IS NOT NULL)
      OR (kind='reply' AND source_session_id IS NOT NULL AND (native_message_id IS NOT NULL OR native_event_id IS NOT NULL)
        AND input_request_id IS NULL AND input_fingerprint IS NULL)
      OR (kind='ask' AND source_session_id IS NOT NULL AND input_request_id IS NULL AND input_fingerprint IS NULL)),
    CHECK((kind='ask' AND question_request_id IS NOT NULL AND question_state IS NOT NULL AND question_version>0)
      OR (kind!='ask' AND question_request_id IS NULL AND question_choices IS NULL AND question_allow_freeform IS NULL
        AND question_state IS NULL AND question_version=0)))`,
  topics: `CREATE TABLE topics (
    id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
    archived INTEGER NOT NULL CHECK(archived IN (0,1)), version INTEGER NOT NULL,
    session_id TEXT, mapping_state TEXT NOT NULL CHECK(mapping_state IN ('unbound','bound','calling','unknown')),
    mapping_error TEXT, creation_receipt TEXT CHECK(creation_receipt IS NULL OR json_valid(creation_receipt)),
    CHECK((mapping_state='bound' AND session_id IS NOT NULL) OR (mapping_state!='bound' AND session_id IS NULL)))`,
  topic_messages: `CREATE TABLE topic_messages (
    id TEXT PRIMARY KEY NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id),
    topic_id TEXT NOT NULL REFERENCES topics(id), origin TEXT NOT NULL CHECK(origin IN ('user','session')),
    prompt TEXT, session_id TEXT, state TEXT CHECK(state IN ('pending','calling','accepted','rejected','unknown','cancelled')),
    mode TEXT CHECK(mode IN ('prompt','ask')), request_id TEXT, was_freeform INTEGER CHECK(was_freeform IN (0,1)),
    native_message_id TEXT, result TEXT CHECK(result IS NULL OR json_valid(result)), error TEXT,
    created_at INTEGER NOT NULL, UNIQUE(message_id,topic_id),
    CHECK((origin='session' AND prompt IS NULL AND state IS NULL AND mode IS NULL
      AND request_id IS NULL AND was_freeform IS NULL AND native_message_id IS NULL AND result IS NULL AND error IS NULL)
      OR (origin='user' AND prompt IS NOT NULL AND state IS NOT NULL)),
    CHECK(mode!='ask' OR (request_id IS NOT NULL AND was_freeform IS NOT NULL)))`,
} as const;
const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const definitions = legacyDefinitions;
export function inspectSchema(sql: DatabaseSync): number {
  const version = Number(sql.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  const existing = sql.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','view','trigger')").all();
  requireFact([3, 4].includes(version) || version === 0 && existing.length === 0,
    'SCHEMA_VERSION', 'Assistant supports empty storage, exact schema 3, or additive schema 4; no reset is permitted');
  if (version === 3) requireFact(existing.length === 3 && existing.every(row =>
    row.type === 'table' && Object.hasOwn(definitions, String(row.name))
    && normalize(String(row.sql)) === normalize(definitions[String(row.name) as Table])),
  'SCHEMA_TABLES', 'Assistant schema 3 must exactly match messages, topic_messages and topics');
  if (version === 4) {
    const expected = ['messages', 'topic_messages', 'topics', 'foreground_inputs', 'inbox', 'workers', 'tool_actions'];
    requireFact(existing.length === expected.length && existing.every(row => row.type === 'table' && expected.includes(String(row.name))),
      'SCHEMA_TABLES', 'Assistant schema 4 contains unexpected or missing tables');
    for (const table of ['topics', 'topic_messages'] as const) {
      requireFact(normalize(String(existing.find(row => row.name === table)?.sql)) === normalize(definitions[table]),
        'SCHEMA_TABLES', `Retained ${table} schema changed`);
    }
    const actual = normalize(String(existing.find(row => row.name === 'messages')?.sql));
    requireFact(actual.replace(", conversation TEXT NOT NULL DEFAULT '{\"channel\":\"legacy\",\"targetSessionId\":null,\"rootId\":null}' CHECK(json_valid(conversation))", '')
      === normalize(definitions.messages),
      'SCHEMA_TABLES', 'Retained messages schema changed');
    for (const [table, definition] of Object.entries(additions))
      requireFact(normalize(String(existing.find(row => row.name === table)?.sql)) === normalize(definition),
        'SCHEMA_TABLES', `Assistant ${table} schema changed`);
  }
  return version;
}
const additions = {
  foreground_inputs: 'CREATE TABLE foreground_inputs (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)))',
  inbox: 'CREATE TABLE inbox (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)))',
  workers: 'CREATE TABLE workers (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)))',
  tool_actions: 'CREATE TABLE tool_actions (id TEXT PRIMARY KEY NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL CHECK(json_valid(result)))',
};
/** Explicit, transactional forward migration. Existing rows and schema-3 receipts are never rewritten. */
export function migrateSchema4(sql: DatabaseSync): { from: number; to: 4; changed: boolean } {
  const from = inspectSchema(sql);
  requireFact(from !== 0, 'MIGRATION_TARGET', 'Create empty storage through Database; migration requires an existing schema-3 or schema-4 target');
  if (from === 4) return { from, to: 4, changed: false };
  sql.exec('BEGIN IMMEDIATE');
  try {
    sql.exec("ALTER TABLE messages ADD COLUMN conversation TEXT NOT NULL DEFAULT '{\"channel\":\"legacy\",\"targetSessionId\":null,\"rootId\":null}' CHECK(json_valid(conversation))");
    for (const definition of Object.values(additions)) sql.exec(definition);
    sql.exec('PRAGMA user_version=4');
    sql.exec('COMMIT');
    return { from, to: 4, changed: true };
  } catch (error) { sql.exec('ROLLBACK'); throw error; }
}
export function fingerprint(value: unknown): string {
  const canonical = (v: unknown): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    return `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}
type Row = Record<string, unknown>;
const parse = (value: unknown): unknown => value === null ? null : JSON.parse(String(value));
function decode<T extends Table>(table: T, row: Row): Tables[T] {
  if (table === 'messages') {
    const attachments = attachmentsSchema.parse(parse(row.attachments));
    const history = parse(row.clarification_history) as Message['clarificationHistory'];
    const message: Message = { id: String(row.id), sequence: Number(row.sequence), revision: Number(row.revision),
      kind: row.kind as Message['kind'], raw: String(row.raw), attachments,
      sessionId: row.source_session_id as string | null, nativeMessageId: row.native_message_id as string | null,
      nativeEventId: row.native_event_id as string | null, createdAt: Number(row.created_at),
      processed: !!row.processed, excluded: !!row.excluded, diagnostic: row.diagnostic as string | null,
      question: row.question_request_id === null ? null : {
        request: { requestId: String(row.question_request_id), question: String(row.raw),
          ...(row.question_choices === null ? {} : { choices: parse(row.question_choices) as string[] }),
          ...(row.question_allow_freeform === null ? {} : { allowFreeform: !!row.question_allow_freeform }) },
        state: row.question_state as NonNullable<Message['question']>['state'], stateVersion: Number(row.question_version) },
      clarificationHistory: history,
      clarification: history.find(item => item.answer === null) ?? null,
      conversation: row.conversation ? parse(row.conversation) as Message['conversation'] : undefined };
    if (row.input_request_id) message.input = { requestId: String(row.input_request_id),
      text: message.raw, attachments, fingerprint: String(row.input_fingerprint) };
    return message as Tables[T];
  }
  if (table === 'topics') return { id: String(row.id), title: String(row.title), content: String(row.content),
    archived: !!row.archived, version: Number(row.version), sessionId: row.session_id as string | null,
    mappingState: row.mapping_state as Topic['mappingState'], mappingError: row.mapping_error as string | null,
    creationReceipt: parse(row.creation_receipt) } as Tables[T];
  return { id: String(row.id), messageId: String(row.message_id), topicId: String(row.topic_id),
    origin: row.origin as TopicMessage['origin'], prompt: row.prompt as string | null,
    sessionId: row.session_id as string | null, state: row.state as TopicMessage['state'],
    mode: row.mode as TopicMessage['mode'], requestId: row.request_id as string | null,
    wasFreeform: row.was_freeform === null ? null : !!row.was_freeform,
    nativeMessageId: row.native_message_id as string | null, result: parse(row.result),
    error: row.error as string | null, createdAt: Number(row.created_at) } as Tables[T];
}

/** Only original messages, per-topic associations/sends, and topic definitions are stored. */
export class Database {
  readonly sql: DatabaseSync;
  private inTransaction = false;
  constructor(path: string) {
    if (path !== ':memory:' && existsSync(path)) {
      const inspection = new DatabaseSync(path, { readOnly: true });
      try { inspectSchema(inspection); } finally { inspection.close(); }
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.sql = new DatabaseSync(path);
    try {
      const version = inspectSchema(this.sql);
      // No DDL, PRAGMA writes or permission changes precede the compatibility check.
      if (path !== ':memory:') chmodSync(path, 0o600);
      this.sql.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');
      if (version === 0) this.transaction(() => {
        this.sql.exec(definitions.messages);
        this.sql.exec(definitions.topics);
        this.sql.exec(definitions.topic_messages);
        this.sql.exec(`CREATE INDEX messages_revision ON messages(revision);
          CREATE INDEX messages_eligible ON messages(processed,excluded,sequence);
          CREATE INDEX topic_messages_pending ON topic_messages(origin,state);
          PRAGMA user_version=3`);
      });
      migrateSchema4(this.sql);
    } catch (error) { this.sql.close(); throw error; }
  }
  transaction<T>(fn: () => T): T {
    requireFact(!this.inTransaction, 'NESTED_TRANSACTION', 'Nested transactions are not supported');
    this.sql.exec('BEGIN IMMEDIATE'); this.inTransaction = true;
    try {
      const result = fn();
      requireFact(!(result instanceof Promise), 'ASYNC_TRANSACTION', 'Native effects cannot run inside a transaction');
      this.sql.exec('COMMIT'); return result;
    } catch (error) { this.sql.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }
  get<T extends Table>(table: T, id: string): Tables[T] | undefined {
    const row = this.sql.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    return row ? decode(table, row) : undefined;
  }
  must<T extends Table>(table: T, id: string): Tables[T] {
    const row = this.get(table, id);
    requireFact(row, 'NOT_FOUND', `${table} record not found`, 404);
    return row;
  }
  put<T extends Table>(table: T, value: Tables[T]): void {
    if (!this.inTransaction) { this.transaction(() => this.put(table, value)); return; }
    if (table === 'messages') {
      const m = value as Message, old = this.get('messages', m.id);
      if (old) requireFact(fingerprint([old.kind, old.raw, old.attachments, old.sessionId,
        old.nativeMessageId, old.nativeEventId, old.sequence, old.createdAt, old.input, questionIdentity(old.question?.request)])
        === fingerprint([m.kind, m.raw, m.attachments, m.sessionId,
          m.nativeMessageId, m.nativeEventId, m.sequence, m.createdAt, m.input, questionIdentity(m.question?.request)]),
      'IMMUTABLE_ORIGINAL', 'Original input, native body, source identity and display order cannot change');
      for (const entry of old?.clarificationHistory ?? []) {
        const current = m.clarificationHistory.find(item => item.id === entry.id);
        requireFact(current && fingerprint([entry.id, entry.question, entry.choices, entry.allowFreeform, entry.createdAt])
          === fingerprint([current.id, current.question, current.choices, current.allowFreeform, current.createdAt])
          && (entry.answer === null || fingerprint(entry) === fingerprint(current)),
        'IMMUTABLE_CLARIFICATION', 'Saved clarification questions and acknowledged answers are append-only');
      }
      requireFact(m.clarificationHistory.filter(item => item.answer === null).length <= 1,
        'CLARIFICATION_WAITING', 'Only one local question may wait on an original');
      requireFact(!old?.processed || m.processed, 'PROCESSED_IMMUTABLE', 'Completed semantic results cannot be reopened');
      requireFact(!old?.excluded || m.excluded, 'INTERNAL_SOURCE', 'An old internalized source cannot be resumed as business input');
      m.revision = this.watermark + 1;
      this.sql.prepare(`INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,processed=excluded.processed,
          excluded=excluded.excluded,diagnostic=excluded.diagnostic,question_state=excluded.question_state,
          question_version=excluded.question_version,
          clarification_history=excluded.clarification_history`).run(
        m.id, m.sequence, m.revision, m.kind, m.raw, JSON.stringify(m.attachments), m.sessionId,
        m.nativeMessageId, m.nativeEventId, m.createdAt, Number(m.processed), Number(m.excluded), m.diagnostic,
        m.input?.requestId ?? null, m.input?.fingerprint ?? null, m.question?.request.requestId ?? null,
        m.question?.request.choices ? JSON.stringify(m.question.request.choices) : null,
        m.question?.request.allowFreeform === undefined ? null : Number(m.question.request.allowFreeform),
        m.question?.state ?? null, m.question?.stateVersion ?? 0,
        JSON.stringify(m.clarificationHistory), JSON.stringify(m.conversation ?? { channel: 'legacy', targetSessionId: null, rootId: null }));
      return;
    }
    if (table === 'topics') {
      const t = value as Topic;
      this.sql.prepare(`INSERT INTO topics VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,content=excluded.content,archived=excluded.archived,version=excluded.version,
        session_id=excluded.session_id,mapping_state=excluded.mapping_state,mapping_error=excluded.mapping_error,
        creation_receipt=excluded.creation_receipt`).run(t.id, t.title, t.content, Number(t.archived),
        t.version, t.sessionId, t.mappingState, t.mappingError, t.creationReceipt === null ? null : JSON.stringify(t.creationReceipt));
      for (const m of this.relatedMessages(t.id)) this.put('messages', m);
      return;
    }
    const t = value as TopicMessage, old = this.get('topic_messages', t.id);
    const original = this.must('messages', t.messageId);
    requireFact(original.kind === 'user' ? t.origin === 'user' : t.origin === 'session' && t.sessionId === original.sessionId,
      'TOPIC_MESSAGE_ORIGIN', 'Topic-message origin and source identity must agree with the immutable original');
    if (old) {
      requireFact(fingerprint([old.messageId, old.topicId, old.origin, old.prompt, old.createdAt])
        === fingerprint([t.messageId, t.topicId, t.origin, t.prompt, t.createdAt]),
      'IMMUTABLE_SPLIT', 'Topic association and faithful split prompt cannot change');
      requireFact(!old.sessionId || old.sessionId === t.sessionId,
        'FROZEN_TARGET', 'A send retains its actual target despite later mapping changes');
      requireFact(old.state !== 'calling' || t.state !== 'pending',
        'UNCERTAIN_SEND', 'A native call cannot be returned to pending');
      requireFact(!['accepted','rejected','unknown','cancelled'].includes(old.state ?? '')
        || old.state === t.state, 'TERMINAL_SEND', 'Settled or uncertain sends cannot be repeated');
      if (['accepted','rejected','unknown','cancelled'].includes(old.state ?? ''))
        requireFact(fingerprint([old.mode,old.requestId,old.wasFreeform,old.nativeMessageId,old.result,old.error])
          === fingerprint([t.mode,t.requestId,t.wasFreeform,t.nativeMessageId,t.result,t.error]),
        'IMMUTABLE_RECEIPT', 'Settled native send facts cannot be rewritten');
    }
    this.sql.prepare(`INSERT INTO topic_messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,state=excluded.state,mode=excluded.mode,
        request_id=excluded.request_id,was_freeform=excluded.was_freeform,native_message_id=excluded.native_message_id,
        result=excluded.result,error=excluded.error`).run(t.id, t.messageId, t.topicId, t.origin, t.prompt,
      t.sessionId, t.state, t.mode, t.requestId, t.wasFreeform === null ? null : Number(t.wasFreeform),
      t.nativeMessageId, t.result === null ? null : JSON.stringify(t.result), t.error, t.createdAt);
    this.put('messages', this.must('messages', t.messageId));
  }
  list<T extends Table>(table: T, after = 0, limit = 100): { items: Tables[T][]; cursor: number; hasMore: boolean } {
    requireFact(Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 200,
      'PAGINATION', 'Use a nonnegative cursor and limit 1..200', 400);
    const rows = this.sql.prepare(`SELECT rowid AS ordinal,* FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT ?`).all(after, limit + 1);
    const selected = rows.slice(0, limit);
    return { items: selected.map(row => decode(table, row)),
      cursor: selected.length ? Number(selected.at(-1)!.ordinal) : after, hasMore: rows.length > limit };
  }
  find<T extends Table>(table: T, predicate: (item: Tables[T]) => boolean): Tables[T][] {
    const items: Tables[T][] = [];
    for (let cursor = 0; ;) {
      const page = this.list(table, cursor, 200);
      items.push(...page.items.filter(predicate));
      if (!page.hasMore) return items;
      cursor = page.cursor;
    }
  }
  get watermark(): number { return Number(this.sql.prepare('SELECT MAX(revision) AS n FROM messages').get()?.n ?? 0); }
  get nextSequence(): number { return Number(this.sql.prepare('SELECT MAX(sequence) AS n FROM messages').get()?.n ?? 0) + 1; }
  input(requestId: string): Message | undefined {
    const row = this.sql.prepare('SELECT * FROM messages WHERE input_request_id=?').get(requestId);
    return row ? decode('messages', row) : undefined;
  }
  nativeMessage(sessionId: string, nativeMessageId: string): Message | undefined {
    const row = this.sql.prepare('SELECT * FROM messages WHERE source_session_id=? AND native_message_id=?').get(sessionId, nativeMessageId);
    return row ? decode('messages', row) : undefined;
  }
  nativeEvent(sessionId: string, nativeEventId: string): Message | undefined {
    const row = this.sql.prepare('SELECT * FROM messages WHERE source_session_id=? AND native_event_id=?').get(sessionId, nativeEventId);
    return row ? decode('messages', row) : undefined;
  }
  nativeQuestion(sessionId: string, requestId: string): Message | undefined {
    const row = this.sql.prepare('SELECT * FROM messages WHERE source_session_id=? AND question_request_id=?').get(sessionId, requestId);
    return row ? decode('messages', row) : undefined;
  }
  topicMessages(messageId: string): TopicMessage[] {
    return this.sql.prepare('SELECT * FROM topic_messages WHERE message_id=? ORDER BY rowid').all(messageId)
      .map(row => decode('topic_messages', row));
  }
  relatedMessages(topicId: string): Message[] {
    return this.sql.prepare('SELECT m.* FROM messages m JOIN topic_messages tm ON tm.message_id=m.id WHERE tm.topic_id=?')
      .all(topicId).map(row => decode('messages', row));
  }
  messagePage(direction: 'before' | 'after', cursor: number | undefined, limit: number, legacy = false) {
    requireFact(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100
      && (cursor === undefined || Number.isSafeInteger(cursor) && cursor >= 0), 'PAGINATION', 'Invalid message cursor', 400);
    const field = direction === 'before' ? 'sequence' : 'revision';
    const rows = this.sql.prepare(`SELECT * FROM messages WHERE json_extract(conversation,'$.channel') ${legacy ? '=' : '!='} 'legacy'
      AND ${field}${direction === 'before' ? '<' : '>'}?
      ORDER BY ${field} ${direction === 'before' ? 'DESC' : 'ASC'} LIMIT ?`)
      .all(cursor ?? (direction === 'before' ? Number.MAX_SAFE_INTEGER : 0), limit + 1);
    const selected = rows.slice(0, limit), items = selected.map(row => decode('messages', row));
    if (direction === 'before') items.reverse();
    return { items, before: items.length ? Math.min(...items.map(m => m.sequence)) : null,
      cursor: direction === 'after' ? items.at(-1)?.revision ?? cursor ?? 0 : undefined,
      hasMore: rows.length > limit, watermark: this.watermark };
  }
  record<T extends 'foreground_inputs' | 'inbox' | 'workers'>(table: T, id: string):
    ({ foreground_inputs: ForegroundInput; inbox: InboxItem; workers: Worker })[T] | undefined {
    const row = this.sql.prepare(`SELECT payload FROM ${table} WHERE id=?`).get(id);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  records<T extends 'foreground_inputs' | 'inbox' | 'workers'>(table: T):
    ({ foreground_inputs: ForegroundInput; inbox: InboxItem; workers: Worker })[T][] {
    return this.sql.prepare(`SELECT payload FROM ${table} ORDER BY rowid`).all().map(row => JSON.parse(String(row.payload)));
  }
  save<T extends 'foreground_inputs' | 'inbox' | 'workers'>(table: T,
    value: ({ foreground_inputs: ForegroundInput; inbox: InboxItem; workers: Worker })[T]): void {
    this.sql.prepare(`INSERT INTO ${table}(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`)
      .run(value.id, JSON.stringify(value));
  }
  toolAction(id: string, value: unknown): unknown | undefined {
    const row = this.sql.prepare('SELECT * FROM tool_actions WHERE id=?').get(id);
    if (!row) return;
    requireFact(row.fingerprint === fingerprint(value), 'IDEMPOTENCY_CONFLICT', 'Native tool action changed its arguments');
    return JSON.parse(String(row.result));
  }
  saveToolAction(id: string, value: unknown, result: unknown): void {
    this.sql.prepare('INSERT INTO tool_actions VALUES(?,?,?)').run(id, fingerprint(value), JSON.stringify(result));
  }
  close(): void { this.sql.close(); }
}
