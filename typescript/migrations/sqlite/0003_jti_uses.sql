-- jti_uses: optional replay-prevention ledger for online verifiers.
-- Each row records that a token's jti has been validated; a second
-- validate of the same jti is rejected with TokenReplayed before the
-- result is returned. The table is opt-in and only consulted when the
-- caller wires a JtiLedger into ValidateOptions.
--
-- Schema is intentionally minimal:
--   jti           — token's `jti` claim (PRIMARY KEY enforces uniqueness)
--   expires_at    — unix seconds at which the row may be pruned
--                   (typically the token's `exp` + skew)
--
-- Pruning is operator-driven via JtiLedger.PruneExpired(); the table
-- never auto-vacuums.

CREATE TABLE IF NOT EXISTS jti_uses (
    jti        TEXT    PRIMARY KEY,
    expires_at INTEGER NOT NULL CHECK (expires_at > 0)
);

CREATE INDEX IF NOT EXISTS idx_jti_uses_expires_at ON jti_uses(expires_at);
