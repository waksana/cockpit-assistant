import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Published layouts, independent of both the target Store and the offline upgrader.
export const schema3Sql = readFileSync(new URL('./fixtures/schema3.sql', import.meta.url), 'utf8');
export const schema4Sql = readFileSync(new URL('./fixtures/schema4.sql', import.meta.url), 'utf8');
export const schema5Sql = readFileSync(new URL('./fixtures/schema5.sql', import.meta.url), 'utf8');
const publishedSql = { 3: schema3Sql, 4: schema4Sql, 5: schema5Sql };
export function preservedSchema(version) {
  assert.ok(Object.hasOwn(publishedSql, version));
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(publishedSql[version]);
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name")
      .all().map(({ name: table }) => ({
        table, columns: db.prepare(`PRAGMA table_info("${table}")`).all().map(column => column.name),
      }));
  } finally { db.close(); }
}
// The deployment contract permits one source-to-target migration per database.
// Schemas 3/4 remain supported only by the explicitly invoked offline utility.
export const schema6Migrations = [5].map(from => ({
  database: 'assistant.sqlite', from, to: 6, nondestructive: true,
  preflight: { entry: 'dist/migrate.js', args: ['preflight', { path: 'data' }],
    expected: { ok: true, phase: 'preflight', from, to: 6 } },
  apply: { entry: 'dist/migrate.js', args: ['apply', { path: 'data' }],
    expected: { ok: true, phase: 'apply', schema: 6, to: 6 } },
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

// A source-wide independent oracle, including archives, indexes and sqlite_sequence.
export function retainedDatabase(db, source) {
  const objects = db.prepare('SELECT type,name,tbl_name,rootpage,sql FROM sqlite_master ORDER BY type,name').all()
    .filter(row => !source || source.objects.some(old => old.type === row.type && old.name === row.name));
  const tables = source ? Object.keys(source.tables) : objects.filter(row => row.type === 'table').map(row => row.name);
  const quote = name => `"${name.replaceAll('"', '""')}"`;
  return { objects, tables: Object.fromEntries(tables.map(table => {
    const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all();
    const fields = columns.flatMap(({ name }) => [quote(name),
      `typeof(${quote(name)}) AS ${quote(`${name}:type`)}`, `hex(${quote(name)}) AS ${quote(`${name}:bytes`)}`]);
    const rows = db.prepare(`SELECT rowid AS _legacy_rowid,${fields.join(',')} FROM ${quote(table)} ORDER BY rowid`);
    rows.setReadBigInts(true);
    return [table, { columns, rows: rows.all() }];
  })) };
}
