-- last_seen_at: liveness signal for a license usage (seat).
--
-- /heartbeat previously validated a token and returned {ok:true} without
-- recording anything, so a seat held by a decommissioned device was
-- indistinguishable from one in daily use. Operators could only reclaim it
-- by manually revoking the usage, which on a max_usages-constrained
-- license is a support burden.
--
-- Backfilled to registered_at rather than NULL: a usage that has never
-- sent a heartbeat was last known alive when it registered, so an
-- inactivity sweep measured from that instant is correct on day one and
-- needs no "has it ever reported?" special case. NOT NULL keeps the
-- sweep query a plain comparison.
ALTER TABLE license_usages
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

UPDATE license_usages
  SET last_seen_at = registered_at
  WHERE last_seen_at IS NULL;

ALTER TABLE license_usages
  ALTER COLUMN last_seen_at SET NOT NULL;

-- Sweeps scan active rows ordered by staleness; the partial index keeps
-- that cheap without carrying revoked rows we never sweep.
CREATE INDEX IF NOT EXISTS license_usages_active_last_seen_idx
  ON license_usages (last_seen_at)
  WHERE status = 'active';
