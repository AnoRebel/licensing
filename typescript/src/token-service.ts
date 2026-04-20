/**
 * `issueToken`.
 *
 * Token issuance refuses non-issuable statuses (suspended, revoked, expired,
 * pending) and builds the LIC1 payload with the required + optional claim
 * set.
 *
 * Semantics:
 *
 *   1. Loads the *active* signing key for the license's scope and the
 *      caller-requested `alg`. If none exists and the license has a scope,
 *      falls back to the global (scope_id = null) key — this mirrors the
 *      PHP reference's "scoped → global" fallback so operators can run a
 *      single global signer until they're ready to split per-scope keys.
 *
 *   2. Refuses to issue for non-usable statuses. `effectiveStatus` is used
 *      so that a license still within its grace window issues a token with
 *      `status: 'grace'` without requiring the caller to have called `tick`
 *      first. `pending` licenses cannot issue — activation (the first
 *      `registerUsage`) must have already happened.
 *
 *   3. Claims are built to match the LIC1 payload spec exactly — `jti` is a
 *      fresh uuidv7 per token, timestamps are unix seconds (iat/nbf/exp),
 *      `scope` is the scope slug (empty string for global), `status` is the
 *      effective status, and optional claims (`force_online_after`,
 *      `entitlements`, `meta`) are OMITTED (not set to null) when unused so
 *      the canonical JSON is minimal.
 *
 *   4. `force_online_after` can come from (a) the caller-supplied override,
 *      (b) `license.meta.force_online_after_sec` (set by
 *      `createLicenseFromTemplate`), or (c) be absent entirely. It's
 *      expressed as an absolute unix-seconds deadline relative to `iat`, so
 *      clients can compare directly against their clock.
 *
 *   5. `entitlements` come from `license.meta.entitlements` (snapshotted at
 *      creation time by the template flow). Caller `entitlements` in opts
 *      wins if provided.
 *
 *   6. The signing key's private PEM is decrypted in-frame using the
 *      passphrase, the signature backend signs the canonical signing input,
 *      and the plaintext handle is NOT cached — every issue re-decrypts.
 *      This is a deliberate trade: a warm cache would save ~100ms/token
 *      but widens the memory-exposure window; the ~100ms is negligible
 *      versus network/DB round-trips in a real issuer service.
 *
 * Non-goals for 5.5:
 *   - Refresh/rotation of tokens (that's a caller-orchestration concern).
 *   - Batch issuance — callers loop.
 *   - A `refreshToken(oldToken, ...)` API — clients simply re-call issue.
 */

import type { SignatureBackend } from './crypto/types.ts';
import { errors } from './errors.ts';
import type { Clock } from './id.ts';
import { newUuidV7 } from './id.ts';
import { KeyHierarchy } from './key-hierarchy.ts';
import { encode as encodeLic1, type LIC1Header } from './lic1.ts';
import { effectiveStatus } from './lifecycle.ts';
import type { Storage } from './storage/types.ts';
import type {
  JSONValue,
  KeyAlg,
  License,
  LicenseKey,
  LicenseScope,
  LicenseUsage,
} from './types.ts';

export interface IssueTokenInput {
  /** The license being validated. Status is re-resolved via
   *  `effectiveStatus(now)` — caller does NOT need to have called `tick`
   *  first to promote active→grace. */
  readonly license: License;
  /** The active usage row (seat) this token is scoped to. Its fingerprint
   *  becomes the `usage_fingerprint` claim and binds the token to a device. */
  readonly usage: LicenseUsage;
  /** Token time-to-live in seconds. Required — no silent default so callers
   *  are forced to decide. Typical: 3600–86400 for online-gate'd apps,
   *  up to 30 days for offline-first. */
  readonly ttlSeconds: number;
  /** Algorithm selector for the signing key. The issuer picks the active
   *  key matching `(scope_id, role=signing, alg)`. */
  readonly alg: KeyAlg;
  /** Passphrase for the active signing key's encrypted PKCS8 blob. Provided
   *  per-call (from KMS/env/HSM) rather than cached in-memory. */
  readonly signingPassphrase: string;
  /** Optional override: absolute unix-seconds deadline by which the client
   *  MUST re-check with the server. When omitted, falls back to
   *  `license.meta.force_online_after_sec` relative to `iat` (if set).
   *  Pass `null` to explicitly omit even when the license meta has one. */
  readonly forceOnlineAfter?: number | null;
  /** Optional entitlements override — wins over `license.meta.entitlements`.
   *  Pass `null` to explicitly omit both. */
  readonly entitlements?: Readonly<Record<string, JSONValue>> | null;
  /** Optional freeform meta to include in the claim set. Not merged with
   *  the license's meta — this is a token-scoped claim only. */
  readonly meta?: Readonly<Record<string, JSONValue>>;
}

