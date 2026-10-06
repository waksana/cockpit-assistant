import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { attachmentsSchema } from './attachments.ts';
import { requireFact } from './errors.ts';
import { legacySchemas } from './legacy-schema.ts';
import { definitions, incomingIdentity, inspectStore, questionSchema, SCHEMA_VERSION } from './store.ts';
import type { Incoming } from './store.ts';

type Version = 3 | 4 | 5 | 6;
type Row = Record<string, unknown>;
export interface MigrationReceipt {
  ok: true;
  phase: 'preflight' | 'apply';
  schema: Version;
  from: Version;
  to: 6;
  changed: boolean;
}
const additions = ['deliveries', 'mailbox', 'seen'] as const;
const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const watchSelection = `SELECT DISTINCT session_id,1 AS enabled,1 AS version,0 AS updated_at FROM topics
  WHERE session_id IS NOT NULL AND session_id!='' ORDER BY session_id`;
function objects(sql: DatabaseSync): Row[] {
  return sql.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all();
}
function allObjects(sql: DatabaseSync): Row[] {
  return sql.prepare('SELECT type,name,tbl_name,rootpage,sql FROM sqlite_master ORDER BY type,name').all();
}
function schemaFingerprint(rows: Row[]): string {
  return createHash('sha256').update(JSON.stringify(rows.map(row =>
    [row.type, row.name, normalize(String(row.sql))]))).digest('hex');
}
function target(dataRoot: string): string {
  requireFact(typeof dataRoot === 'string' && isAbsolute(dataRoot), 'MIGRATION_PATH',
    'Migration requires an absolute module data-root directory');
  const root = resolve(dataRoot), path = join(root, 'assistant.sqlite');
  requireFact(lstatSync(root).isDirectory() && realpathSync(root) === root, 'MIGRATION_PATH',
    'Migration requires an existing, unlinked module data-root directory');
  const stat = lstatSync(path);
  requireFact(stat.isFile() && !stat.isSymbolicLink() && realpathSync(path) === path, 'MIGRATION_TARGET',
    'Migration requires an existing, unlinked assistant.sqlite file');
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = `${path}${suffix}`, sidecarStat = lstatSync(sidecar, { throwIfNoEntry: false });
    if (!sidecarStat) continue;
    requireFact(sidecarStat.isFile() && !sidecarStat.isSymbolicLink() && realpathSync(sidecar) === sidecar,
      'MIGRATION_PATH', 'SQLite sidecars must be unlinked regular files in the offline data root');
    requireFact(suffix === '-shm' || sidecarStat.size === 0, 'MIGRATION_WAL',
      'Use a checkpointed offline SQLite snapshot before migration; a live WAL or journal cannot be ignored');
  }
  return path;
}
function checkedSchema(sql: DatabaseSync): Version {
  const version = Number(sql.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  requireFact(version === 3 || version === 4 || version === 5 || version === 6, 'MIGRATION_TARGET',
    'Migration accepts only the published schemas 3, 4 or 5, or an already migrated schema 6');
  const actual = objects(sql);
  if (version === 3 || version === 4) {
    requireFact(schemaFingerprint(actual) === legacySchemas[version].fingerprint, 'MIGRATION_SCHEMA',
      `Assistant schema ${version} does not match the independently pinned published layout`);
  } else {
    const published = actual.filter(row => legacySchemas[5].tables.some(name => name === row.name));
    requireFact(schemaFingerprint(published) === legacySchemas[5].fingerprint, 'MIGRATION_SCHEMA',
      'Assistant schema 5 business tables do not match the independently pinned published layout');
    if (version === 6) inspectStore(sql);
    const archive = actual.filter(row => !additions.some(name => name === row.name)
      && !(version === 6 && row.name === 'watches' && row.type === 'table'));
    const fresh = archive.length === 1 && archive[0]?.type === 'table' && archive[0]?.name === 'topics';
    requireFact(fresh || ([3, 4] as const).some(old => legacySchemas[old].fingerprint === schemaFingerprint(archive)),
      'MIGRATION_SCHEMA', `Assistant schema ${version} contains an unrecognized archive layout`);
  }
  requireFact(sql.prepare('PRAGMA integrity_check').all().every(row => row.integrity_check === 'ok')
    && sql.prepare('PRAGMA foreign_key_check').all().length === 0, 'MIGRATION_INTEGRITY',
  'Assistant database integrity check failed');
  return version;
}
function document(value: unknown): Row {
  requireFact(typeof value === 'string', 'MIGRATION_INBOX', 'Legacy payload must be JSON text');
  const parsed: unknown = JSON.parse(value);
  requireFact(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), 'MIGRATION_INBOX',
    'Legacy inbox and notification payloads must be objects');
  return parsed as Row;
}
function nativeId(value: unknown): string {
  requireFact(typeof value === 'string' && value.length > 0, 'MIGRATION_INBOX',
    'Legacy inbox source and native IDs must be nonempty strings');
  return value;
}
interface ImportPlan {
  seen: { id: string; fingerprint: string | null; created_at: number }[];
  mailbox: {
    id: string; session_id: string; native_id: string; kind: 'reply' | 'ask'; text: string;
    attachments: string; question: string | null; created_at: number;
    notice_state: 'notified' | 'unknown'; notice_id: string | null; notification_receipt: string | null;
  }[];
}
function inboxPlan(sql: DatabaseSync, version: Version): ImportPlan {
  const plan: ImportPlan = { seen: [], mailbox: [] };
  if (version !== 4) return plan;
  const identities = new Set<string>();
  for (const row of sql.prepare('SELECT id,payload FROM inbox ORDER BY rowid').iterate()) {
    const old = document(row.payload);
    requireFact(old.id === row.id && (old.kind === 'result' || old.kind === 'ask')
      && (old.body === null || typeof old.body === 'string')
      && typeof old.createdAt === 'number' && Number.isSafeInteger(old.createdAt),
    'MIGRATION_INBOX', 'Legacy inbox identity, body or creation time is invalid');
    const item: Incoming = {
      session_id: nativeId(old.sessionId), native_id: nativeId(old.nativeId),
      kind: old.kind === 'result' ? 'reply' : 'ask', text: old.body ?? '', attachments: [], question: null,
    };
    if (old.body !== null) {
      item.attachments = attachmentsSchema.parse(old.attachments);
      item.question = old.question === null ? null : questionSchema.strict().parse(old.question);
      requireFact(item.kind === 'reply' ? item.question === null
        : item.question?.requestId === item.native_id && item.question.question === item.text,
      'MIGRATION_INBOX', 'Legacy native question must retain its request identity and original text');
    }
    const identity = incomingIdentity(item);
    requireFact(!identities.has(identity.id), 'MIGRATION_INBOX',
      'Multiple legacy inbox rows claim the same native identity; resolve the source offline');
    identities.add(identity.id);
    plan.seen.push({ id: identity.id, fingerprint: old.body === null ? null : identity.fingerprint, created_at: old.createdAt });
    // A consumed body's hash cannot be reconstructed. Its identity-only tombstone still prevents replay.
    if (old.body === null) continue;
    requireFact(old.notificationId === null || typeof old.notificationId === 'string', 'MIGRATION_INBOX',
      'Legacy notification ID must be text or null');
    let receipt: string | null = null, noticeState: 'notified' | 'unknown' = 'unknown';
    if (old.notificationId !== null) {
      const notification = sql.prepare('SELECT payload FROM foreground_inputs WHERE id=?').get(old.notificationId);
      if (notification) {
        const notice = document(notification.payload);
        requireFact(notice.id === old.notificationId && notice.kind === 'notification'
          && (notice.receipt === null || typeof notice.receipt === 'string'), 'MIGRATION_INBOX',
        'Legacy notification reference is incompatible');
        receipt = notice.receipt;
        if (notice.state === 'accepted' && receipt) noticeState = 'notified';
      }
    }
    plan.mailbox.push({
      id: identity.id, session_id: item.session_id, native_id: item.native_id, kind: item.kind, text: item.text,
      attachments: JSON.stringify(item.attachments), question: item.question === null ? null : JSON.stringify(item.question),
      created_at: old.createdAt, notice_state: noticeState, notice_id: old.notificationId, notification_receipt: receipt,
    });
  }
  return plan;
}
const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
function preserved(sql: DatabaseSync, tables: string[]) {
  return tables.map(table => {
    const columns = sql.prepare(`PRAGMA table_info(${quoted(table)})`).all();
    const fields = columns.flatMap(column => {
      const name = quoted(String(column.name));
      // Hash text/blob bytes directly, including embedded NULs and non-UTF8 text.
      return [`typeof(${name}) AS ${quoted(`${column.name}:type`)}`,
        `CASE WHEN typeof(${name}) IN ('text','blob') THEN hex(${name}) ELSE ${name} END AS ${quoted(`${column.name}:value`)}`];
    });
    const statement = sql.prepare(`SELECT rowid AS _original_rowid,${fields.join(',')} FROM ${quoted(table)} ORDER BY rowid`);
    statement.setReadBigInts(true);
    const hash = createHash('sha256');
    for (const row of statement.iterate()) {
      hash.update(JSON.stringify(Object.values(row).map(value => {
        if (value === null) return ['null'];
        if (typeof value === 'bigint') return ['integer', String(value)];
        if (typeof value === 'number') {
          const bytes = Buffer.alloc(8); bytes.writeDoubleLE(value);
          return ['real', bytes.toString('hex')];
        }
        return [typeof value, value];
      })));
      hash.update('\n');
    }
    return { table, columns, rows: hash.digest('hex') };
  });
}
function verifyImport(sql: DatabaseSync, plan: ImportPlan): void {
  assert.equal(sql.prepare('SELECT count(*) AS n FROM deliveries').get()?.n, 0,
    'Migration must never turn old pending work into new deliveries');
  assert.deepEqual(sql.prepare('SELECT * FROM seen ORDER BY rowid').all().map(row => ({ ...row })), plan.seen,
    'Every old inbox identity must be retained, including consumed entries');
  assert.deepEqual(sql.prepare('SELECT * FROM mailbox ORDER BY sequence').all().map(row => ({ ...row })),
    plan.mailbox.map((row, index) => ({ sequence: index + 1, ...row })),
    'Every unconsumed body, attachment, native question and notification receipt must migrate exactly');
}

