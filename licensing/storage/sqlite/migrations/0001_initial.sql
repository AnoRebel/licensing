-- 0001_initial.sql — SQLite realisation of the canonical licensing schema.
--
-- IDEMPOTENT: every object uses `IF NOT EXISTS` so running this file twice
-- is a no-op.
--
-- Type mapping (SQLite is dynamically typed; we use type affinities):
--   uuid v7      → TEXT          (36-char canonical string)
--   timestamptz  → TEXT          (ISO-8601 microsecond strings, lex-sortable
--                                 and matching the core's `Instant` contract)
--   string       → TEXT          (length CHECK constraints enforce caps)
--   int          → INTEGER
--   enum         → TEXT + CHECK
--   json / json object → TEXT    (JSON string; adapter does JSON.parse/stringify)
--   text         → TEXT
--
-- Differences from the Postgres migration:
--   - `char_length(x)` → `length(x)` (same semantics for ASCII; our inputs are
--     base64url/ASCII-ish so this is fine).
--   - Regex CHECKs (`slug ~ '…'`, `fingerprint ~ '^[0-9a-f]{64}$'`) are dropped;
--     the adapter validates input shapes before insert (same layer, different
--     location — SQLite has no core REGEXP operator without an extension).
--   - `RAISE EXCEPTION` → `RAISE(ABORT, ...)`. The adapter's error mapper
--     detects the 'ImmutableAuditLog' prefix identically.
--   - `REFERENCES … ON DELETE RESTRICT` — SQLite enforces FKs only if
--     `PRAGMA foreign_keys = ON` is set. The adapter sets this on every
--     connection.
--   - Partial UNIQUE indexes work identically to Postgres.
--
-- All NULLS-NOT-DISTINCT emulation uses split partial indexes exactly as in
-- the Postgres migration — SQLite has the same NULL-distinct-by-default
-- behavior in unique indexes.

CREATE TABLE IF NOT EXISTS license_scopes (
  id         TEXT    PRIMARY KEY,
  slug       TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  meta       TEXT    NOT NULL DEFAULT '{}',
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,
  CONSTRAINT license_scopes_slug_len CHECK (length(slug) <= 64),
  CONSTRAINT license_scopes_name_len CHECK (length(name) <= 128)
);

CREATE UNIQUE INDEX IF NOT EXISTS license_scopes_slug_key ON license_scopes (slug);

CREATE TABLE IF NOT EXISTS license_templates (
  id                     TEXT    PRIMARY KEY,
  scope_id               TEXT    REFERENCES license_scopes(id) ON DELETE RESTRICT,
  name                   TEXT    NOT NULL,
  max_usages             INTEGER NOT NULL,
  trial_duration_sec     INTEGER NOT NULL,
  grace_duration_sec     INTEGER NOT NULL,
  force_online_after_sec INTEGER,
  entitlements           TEXT    NOT NULL DEFAULT '{}',
  meta                   TEXT    NOT NULL DEFAULT '{}',
  created_at             TEXT    NOT NULL,
  updated_at             TEXT    NOT NULL,
  CONSTRAINT license_templates_name_len   CHECK (length(name) <= 128),
  CONSTRAINT license_templates_max_usages CHECK (max_usages >= 1),
  CONSTRAINT license_templates_trial_sec  CHECK (trial_duration_sec >= 0),
  CONSTRAINT license_templates_grace_sec  CHECK (grace_duration_sec >= 0),
  CONSTRAINT license_templates_force_sec  CHECK (force_online_after_sec IS NULL OR force_online_after_sec >= 0)
);

-- (scope_id, name) unique with NULLS NOT DISTINCT semantics via split partial
-- indexes.
CREATE UNIQUE INDEX IF NOT EXISTS license_templates_scope_name_key
  ON license_templates (scope_id, name)
  WHERE scope_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS license_templates_global_name_key
  ON license_templates (name)
  WHERE scope_id IS NULL;

CREATE TABLE IF NOT EXISTS licenses (
  id              TEXT    PRIMARY KEY,
  scope_id        TEXT    REFERENCES license_scopes(id) ON DELETE RESTRICT,
  template_id     TEXT    REFERENCES license_templates(id) ON DELETE RESTRICT,
  licensable_type TEXT    NOT NULL,
  licensable_id   TEXT    NOT NULL,
  license_key     TEXT    NOT NULL,
  status          TEXT    NOT NULL,
  max_usages      INTEGER NOT NULL,
  activated_at    TEXT,
  expires_at      TEXT,
  grace_until     TEXT,
  meta            TEXT    NOT NULL DEFAULT '{}',
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  CONSTRAINT licenses_licensable_type_len CHECK (length(licensable_type) <= 128),
  CONSTRAINT licenses_licensable_id_len   CHECK (length(licensable_id)   <= 128),
  CONSTRAINT licenses_status_enum CHECK (status IN (
    'pending', 'active', 'grace', 'expired', 'suspended', 'revoked'
  )),
  CONSTRAINT licenses_max_usages CHECK (max_usages >= 1),
  CONSTRAINT licenses_grace_after_expiry CHECK (
    grace_until IS NULL OR expires_at IS NULL OR grace_until > expires_at
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS licenses_license_key_key ON licenses (license_key);
CREATE UNIQUE INDEX IF NOT EXISTS licenses_scoped_triple_key
  ON licenses (licensable_type, licensable_id, scope_id)
  WHERE scope_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS licenses_global_pair_key
  ON licenses (licensable_type, licensable_id)
  WHERE scope_id IS NULL;

CREATE INDEX IF NOT EXISTS licenses_scope_status_idx ON licenses (scope_id, status);
CREATE INDEX IF NOT EXISTS licenses_expires_at_idx   ON licenses (expires_at);

CREATE TABLE IF NOT EXISTS license_usages (
  id             TEXT    PRIMARY KEY,
  license_id     TEXT    NOT NULL REFERENCES licenses(id) ON DELETE RESTRICT,
  fingerprint    TEXT    NOT NULL,
  status         TEXT    NOT NULL,
  registered_at  TEXT    NOT NULL,
  revoked_at     TEXT,
  client_meta    TEXT    NOT NULL DEFAULT '{}',
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  CONSTRAINT license_usages_fingerprint_len CHECK (length(fingerprint) = 64),
  CONSTRAINT license_usages_status_enum CHECK (status IN ('active', 'revoked'))
);

CREATE UNIQUE INDEX IF NOT EXISTS license_usages_active_fp_key
  ON license_usages (license_id, fingerprint)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS license_usages_license_status_idx
  ON license_usages (license_id, status);

CREATE TABLE IF NOT EXISTS license_keys (
  id                TEXT    PRIMARY KEY,
  scope_id          TEXT    REFERENCES license_scopes(id) ON DELETE RESTRICT,
  kid               TEXT    NOT NULL,
  alg               TEXT    NOT NULL,
  role              TEXT    NOT NULL,
  state             TEXT    NOT NULL,
  public_pem        TEXT    NOT NULL,
  private_pem_enc   TEXT,
  rotated_from      TEXT    REFERENCES license_keys(id) ON DELETE SET NULL,
  rotated_at        TEXT,
  not_before        TEXT    NOT NULL,
  not_after         TEXT,
  meta              TEXT    NOT NULL DEFAULT '{}',
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  CONSTRAINT license_keys_kid_len    CHECK (length(kid) <= 64),
  CONSTRAINT license_keys_alg_enum   CHECK (alg   IN ('ed25519', 'rs256-pss', 'hs256')),
  CONSTRAINT license_keys_role_enum  CHECK (role  IN ('root', 'signing')),
  CONSTRAINT license_keys_state_enum CHECK (state IN ('active', 'retiring')),
  CONSTRAINT license_keys_not_after_after_nbf CHECK (
    not_after IS NULL OR not_after > not_before
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS license_keys_kid_key ON license_keys (kid);

-- One active signing key per scope, NULLS NOT DISTINCT via split indexes.
CREATE UNIQUE INDEX IF NOT EXISTS license_keys_active_signing_scoped_key
  ON license_keys (scope_id)
  WHERE state = 'active' AND role = 'signing' AND scope_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS license_keys_active_signing_global_key
  ON license_keys (role)
  WHERE state = 'active' AND role = 'signing' AND scope_id IS NULL;

CREATE TABLE IF NOT EXISTS audit_logs (
  id           TEXT    PRIMARY KEY,
  license_id   TEXT    REFERENCES licenses(id) ON DELETE SET NULL,
  scope_id     TEXT    REFERENCES license_scopes(id) ON DELETE SET NULL,
  actor        TEXT    NOT NULL,
  event        TEXT    NOT NULL,
  prior_state  TEXT,
  new_state    TEXT,
  occurred_at  TEXT    NOT NULL,
  CONSTRAINT audit_logs_actor_len CHECK (length(actor) <= 256),
  CONSTRAINT audit_logs_event_len CHECK (length(event) <= 128)
);

CREATE INDEX IF NOT EXISTS audit_logs_license_occurred_idx
  ON audit_logs (license_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_scope_occurred_idx
  ON audit_logs (scope_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_event_occurred_idx
  ON audit_logs (event, occurred_at DESC);

-- AuditLog immutability: BEFORE UPDATE/DELETE triggers raise with a message
-- the adapter's error mapper recognises (`ImmutableAuditLog` prefix).
CREATE TRIGGER IF NOT EXISTS audit_logs_no_update
  BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'ImmutableAuditLog: audit rows are append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_logs_no_delete
  BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'ImmutableAuditLog: audit rows are append-only');
END;
