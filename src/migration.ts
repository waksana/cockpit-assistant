import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inspectSchema, migrateSchema4 } from './database.ts';
import { requireFact } from './errors.ts';

export const SCHEMA3_PRESERVE = [
  { table: 'messages', columns: ['id', 'sequence', 'revision', 'kind', 'raw', 'attachments',
    'source_session_id', 'native_message_id', 'native_event_id', 'created_at', 'processed',
    'excluded', 'diagnostic', 'input_request_id', 'input_fingerprint', 'question_request_id',
    'question_choices', 'question_allow_freeform', 'question_state', 'question_version', 'clarification_history'] },
  { table: 'topic_messages', columns: ['id', 'message_id', 'topic_id', 'origin', 'prompt', 'session_id',
    'state', 'mode', 'request_id', 'was_freeform', 'native_message_id', 'result', 'error', 'created_at'] },
  { table: 'topics', columns: ['id', 'title', 'content', 'archived', 'version', 'session_id',
    'mapping_state', 'mapping_error', 'creation_receipt'] },
] as const;

export interface MigrationReceipt {
  ok: true;
  phase: 'preflight' | 'apply';
  schema: 3 | 4;
  from: 3 | 4;
  to: 4;
  changed: boolean;
}
function target(dataRoot: string): string {
  requireFact(typeof dataRoot === 'string' && isAbsolute(dataRoot), 'MIGRATION_PATH',
    'Migration requires an absolute module data-root directory');
  const root = resolve(dataRoot), path = join(root, 'assistant.sqlite');
  requireFact(lstatSync(root).isDirectory() && realpathSync(root) === root,
    'MIGRATION_PATH', 'Migration requires an existing, unlinked module data-root directory');
  const stat = lstatSync(path);
  requireFact(stat.isFile() && !stat.isSymbolicLink() && realpathSync(path) === path,
    'MIGRATION_TARGET', 'Migration requires an existing, unlinked assistant.sqlite file');
  return path;
}
function checkedSchema(sql: DatabaseSync): 3 | 4 {
  const version = inspectSchema(sql);
  requireFact(version === 3 || version === 4, 'MIGRATION_TARGET',
    'Migration requires retained schema 3 or its schema 4 successor, never an empty database');
  requireFact(sql.prepare('PRAGMA integrity_check').all().every(row => row.integrity_check === 'ok')
    && sql.prepare('PRAGMA foreign_key_check').all().length === 0,
    'MIGRATION_INTEGRITY', 'Assistant database integrity check failed');
  return version;
}
/** Read-only preflight. CLI wrappers own JSON serialization and stdout. */
export function inspect(dataRoot: string): MigrationReceipt {
  const sql = new DatabaseSync(target(dataRoot), { readOnly: true });
  try {
    const from = checkedSchema(sql);
    return { ok: true, phase: 'preflight', schema: from, from, to: 4, changed: false };
  } finally { sql.close(); }
}
/** Only the existing SQLite schema is changed; no lifecycle, recovery or Host access runs. */
export function migrate(dataRoot: string): MigrationReceipt {
  inspect(dataRoot);
  const sql = new DatabaseSync(target(dataRoot));
  try {
    checkedSchema(sql);
    const result = migrateSchema4(sql), schema = checkedSchema(sql);
    requireFact(schema === 4, 'MIGRATION_TARGET', 'Migration did not reach schema 4');
    return { ok: true, phase: 'apply', schema, from: result.from as 3 | 4, to: 4, changed: result.changed };
  } finally { sql.close(); }
}
