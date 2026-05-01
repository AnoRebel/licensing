/**
 * SQLite-backed JtiLedger adapter.
 *
 * Implements `client.JtiLedger` against the `jti_uses` table created by
 * migration `0003_jti_uses.sql`. Concurrency: bun:sqlite serializes
 * writers automatically; the ledger is safe to share across async
 * call sites. Each `recordJtiUse` is one INSERT round trip.
 *
 * Operators using the high-level `SqliteStorage` already have the
 * underlying `Database`; pull it out and pass to `new SqliteJtiLedger(db)`.
 * The migration MUST be applied before the first `recordJtiUse`.
 */

import type { Database } from 'bun:sqlite';

import type { JtiLedger } from '../../client/jti-ledger.ts';

export class SqliteJtiLedger implements JtiLedger {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Strategy: INSERT ... ON CONFLICT DO NOTHING. SQLite's
   * `Statement.run()` returns `changes` reflecting whether the insert
   * actually wrote a row. Returns `true` on fresh insert, `false` on
   * conflict.
   */
  async recordJtiUse(jti: string, expSec: number): Promise<boolean> {
    const stmt = this.#db.prepare(
      'INSERT INTO jti_uses (jti, expires_at) VALUES (?, ?) ON CONFLICT(jti) DO NOTHING',
    );
    const res = stmt.run(jti, expSec);
    return res.changes === 1;
  }

  /**
   * Removes every row whose `expires_at ≤ nowSec`. Idempotent; returns
   * the number of rows removed.
   */
  async pruneExpired(nowSec: number): Promise<number> {
    const stmt = this.#db.prepare('DELETE FROM jti_uses WHERE expires_at <= ?');
    const res = stmt.run(nowSec);
    return res.changes;
  }
}
