import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { requireFact } from './errors.ts';

export const RECENT_SCHEMA_VERSION = 1;
export const RECENT_LIMITS = {
  messages: 20, sessionBytes: 64 * 1024, messageBytes: 8 * 1024,
  snippets: 10, snippetCharacters: 512, queryCharacters: 200,
  scanPages: 8, pageEvents: 16, directoryPage: 100, searchCandidates: 100, concurrentSearches: 4,
} as const;

export interface RecentMetadata {
  sessionId: string;
  title: string;
  cwd: string;
  lastActivity: number;
  lastActivitySource?: string;
}
export interface RecentMessage {
  eventId: string;
  messageId: string | null;
  role: 'user' | 'assistant';
  timestamp: string | number | null;
  text: string;
  truncated: boolean;
}
export interface RecentRow {
  sessionId: string;
  generation: string;
  metadata: RecentMetadata;
  syncedActivity: number | null;
  syncedActivitySource: string | null;
  anchor: string | null;
  state: 'stale' | 'current' | 'failed';
  requested: boolean;
  force: boolean;
  syncedAt: number | null;
  scanLimited: boolean;
  truncated: boolean;
  error: string | null;
}
const storedMetadata = z.strictObject({
  sessionId: z.string().min(1).max(1024), title: z.string().max(512), cwd: z.string().max(2048),
  lastActivity: z.number().finite(),
  lastActivitySource: z.enum(['host-event-receipt', 'native-construction', 'native-persisted']).optional(),
});
const storedPointer = z.strictObject({
  eventId: z.string().min(1).max(1024), messageId: z.string().min(1).max(1024).nullable(),
  role: z.enum(['user', 'assistant']), timestamp: z.union([z.string().max(128), z.number().finite(), z.null()]),
  truncated: z.boolean(),
});
function decode<T>(schema: z.ZodType<T>, value: string): T {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { requireFact(false, 'RECENT_CORRUPT', 'Recent cache JSON is corrupt'); }
  const result = schema.safeParse(parsed);
  requireFact(result.success, 'RECENT_CORRUPT', 'Recent cache contains incompatible discovery data');
  return result.data;
}
export const recentDefinitions = {
  recent_sessions: `CREATE TABLE recent_sessions (
    session_id TEXT PRIMARY KEY NOT NULL, generation TEXT NOT NULL,
    metadata TEXT NOT NULL CHECK(json_valid(metadata)), synced_activity REAL,
    synced_activity_source TEXT, anchor TEXT,
    state TEXT NOT NULL CHECK(state IN ('stale','current','failed')),
    requested INTEGER NOT NULL, request_order INTEGER NOT NULL, force INTEGER NOT NULL, synced_at INTEGER,
    scan_limited INTEGER NOT NULL, truncated INTEGER NOT NULL, error TEXT, seen_run TEXT)`,
  recent_messages: `CREATE TABLE recent_messages (
    session_id TEXT NOT NULL REFERENCES recent_sessions(session_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL, message TEXT NOT NULL CHECK(json_valid(message)), text TEXT NOT NULL,
    PRIMARY KEY(session_id,ordinal))`,
} as const;

