/**
 * Core entity types. Mirrors `fixtures/schema/entities.md` and the Go
 * counterparts in `github.com/AnoRebel/licensing`. Field names, nullability,
 * and semantic meaning MUST stay in lockstep across all three sources.
 *
 * These types describe the *canonical core shape* — storage adapters are
 * responsible for mapping to/from their native representation.
 */

/** Status discriminator for a License. */
export type LicenseStatus = 'pending' | 'active' | 'grace' | 'expired' | 'suspended' | 'revoked';

/** Status discriminator for a LicenseUsage (seat). */
export type UsageStatus = 'active' | 'revoked';

/** Rotation state for a signing key. */
export type KeyState = 'active' | 'retiring';

/** Role for a LicenseKey; root keys certify signing keys. */
export type KeyRole = 'root' | 'signing';

/** Registered signature algorithms. Extending this requires a matching
 *  backend registration; see {@link ./crypto.ts}. */
export type KeyAlg = 'ed25519' | 'rs256-pss' | 'hs256';

/** An absolute instant; ISO-8601 string with microsecond precision. */
export type Instant = string;

/** UUID v7 string. Sort-order-preserving by construction. */
export type UUIDv7 = string;

/** SHA-256 hex of the device fingerprint inputs. Always 64 lowercase hex. */
export type Fingerprint = string;

/** Loose JSON value — used only where the schema is deliberately free-form
 *  (e.g. `meta`, `entitlements`). Canonical JSON rules do NOT apply to these. */
export type JSONValue =
  | null
  | boolean
  | number
  | string
  | readonly JSONValue[]
  | { readonly [key: string]: JSONValue };

export interface License {
  readonly id: UUIDv7;
  readonly scope_id: UUIDv7 | null;
  readonly template_id: UUIDv7 | null;
  readonly licensable_type: string;
  readonly licensable_id: string;
  readonly license_key: string;
  readonly status: LicenseStatus;
  readonly max_usages: number;
  /** Mirrors the `trial: true` claim on trial-issued tokens. Added in v0002. */
  readonly is_trial: boolean;
  readonly activated_at: Instant | null;
  readonly expires_at: Instant | null;
  readonly grace_until: Instant | null;
  readonly meta: Readonly<Record<string, JSONValue>>;
  readonly created_at: Instant;
  readonly updated_at: Instant;
}

export interface LicenseScope {
  readonly id: UUIDv7;
  readonly slug: string;
  readonly name: string;
  readonly meta: Readonly<Record<string, JSONValue>>;
  readonly created_at: Instant;
  readonly updated_at: Instant;
}

export interface LicenseTemplate {
  readonly id: UUIDv7;
  readonly scope_id: UUIDv7 | null;
  /** Self-FK enabling template inheritance. Added in v0002. */
  readonly parent_id: UUIDv7 | null;
  readonly name: string;
  readonly max_usages: number;
  readonly trial_duration_sec: number;
  /** Minimum gap between successive trials of this template against the same fingerprint. Added in v0002. */
  readonly trial_cooldown_sec: number | null;
  readonly grace_duration_sec: number;
  readonly force_online_after_sec: number | null;
  readonly entitlements: Readonly<Record<string, JSONValue>>;
  readonly meta: Readonly<Record<string, JSONValue>>;
  readonly created_at: Instant;
  readonly updated_at: Instant;
}

export interface LicenseUsage {
  readonly id: UUIDv7;
  readonly license_id: UUIDv7;
  readonly fingerprint: Fingerprint;
  readonly status: UsageStatus;
  readonly registered_at: Instant;
  readonly revoked_at: Instant | null;
  readonly client_meta: Readonly<Record<string, JSONValue>>;
  readonly created_at: Instant;
  readonly updated_at: Instant;
}

export interface LicenseKey {
  readonly id: UUIDv7;
  readonly scope_id: UUIDv7 | null;
  readonly kid: string;
  readonly alg: KeyAlg;
  readonly role: KeyRole;
  readonly state: KeyState;
  readonly public_pem: string;
  readonly private_pem_enc: string | null;
  readonly rotated_from: UUIDv7 | null;
  readonly rotated_at: Instant | null;
  readonly not_before: Instant;
  readonly not_after: Instant | null;
  readonly meta: Readonly<Record<string, JSONValue>>;
  readonly created_at: Instant;
  readonly updated_at: Instant;
}

export interface AuditLogEntry {
  readonly id: UUIDv7;
  readonly license_id: UUIDv7 | null;
  readonly scope_id: UUIDv7 | null;
  readonly actor: string;
  readonly event: string;
  readonly prior_state: Readonly<Record<string, JSONValue>> | null;
  readonly new_state: Readonly<Record<string, JSONValue>> | null;
  readonly occurred_at: Instant;
}
