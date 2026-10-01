import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Published layouts, independent of both the target Store and the offline upgrader.
export const schema3Sql = readFileSync(new URL('./fixtures/schema3.sql', import.meta.url), 'utf8');
export const schema4Sql = readFileSync(new URL('./fixtures/schema4.sql', import.meta.url), 'utf8');
export function preservedSchema(version) {
  assert.ok(version === 3 || version === 4);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(version === 3 ? schema3Sql : schema4Sql);
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name")
      .all().map(({ name: table }) => ({
        table, columns: db.prepare(`PRAGMA table_info("${table}")`).all().map(column => column.name),
      }));
  } finally { db.close(); }
}
export const preservedTopics = () => preservedSchema(3).filter(({ table }) => table === 'topics');
// The deployment contract permits one source-to-target migration per database.
// Schema 3 remains supported by the explicitly invoked offline utility.
export const schema5Migrations = [4].map(from => ({
  database: 'assistant.sqlite', from, to: 5, nondestructive: true,
  preflight: { entry: 'dist/migrate.js', args: ['preflight', { path: 'data' }],
    expected: { ok: true, phase: 'preflight', from, to: 5 } },
  apply: { entry: 'dist/migrate.js', args: ['apply', { path: 'data' }],
    expected: { ok: true, phase: 'apply', schema: 5, to: 5 } },
  files: [],
}));

export function retainedRows(db, version) {
  return Object.fromEntries(preservedSchema(version).map(({ table, columns }) => {
    for (const column of columns) assert.match(column, /^[a-z_]+$/);
    const statement = db.prepare(
      `SELECT rowid AS _legacy_rowid,${columns.map(column => `"${column}"`).join(',')} FROM "${table}" ORDER BY rowid`);
    statement.setReadBigInts(true);
    return [table, statement.all()];
  }));
}
