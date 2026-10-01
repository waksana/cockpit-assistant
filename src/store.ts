import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { attachmentsSchema } from './attachments.ts';
import { requireFact } from './errors.ts';

export const SCHEMA_VERSION = 5;
export const definitions = {
  topics: `CREATE TABLE topics (
    id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
    archived INTEGER NOT NULL CHECK(archived IN (0,1)), version INTEGER NOT NULL,
    session_id TEXT, mapping_state TEXT NOT NULL CHECK(mapping_state IN ('unbound','bound','calling','unknown')),
    mapping_error TEXT, creation_receipt TEXT CHECK(creation_receipt IS NULL OR json_valid(creation_receipt)),
    CHECK((mapping_state='bound' AND session_id IS NOT NULL) OR (mapping_state!='bound' AND session_id IS NULL)))`,
  deliveries: `CREATE TABLE deliveries (
    id TEXT PRIMARY KEY NOT NULL, source_session TEXT NOT NULL, source_message TEXT NOT NULL,
    topic_id TEXT NOT NULL REFERENCES topics(id), fingerprint TEXT NOT NULL,
    session_id TEXT, state TEXT NOT NULL CHECK(state IN ('calling','accepted','rejected','unknown')),
    mode TEXT CHECK(mode IN ('prompt','ask')), request_id TEXT, native_message_id TEXT,
    result TEXT CHECK(result IS NULL OR json_valid(result)), error TEXT, created_at INTEGER NOT NULL,
    UNIQUE(source_session,source_message,topic_id))`,
  mailbox: `CREATE TABLE mailbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL,
    native_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('reply','ask')), text TEXT NOT NULL,
    attachments TEXT NOT NULL CHECK(json_valid(attachments)),
    question TEXT CHECK(question IS NULL OR json_valid(question)), created_at INTEGER NOT NULL,
    notice_state TEXT NOT NULL CHECK(notice_state IN ('pending','calling','notified','unknown')),
    notice_id TEXT, notification_receipt TEXT)`,
  seen: 'CREATE TABLE seen (id TEXT PRIMARY KEY NOT NULL, fingerprint TEXT, created_at INTEGER NOT NULL)',
} as const;
export const archivedTables = ['messages', 'topic_messages', 'foreground_inputs', 'inbox', 'workers', 'tool_actions'];
const normalized = (sql: string) => sql.replace(/\s+/g, ' ').trim();
export function inspectStore(sql: DatabaseSync): number {
  const version = Number(sql.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  const objects = sql.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','view','trigger')").all();
  if (version === 0 && !objects.length) return 0;
  requireFact(version === SCHEMA_VERSION, 'MIGRATION_REQUIRED', 'Use the explicit preserved-data migration before loading this Assistant store');
  for (const [name, definition] of Object.entries(definitions))
    requireFact(objects.some(row => row.name === name && row.type === 'table' && normalized(String(row.sql)) === normalized(definition)),
      'SCHEMA_TABLES', `Assistant ${name} schema is missing or incompatible`);
  requireFact(objects.every(row => row.type === 'table'
    && (Object.hasOwn(definitions, String(row.name)) || archivedTables.includes(String(row.name)))),
  'SCHEMA_TABLES', 'Assistant storage contains an unexpected object');
  return version;
}
export function fingerprint(value: unknown): string {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
const json = z.string().transform((value, context): unknown => {
  try { return JSON.parse(value); }
  catch { context.addIssue({ code: 'custom', message: 'Invalid stored JSON' }); return z.NEVER; }
});
export const questionSchema = z.object({
  requestId: z.string().min(1), question: z.string(), choices: z.array(z.string()).optional(), allowFreeform: z.boolean().optional(),
});
const topicRow = z.object({
  id: z.string(), title: z.string(), content: z.string(), archived: z.number().transform(Boolean), version: z.number(),
  session_id: z.string().nullable(), mapping_state: z.enum(['unbound', 'bound', 'calling', 'unknown']),
  mapping_error: z.string().nullable(), creation_receipt: json.nullable(),
});
export type Topic = z.infer<typeof topicRow>;
const deliveryRow = z.object({
  id: z.string(), source_session: z.string(), source_message: z.string(), topic_id: z.string(), fingerprint: z.string(),
  session_id: z.string().nullable(), state: z.enum(['calling', 'accepted', 'rejected', 'unknown']),
  mode: z.enum(['prompt', 'ask']).nullable(), request_id: z.string().nullable(), native_message_id: z.string().nullable(),
  result: json.nullable(), error: z.string().nullable(), created_at: z.number(),
});
export type Delivery = z.infer<typeof deliveryRow>;
const inboxRow = z.object({
  sequence: z.number(), id: z.string(), session_id: z.string(), native_id: z.string(),
  kind: z.enum(['reply', 'ask']), text: z.string(), attachments: json.pipe(attachmentsSchema),
  question: json.pipe(questionSchema).nullable(), created_at: z.number(),
  notice_state: z.enum(['pending', 'calling', 'notified', 'unknown']), notice_id: z.string().nullable(),
  notification_receipt: z.string().nullable(),
});
export type InboxItem = z.infer<typeof inboxRow>;
export type Incoming = Pick<InboxItem, 'session_id' | 'native_id' | 'kind' | 'text' | 'attachments' | 'question'>;
export function incomingIdentity(item: Incoming) {
  const question = item.question ? { ...item.question, choices: item.question.choices ?? [],
    allowFreeform: item.question.allowFreeform ?? true } : null;
  return { id: `event:${fingerprint([item.session_id, item.kind, item.native_id])}`,
    fingerprint: fingerprint([item.text, item.attachments, question]) };
}

export class Store {
  readonly sql: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:' && existsSync(path)) {
      const sql = new DatabaseSync(path, { readOnly: true });
      try { inspectStore(sql); } finally { sql.close(); }
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.sql = new DatabaseSync(path);
    try {
      const version = inspectStore(this.sql);
      if (path !== ':memory:') chmodSync(path, 0o600);
      this.sql.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');
      if (!version) this.transaction(() => {
        for (const definition of Object.values(definitions)) this.sql.exec(definition);
        this.sql.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
      });
    } catch (error) { this.sql.close(); throw error; }
  }
  transaction<T>(action: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      requireFact(!(result instanceof Promise), 'ASYNC_TRANSACTION', 'Native calls must remain outside SQLite transactions');
      this.sql.exec('COMMIT'); return result;
    } catch (error) { this.sql.exec('ROLLBACK'); throw error; }
  }
  topics(): Topic[] { return this.sql.prepare('SELECT * FROM topics ORDER BY rowid').all().map(row => topicRow.parse(row)); }
  topic(id: string): Topic {
    const row = this.sql.prepare('SELECT * FROM topics WHERE id=?').get(id);
    requireFact(row, 'TOPIC_NOT_FOUND', 'Use a topic ID returned by assistant_topics or assistant_topic', 404);
    return topicRow.parse(row);
  }
  saveTopic(topic: Topic): Topic {
    this.sql.prepare(`INSERT INTO topics VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,content=excluded.content,archived=excluded.archived,version=excluded.version,
      session_id=excluded.session_id,mapping_state=excluded.mapping_state,mapping_error=excluded.mapping_error,
      creation_receipt=excluded.creation_receipt`).run(topic.id, topic.title, topic.content, Number(topic.archived),
      topic.version, topic.session_id, topic.mapping_state, topic.mapping_error,
      topic.creation_receipt === null ? null : JSON.stringify(topic.creation_receipt));
    return topic;
  }
  seen(id: string, hash: string): boolean {
    const row = this.sql.prepare('SELECT fingerprint FROM seen WHERE id=?').get(id);
    if (!row) return false;
    requireFact(row.fingerprint === hash, 'IDEMPOTENCY_CONFLICT', 'A native operation changed its arguments');
    return true;
  }
  remember(id: string, hash: string, at = Date.now()): void { this.sql.prepare('INSERT INTO seen VALUES(?,?,?)').run(id, hash, at); }
  receipt(id: string): { fingerprint: string | null; createdAt: number } | null {
    const row = this.sql.prepare('SELECT fingerprint,created_at FROM seen WHERE id=?').get(id);
    return row ? { fingerprint: row.fingerprint === null ? null : String(row.fingerprint), createdAt: Number(row.created_at) } : null;
  }
  observed(id: string): number | null {
    const row = this.sql.prepare('SELECT created_at FROM seen WHERE id=?').get(id);
    return row ? Number(row.created_at) : null;
  }
  deliveries(sessionId: string, messageId: string): Delivery[] {
    return this.sql.prepare('SELECT * FROM deliveries WHERE source_session=? AND source_message=? ORDER BY rowid')
      .all(sessionId, messageId).map(row => deliveryRow.parse(row));
  }
  begin(sessionId: string, messageId: string, items: { topicId: string; prompt: string }[]) {
    const hash = fingerprint(items);
    return this.transaction(() => {
      const previous = this.deliveries(sessionId, messageId);
      if (previous.length) {
        requireFact(previous.every(row => row.fingerprint === hash), 'FROZEN_DISPATCH', 'This native input already has its one complete split');
        return { fresh: false, deliveries: previous };
      }
      requireFact(new Set(items.map(item => item.topicId)).size === items.length, 'DUPLICATE_TOPIC', 'Use each topic only once');
      const rows = items.map(item => {
        const topic = this.topic(item.topicId);
        requireFact(!topic.archived, 'ARCHIVED_TOPIC', 'Archived topics cannot receive work');
        const row: Delivery = { id: randomUUID(), source_session: sessionId, source_message: messageId, topic_id: topic.id,
          fingerprint: hash, session_id: topic.session_id, state: 'calling', mode: null,
          request_id: null, native_message_id: null, result: null, error: null, created_at: Date.now() };
        this.sql.prepare('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id, sessionId, messageId,
          topic.id, hash, row.session_id, row.state, null, null, null, null, null, row.created_at);
        return row;
      });
      return { fresh: true, deliveries: rows };
    });
  }
  delivery(id: string): Delivery { return deliveryRow.parse(this.sql.prepare('SELECT * FROM deliveries WHERE id=?').get(id)); }
  finish(row: Delivery): void {
    const current = this.delivery(row.id);
    requireFact(current.state === 'calling', 'SETTLED_DELIVERY', 'Do not overwrite a settled or uncertain delivery');
    requireFact(!current.session_id || current.session_id === row.session_id, 'FROZEN_TARGET', 'A delivery retains its actual target');
    this.sql.prepare(`UPDATE deliveries SET session_id=?,state=?,mode=?,request_id=?,native_message_id=?,result=?,error=? WHERE id=?`)
      .run(row.session_id, row.state, row.mode, row.request_id, row.native_message_id,
        row.result === null ? null : JSON.stringify(row.result), row.error, row.id);
  }
  managed(sessionId: string): boolean {
    return !!this.sql.prepare('SELECT 1 FROM topics WHERE session_id=? UNION ALL SELECT 1 FROM deliveries WHERE session_id=? LIMIT 1')
      .get(sessionId, sessionId);
  }
  enqueue(item: Incoming, notice: InboxItem['notice_state'] = 'pending'): boolean {
    const identity = incomingIdentity(item);
    return this.transaction(() => {
      const previous = this.sql.prepare('SELECT fingerprint FROM seen WHERE id=?').get(identity.id);
      if (previous) {
        // Migrated consumed entries retain identity only; their bodies no longer exist.
        requireFact(previous.fingerprint === null || previous.fingerprint === identity.fingerprint,
          'NATIVE_ID_CONFLICT', 'A native message changed its original contents');
        return false;
      }
      this.remember(identity.id, identity.fingerprint);
      this.sql.prepare(`INSERT INTO mailbox(id,session_id,native_id,kind,text,attachments,question,created_at,notice_state)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(identity.id, item.session_id, item.native_id, item.kind, item.text,
        JSON.stringify(item.attachments), item.question === null ? null : JSON.stringify(item.question), Date.now(), notice);
      return true;
    });
  }
  inbox(): InboxItem[] { return this.sql.prepare('SELECT * FROM mailbox ORDER BY sequence').all().map(row => inboxRow.parse(row)); }
  take(callId: string, limit: number, ids?: string[], available?: ReadonlySet<string>) {
    return this.transaction(() => {
      const key = `read:${callId}`, hash = fingerprint({ limit, ids: ids ?? null });
      if (this.seen(key, hash)) {
        return { items: [], alreadyRead: true, hasMore: this.inbox().some(item => !available || available.has(item.id)) };
      }
      const pending = this.inbox().filter(item => !available || available.has(item.id));
      const selected = pending.filter(item => !ids || ids.includes(item.id)).slice(0, limit);
      for (const item of selected) this.sql.prepare('DELETE FROM mailbox WHERE id=?').run(item.id);
      this.remember(key, hash);
      return { items: selected, alreadyRead: false, hasMore: pending.length > selected.length };
    });
  }
  discardQuestions(ids: readonly string[]): void {
    this.transaction(() => {
      for (const id of ids) this.sql.prepare("DELETE FROM mailbox WHERE id=? AND kind='ask'").run(id);
    });
  }
  reserveNotice(eligible?: ReadonlySet<string>): { id: string; items: InboxItem[] } | null {
    return this.transaction(() => {
      const items = this.inbox().filter(item => item.notice_state === 'pending'
        && (!eligible || eligible.has(item.id))).slice(0, 50);
      if (!items.length) return null;
      const id = randomUUID();
      for (const item of items) this.sql.prepare("UPDATE mailbox SET notice_state='calling',notice_id=? WHERE id=?").run(id, item.id);
      return { id, items };
    });
  }
  settleNotice(id: string, receipt: string | null, accepted: boolean): void {
    this.sql.prepare("UPDATE mailbox SET notice_state=?,notification_receipt=? WHERE notice_id=? AND notice_state='calling'")
      .run(accepted && receipt ? 'notified' : 'unknown', receipt, id);
  }
  recover(): void {
    this.transaction(() => {
      this.sql.exec(`UPDATE deliveries SET state='unknown',error='Interrupted native delivery; inspect the original session' WHERE state='calling';
        UPDATE topics SET mapping_state='unknown',mapping_error='Interrupted native creation; do not create a replacement' WHERE mapping_state='calling';
        UPDATE mailbox SET notice_state='unknown' WHERE notice_state='calling'`);
    });
  }
  close(): void { this.sql.close(); }
}