export function inspectRecentStore(sql: DatabaseSync): number {
  const version = Number(sql.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  const objects = sql.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','view','trigger')").all();
  if (!version && !objects.length) return 0;
  requireFact(version === RECENT_SCHEMA_VERSION, 'RECENT_SCHEMA', 'Recent discovery cache schema is incompatible');
  const normalized = (s: string) => s.replace(/\s+/g, ' ').trim();
  requireFact(objects.length === Object.keys(recentDefinitions).length
    && Object.entries(recentDefinitions).every(([name, definition]) => objects.some(row =>
      row.name === name && row.type === 'table' && normalized(String(row.sql)) === normalized(definition))),
  'RECENT_SCHEMA', 'Recent discovery cache tables are incompatible');
  return version;
}

/** A disposable discovery database; never opens or migrates assistant.sqlite. */
export class RecentStore {
  readonly sql: DatabaseSync;
  private closed = false;
  private requestOrder = 0;
  constructor(path: string) {
    if (path !== ':memory:' && existsSync(path)) {
      const reader = new DatabaseSync(path, { readOnly: true });
      try { inspectRecentStore(reader); } finally { reader.close(); }
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.sql = new DatabaseSync(path);
    try {
      const version = inspectRecentStore(this.sql);
      if (path !== ':memory:') chmodSync(path, 0o600);
      this.sql.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');
      if (!version) this.transaction(() => {
        for (const definition of Object.values(recentDefinitions)) this.sql.exec(definition);
        this.sql.exec(`PRAGMA user_version=${RECENT_SCHEMA_VERSION}`);
      });
      this.sql.exec('CREATE INDEX IF NOT EXISTS recent_pending_order ON recent_sessions(requested,request_order)');
      this.requestOrder = Number(this.sql.prepare('SELECT max(request_order) value FROM recent_sessions').get()?.value ?? 0);
    } catch (error) { this.sql.close(); throw error; }
  }
  private transaction<T>(action: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE');
    try { const value = action(); this.sql.exec('COMMIT'); return value; }
    catch (error) { this.sql.exec('ROLLBACK'); throw error; }
  }
  get(sessionId: string): RecentRow | null {
    const oversized = this.sql.prepare(`SELECT 1 FROM recent_sessions WHERE session_id=? AND
      (length(CAST(session_id AS BLOB))>4096 OR length(CAST(generation AS BLOB))>64
      OR length(CAST(metadata AS BLOB))>16384 OR length(CAST(anchor AS BLOB))>64
      OR length(CAST(error AS BLOB))>2048 OR length(CAST(synced_activity_source AS BLOB))>128)`).get(sessionId);
    requireFact(!oversized, 'RECENT_CORRUPT', 'Recent session metadata exceeds its storage budget');
    const row = this.sql.prepare('SELECT * FROM recent_sessions WHERE session_id=?').get(sessionId);
    if (!row) return null;
    const metadata = decode(storedMetadata, String(row.metadata));
    requireFact(metadata.sessionId === sessionId, 'RECENT_CORRUPT', 'Recent stored session identities differ');
    return {
      sessionId: String(row.session_id), generation: String(row.generation),
      metadata,
      syncedActivity: row.synced_activity === null ? null : Number(row.synced_activity),
      syncedActivitySource: row.synced_activity_source === null ? null : String(row.synced_activity_source),
      anchor: row.anchor === null ? null : String(row.anchor),
      state: row.state as RecentRow['state'], requested: !!row.requested, force: !!row.force,
      syncedAt: row.synced_at === null ? null : Number(row.synced_at), scanLimited: !!row.scan_limited,
      truncated: !!row.truncated, error: row.error === null ? null : String(row.error),
    };
  }
  beginInventory(): void {
    this.sql.exec("UPDATE recent_sessions SET state='stale',seen_run=NULL");
  }
  observe(metadata: RecentMetadata, run: string): void {
    const row = this.get(metadata.sessionId);
    const dirty = !row || row.force || row.syncedActivity !== metadata.lastActivity
      || row.syncedActivitySource !== (metadata.lastActivitySource ?? null);
    this.sql.prepare(`INSERT INTO recent_sessions
      (session_id,generation,metadata,state,requested,request_order,force,scan_limited,truncated,seen_run)
      VALUES (?,?,?,'stale',1,?,?,0,0,?)
      ON CONFLICT(session_id) DO UPDATE SET metadata=excluded.metadata,seen_run=excluded.seen_run,
      request_order=CASE WHEN requested=1 THEN request_order ELSE excluded.request_order END,
      requested=1,force=excluded.force,state='stale'`)
      .run(metadata.sessionId, randomUUID(), JSON.stringify(metadata), ++this.requestOrder, Number(dirty), run);
  }
  invalidate(sessionId: string, kind: 'dirty' | 'reset' | 'delete', run?: string): void {
    if (kind === 'delete') { this.remove(sessionId); return; }
    this.transaction(() => {
      this.sql.prepare(`INSERT INTO recent_sessions
        (session_id,generation,metadata,state,requested,request_order,force,scan_limited,truncated,seen_run)
        VALUES (?,?,?,'stale',1,?,1,0,0,?)
        ON CONFLICT(session_id) DO UPDATE SET generation=excluded.generation,state='stale',requested=1,
        force=CASE WHEN ?='reset' THEN 1 ELSE recent_sessions.force END,error=NULL,
        request_order=CASE WHEN requested=1 THEN request_order ELSE excluded.request_order END,
        seen_run=COALESCE(excluded.seen_run,recent_sessions.seen_run)`)
        .run(sessionId, randomUUID(), JSON.stringify({ sessionId, title: '', cwd: '', lastActivity: 0 }),
          ++this.requestOrder, run ?? null, kind);
      if (kind === 'reset') this.sql.prepare('DELETE FROM recent_messages WHERE session_id=?').run(sessionId);
    });
  }
  next(): RecentRow | null {
    const row = this.sql.prepare('SELECT session_id FROM recent_sessions WHERE requested=1 ORDER BY request_order LIMIT 1').get();
    return row ? this.get(String(row.session_id)) : null;
  }
  claim(row: RecentRow): void {
    this.sql.prepare('UPDATE recent_sessions SET requested=0 WHERE session_id=? AND generation=?').run(row.sessionId, row.generation);
  }
  fail(row: RecentRow, error: string): void {
    this.sql.prepare("UPDATE recent_sessions SET state='failed',force=1,error=? WHERE session_id=? AND generation=?")
      .run(error.slice(0, 512), row.sessionId, row.generation);
  }
  defer(row: RecentRow, error: string): void {
    this.sql.prepare("UPDATE recent_sessions SET state='stale',force=1,error=? WHERE session_id=? AND generation=?")
      .run(error.slice(0, 512), row.sessionId, row.generation);
  }
  publish(row: RecentRow, metadata: RecentMetadata, anchor: string, messages: RecentMessage[] | null,
    coverage: { scanLimited: boolean; truncated: boolean }): boolean {
    if (this.get(row.sessionId)?.generation !== row.generation) return false;
    storedMetadata.parse(metadata);
    if (messages) {
      requireFact(messages.length <= RECENT_LIMITS.messages
        && messages.every(message => Buffer.byteLength(message.text) <= RECENT_LIMITS.messageBytes)
        && messages.reduce((n, message) => n + Buffer.byteLength(message.text), 0) <= RECENT_LIMITS.sessionBytes,
      'RECENT_BUDGET', 'Recent message cache exceeds its text budget');
      for (const { text: _text, ...pointer } of messages) storedPointer.parse(pointer);
    } else this.messages(row.sessionId);
    this.transaction(() => {
      if (messages) {
        this.sql.prepare('DELETE FROM recent_messages WHERE session_id=?').run(row.sessionId);
        const insert = this.sql.prepare('INSERT INTO recent_messages(session_id,ordinal,message,text) VALUES (?,?,?,?)');
        messages.forEach(({ text, ...message }, i) => insert.run(row.sessionId, i, JSON.stringify(message), text));
      }
      this.sql.prepare(`UPDATE recent_sessions SET metadata=?,synced_activity=?,synced_activity_source=?,anchor=?,
        state='current',force=0,synced_at=?,scan_limited=?,truncated=?,error=NULL WHERE session_id=? AND generation=?`)
        .run(JSON.stringify(metadata), metadata.lastActivity, metadata.lastActivitySource ?? null, anchor,
          Date.now(), Number(coverage.scanLimited), Number(coverage.truncated), row.sessionId, row.generation);
    });
    return true;
  }
  private validateMessageBudgets(sessionId?: string): void {
    const invalid = this.sql.prepare(`SELECT 1 FROM recent_messages m JOIN recent_sessions s ON s.session_id=m.session_id
      WHERE ${sessionId === undefined ? "s.state='current'" : 'm.session_id=?'} GROUP BY m.session_id
      HAVING count(*)>${RECENT_LIMITS.messages} OR sum(length(CAST(m.text AS BLOB)))>${RECENT_LIMITS.sessionBytes}
      OR max(length(CAST(m.text AS BLOB)))>${RECENT_LIMITS.messageBytes}
      OR max(length(CAST(m.message AS BLOB)))>16384 LIMIT 1`);
    requireFact(!(sessionId === undefined ? invalid.get() : invalid.get(sessionId)),
      'RECENT_CORRUPT', 'Recent cached messages exceed their storage budgets');
  }
  messages(sessionId: string): RecentMessage[] {
    this.validateMessageBudgets(sessionId);
    return this.sql.prepare('SELECT message,text FROM recent_messages WHERE session_id=? ORDER BY ordinal').all(sessionId)
      .map(row => ({ ...decode(storedPointer, String(row.message)), text: String(row.text) }));
  }
  candidates(query: string): Array<{ sessionId: string; generation: string; message: RecentMessage }> {
    this.validateMessageBudgets();
    return this.sql.prepare(`SELECT s.session_id,s.generation,m.message,m.text FROM recent_sessions s
      JOIN recent_messages m ON m.session_id=s.session_id WHERE s.state='current' AND instr(m.text,?)>0
      ORDER BY s.synced_activity DESC,m.ordinal LIMIT ?`).all(query, RECENT_LIMITS.searchCandidates + 1)
      .map(row => ({ sessionId: String(row.session_id), generation: String(row.generation),
        message: { ...decode(storedPointer, String(row.message)), text: String(row.text) } }));
  }
  prune(run: string): void {
    this.sql.prepare('DELETE FROM recent_sessions WHERE seen_run IS NULL OR seen_run<>?').run(run);
  }
  remove(sessionId: string): void { this.sql.prepare('DELETE FROM recent_sessions WHERE session_id=?').run(sessionId); }
  counts(): { sessions: number; current: number; stale: number; failed: number; pending: number; truncated: number; scanLimited: number; deferred: number } {
    const row = this.sql.prepare(`SELECT count(*) sessions,sum(state='current') current,sum(state='stale') stale,
      sum(state='failed') failed,sum(requested) pending,sum(truncated) truncated,sum(scan_limited) scanLimited,
      sum(state='stale' AND error='SESSION_TRANSITION') deferred FROM recent_sessions`).get()!;
    return { sessions: Number(row.sessions), current: Number(row.current ?? 0), stale: Number(row.stale ?? 0),
      failed: Number(row.failed ?? 0), pending: Number(row.pending ?? 0), truncated: Number(row.truncated ?? 0),
      scanLimited: Number(row.scanLimited ?? 0), deferred: Number(row.deferred ?? 0) };
  }
  close(): void { if (!this.closed) { this.closed = true; this.sql.close(); } }
}
