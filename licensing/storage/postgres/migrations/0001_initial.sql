-- 0001_initial.sql — canonical schema for the licensing adapter.
--
-- IDEMPOTENT: every object uses `IF NOT EXISTS` or equivalent so running
-- this file twice is a no-op (spec `licensing-storage > Migration is
-- idempotent`). Schema shape is authoritative in `fixtures/schema/entities.md`;
-- this file is the Postgres realisation of that document.
--
-- Type mapping:
--   uuid v7      → uuid
--   timestamptz  → timestamptz    (microsecond precision preserved)
--   string       → text           (length CHECK constraints enforce caps)
--   int          → integer        (32-bit signed is sufficient for all int fields)
--   enum         → text + CHECK   (we use CHECK constraints instead of
--                                  Postgres ENUM types to keep schema changes
--                                  cheap — adding a new status doesn't need
--                                  ALTER TYPE gymnastics)
--   json / json object → jsonb
--   text         → text           (unbounded, used for PEM bodies)
--
-- AuditLog immutability: enforced via a BEFORE UPDATE/DELETE trigger that
-- RAISES EXCEPTION with a SQLSTATE carrying the `ImmutableAuditLog` code.
-- The adapter's error mapper translates that into `errors.immutableAuditLog()`.

CREATE TABLE IF NOT EXISTS license_scopes (
  id         uuid          PRIMARY KEY,
  slug       text          NOT NULL,
  name       text          NOT NULL,
  meta       jsonb         NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz   NOT NULL DEFAULT now(),
  updated_at timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT license_scopes_slug_len   CHECK (char_length(slug) <= 64),
  CONSTRAINT license_scopes_name_len   CHECK (char_length(name) <= 128),
  CONSTRAINT license_scopes_slug_shape CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$')
);

CREATE UNIQUE INDEX IF NOT EXISTS license_scopes_slug_key ON license_scopes (slug);

CREATE TABLE IF NOT EXISTS license_templates (
  id                     uuid         PRIMARY KEY,
  scope_id               uuid         REFERENCES license_scopes(id) ON DELETE RESTRICT,
  name                   text         NOT NULL,
  max_usages             integer      NOT NULL,
  trial_duration_sec     integer      NOT NULL,
  grace_duration_sec     integer      NOT NULL,
  force_online_after_sec integer,
  entitlements           jsonb        NOT NULL DEFAULT '{}'::jsonb,
  meta                   jsonb        NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz  NOT NULL DEFAULT now(),
  updated_at             timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT license_templates_name_len   CHECK (char_length(name) <= 128),
  CONSTRAINT license_templates_max_usages CHECK (max_usages >= 1),
  CONSTRAINT license_templates_trial_sec  CHECK (trial_duration_sec >= 0),
  CONSTRAINT license_templates_grace_sec  CHECK (grace_duration_sec >= 0),
  CONSTRAINT license_templates_force_sec  CHECK (force_online_after_sec IS NULL OR force_online_after_sec >= 0)
);

-- `(scope_id, name)` unique — Postgres unique indexes use NULLS DISTINCT by
-- default (pre-15) or NULLS NOT DISTINCT (15+). The spec requires NULLS NOT
-- DISTINCT semantics ("null scope_id is treated as the global scope"). We
-- emulate that by adding a partial index on `scope_id IS NULL`.
CREATE UNIQUE INDEX IF NOT EXISTS license_templates_scope_name_key
  ON license_templates (scope_id, name)
  WHERE scope_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS license_templates_global_name_key
  ON license_templates (name)
  WHERE scope_id IS NULL;

