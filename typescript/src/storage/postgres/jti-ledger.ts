/**
 * Postgres-backed JtiLedger adapter.
 *
 * Implements `client.JtiLedger` against the `jti_uses` table created by
 * migration `0003_jti_uses.sql`. The pg `Pool` serializes per-connection
 * access; the ledger is safe to share across async call sites. Each
 * `recordJtiUse` is one INSERT round trip.
 *
 * Operators using the high-level `PostgresStorage` already have the
 * underlying `Pool`; pull it out and pass to `new PostgresJtiLedger(pool)`.
 * The migration MUST be applied before the first `recordJtiUse`.
 */

import type { Pool } from 'pg';

import type { JtiLedger } from '../../client/jti-ledger.ts';

export class PostgresJtiLedger implements JtiLedger {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * Strategy: INSERT ... ON CONFLICT DO NOTHING. The pg result's
   * `rowCount` reflects whether the insert wrote a row — 1 on fresh
   * insert, 0 on conflict. Distinguishes first-use from replay without
   * a separate SELECT.
   */
  async recordJtiUse(jti: string, expSec: number): Promise<boolean> {
    const result = await this.#pool.query(
      'INSERT INTO jti_uses (jti, expires_at) VALUES ($1, $2) ON CONFLICT (jti) DO NOTHING',
      [jti, expSec],
    );
    return result.rowCount === 1;
  }

  /**
   * Removes every row whose `expires_at ≤ nowSec`. Idempotent; returns
   * the number of rows removed.
   */
  async pruneExpired(nowSec: number): Promise<number> {
    const result = await this.#pool.query('DELETE FROM jti_uses WHERE expires_at <= $1', [nowSec]);
    return result.rowCount ?? 0;
  }
}
