/**
 * Schema-parity test.
 *
 * Asserts that the SQLite adapter's schema description is structurally
 * identical to the memory adapter's (which is itself diffed against
 * `fixtures/schema/entities.md` by the memory-adapter's parity test).
 * Transitivity gives us: SQLITE_SCHEMA matches the markdown fixture.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';

import type { SchemaDescription } from '@anorebel/licensing/storage';
import { MEMORY_SCHEMA } from '@anorebel/licensing/storage/memory';

import { SQLITE_SCHEMA, SqliteStorage } from '../../src/storage/sqlite/index.ts';

function normalize(s: SchemaDescription): unknown {
  return s.map((e) => ({
    name: e.name,
    columns: [...e.columns]
      .map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.nullable,
        unique: [...c.unique].sort(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

describe('storage-sqlite schema parity', () => {
  it('SQLITE_SCHEMA is structurally identical to MEMORY_SCHEMA', () => {
    expect(normalize(SQLITE_SCHEMA)).toEqual(normalize(MEMORY_SCHEMA));
  });

  it('describeSchema() returns SQLITE_SCHEMA', () => {
    const db = new Database(':memory:');
    const storage = new SqliteStorage(db, { skipWalPragma: true });
    expect(storage.describeSchema()).toBe(SQLITE_SCHEMA);
    db.close();
  });

  it('entity names match (order-preserving)', () => {
    const sqliteNames = SQLITE_SCHEMA.map((e) => e.name);
    const memNames = MEMORY_SCHEMA.map((e) => e.name);
    expect(sqliteNames).toEqual(memNames);
  });
});