CREATE TABLE IF NOT EXISTS licenses (
  id              uuid         PRIMARY KEY,
  scope_id        uuid         REFERENCES license_scopes(id) ON DELETE RESTRICT,
  template_id     uuid         REFERENCES license_templates(id) ON DELETE RESTRICT,
  licensable_type text         NOT NULL,
  licensable_id   text         NOT NULL,
  license_key     text         NOT NULL,
  status          text         NOT NULL,
  max_usages      integer      NOT NULL,
  activated_at    timestamptz,
  expires_at      timestamptz,
  grace_until     timestamptz,
  meta            jsonb        NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT licenses_licensable_type_len CHECK (char_length(licensable_type) <= 128),
  CONSTRAINT licenses_licensable_id_len   CHECK (char_length(licensable_id)   <= 128),
  CONSTRAINT licenses_status_enum CHECK (status IN (
    'pending', 'active', 'grace', 'expired', 'suspended', 'revoked'
  )),
  CONSTRAINT licenses_max_usages CHECK (max_usages >= 1),
  CONSTRAINT licenses_grace_after_expiry CHECK (
    grace_until IS NULL OR expires_at IS NULL OR grace_until > expires_at
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS licenses_license_key_key ON licenses (license_key);
-- (licensable_type, licensable_id, scope_id) unique triple, NULLS NOT
-- DISTINCT semantics via split indexes.
CREATE UNIQUE INDEX IF NOT EXISTS licenses_scoped_triple_key
  ON licenses (licensable_type, licensable_id, scope_id)
  WHERE scope_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS licenses_global_pair_key
  ON licenses (licensable_type, licensable_id)
  WHERE scope_id IS NULL;

CREATE INDEX IF NOT EXISTS licenses_scope_status_idx ON licenses (scope_id, status);
CREATE INDEX IF NOT EXISTS licenses_expires_at_idx   ON licenses (expires_at);

CREATE TABLE IF NOT EXISTS license_usages (
  id             uuid         PRIMARY KEY,
  license_id     uuid         NOT NULL REFERENCES licenses(id) ON DELETE RESTRICT,
  fingerprint    text         NOT NULL,
  status         text         NOT NULL,
  registered_at  timestamptz  NOT NULL,
  revoked_at     timestamptz,
  client_meta    jsonb        NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz  NOT NULL DEFAULT now(),
  updated_at     timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT license_usages_fingerprint_len   CHECK (char_length(fingerprint) = 64),
  CONSTRAINT license_usages_fingerprint_hex   CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT license_usages_status_enum CHECK (status IN ('active', 'revoked'))
);

-- Partial unique: one active usage per (license, fingerprint).
CREATE UNIQUE INDEX IF NOT EXISTS license_usages_active_fp_key
  ON license_usages (license_id, fingerprint)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS license_usages_license_status_idx
  ON license_usages (license_id, status);

CREATE TABLE IF NOT EXISTS license_keys (
  id                uuid         PRIMARY KEY,
  scope_id          uuid         REFERENCES license_scopes(id) ON DELETE RESTRICT,
  kid               text         NOT NULL,
  alg               text         NOT NULL,
  role              text         NOT NULL,
  state             text         NOT NULL,
  public_pem        text         NOT NULL,
  private_pem_enc   text,
  rotated_from      uuid         REFERENCES license_keys(id) ON DELETE SET NULL,
  rotated_at        timestamptz,
  not_before        timestamptz  NOT NULL,
  not_after         timestamptz,
  meta              jsonb        NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT license_keys_kid_len   CHECK (char_length(kid) <= 64),
  CONSTRAINT license_keys_alg_enum   CHECK (alg   IN ('ed25519', 'rs256-pss', 'hs256')),
  CONSTRAINT license_keys_role_enum  CHECK (role  IN ('root', 'signing')),
  CONSTRAINT license_keys_state_enum CHECK (state IN ('active', 'retiring')),
  CONSTRAINT license_keys_not_after_after_nbf CHECK (
    not_after IS NULL OR not_after > not_before
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS license_keys_kid_key ON license_keys (kid);

-- Partial unique: exactly one active SIGNING key per scope. Predicate must
-- also cover the NULL-scope "global" case via the same partial index (NULL
-- groups share a single index slot under the WHERE clause because the
-- coalesced predicate doesn't discriminate on scope_id value alone).
-- Split into two indexes to get NULLS NOT DISTINCT semantics.
CREATE UNIQUE INDEX IF NOT EXISTS license_keys_active_signing_scoped_key
  ON license_keys (scope_id)
  WHERE state = 'active' AND role = 'signing' AND scope_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS license_keys_active_signing_global_key
  ON license_keys ((0))
  WHERE state = 'active' AND role = 'signing' AND scope_id IS NULL;

CREATE TABLE IF NOT EXISTS audit_logs (
  id           uuid         PRIMARY KEY,
  license_id   uuid         REFERENCES licenses(id) ON DELETE SET NULL,
  scope_id     uuid         REFERENCES license_scopes(id) ON DELETE SET NULL,
  actor        text         NOT NULL,
  event        text         NOT NULL,
  prior_state  jsonb,
  new_state    jsonb,
  occurred_at  timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT audit_logs_actor_len CHECK (char_length(actor) <= 256),
  CONSTRAINT audit_logs_event_len CHECK (char_length(event) <= 128)
);

CREATE INDEX IF NOT EXISTS audit_logs_license_occurred_idx
  ON audit_logs (license_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_scope_occurred_idx
  ON audit_logs (scope_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_event_occurred_idx
  ON audit_logs (event, occurred_at DESC);

-- AuditLog immutability. Any UPDATE or DELETE against `audit_logs` raises an
-- exception with SQLSTATE 'P0001' (raise_exception) and a message prefix the
-- adapter detects to translate into `ImmutableAuditLog`. The trigger covers
-- both row-level and set-level operations.
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ImmutableAuditLog: audit rows are append-only'
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs;
CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

DROP TRIGGER IF EXISTS audit_logs_no_delete ON audit_logs;
CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
