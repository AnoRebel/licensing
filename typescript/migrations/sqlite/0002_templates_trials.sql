-- 0002_templates_trials.sql — extend v0001 with template hierarchy, trial
-- bookkeeping, and a licensable lookup index.
--
-- Schema doc: fixtures/schema/entities.md (v0002 entries, also marked in §1, §3, §7).
--
-- Idempotence model differs from Postgres: SQLite's ALTER TABLE ADD COLUMN
-- does NOT support `IF NOT EXISTS`. The migrations runner's
-- `_licensing_migrations` table guards against re-application, so each ALTER
-- runs at most once. CREATE INDEX/TABLE statements still use IF NOT EXISTS for
-- defence in depth.
--
-- SQLite cannot add CHECK constraints to an existing table via ALTER; the
-- equivalent of trial_cooldown_sec's range check is enforced at the adapter
-- layer (matching v0001's pattern of moving regex CHECKs to application code).

-- 1. licenses.is_trial
ALTER TABLE licenses
  ADD COLUMN is_trial INTEGER NOT NULL DEFAULT 0;

-- 2. (licensable_type, licensable_id) lookup index
CREATE INDEX IF NOT EXISTS licenses_licensable_type_id_idx
  ON licenses (licensable_type, licensable_id);

-- 3. license_templates.parent_id (self-FK, ON DELETE RESTRICT).
--    SQLite ALTER TABLE supports adding a column with REFERENCES; cycles are
--    rejected at the adapter layer pre-write (the storage spec requires
--    cycle detection at write time and the adapter layer is the
--    cross-adapter location for that check).
ALTER TABLE license_templates
  ADD COLUMN parent_id TEXT
    REFERENCES license_templates(id) ON DELETE RESTRICT;

-- 4. license_templates.trial_cooldown_sec (range check enforced in adapter).
ALTER TABLE license_templates
  ADD COLUMN trial_cooldown_sec INTEGER;

-- 5. trial_issuances table
CREATE TABLE IF NOT EXISTS trial_issuances (
  id               TEXT    PRIMARY KEY,
  template_id      TEXT    REFERENCES license_templates(id) ON DELETE RESTRICT,
  fingerprint_hash TEXT    NOT NULL,
  issued_at        TEXT    NOT NULL,
  CONSTRAINT trial_issuances_fingerprint_hash_len
    CHECK (length(fingerprint_hash) = 64)
);

-- 6. NULLS-NOT-DISTINCT emulation via split partial unique indexes.
CREATE UNIQUE INDEX IF NOT EXISTS trial_issuances_template_fp_key
  ON trial_issuances (template_id, fingerprint_hash)
  WHERE template_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS trial_issuances_global_fp_key
  ON trial_issuances (fingerprint_hash)
  WHERE template_id IS NULL;

-- 7. issued_at index for cleanup queries
CREATE INDEX IF NOT EXISTS trial_issuances_issued_at_idx
  ON trial_issuances (issued_at);
