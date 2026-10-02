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
const inboxRow = z.object({
  sequence: z.number(), id: z.string(), session_id: z.string(), native_id: z.string(),
  kind: z.enum(['reply', 'ask']), text: z.string(), attachments: json.pipe(attachmentsSchema),
  question: json.pipe(questionSchema).nullable(), created_at: z.number(),
  notice_state: z.enum(['pending', 'calling', 'notified', 'unknown']), notice_id: z.string().nullable(),
  notification_receipt: z.string().nullable(),
});
export type InboxItem = z.infer<typeof inboxRow>;
export type Incoming = Pick<InboxItem, 'session_id' | 'native_id' | 'kind' | 'text' | 'attachments' | 'question'>;
const wakeSchema = z.strictObject({
  sessionId: z.string().min(1), state: z.enum(['loading', 'loaded', 'failed', 'unknown']),
  error: z.string().nullable(),
});
export type ForegroundWake = z.infer<typeof wakeSchema>;
const sourcePointer = z.strictObject({
  eventId: z.string().min(1), timestamp: z.union([z.string(), z.number(), z.null()]),
  type: z.string().min(1).max(200).optional(),
});
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
  state<T>(key: string, schema: z.ZodType<T>): T | null {
    const value = this.receipt(`evidence:${key}`)?.fingerprint;
    return value === undefined || value === null ? null : json.pipe(schema).parse(value);
  }
  saveState<T>(key: string, value: T, schema: z.ZodType<T>): void {
    this.sql.prepare(`INSERT INTO seen VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET
      fingerprint=excluded.fingerprint,created_at=excluded.created_at`)
      .run(`evidence:${key}`, JSON.stringify(schema.parse(value)), Date.now());
  }
  observed(id: string): number | null {
    const row = this.sql.prepare('SELECT created_at FROM seen WHERE id=?').get(id);
    return row ? Number(row.created_at) : null;
  }
  foregroundWake(): ForegroundWake | null {
    const value = this.receipt('foreground-wake')?.fingerprint;
    return value ? json.pipe(wakeSchema).parse(value) : null;
  }
  saveForegroundWake(wake: ForegroundWake): void {
    this.sql.prepare(`INSERT INTO seen VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET
      fingerprint=excluded.fingerprint,created_at=excluded.created_at`)
      .run('foreground-wake', JSON.stringify(wakeSchema.parse(wake)), Date.now());
  }
  managed(sessionId: string): boolean {
    return !!this.sql.prepare('SELECT 1 FROM topics WHERE session_id=? LIMIT 1').get(sessionId);
  }
  enqueuePointer(sessionId: string, nativeId: string, kind: Incoming['kind'],
    source?: { eventId: string; timestamp: string | number | null; type?: string }): boolean {
    const item: Incoming = { session_id: sessionId, native_id: nativeId, kind, text: '', attachments: [], question: null };
    const identity = incomingIdentity(item);
    if (this.receipt(identity.id)) {
      const previous = this.source(identity.id);
      requireFact(!previous || !source || previous.eventId === source.eventId, 'NATIVE_ID_CONFLICT',
        'A native message identity changed its source event');
      return false;
    }
    return this.enqueue(item, 'pending', source);
  }
  enqueue(item: Incoming, notice: InboxItem['notice_state'] = 'pending',
    source?: { eventId: string; timestamp: string | number | null; type?: string }): boolean {
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
      if (this.receipt(`handled:${fingerprint([item.session_id, source?.eventId ?? item.native_id])}`)) return false;
      this.sql.prepare(`INSERT INTO mailbox(id,session_id,native_id,kind,text,attachments,question,created_at,notice_state)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(identity.id, item.session_id, item.native_id, item.kind, item.text,
        JSON.stringify(item.attachments), item.question === null ? null : JSON.stringify(item.question), Date.now(), notice);
      if (source) {
        this.saveState(`source:${identity.id}`, source, sourcePointer);
        this.sql.prepare("UPDATE mailbox SET text='',attachments='[]',question=NULL WHERE id=?").run(identity.id);
      }
      return true;
    });
  }
  source(id: string) { return this.state(`source:${id}`, sourcePointer); }
  removeResolved(ids: readonly string[]): void {
    for (const id of ids) {
      const row = this.sql.prepare('SELECT text,attachments,question FROM mailbox WHERE id=?').get(id);
      if (!row) continue;
      if (row.text !== '' || row.attachments !== '[]' || row.question !== null) {
        this.sql.prepare('INSERT OR IGNORE INTO seen VALUES(?,?,?)')
          .run(`inbox-archived:${id}`, 'handled-legacy-row', Date.now());
      } else this.sql.prepare('DELETE FROM mailbox WHERE id=?').run(id);
    }
  }
  inbox(): InboxItem[] {
    return this.sql.prepare(`SELECT mailbox.* FROM mailbox WHERE NOT EXISTS
      (SELECT 1 FROM seen WHERE seen.id='inbox-archived:'||mailbox.id) ORDER BY sequence`).all()
      .map(row => inboxRow.parse(row));
  }
  discardQuestions(ids: readonly string[]): void {
    this.transaction(() => {
      for (const id of ids) if (this.sql.prepare("SELECT 1 FROM mailbox WHERE id=? AND kind='ask'").get(id))
        this.removeResolved([id]);
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
      const wake = this.foregroundWake();
      if (wake?.state === 'loading') this.saveForegroundWake({ ...wake, state: 'unknown',
        error: 'Interrupted foreground load; inspect or load the original session through the Host, without automatic replay' });
      this.sql.exec("UPDATE mailbox SET notice_state='unknown' WHERE notice_state='calling'");
    });
  }
  close(): void { this.sql.close(); }
}