export interface IssueTokenResult {
  /** The encoded LIC1 token — safe to hand to a client for offline use. */
  readonly token: string;
  /** The signing key used (`kid`, `alg`) — handy for logging. */
  readonly kid: string;
  /** Unix seconds of `iat/nbf` (they're always equal for fresh issuance). */
  readonly iat: number;
  /** Unix seconds of `exp`. */
  readonly exp: number;
  /** Per-token uuidv7 — also the `jti` claim. */
  readonly jti: string;
}

/**
 * Issue a new LIC1 token for `(license, usage)` signed by the active
 * signing key for the license's scope. Does not persist anything — token
 * issuance is stateless at the storage layer (the audit row for "token
 * issued" is a future concern; we only audit *lifecycle* transitions, not
 * every token emission).
 */
export async function issueToken(
  storage: Storage,
  clock: Clock,
  backends: ReadonlyMap<KeyAlg, SignatureBackend>,
  input: IssueTokenInput,
): Promise<IssueTokenResult> {
  if (input.ttlSeconds <= 0) {
    throw errors.fingerprintRejected(`issueToken.ttlSeconds must be > 0 (got ${input.ttlSeconds})`);
  }
  if (input.usage.license_id !== input.license.id) {
    throw errors.tokenMalformed(
      `usage.license_id (${input.usage.license_id}) does not belong to license ${input.license.id}`,
    );
  }
  if (input.usage.status !== 'active') {
    throw errors.tokenMalformed(
      `usage ${input.usage.id} is not active (status=${input.usage.status})`,
    );
  }

  // Resolve status at issuance time. `effectiveStatus` promotes
  // active→grace when now is between expires_at and grace_until, and
  // active→expired once grace has passed.
  const nowIso = clock.nowIso();
  const status = effectiveStatus(input.license, nowIso);
  if (status === 'pending') {
    throw errors.tokenMalformed(
      `license ${input.license.id} is still pending — activate via registerUsage first`,
    );
  }
  if (status === 'suspended') throw errors.licenseSuspended();
  if (status === 'revoked') throw errors.licenseRevoked();
  if (status === 'expired') throw errors.licenseExpired();
  // Reachable: 'active' | 'grace'.

  // Load the active signing key. Scope-preferential: try scoped first, fall
  // back to global if the license has a scope but no scoped signer exists.
  const signing = await findActiveSigningKey(storage, input.license.scope_id, input.alg);
  if (signing === null) {
    throw errors.unknownKid(
      input.license.scope_id === null
        ? `no active global signing key for alg=${input.alg}`
        : `no active signing key for scope=${input.license.scope_id} alg=${input.alg} (and no global fallback)`,
    );
  }
  // Defense-in-depth scope drift guard: `findActiveSigningKey` already filters
  // `WHERE scope_id = <license.scope_id> OR (scope_id IS NULL AND no scoped
  // match)`, but we re-assert here so a DB-integrity bug that returns a key
  // from scope B for a license in scope A can't sign cross-tenant tokens.
  // Valid signers are either the license's own scope or the global fallback.
  if (signing.scope_id !== input.license.scope_id && signing.scope_id !== null) {
    throw errors.unknownKid(
      `signing key ${signing.kid} scope (${signing.scope_id}) does not match license scope (${input.license.scope_id ?? 'global'})`,
    );
  }

  // Resolve scope slug for the `scope` claim. Empty string means global.
  // Lookup only when the license has a scope.
  const scopeSlug =
    input.license.scope_id === null ? '' : await resolveScopeSlug(storage, input.license.scope_id);

  const iat = unixSeconds(nowIso);
  const exp = iat + input.ttlSeconds;
  const jti = newUuidV7(clock);

  // Build the payload in canonical shape. Optional claims are OMITTED
  // (not nulled) when unused to keep the canonical JSON minimal.
  const payload: Record<string, JSONValue> = {
    jti,
    iat,
    nbf: iat,
    exp,
    scope: scopeSlug,
    license_id: input.license.id,
    usage_id: input.usage.id,
    usage_fingerprint: input.usage.fingerprint,
    status,
    max_usages: input.license.max_usages,
  };

  const forceOnlineAfter = resolveForceOnlineAfter(input, iat);
  if (forceOnlineAfter !== null) payload.force_online_after = forceOnlineAfter;

  const entitlements = resolveEntitlements(input);
  if (entitlements !== null) payload.entitlements = entitlements as JSONValue;

  if (input.meta !== undefined) payload.meta = input.meta as JSONValue;

  // Sign. The handle is scoped to this frame and discarded; no cache.
  const hierarchy = new KeyHierarchy({
    store: {
      // Minimal adapter — importSigningPrivate only calls findByKid + one
      // of the backends. A thin inline store is fine.
      async put() {
        throw new Error('unreachable');
      },
      async get() {
        return null;
      },
      async findByKid(kid: string) {
        return kid === signing.kid ? signing : null;
      },
      async list() {
        return [signing];
      },
      async update() {
        throw new Error('unreachable');
      },
    },
    backends,
    clock,
  });
  const { handle } = await hierarchy.importSigningPrivate(signing.kid, input.signingPassphrase);

  const backend = backends.get(input.alg);
  if (!backend) throw errors.unsupportedAlgorithm(input.alg);

  const header: LIC1Header = {
    v: 1,
    typ: 'lic',
    alg: input.alg,
    kid: signing.kid,
  };
  const token = await encodeLic1({ header, payload, privateKey: handle, backend });

  return { token, kid: signing.kid, iat, exp, jti };
}

