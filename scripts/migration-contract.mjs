import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Pinned from Rolling 7, independently of the target's mutable database definitions.
export const schema3Sql = readFileSync(new URL('./fixtures/schema3.sql', import.meta.url), 'utf8');
export function preservedSchema3() {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(schema3Sql);
    return ['messages', 'topic_messages', 'topics'].map(table => ({
      table, columns: db.prepare(`PRAGMA table_info("${table}")`).all().map(column => column.name),
    }));
  } finally { db.close(); }
}
export const schema4Migration = {
  database: 'assistant.sqlite', from: 3, to: 4, nondestructive: true,
  preflight: { entry: 'dist/migrate.js', args: ['preflight', { path: 'data' }],
    expected: { ok: true, phase: 'preflight', to: 4 } },
  apply: { entry: 'dist/migrate.js', args: ['apply', { path: 'data' }],
    expected: { ok: true, phase: 'apply', schema: 4, to: 4 } },
  files: [],
};

export function retainedRows(db) {
  return Object.fromEntries(preservedSchema3().map(({ table, columns }) => {
    for (const column of columns) assert.match(column, /^[a-z_]+$/);
    return [table, db.prepare(`SELECT ${columns.map(column => `"${column}"`).join(',')} FROM "${table}" ORDER BY id`).all()];
  }));
}
