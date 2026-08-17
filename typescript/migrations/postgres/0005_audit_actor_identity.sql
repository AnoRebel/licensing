-- actor_kind / actor_id: split audit attribution into "what kind of
-- principal did this" and "which one".
--
-- `actor` was a single free-form string carrying both concepts at once —
-- "system", "admin", "admin:renew". That answers "was this automatic or
-- operator-driven?" only by string-matching, and cannot answer "WHICH
-- operator?" at all, so a multi-operator deployment could not attribute an
-- action to a person.
--
-- `actor` is deliberately kept and still required. It stays the
-- human-readable label, so existing rows, queries, and the admin UI keep
-- working unchanged; the new columns are additive detail.
--
-- Backfill derives the kind from the legacy label rather than defaulting
-- everything to 'system', which would have mislabelled every historical
-- admin action.
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS actor_kind text,
  ADD COLUMN IF NOT EXISTS actor_id   text;

UPDATE audit_logs
  SET actor_kind = CASE
    WHEN actor = 'system' OR actor LIKE 'system:%' THEN 'system'
    WHEN actor = 'admin'  OR actor LIKE 'admin:%'  THEN 'admin'
    ELSE 'unknown'
  END
  WHERE actor_kind IS NULL;

ALTER TABLE audit_logs
  ALTER COLUMN actor_kind SET NOT NULL;

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_actor_kind_enum
    CHECK (actor_kind IN ('system', 'admin', 'client', 'unknown'));

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_actor_id_len CHECK (actor_id IS NULL OR char_length(actor_id) <= 256);

-- "Everything this operator did", the query the split exists to enable.
CREATE INDEX IF NOT EXISTS audit_logs_actor_identity_idx
  ON audit_logs (actor_kind, actor_id, occurred_at DESC);