// ---------- internals ----------

async function findActiveSigningKey(
  storage: Storage,
  scope_id: License['scope_id'],
  alg: KeyAlg,
): Promise<LicenseKey | null> {
  // Scoped first. Walk pages because realistic counts are tiny but the
  // adapter interface forces us to respect paging.
  if (scope_id !== null) {
    const scoped = await findFirstActive(storage, { scope_id, alg });
    if (scoped !== null) return scoped;
  }
  // Global fallback (or direct query when scope_id was null to begin with).
  return findFirstActive(storage, { scope_id: null, alg });
}

async function findFirstActive(
  storage: Storage,
  filter: { scope_id: LicenseScope['id'] | null; alg: KeyAlg },
): Promise<LicenseKey | null> {
  let cursor: string | null | undefined;
  while (true) {
    const page = await storage.listKeys(
      { scope_id: filter.scope_id, alg: filter.alg, role: 'signing', state: 'active' },
      cursor === null || cursor === undefined ? { limit: 50 } : { limit: 50, cursor },
    );
    if (page.items.length > 0) return page.items[0] ?? null;
    if (page.cursor === null) return null;
    cursor = page.cursor;
  }
}

async function resolveScopeSlug(
  storage: Storage,
  scope_id: NonNullable<License['scope_id']>,
): Promise<string> {
  const scope = await storage.getScope(scope_id);
  if (scope === null) {
    throw errors.tokenMalformed(`license references unknown scope ${scope_id}`);
  }
  return scope.slug;
}

/** Cap at ~10 years past `iat`. Longer horizons are almost certainly
 *  misconfigured meta, and `iat + very_large_number` is a silent DoS against
 *  the "must re-check with server" guarantee. */
const FORCE_ONLINE_MAX_SEC = 10 * 365 * 24 * 3600;

/** Validate a candidate `force_online_after` deadline. Already absolute
 *  (unix seconds). Must be a finite non-negative safe integer within the
 *  capped horizon and not already past `iat`. */
function validateForceOnlineDeadline(candidate: number, iat: number, context: string): number {
  if (!Number.isFinite(candidate) || !Number.isSafeInteger(candidate)) {
    throw errors.fingerprintRejected(`${context} must be a finite integer (got ${candidate})`);
  }
  if (candidate < iat) {
    throw errors.fingerprintRejected(`${context} (${candidate}) is in the past (iat=${iat})`);
  }
  if (candidate > iat + FORCE_ONLINE_MAX_SEC) {
    throw errors.fingerprintRejected(
      `${context} (${candidate}) exceeds max horizon (${iat + FORCE_ONLINE_MAX_SEC})`,
    );
  }
  return candidate;
}

function resolveForceOnlineAfter(input: IssueTokenInput, iat: number): number | null {
  if (input.forceOnlineAfter !== undefined) {
    if (input.forceOnlineAfter === null) return null;
    return validateForceOnlineDeadline(input.forceOnlineAfter, iat, 'forceOnlineAfter');
  }
  const meta = input.license.meta as Record<string, unknown>;
  const fromMeta = meta.force_online_after_sec;
  // `force_online_after_sec` in meta is a RELATIVE duration (seconds from
  // now), not an absolute deadline — this is the shape `createLicenseFromTemplate`
  // writes. Validate the relative value, then convert to absolute.
  if (typeof fromMeta !== 'number') return null;
  if (!Number.isFinite(fromMeta) || !Number.isSafeInteger(fromMeta) || fromMeta <= 0) {
    throw errors.fingerprintRejected(
      `license.meta.force_online_after_sec must be a positive integer (got ${fromMeta})`,
    );
  }
  if (fromMeta > FORCE_ONLINE_MAX_SEC) {
    throw errors.fingerprintRejected(
      `license.meta.force_online_after_sec (${fromMeta}) exceeds max horizon (${FORCE_ONLINE_MAX_SEC})`,
    );
  }
  return iat + fromMeta;
}

function resolveEntitlements(input: IssueTokenInput): Readonly<Record<string, JSONValue>> | null {
  if (input.entitlements !== undefined) return input.entitlements;
  const meta = input.license.meta as Record<string, unknown>;
  const fromMeta = meta.entitlements;
  if (fromMeta !== undefined && fromMeta !== null && typeof fromMeta === 'object') {
    return fromMeta as Readonly<Record<string, JSONValue>>;
  }
  return null;
}

function unixSeconds(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}
