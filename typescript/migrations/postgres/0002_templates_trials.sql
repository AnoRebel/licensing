-- 0002_templates_trials.sql — extend v0001 with template hierarchy, trial
-- bookkeeping, and a licensable lookup index.
--
-- Schema doc: fixtures/schema/entities.md (v0002 entries, also marked in §1, §3, §7).
--
-- IDEMPOTENT: every change uses `IF NOT EXISTS` so the migration runner can
-- replay it safely (it normally won't, thanks to `_licensing_migrations`, but
-- defence in depth costs nothing).
--
-- Additions (no removals, no renames):
--   1. licenses.is_trial            — bool, NOT NULL, default false.
--   2. licenses_licensable_type_id_idx
--                                   — non-unique index on
--                                     (licensable_type, licensable_id).
--   3. license_templates.parent_id  — uuid, nullable, FK → license_templates(id)
--                                     ON DELETE RESTRICT (self-referential).
--   4. license_templates.trial_cooldown_sec
--                                   — int, nullable, ≥ 0.
--   5. trial_issuances              — new table tracking trial dedupe per
--                                     (template_id, fingerprint_hash).
--   6. Split partial unique indexes on trial_issuances for NULLS-NOT-DISTINCT
--      semantics on template_id.
--   7. trial_issuances_issued_at_idx — non-unique index for cleanup queries.

-- 1. licenses.is_trial
ALTER TABLE licenses
  ADD COLUMN IF NOT EXISTS is_trial boolean NOT NULL DEFAULT false;

-- 2. (licensable_type, licensable_id) lookup index
CREATE INDEX IF NOT EXISTS licenses_licensable_type_id_idx
  ON licenses (licensable_type, licensable_id);

-- 3. license_templates.parent_id (self-FK).
--    ADD COLUMN with REFERENCES is supported on Postgres ≥ 11 in a single
--    statement. ON DELETE RESTRICT prevents orphaning a child template by
--    deleting its parent — admins must clear the chain explicitly.
ALTER TABLE license_templates
  ADD COLUMN IF NOT EXISTS parent_id uuid
    REFERENCES license_templates(id) ON DELETE RESTRICT;

-- 4. license_templates.trial_cooldown_sec
ALTER TABLE license_templates
  ADD COLUMN IF NOT EXISTS trial_cooldown_sec integer;

-- The CHECK constraint can't use IF NOT EXISTS in standard Postgres, so we
-- add it conditionally via DO block. This keeps the migration replay-safe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'license_templates_trial_cooldown_sec'
  ) THEN
    ALTER TABLE license_templates
      ADD CONSTRAINT license_templates_trial_cooldown_sec
      CHECK (trial_cooldown_sec IS NULL OR trial_cooldown_sec >= 0);
  END IF;
END $$;

-- 5. trial_issuances table
CREATE TABLE IF NOT EXISTS trial_issuances (
  id               uuid          PRIMARY KEY,
  template_id      uuid          REFERENCES license_templates(id) ON DELETE RESTRICT,
  fingerprint_hash text          NOT NULL,
  issued_at        timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT trial_issuances_fingerprint_hash_len
    CHECK (char_length(fingerprint_hash) = 64),
  CONSTRAINT trial_issuances_fingerprint_hash_hex
    CHECK (fingerprint_hash ~ '^[0-9a-f]{64}$')
);

-- 6. NULLS-NOT-DISTINCT emulation via split partial unique indexes — the same
-- pattern v0001 uses for license_templates(scope_id, name).
CREATE UNIQUE INDEX IF NOT EXISTS trial_issuances_template_fp_key
  ON trial_issuances (template_id, fingerprint_hash)
  WHERE template_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS trial_issuances_global_fp_key
  ON trial_issuances (fingerprint_hash)
  WHERE template_id IS NULL;

-- 7. issued_at index for cleanup queries
CREATE INDEX IF NOT EXISTS trial_issuances_issued_at_idx
  ON trial_issuances (issued_at);
