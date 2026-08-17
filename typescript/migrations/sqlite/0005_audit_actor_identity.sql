-- actor_kind / actor_id — see the Postgres twin for the rationale.
--
-- SQLite cannot add a NOT NULL column without a constant default, cannot
-- promote a column to NOT NULL afterwards, and cannot add a CHECK
-- constraint to an existing table. The column is therefore added nullable
-- and backfilled; readers coalesce a NULL to 'unknown', so a row written
-- by an older binary behaves identically to a migrated one. The enum is
-- enforced in application code on the write path for both adapters, which
-- is where a bad value would originate anyway.
ALTER TABLE audit_logs
  ADD COLUMN actor_kind TEXT;

ALTER TABLE audit_logs
  ADD COLUMN actor_id TEXT;

UPDATE audit_logs
  SET actor_kind = CASE
    WHEN actor = 'system' OR actor LIKE 'system:%' THEN 'system'
    WHEN actor = 'admin'  OR actor LIKE 'admin:%'  THEN 'admin'
    ELSE 'unknown'
  END
  WHERE actor_kind IS NULL;

-- "Everything this operator did", the query the split exists to enable.
CREATE INDEX IF NOT EXISTS audit_logs_actor_identity_idx
  ON audit_logs (actor_kind, actor_id, occurred_at DESC);
