# Entity schema (NORMATIVE)

Canonical field definitions shared by every storage adapter across both ports.
Task 4.4 (TS) and 9.4 (Go) load this file at test time and assert that each
adapter surfaces matching field names, types, nullability, and uniqueness.

Timestamps are always **microsecond-precision UTC** in the wire / core
representation. Adapters MAY store them at higher precision internally so
long as round-trips preserve the microsecond floor. Timestamp fields are
typed `timestamptz` in column specifications below; the core type is an
absolute instant (not a wall-clock in a named timezone).

IDs are **UUID v7** unless otherwise noted. UUID v7 is chosen so IDs are
time-sortable in indexes without a separate `created_at` sort key; the first
48 bits encode the insertion time in ms.

"Nullable?" yes means the column is nullable and the core type is optional.
"Unique?" lists the columns that participate in a `UNIQUE` index, whether
single-column or composite.

---

## 1. License

| Field             | Type                 | Nullable? | Unique?          | Notes                                                                |
| ----------------- | -------------------- | --------- | ---------------- | -------------------------------------------------------------------- |
| `id`              | uuid v7              | no        | yes (PK)         | Primary key.                                                         |
| `scope_id`        | uuid v7              | yes       | —                | FK → `license_scopes(id)`; null = global scope.                      |
| `template_id`     | uuid v7              | yes       | —                | FK → `license_templates(id)`.                                        |
| `licensable_type` | string (≤ 128 chars) | no        | composite below  | Free-form type discriminator supplied by the caller (e.g., `"User"`). |
| `licensable_id`   | string (≤ 128 chars) | no        | composite below  | Opaque identifier within `licensable_type`.                          |
| `license_key`     | string               | no        | yes (single)     | Crockford Base32, `LIC-` prefix; case-insensitive compare; stored canonicalized uppercase. |
| `status`          | enum                 | no        | —                | One of `pending`, `active`, `grace`, `expired`, `suspended`, `revoked`. |
| `max_usages`      | int (≥ 1)            | no        | —                | Seat cap enforced by `license_usages` count.                         |
| `is_trial`        | bool                 | no        | —                | Default `false`. Mirrors the `trial: true` claim emitted in trial tokens. Added in v0002. |
| `activated_at`    | timestamptz          | yes       | —                | Set when status first transitions to `active`.                       |
| `expires_at`      | timestamptz          | yes       | —                | Null = perpetual.                                                    |
| `grace_until`     | timestamptz          | yes       | —                | MUST be `> expires_at` when both set.                                |
| `meta`            | json object          | no        | —                | Default `{}`; canonical JSON rules do not apply to this field (internal). |
| `created_at`      | timestamptz          | no        | —                | Defaults to now at insert.                                           |
| `updated_at`      | timestamptz          | no        | —                | Maintained by the storage adapter on every write.                    |

Uniqueness:
- `license_key` — globally unique.
- `(licensable_type, licensable_id, scope_id)` — a licensable may hold at
  most one license per scope. The triple includes `scope_id` so the same
  user can hold distinct licenses in distinct scopes.

Indexes (non-unique, required for performance):
- `(scope_id, status)` — admin filter queries.
- `(expires_at)` — expiry-tick sweeps.
- `(licensable_type, licensable_id)` — owner-based lookups (`findByLicensable`). Added in v0002.

---

## 2. LicenseScope

| Field        | Type                 | Nullable? | Unique?  | Notes                                            |
| ------------ | -------------------- | --------- | -------- | ------------------------------------------------ |
| `id`         | uuid v7              | no        | yes (PK) |                                                  |
| `slug`       | string (≤ 64 chars)  | no        | yes      | Human-friendly identifier; `^[a-z0-9][a-z0-9-]*$`. |
| `name`       | string (≤ 128 chars) | no        | —        | Display name.                                    |
| `meta`       | json object          | no        | —        | Default `{}`.                                    |
| `created_at` | timestamptz          | no        | —        |                                                  |
| `updated_at` | timestamptz          | no        | —        |                                                  |

---

## 3. LicenseTemplate

