/**
 * Schema-parity test.
 *
 * The memory adapter already runs a full markdown-backed parity test against
 * `fixtures/schema/entities.md`. That same fixture is the source of truth.
 * Rather than re-implement the markdown parser here (and risk the two parsers
 * drifting), we assert:
 *
 *   1. POSTGRES_SCHEMA is structurally identical to MEMORY_SCHEMA
 *      (same entities, same columns, same flags, same constraint names).
 *   2. PostgresStorage.describeSchema() returns POSTGRES_SCHEMA.
 *
 * Since the memory adapter's parity test guarantees MEMORY_SCHEMA matches the
 * markdown fixture, transitivity gives us: POSTGRES_SCHEMA also matches the
 * fixture. If the fixture changes and only one adapter is updated, the
 * structural-identity assertion here fires and flags the divergence. This is
 * the invariant called out in `src/schema.ts`.
 */

import { describe, expect, it } from 'bun:test';

import type { SchemaDescription } from '@anorebel/licensing/storage';
import { MEMORY_SCHEMA } from '@anorebel/licensing/storage/memory';
import type { Pool } from 'pg';

import { POSTGRES_SCHEMA, PostgresStorage } from '../../src/storage/postgres/index.ts';

/** Deeply normalize a schema description so `toEqual` compares by value, not
 *  by array identity or column order within an entity. Keeping entity order
 *  meaningful (licenses first, etc.) is the convention of both adapters, so
 *  that stays intact. */
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

describe('storage-postgres schema parity', () => {
  it('POSTGRES_SCHEMA is structurally identical to MEMORY_SCHEMA', () => {
    expect(normalize(POSTGRES_SCHEMA)).toEqual(normalize(MEMORY_SCHEMA));
  });

  it('describeSchema() returns POSTGRES_SCHEMA', () => {
    // Pass a fake pool — describeSchema() must not touch it.
    const fakePool = {} as unknown as Pool;
    const storage = new PostgresStorage(fakePool);
    expect(storage.describeSchema()).toBe(POSTGRES_SCHEMA);
  });

  it('entity names match (order-preserving)', () => {
    const pgNames = POSTGRES_SCHEMA.map((e) => e.name);
    const memNames = MEMORY_SCHEMA.map((e) => e.name);
    expect(pgNames).toEqual(memNames);
  });
});
