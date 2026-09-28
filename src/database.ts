import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { Table, Tables } from './types.ts';
import { requireFact } from './errors.ts';

const tables: Table[] = ['topics', 'receptions', 'messages', 'anchors', 'questions', 'work',
  'bindings', 'deliveries', 'publications', 'memories', 'risks', 'routes', 'native', 'operations', 'exposures'];

export function fingerprint(value: unknown): string {
  const canonical = (v: unknown): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    return `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** One database is one explicitly configured Assistant space, never the host catalog. */
export class Database {
  readonly sql: DatabaseSync;
  private inTransaction = false;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.sql = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.sql.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const schema = this.sql.prepare('PRAGMA user_version').get();
    requireFact(schema?.user_version === 0 || schema?.user_version === 1,
      'SCHEMA_VERSION', 'Database schema is newer than this module');
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    for (const table of tables) {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        document TEXT NOT NULL CHECK(json_valid(document)))`);
    }
    this.sql.exec('PRAGMA user_version=1');
  }
  transaction<T>(fn: () => T): T {
    requireFact(!this.inTransaction, 'NESTED_TRANSACTION', 'Nested transactions are not supported');
    this.sql.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const value = fn();
      requireFact(!(value instanceof Promise), 'ASYNC_TRANSACTION', 'Native effects cannot run inside a transaction');
      this.sql.exec('COMMIT');
      return value;
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }
  get<T extends Table>(table: T, id: string): Tables[T] | undefined {
    const row = this.sql.prepare(`SELECT document FROM ${table} WHERE id=?`).get(id);
    return row ? JSON.parse(String(row.document)) as Tables[T] : undefined;
  }
  must<T extends Table>(table: T, id: string): Tables[T] {
    const value = this.get(table, id);
    requireFact(value, 'NOT_FOUND', `${table} record not found`, 404);
    return value;
  }
  put<T extends Table>(table: T, record: Tables[T]): void {
    this.sql.prepare(`INSERT INTO ${table}(id,document) VALUES(?,?)
      ON CONFLICT(id) DO UPDATE SET document=excluded.document`).run(record.id, JSON.stringify(record));
  }
  list<T extends Table>(table: T, after = 0, limit = 100): { items: Tables[T][]; cursor: number; hasMore: boolean } {
    requireFact(Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 200,
      'PAGINATION', 'Use a nonnegative cursor and limit 1..200', 400);
    const rows = this.sql.prepare(`SELECT ordinal,document FROM ${table} WHERE ordinal>? ORDER BY ordinal LIMIT ?`)
      .all(after, limit + 1);
    const page = rows.slice(0, limit);
    return { items: page.map(row => JSON.parse(String(row.document)) as Tables[T]),
      cursor: page.length ? Number(page[page.length - 1]!.ordinal) : after, hasMore: rows.length > limit };
  }
  find<T extends Table>(table: T, predicate: (item: Tables[T]) => boolean): Tables[T][] {
    const found: Tables[T][] = [];
    let cursor = 0;
    for (;;) {
      const page = this.list(table, cursor, 200);
      found.push(...page.items.filter(predicate));
      if (!page.hasMore) return found;
      cursor = page.cursor;
    }
  }
  meta<T>(key: string, fallback: T): T {
    const row = this.sql.prepare('SELECT value FROM meta WHERE key=?').get(key);
    return row ? JSON.parse(String(row.value)) as T : fallback;
  }
  setMeta(key: string, value: unknown): void {
    this.sql.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value));
  }
  next(key: string): number {
    const next = this.meta(key, 0) + 1;
    this.setMeta(key, next);
    return next;
  }
  close(): void { this.sql.close(); }
}