/** Read-only validation; this module never invokes Host or session APIs. */
export function inspect(dataRoot: string): MigrationReceipt {
  const sql = new DatabaseSync(`${pathToFileURL(target(dataRoot)).href}?immutable=1`, { readOnly: true });
  try {
    sql.exec('BEGIN');
    const from = checkedSchema(sql);
    inboxPlan(sql, from);
    return { ok: true, phase: 'preflight', schema: from, from, to: 6, changed: false };
  } finally {
    sql.exec('ROLLBACK');
    sql.close();
  }
}

/** Add only active tables; all legacy rows, columns and SQL objects remain untouched. */
export function migrate(dataRoot: string): MigrationReceipt {
  const initial = inspect(dataRoot);
  if (initial.schema === 6) return { ...initial, phase: 'apply' };
  const sql = new DatabaseSync(target(dataRoot));
  try {
    sql.exec('BEGIN IMMEDIATE');
    try {
      const from = checkedSchema(sql);
      if (from === 6) {
        sql.exec('COMMIT');
        return { ok: true, phase: 'apply', schema: 6, from, to: 6, changed: false };
      }
      const previousObjects = allObjects(sql);
      const tables = previousObjects.filter(row => row.type === 'table').map(row => String(row.name));
      const before = preserved(sql, tables), plan = inboxPlan(sql, from);
      const watches = sql.prepare(watchSelection).all();
      if (from === 3 || from === 4) {
        for (const name of additions) sql.exec(definitions[name]);
        const remember = sql.prepare('INSERT INTO seen(id,fingerprint,created_at) VALUES(?,?,?)');
        for (const row of plan.seen) remember.run(row.id, row.fingerprint, row.created_at);
        const enqueue = sql.prepare(`INSERT INTO mailbox
          (id,session_id,native_id,kind,text,attachments,question,created_at,notice_state,notice_id,notification_receipt)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
        for (const row of plan.mailbox) enqueue.run(row.id, row.session_id, row.native_id, row.kind, row.text,
          row.attachments, row.question, row.created_at, row.notice_state, row.notice_id, row.notification_receipt);
      }
      sql.exec(definitions.watches);
      // updated_at=0 records that the legacy registry had no watch timestamp.
      sql.exec(`INSERT INTO watches(session_id,enabled,version,updated_at) ${watchSelection}`);
      sql.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
      checkedSchema(sql);
      assert.deepEqual(allObjects(sql).filter(row => previousObjects.some(old => old.type === row.type && old.name === row.name)), previousObjects,
        'Migration changed a legacy SQL object');
      assert.deepEqual(preserved(sql, tables), before, 'Migration changed a legacy column, row or original value');
      if (from === 3 || from === 4) verifyImport(sql, plan);
      assert.deepEqual(sql.prepare('SELECT * FROM watches ORDER BY session_id').all(), watches,
        'Migration must import exactly the distinct nonempty topic session IDs without guessed timestamps');
      sql.exec('COMMIT');
      return { ok: true, phase: 'apply', schema: 6, from, to: 6, changed: true };
    } catch (error) { sql.exec('ROLLBACK'); throw error; }
  } finally { sql.close(); }
}