| Field                   | Type                 | Nullable? | Unique?  | Notes                                                                 |
| ----------------------- | -------------------- | --------- | -------- | --------------------------------------------------------------------- |
| `id`                    | uuid v7              | no        | yes (PK) |                                                                       |
| `scope_id`              | uuid v7              | yes       | —        | FK → `license_scopes(id)`.                                            |
| `parent_id`             | uuid v7              | yes       | —        | FK → `license_templates(id)` ON DELETE RESTRICT. Self-referential. NULL means "no parent". A non-NULL value enables inheritance: at issue time, the resolver walks the parent chain and child-wins-deep-merges `entitlements` and `meta`. Cycles MUST be rejected at insert/update with `TemplateCycleError`. Walk depth is capped at 5 ancestors (warning logged if exceeded). Added in v0002. |
| `name`                  | string (≤ 128 chars) | no        | —        |                                                                       |
| `max_usages`            | int (≥ 1)            | no        | —        | Default for `License.max_usages`.                                     |
| `trial_duration_sec`    | int (≥ 0)            | no        | —        | 0 = no trial.                                                         |
| `trial_cooldown_sec`    | int (≥ 0)            | yes       | —        | Minimum gap between successive trials of this template against the same fingerprint. NULL = no cooldown enforced (the unique constraint on `trial_issuances` still prevents simultaneous duplicates). Added in v0002. |
| `grace_duration_sec`    | int (≥ 0)            | no        | —        | 0 = no grace.                                                         |
| `force_online_after_sec`| int (≥ 0)            | yes       | —        | Null = never force online; 0 = always force online.                   |
| `entitlements`          | json object          | no        | —        | Default `{}`; copied into `License.meta.entitlements` at creation.    |
| `meta`                  | json object          | no        | —        | Default `{}`.                                                         |
| `created_at`            | timestamptz          | no        | —        |                                                                       |
| `updated_at`            | timestamptz          | no        | —        |                                                                       |

Uniqueness:
- `(scope_id, name)` — a template name is unique within its scope. Null
  `scope_id` is treated as the global scope for uniqueness (storage-adapter
  implementations must emulate `NULLS NOT DISTINCT` semantics).

---

## 4. LicenseUsage

| Field          | Type                 | Nullable? | Unique?         | Notes                                                            |
| -------------- | -------------------- | --------- | --------------- | ---------------------------------------------------------------- |
| `id`           | uuid v7              | no        | yes (PK)        |                                                                  |
| `license_id`   | uuid v7              | no        | composite below | FK → `licenses(id)`; ON DELETE restrict.                         |
| `fingerprint`  | string (64 chars)    | no        | composite below | SHA-256 hex of the device-fingerprint input; lowercase.          |
| `status`       | enum                 | no        | —               | One of `active`, `revoked`.                                      |
| `registered_at`| timestamptz          | no        | —               |                                                                  |
| `revoked_at`   | timestamptz          | yes       | —               | Set when status transitions to `revoked`.                        |
| `client_meta`  | json object          | no        | —               | Default `{}`; opaque client-supplied hints (OS, hostname, etc.). |
| `created_at`   | timestamptz          | no        | —               |                                                                  |
| `updated_at`   | timestamptz          | no        | —               |                                                                  |

Uniqueness:
- Partial unique: `(license_id, fingerprint) WHERE status = 'active'`. A
  fingerprint may re-register on the same license after prior revocation;
  it cannot be active twice simultaneously. Adapters that lack partial-
  index support (notably SQLite's older dialects — `bun:sqlite` supports
  them via `CREATE UNIQUE INDEX ... WHERE`) must emulate this constraint
  with an application-level check inside the seat-enforcement transaction.

Indexes:
- `(license_id, status)` — seat-count queries.

---

## 5. LicenseKey (signing key storage)

Not to be confused with the human-readable `license_key` string on License.
This entity stores cryptographic signing keys managed by the issuer.

| Field           | Type                 | Nullable? | Unique?         | Notes                                                              |
| --------------- | -------------------- | --------- | --------------- | ------------------------------------------------------------------ |
| `id`            | uuid v7              | no        | yes (PK)        |                                                                    |
| `scope_id`      | uuid v7              | yes       | —               | FK → `license_scopes(id)`; null = global signing key.              |
| `kid`           | string (≤ 64 chars)  | no        | yes (single)    | Opaque, globally unique; embedded in every token header.           |
| `alg`           | enum                 | no        | —               | One of `ed25519`, `rs256-pss`, `hs256`.                            |
| `role`          | enum                 | no        | —               | One of `root`, `signing`.                                          |
| `state`         | enum                 | no        | —               | One of `active`, `retiring`. Exactly one `signing` key per `scope_id` may be `active`; root keys are always `active`. |
| `public_pem`    | text                 | no        | —               | SPKI PEM (or SPKI-equivalent for HMAC: hex-encoded secret, wrapped). |
| `private_pem_enc`| text                | yes       | —               | Encrypted PKCS#8 PEM (PBES2, AES-256-GCM). Null on verifier-only installs. |
| `rotated_from`  | uuid v7              | yes       | —               | FK → `license_keys(id)` — the key this one succeeded on rotation.  |
| `rotated_at`    | timestamptz          | yes       | —               | Set when state transitions to `retiring`.                          |
| `not_before`    | timestamptz          | no        | —               | Key MUST NOT be used for signing before this moment.               |
| `not_after`     | timestamptz          | yes       | —               | Null = no upper bound; signing SHALL stop before this if set.      |
| `meta`          | json object          | no        | —               | Default `{}`.                                                      |
| `created_at`    | timestamptz          | no        | —               |                                                                    |
| `updated_at`    | timestamptz          | no        | —               |                                                                    |

