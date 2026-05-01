/**
 * Replay-prevention ledger.
 *
 * The ledger is the optional, opt-in layer that closes the
 * replay-within-`exp` gap for online verifiers. When wired into
 * `validate()` via `ValidateOptions.jtiLedger`, the verifier records each
 * token's jti after every other check has passed; a second validate of
 * the same token surfaces `LicensingClientError{code: 'TokenReplayed'}`.
 *
 * The ledger is meaningful only for online verifiers — offline clients
 * cannot consult a shared store, so the protocol's offline-first use
 * case ignores this layer entirely. Verifiers that DO have storage
 * reach (server-side validators, online activation paths) gain
 * per-trust-domain replay protection at the cost of one ledger lookup
 * per validate.
 *
 * Implementations MUST be safe for concurrent use. The `MemoryJtiLedger`
 * here is sized for single-instance verifiers and tests; multi-instance
 * deployments need a shared backing store (Postgres, SQLite, Redis, …)
 * — ship your own implementation in that case.
 */

export interface JtiLedger {
  /**
   * Record that `jti` has been used. Returns `true` when this is the
   * first time the ledger has seen this jti — caller proceeds. Returns
   * `false` when the jti was already recorded — caller MUST reject the
   * token with `TokenReplayed`.
   *
   * `expSec` is the unix-seconds at which the entry MAY be pruned
   * (typically the token's `exp` + skew). Implementations are NOT
   * required to enforce expiry on read — the token's own `exp` claim
   * already does. `expSec` is purely a hint for pruning so the ledger
   * doesn't grow without bound.
   */
  recordJtiUse(jti: string, expSec: number): Promise<boolean>;

  /**
   * Remove entries whose `expSec ≤ nowSec`. Returns the number of
   * entries removed. Operators MAY call this from their own scheduler;
   * the ledger does NOT prune on its own — first because pruning is
   * operator policy (some want to keep history for audit), second
   * because lazy pruning makes recordJtiUse latency unpredictable.
   * Implementations MUST be idempotent.
   */
  pruneExpired(nowSec: number): Promise<number>;
}

/**
 * In-process JtiLedger backed by a Map. Suitable for single-instance
 * verifiers and for tests. Multi-instance deployments need a shared
 * backing store (Postgres, SQLite, Redis, …); ship your own JtiLedger
 * implementation in that case.
 */
export class MemoryJtiLedger implements JtiLedger {
  readonly #entries = new Map<string, number>();

  async recordJtiUse(jti: string, expSec: number): Promise<boolean> {
    if (this.#entries.has(jti)) return false;
    this.#entries.set(jti, expSec);
    return true;
  }

  async pruneExpired(nowSec: number): Promise<number> {
    let removed = 0;
    for (const [jti, exp] of this.#entries) {
      if (exp <= nowSec) {
        this.#entries.delete(jti);
        removed++;
      }
    }
    return removed;
  }

  /** Current entry count — useful for tests and operator metrics. */
  get size(): number {
    return this.#entries.size;
  }
}
