/**
 * SQLite JtiLedger conformance.
 *
 * Mirrors the in-memory reference suite in tests/client/jti-ledger.test.ts;
 * SQLite-specific concurrency posture (writers serialize automatically) is
 * also exercised by the contended-record test.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';

import { SqliteJtiLedger } from '../../src/storage/sqlite/jti-ledger.ts';
import { applyMigrations } from '../../src/storage/sqlite/migrations.ts';

function fresh(): { db: Database; l: SqliteJtiLedger } {
  const db = new Database(':memory:');
  applyMigrations(db);
  return { db, l: new SqliteJtiLedger(db) };
}

describe('SqliteJtiLedger', () => {
  it('first use is recorded and reported as first', async () => {
    const { l } = fresh();
    expect(await l.recordJtiUse('jti-a', 2_000_000_100)).toBe(true);
  });

  it('second use of the same jti is rejected', async () => {
    const { l } = fresh();
    await l.recordJtiUse('jti-a', 2_000_000_100);
    expect(await l.recordJtiUse('jti-a', 2_000_000_100)).toBe(false);
  });

  it('distinct jtis coexist as first-use', async () => {
    const { l } = fresh();
    for (const jti of ['a', 'b', 'c']) {
      expect(await l.recordJtiUse(jti, 2_000_000_100)).toBe(true);
    }
  });

  it('pruneExpired removes rows whose expires_at ≤ nowSec', async () => {
    const { l } = fresh();
    await l.recordJtiUse('expired-1', 100);
    await l.recordJtiUse('expired-2', 200);
    await l.recordJtiUse('alive', 9_000_000_000);
    expect(await l.pruneExpired(500)).toBe(2);
    expect(await l.pruneExpired(500)).toBe(0); // idempotent
  });

  it('pruneExpired boundary is inclusive', async () => {
    const { l } = fresh();
    await l.recordJtiUse('exact', 1_000);
    expect(await l.pruneExpired(1_000)).toBe(1);
  });

  it('pruned jti can be re-recorded as first-use', async () => {
    const { l } = fresh();
    await l.recordJtiUse('rotated', 100);
    await l.pruneExpired(500);
    expect(await l.recordJtiUse('rotated', 9_000_000_000)).toBe(true);
  });

  it('contended writes produce exactly one first-use winner', async () => {
    // Drive 50 parallel records of the same jti; SQLite serializes
    // writers via the unique constraint, so exactly one MUST win.
    const { l } = fresh();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => l.recordJtiUse('contended', 2_000_000_100)),
    );
    const firsts = results.filter((r) => r === true).length;
    expect(firsts).toBe(1);
  });
});