Uniqueness:
- `kid` — globally unique.
- Partial unique: `(scope_id, role) WHERE state = 'active' AND role = 'signing'`.
  Enforced at the application layer inside the rotation transaction on
  adapters without partial-index support.

---

## 6. AuditLog

| Field         | Type                 | Nullable? | Unique?  | Notes                                                                 |
| ------------- | -------------------- | --------- | -------- | --------------------------------------------------------------------- |
| `id`          | uuid v7              | no        | yes (PK) |                                                                       |
| `license_id`  | uuid v7              | yes       | —        | FK → `licenses(id)`; null for global events (e.g., scope creation).    |
| `scope_id`    | uuid v7              | yes       | —        | FK → `license_scopes(id)`.                                            |
| `actor`       | string (≤ 256 chars) | no        | —        | Free-form; `"system"` for automatic transitions, else a principal id. |
| `event`       | string (≤ 128 chars) | no        | —        | Dotted identifier, e.g. `license.created`, `usage.registered`, `key.rotated`. |
| `prior_state` | json                 | yes       | —        | Whole-entity snapshot before the transition (nullable for create events). |
| `new_state`   | json                 | yes       | —        | Whole-entity snapshot after the transition (nullable for delete events). |
| `occurred_at` | timestamptz          | no        | —        | Defaults to now.                                                      |

Immutability:
- Storage adapters MUST reject UPDATE and DELETE against this table with
  `ImmutableAuditLog`. Enforcement mechanisms per adapter:
  - **Postgres:** row-level security policy plus a `BEFORE UPDATE/DELETE`
    trigger that raises.
  - **SQLite:** matching `BEFORE UPDATE/DELETE` triggers that `RAISE(ABORT)`.
  - **Memory:** explicit check in the adapter's `update` / `delete` methods.

Indexes:
- `(license_id, occurred_at DESC)` — license detail page tail.
- `(scope_id, occurred_at DESC)` — scope audit stream.
- `(event, occurred_at DESC)` — admin event-type filters.

---

## 7. TrialIssuance (added in v0002)

Tracks every trial license issuance against a `(template_id, fingerprint_hash)`
pair so the issuer can enforce the per-template trial cooldown on the same
device. The hash uses a per-installation pepper (see `server-issued-trials`
spec) so a leaked table cannot be reversed back to raw fingerprints.

| Field              | Type                 | Nullable? | Unique?         | Notes                                                                 |
| ------------------ | -------------------- | --------- | --------------- | --------------------------------------------------------------------- |
| `id`               | uuid v7              | no        | yes (PK)        |                                                                       |
| `template_id`      | uuid v7              | yes       | composite below | FK → `license_templates(id)` ON DELETE RESTRICT. NULL = trial issued without a template (deduped against the global "no template" bucket via the partial unique index `WHERE template_id IS NULL`). |
| `fingerprint_hash` | string (64 chars)    | no        | composite below | SHA-256 hex of `(pepper \|\| canonical_fingerprint_input)`, lowercase. |
| `issued_at`        | timestamptz          | no        | —               | Defaults to now.                                                      |

Uniqueness:
- Partial unique: `(template_id, fingerprint_hash) WHERE template_id IS NOT NULL`
  AND `(fingerprint_hash) WHERE template_id IS NULL` — split partial indexes
  give NULLS-NOT-DISTINCT semantics, matching the project's existing pattern
  for `license_templates(scope_id, name)`. Adapters without partial-index
  support emulate this with an application-level check inside the trial-
  issuance transaction.

Indexes:
- `(issued_at)` — cleanup queries (e.g. delete trials issued more than N
  years ago).

---

## 8. Cross-adapter expectations

All three storage adapters SHALL:

1. Represent every field in §§1–7 with the exact name, type class, and
   nullability listed here. "Type class" means: adapters map `uuid v7` to
   their native UUID type, `timestamptz` to their native timestamp-with-
   timezone type, `int` to a ≥ 32-bit integer, `json` / `json object` to
   their native JSON type (Postgres `jsonb`, SQLite `TEXT` with a
   `json_valid` CHECK, memory adapter a native map).
2. Enforce every uniqueness constraint listed, including the partial-
   unique constraints. Integration tests verify this by attempting a
   conflicting insert and asserting the documented error identifier.
3. Expose a deterministic schema-description accessor (method
   `describeSchema()` in TS, `DescribeSchema(ctx)` in Go) returning a
   stable data structure that the schema-parity test compares to this
   document's parsed representation.
4. Maintain `created_at` and `updated_at` without caller intervention.
   Callers supplying those fields at write time MUST have them ignored in
   favor of adapter-managed values.

Any drift between an adapter and this document is a bug in the adapter, not
a license to update the document. Schema changes go through a dedicated
change proposal.
