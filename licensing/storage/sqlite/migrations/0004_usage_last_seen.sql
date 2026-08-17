-- last_seen_at: liveness signal for a license usage (seat).
--
-- See the Postgres twin for the rationale. SQLite cannot add a NOT NULL
-- column without a constant default, and cannot promote a column to NOT
-- NULL afterwards, so the column is added nullable and backfilled from
-- registered_at. Readers coalesce NULL to registered_at, which keeps a
-- row written by an older binary behaving identically to a migrated one.
ALTER TABLE license_usages
  ADD COLUMN last_seen_at TEXT;

UPDATE license_usages
  SET last_seen_at = registered_at
  WHERE last_seen_at IS NULL;

-- Sweeps scan active rows ordered by staleness; the partial index keeps
-- that cheap without carrying revoked rows we never sweep.
CREATE INDEX IF NOT EXISTS license_usages_active_last_seen_idx
  ON license_usages (last_seen_at)
  WHERE status = 'active';
