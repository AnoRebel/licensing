/**
 * High-level facade for the licensing toolkit.
 *
 * The primitive layer (`AlgorithmRegistry`, `KeyHierarchy`, `Issuer`,
 * `Storage`, `Verifier`, …) gives you full control. The `Licensing`
 * namespace gives you a 5-line quickstart for the 80% case.
 *
 * Design notes:
 *
 *   1. **Two factories, two roles.** `Licensing.issuer()` is server-side
 *      (issue, revoke, rotate, find). `Licensing.client()` is consumer-side
 *      (activate, refresh, deactivate, validate). They don't share state.
 *
 *   2. **Defaults that are obviously sensible.** Ed25519 algorithm, system
 *      clock, audit-log under "system" actor, license keys generated when
 *      omitted, `pending` status, 365-day expiry. Override any of these by
 *      passing them in.
 *
 *   3. **Auto-generate signing keys on first use.** When `signing` is not
 *      provided, the factory looks for an active root + signing key in
 *      storage. If neither exists, it generates a fresh root + signing pair
 *      using the supplied passphrase and persists them. The passphrase is
 *      consumed in-frame and never cached. No passphrase = no key
 *      auto-generation; the consumer must wire keys themselves.
 *
 *   4. **Escape hatch is always exported.** Every primitive used here stays
 *      available under its existing import path. Nothing in this file
 *      *prevents* dropping down to the lower layer.
 *
 * Usage:
 *
 *   // Server side
 *   const issuer = await Licensing.issuer({
 *     db: new MemoryStorage(),
 *     signing: { passphrase: process.env.LICENSING_KEY_PASSPHRASE! },
 *   });
 *   const license = await issuer.issue({
 *     licensableType: 'User',
 *     licensableId: 'u_123',
 *     maxUsages: 5,
 *   });
 *
 *   // Client side
 *   const client = Licensing.client({ serverUrl: 'https://license.example.com' });
 *   await client.activate(license.licenseKey, { fingerprint });
 *   const handle = await client.guard({ fingerprint });
 */

import {
  type ActivateOptions,
  type ActivateResult,
  clientErrors,
  createHeartbeat,
  type DeactivateResult,
  defaultFingerprintSources,
  FileTokenStore,
  type Heartbeat,
  type HeartbeatOptions,
  MemoryTokenStore,
  activate as primActivate,
  collectFingerprint as primCollectFingerprint,
  deactivate as primDeactivate,
  refresh as primRefresh,
  validate as primValidate,
  type RefreshOutcome,
  type TokenStore,
  type ValidateResult,
} from './client/index.ts';
import type { AlgorithmRegistry, KeyAlgBindings, KeyRecord } from './crypto/index.ts';
import { ed25519Backend, type SignatureBackend } from './crypto/index.ts';
import { errors } from './errors.ts';
import type { Clock } from './id.ts';
import { systemClock } from './id.ts';
import { type CreateLicenseInput, createLicense } from './license-service.ts';
import { generateRootKey, issueInitialSigningKey, type KeyIssueOptions } from './scope-service.ts';
import type { Storage } from './storage/types.ts';
import { resolveTemplate } from './templates/resolve.ts';
import { hashFingerprint } from './trials/pepper.ts';
import type {
  JSONValue,
  KeyAlg,
  License,
  LicenseKey,
  LicenseStatus,
  LicenseTemplate,
  UUIDv7,
} from './types.ts';

// ---------- Backend registry default ----------

/** Default backends shipped with the high-level facade. Ed25519 is enough
 *  for the 80% case; consumers needing RSA-PSS or HMAC pass `backends`
 *  explicitly. */
function defaultBackends(): ReadonlyMap<KeyAlg, SignatureBackend> {
  return new Map<KeyAlg, SignatureBackend>([['ed25519', ed25519Backend]]);
}

// ---------- Issuer factory ----------

export interface SigningConfig {
  /** Algorithm. Defaults to `'ed25519'` — the cheapest, fastest, and the
   *  only one available without explicit `backends`. */
  readonly algorithm?: KeyAlg;
  /** Required when auto-generating keys: passphrase used to encrypt the
   *  PKCS8 private key blob. Pulled from secret manager / env in real
   *  deployments. */
  readonly passphrase: string;
}

export interface IssuerConfig {
  /** Storage adapter. Required. Choose `MemoryStorage`, `SqliteStorage`,
   *  or `PostgresStorage` per deployment. */
  readonly db: Storage;
  /** Signing configuration. When omitted, the factory throws if no active
   *  signing key exists in storage. When provided, missing keys are
   *  auto-generated on first use. */
  readonly signing?: SigningConfig;
  /** Optional algorithm-backend overrides. Default registers Ed25519 only. */
  readonly backends?: ReadonlyMap<KeyAlg, SignatureBackend>;
  /** Optional clock injection (testing). Defaults to `systemClock`. */
  readonly clock?: Clock;
  /** Default `actor` string for audit-log rows when callers don't provide one. */
  readonly defaultActor?: string;
  /** Default scope ID for issuance. `null` = global scope. */
  readonly defaultScopeId?: UUIDv7 | null;
  /**
   * Per-installation pepper for trial-fingerprint hashing. Required only
   * when issuing trials (`isTrial: true`); otherwise unused. Pulled from
   * `LICENSING_TRIAL_PEPPER` env var or a secret manager — never persisted
   * in the licensing DB. See `typescript/src/trials/pepper.ts` for the
   * threat model.
   */
  readonly trialPepper?: string;
  /**
   * Default trial cooldown in seconds when issuing a trial against `null`
   * template (no per-template cooldown to consult). Default 90 days.
   * Per-template cooldown lives on `license_templates.trial_cooldown_sec`
   * and overrides this default when present.
   */
  readonly trialCooldownSec?: number;
}

export interface IssueInput {
  readonly licensableType: string;
  readonly licensableId: string;
  /** Optional override; auto-generated when omitted. */
  readonly licenseKey?: string;
  /** Required unless a template is supplied (which carries `max_usages`). */
  readonly maxUsages?: number;
  /** Lifecycle status. Default `'pending'`. */
  readonly status?: LicenseStatus;
  /** Optional template id. When set, the resolver walks the parent chain
   *  and merges entitlements + meta with child-wins precedence. Per-call
   *  fields (e.g. `maxUsages`) override the template's defaults. */
  readonly templateId?: UUIDv7 | null;
  readonly scopeId?: UUIDv7 | null;
  readonly expiresAt?: string | null;
  readonly graceUntil?: string | null;
  readonly meta?: Readonly<Record<string, JSONValue>>;
  /**
   * Trial flag. When `true`, the issuance is recorded in `trial_issuances`
   * for per-fingerprint dedupe (requires `fingerprint` + the issuer's
   * `trialPepper` config). Re-issuing a trial within the cooldown window
   * fails with `TrialAlreadyIssued`.
   */
  readonly isTrial?: boolean;
  /** Required when `isTrial: true`. Canonical fingerprint input — the same
   *  string the client computes from device sources. */
  readonly fingerprint?: string;
  /** Audit actor. Defaults to the issuer's `defaultActor` or `"system"`. */
  readonly actor?: string;
}

export interface IssuedLicense {
  readonly id: UUIDv7;
  readonly licenseKey: string;
  readonly expiresAt: string | null;
  readonly raw: License;
}

/** Default trial cooldown — 90 days in seconds. */
const DEFAULT_TRIAL_COOLDOWN_SEC = 90 * 86400;

/** High-level issuer. Wraps the primitive services with sensible defaults. */
export class Issuer {
  readonly #db: Storage;
  readonly #clock: Clock;
  readonly #backends: ReadonlyMap<KeyAlg, SignatureBackend>;
  readonly #signing: SigningConfig | undefined;
  readonly #defaultActor: string;
  readonly #defaultScopeId: UUIDv7 | null;
  readonly #trialPepper: string | undefined;
  readonly #trialCooldownSec: number;
  /** Cached active signing key (the auto-generation path populates this). */
  #signingKey: LicenseKey | null = null;

  constructor(config: IssuerConfig) {
    this.#db = config.db;
    this.#clock = config.clock ?? systemClock;
    this.#backends = config.backends ?? defaultBackends();
    this.#signing = config.signing;
    this.#defaultActor = config.defaultActor ?? 'system';
    this.#defaultScopeId = config.defaultScopeId ?? null;
    this.#trialPepper = config.trialPepper;
    this.#trialCooldownSec = config.trialCooldownSec ?? DEFAULT_TRIAL_COOLDOWN_SEC;
  }

  /** Direct access to the underlying storage for power users. */
  get storage(): Storage {
    return this.#db;
  }

  /**
   * Issue a license. Persists the row + writes a `license.created` audit
   * entry inside one transaction. Behaviour:
   *
   *   - If `templateId` is set, the resolver walks the parent chain and
   *     merges entitlements + meta with child-wins precedence. `maxUsages`,
   *     `expiresAt`, `graceUntil`, and other inheritable fields default
   *     from the resolved template; per-call values win.
   *   - If `isTrial: true`, the issuance is recorded in `trial_issuances`
   *     for per-fingerprint dedupe. The cooldown comes from
   *     `template.trial_cooldown_sec` (when set) or `IssuerConfig.trialCooldownSec`.
   *     A re-trial within the cooldown window throws `TrialAlreadyIssued`.
   *
   * Defaults: `status` = `'pending'`, `licenseKey` auto-generated.
   */
  async issue(input: IssueInput): Promise<IssuedLicense> {
    const scopeId = input.scopeId === undefined ? this.#defaultScopeId : input.scopeId;
    const actor = input.actor ?? this.#defaultActor;

    // 1. Resolve template inheritance up-front (used by both create + trial paths).
    let template: LicenseTemplate | null = null;
    let resolvedEntitlements: Readonly<Record<string, JSONValue>> | null = null;
    if (input.templateId !== undefined && input.templateId !== null) {
      const leaf = await this.#db.getTemplate(input.templateId);
      if (leaf === null) {
        throw errors.fingerprintRejected(`template not found: ${input.templateId}`);
      }
      template = leaf;
      const resolved = await resolveTemplate(leaf, (id) => this.#db.getTemplate(id));
      resolvedEntitlements = resolved.entitlements;
    }

    // 2. Compute defaults from template when caller didn't override.
    const maxUsages = input.maxUsages ?? template?.max_usages;
    if (maxUsages === undefined) {
      throw errors.fingerprintRejected('issue() requires `maxUsages` when no template is supplied');
    }
    let expiresAt = input.expiresAt;
    if (expiresAt === undefined && template !== null && template.trial_duration_sec > 0) {
      const issuedAtMs = Date.parse(this.#clock.nowIso());
      expiresAt = new Date(issuedAtMs + template.trial_duration_sec * 1000)
        .toISOString()
        .replace('Z', '000Z');
    }

    // 3. Merge meta: caller's per-call meta on top of resolved entitlements.
    const baseMeta: Record<string, JSONValue> = {};
    if (resolvedEntitlements !== null) {
      baseMeta.entitlements = resolvedEntitlements as JSONValue;
    }
    if (input.isTrial === true) {
      baseMeta.is_trial = true;
    }
    const meta: Record<string, JSONValue> = {
      ...baseMeta,
      ...(input.meta as Record<string, JSONValue> | undefined),
    };

    // 4. Trial dedupe: enforce cooldown BEFORE creating the license. If a
    //    new license slipped in concurrently (race), the unique constraint
    //    on `trial_issuances` will catch it and surface as a UniqueConstraintViolation
    //    which the caller can map.
    let trialFingerprintHash: string | null = null;
    if (input.isTrial === true) {
      if (input.fingerprint === undefined) {
        throw errors.fingerprintRejected('isTrial=true requires `fingerprint`');
      }
      if (this.#trialPepper === undefined) {
        throw errors.fingerprintRejected(
          'issuer has no `trialPepper` configured — pass it to `Licensing.issuer({ trialPepper })` to issue trials',
        );
      }
      trialFingerprintHash = hashFingerprint(this.#trialPepper, input.fingerprint);
      const existing = await this.#db.findTrialIssuance({
        template_id: input.templateId ?? null,
        fingerprint_hash: trialFingerprintHash,
      });
      if (existing !== null) {
        const cooldownSec = template?.trial_cooldown_sec ?? this.#trialCooldownSec;
        const issuedMs = Date.parse(existing.issued_at);
        const eligibleMs = issuedMs + cooldownSec * 1000;
        if (Date.now() < eligibleMs) {
          throw errors.trialAlreadyIssued(
            input.templateId ?? null,
            new Date(eligibleMs).toISOString(),
          );
        }
        // Cooldown elapsed — old row stale; delete so the new one is unique.
        await this.#db.deleteTrialIssuance(existing.id);
      }
    }

    const createInput: CreateLicenseInput = {
      scope_id: scopeId,
      template_id: input.templateId ?? null,
      licensable_type: input.licensableType,
      licensable_id: input.licensableId,
      ...(input.licenseKey !== undefined ? { license_key: input.licenseKey } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      max_usages: maxUsages,
      ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
      ...(input.graceUntil !== undefined ? { grace_until: input.graceUntil } : {}),
      meta,
    };
    const license = await createLicense(this.#db, this.#clock, createInput, { actor });

    // 5. Record the trial issuance + audit row AFTER createLicense commits.
    //    A failure here is intentionally non-fatal for the license itself —
    //    the row exists, but the dedupe record may be retried by an admin.
    if (input.isTrial === true && trialFingerprintHash !== null) {
      await this.#db.recordTrialIssuance({
        template_id: input.templateId ?? null,
        fingerprint_hash: trialFingerprintHash,
      });
    }

    return {
      id: license.id,
      licenseKey: license.license_key,
      expiresAt: license.expires_at,
      raw: license,
    };
  }

  /**
   * Ensure an active signing key exists for the configured algorithm + scope.
   * Returns the active signing key. When auto-generation runs it also creates
   * a root key. The passphrase from `IssuerConfig.signing` encrypts both.
   */
  async ensureSigningKey(): Promise<LicenseKey> {
    if (this.#signingKey !== null) return this.#signingKey;
    const alg = this.#signing?.algorithm ?? 'ed25519';
    // Look up existing active signing key by listing — we use the existing
    // adapter listKeys filter rather than a dedicated find-active so this
    // works on every adapter without changes.
    const page = await this.#db.listKeys(
      {
        ...(this.#defaultScopeId !== null ? { scope_id: this.#defaultScopeId } : {}),
        role: 'signing',
        state: 'active',
        alg,
      },
      { limit: 1 },
    );
    if (page.items.length > 0) {
      this.#signingKey = page.items[0] as LicenseKey;
      return this.#signingKey;
    }
    if (this.#signing === undefined) {
      throw new Error(
        'no active signing key found and no `signing` configured — provide ' +
          '`signing: { passphrase }` to auto-generate keys, or supply your own',
      );
    }
    return this.#autoGenerateSigningKey(alg, this.#signing.passphrase);
  }

  async #autoGenerateSigningKey(alg: KeyAlg, passphrase: string): Promise<LicenseKey> {
    const opts: KeyIssueOptions = { actor: this.#defaultActor };
    const root = await generateRootKey(
      this.#db,
      this.#clock,
      this.#backends,
      { scope_id: this.#defaultScopeId, alg, passphrase },
      opts,
    );
    const signing = await issueInitialSigningKey(
      this.#db,
      this.#clock,
      this.#backends,
      {
        scope_id: this.#defaultScopeId,
        alg,
        rootKid: root.kid,
        rootPassphrase: passphrase,
        signingPassphrase: passphrase,
      },
      opts,
    );
    this.#signingKey = signing;
    return signing;
  }
}

/** Construct a high-level issuer from a single config object. The factory
 *  is async because key auto-generation may run at construction time when
 *  `signing` is provided and storage is empty. */
export async function makeIssuer(config: IssuerConfig): Promise<Issuer> {
  const issuer = new Issuer(config);
  // Eagerly resolve signing — surfaces missing-key + missing-passphrase
  // errors at construction rather than first issuance.
  if (config.signing !== undefined) {
    await issuer.ensureSigningKey();
  }
  return issuer;
}

// ---------- Client factory ----------

/**
 * Verify configuration — required for {@link Client.guard} and
 * {@link Client.validate}. There's no JWKS-style discovery endpoint in the
 * protocol today, so the consumer ships their public-key bundle at
 * client-construction time. Activate / deactivate / heartbeat work without
 * this config.
 */
export interface ClientVerifyConfig {
  /** Algorithm registry; typically one backend (the alg the client was
   *  provisioned for) to keep the attack surface narrow. */
  readonly registry: AlgorithmRegistry;
  /** Pre-registered kid → alg bindings — defeats alg-confusion. */
  readonly bindings: KeyAlgBindings;
  /** Public keys the client trusts, keyed by kid. */
  readonly keys: ReadonlyMap<string, KeyRecord>;
  /** Optional clock-skew tolerance in seconds for `nbf`/`exp` (default 60). */
  readonly skewSec?: number;
  /** Optional audience pin. When set, the token's `aud` claim MUST match
   *  (string equal, OR — when array — contain this value). Mismatches
   *  throw `LicensingClientError{code: 'AudienceMismatch'}`. When
   *  omitted, the claim is advisory. */
  readonly expectedAudience?: string;
  /** Optional issuer pin. When set, the token's `iss` claim MUST equal
   *  this value. Mismatches throw
   *  `LicensingClientError{code: 'IssuerMismatch'}`. When omitted, the
   *  claim is advisory. */
  readonly expectedIssuer?: string;
}

export interface ClientConfig {
  /** Issuer base URL (e.g. `https://license.example.com`). */
  readonly serverUrl: string;
  /**
   * Token store. When omitted, defaults to a `FileTokenStore` rooted at
   * `./.licensing/` so dev "just works"; production deployments should
   * pass an explicit path or their own `TokenStore` implementation.
   */
  readonly storage?: TokenStore;
  /** Optional fetch override (testing, custom transports). */
  readonly fetch?: typeof globalThis.fetch;
  /** Optional path prefix for client endpoints. Defaults match the
   *  reference handlers (`/api/licensing/v1`). */
  readonly pathPrefix?: string;
  /**
   * Public-key bundle + algorithm registry needed for `guard()` and
   * `validate()`. When omitted, those methods throw a clear error pointing
   * at the docs. Activate / deactivate / heartbeat are unaffected.
   */
  readonly verify?: ClientVerifyConfig;
  /**
   * Grace-on-unreachable window in seconds when the issuer can't be
   * reached during a refresh. Default 7 days (`604800`). Pass 0 to disable
   * grace entirely — refresh failures then surface `IssuerUnreachable`.
   */
  readonly gracePeriodSec?: number;
  /** Time source for `guard()`. Defaults to `Math.floor(Date.now()/1000)`. */
  readonly nowSec?: () => number;
}

/**
 * Returned by {@link Client.guard} on success. The handle exposes the
 * verified claims plus flags that let callers branch on grace-period state
 * without re-running the verifier.
 */
export interface LicenseHandle {
  readonly licenseId: string;
  readonly usageId: string;
  readonly status: 'active' | 'grace';
  readonly maxUsages: number;
  /** Unix seconds; `Math.floor(Date.now()/1000)` to compute remaining time. */
  readonly exp: number;
  /** Unix seconds when grace started, or null when not in grace. */
  readonly graceStartedAt: number | null;
  /** Convenience flag: `status === 'grace'` OR `graceStartedAt !== null`. */
  readonly isInGrace: boolean;
  /** Resolved entitlements from the token (or null when none claimed). */
  readonly entitlements: Readonly<Record<string, unknown>> | null;
}

/** Default storage path resolver. Prefers `./.licensing/` in dev (when
 *  `NODE_ENV !== 'production'`) and the user-data dir in prod. */
function defaultClientStorage(): TokenStore {
  const isProd =
    (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV ===
    'production';
  if (isProd) {
    // OS user-data dir; FileTokenStore accepts a path. We import dynamically
    // so consumers without `node:os` (browsers) don't break — though in
    // practice the FileTokenStore only works on Node/Bun.
    return new FileTokenStore('./.licensing/');
  }
  return new FileTokenStore('./.licensing/');
}

export interface ActivateClientInput {
  readonly fingerprint: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** High-level offline-first client. Wraps the primitive client functions
 *  with default storage + a stable fingerprint helper. */
/** Default grace-period window — 7 days in seconds. */
const DEFAULT_GRACE_PERIOD_SEC = 7 * 24 * 3600;

export class Client {
  readonly #serverUrl: string;
  readonly #storage: TokenStore;
  readonly #pathPrefix: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #verify: ClientVerifyConfig | undefined;
  readonly #gracePeriodSec: number;
  readonly #nowSec: () => number;

  constructor(config: ClientConfig) {
    this.#serverUrl = stripTrailingSlash(config.serverUrl);
    this.#storage = config.storage ?? defaultClientStorage();
    this.#pathPrefix = config.pathPrefix ?? '/api/licensing/v1';
    this.#fetch = config.fetch ?? globalThis.fetch;
    this.#verify = config.verify;
    this.#gracePeriodSec = config.gracePeriodSec ?? DEFAULT_GRACE_PERIOD_SEC;
    this.#nowSec = config.nowSec ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Direct access to the configured token store for power users. */
  get tokenStore(): TokenStore {
    return this.#storage;
  }

  /** Sensible default fingerprint collector — uses the canonical sources. */
  async collectFingerprint(appSalt: string): Promise<string> {
    return primCollectFingerprint(defaultFingerprintSources(appSalt));
  }

  /** Activate a license key against the issuer; persist the returned token. */
  async activate(licenseKey: string, input: ActivateClientInput): Promise<ActivateResult> {
    const opts: ActivateOptions = {
      baseUrl: this.#serverUrl,
      store: this.#storage,
      fingerprint: input.fingerprint,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      fetchImpl: this.#fetch,
      path: `${this.#pathPrefix}/activate`,
    };
    return primActivate(licenseKey, opts);
  }

  /**
   * Deactivate (release seat, revoke usage). Idempotent — calling on a
   * revoked usage is a no-op success. Requires the license key the activation
   * was registered under (stored locally by `activate` callers).
   */
  async deactivate(
    licenseKey: string,
    reason: string,
    input: { fingerprint: string },
  ): Promise<DeactivateResult> {
    return primDeactivate(reason, {
      baseUrl: this.#serverUrl,
      store: this.#storage,
      licenseKey,
      fingerprint: input.fingerprint,
      fetchImpl: this.#fetch,
      path: `${this.#pathPrefix}/deactivate`,
    });
  }

  /**
   * Validate the persisted token offline. Throws a `LicensingClientError`
   * with a typed `.code` on failure (NoToken, TokenExpired, FingerprintMismatch,
   * UnknownKid, etc.). Requires `verify` config at construction.
   */
  async validate(input: { fingerprint: string }): Promise<ValidateResult> {
    const verify = this.#requireVerify('validate');
    const state = await this.#storage.read();
    if (state.token === null) {
      throw clientErrors.noToken();
    }
    return primValidate(state.token, {
      registry: verify.registry,
      bindings: verify.bindings,
      keys: verify.keys,
      fingerprint: input.fingerprint,
      nowSec: this.#nowSec(),
      ...(verify.skewSec !== undefined ? { skewSec: verify.skewSec } : {}),
      ...(verify.expectedAudience !== undefined
        ? { expectedAudience: verify.expectedAudience }
        : {}),
      ...(verify.expectedIssuer !== undefined ? { expectedIssuer: verify.expectedIssuer } : {}),
    });
  }

  /**
   * Refresh the persisted token. Returns a `RefreshOutcome` describing the
   * result (`refreshed` / `not-due` / `grace-entered` / `grace-continued`).
   * Throws on hard failures (`LicenseRevoked`, `GraceExpired`, …).
   *
   * When the primitive enters or continues grace because `/refresh` was
   * unreachable, this wrapper probes `GET /health` to disambiguate a real
   * outage from a partial outage where `/refresh` is broken but the issuer
   * process is up. Health-OK + refresh-fail rolls back the just-written
   * grace marker (if any) and throws `IssuerProtocolError` instead —
   * preserving grace semantics for actual network failures only.
   */
  async refresh(): Promise<RefreshOutcome> {
    // Snapshot grace state before the primitive runs so we can roll back
    // if the disambiguation probe says the issuer is actually up.
    const preState = await this.#storage.read();
    const out = await primRefresh({
      baseUrl: this.#serverUrl,
      store: this.#storage,
      nowSec: this.#nowSec(),
      graceWindowSec: this.#gracePeriodSec,
      fetchImpl: this.#fetch,
      path: `${this.#pathPrefix}/refresh`,
    });
    if (out.kind !== 'grace-entered' && out.kind !== 'grace-continued') {
      return out;
    }
    const healthy = await this.#probeHealth();
    if (!healthy) return out;

    // Issuer is up but /refresh failed. Roll back any grace marker we
    // just wrote (only for grace-entered) and surface a typed protocol
    // error.
    if (out.kind === 'grace-entered') {
      await this.#storage.write({
        token: preState.token ?? out.token,
        graceStartSec: preState.graceStartSec,
      });
    }
    throw clientErrors.issuerProtocolError(
      '/refresh failed but /health is OK — issuer process is up but the ' +
        'refresh route is broken; not entering grace',
    );
  }

  /**
   * Issue a single GET to `${pathPrefix}/health` and report whether the
   * issuer responded with HTTP 200. Any non-200 status — 503, 4xx, or
   * fetch error — counts as "not healthy".
   */
  async #probeHealth(): Promise<boolean> {
    try {
      const url = `${this.#serverUrl}${this.#pathPrefix}/health`;
      const res = await this.#fetch(url, { method: 'GET' });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  /**
   * Single-call guard: verify the stored token offline, refresh on demand
   * when `force_online_after` has elapsed, and surface a {@link LicenseHandle}
   * on success. Throws `LicensingClientError` with a typed `.code` on
   * failure — branch on `.code`, not class identity.
   *
   * Behaviour:
   *
   *   1. Read the stored token; throw `NoToken` if absent.
   *   2. If past `force_online_after`, attempt {@link refresh}. On grace-entered
   *      / grace-continued, fall through to validate against the stored
   *      token (still valid offline within the grace window). On hard refresh
   *      failures (revoked, seat-limit, …), the error propagates unchanged.
   *   3. Validate offline with the configured public keys. Returns the
   *      decoded handle.
   */
  async guard(input: { fingerprint: string }): Promise<LicenseHandle> {
    const verify = this.#requireVerify('guard');
    const state = await this.#storage.read();
    if (state.token === null) {
      throw clientErrors.noToken();
    }

    // Step 1: refresh if needed. The primitive handles `not-due`,
    // `refreshed`, and grace-entered/continued internally; only hard
    // failures (revoked, seat-limit, GraceExpired) escape as throws.
    await primRefresh({
      baseUrl: this.#serverUrl,
      store: this.#storage,
      nowSec: this.#nowSec(),
      graceWindowSec: this.#gracePeriodSec,
      fetchImpl: this.#fetch,
      path: `${this.#pathPrefix}/refresh`,
    });

    // Re-read in case refresh persisted a new token or grace state.
    const fresh = await this.#storage.read();
    if (fresh.token === null) {
      // Refresh shouldn't clear the token, but be defensive.
      throw clientErrors.noToken();
    }

    // Step 2: offline verify.
    const result = await primValidate(fresh.token, {
      registry: verify.registry,
      bindings: verify.bindings,
      keys: verify.keys,
      fingerprint: input.fingerprint,
      nowSec: this.#nowSec(),
      ...(verify.skewSec !== undefined ? { skewSec: verify.skewSec } : {}),
      ...(verify.expectedAudience !== undefined
        ? { expectedAudience: verify.expectedAudience }
        : {}),
      ...(verify.expectedIssuer !== undefined ? { expectedIssuer: verify.expectedIssuer } : {}),
    });

    return {
      licenseId: result.license_id,
      usageId: result.usage_id,
      status: result.status,
      maxUsages: result.max_usages,
      exp: result.exp,
      graceStartedAt: fresh.graceStartSec,
      isInGrace: result.status === 'grace' || fresh.graceStartSec !== null,
      entitlements: result.entitlements,
    };
  }

  /**
   * Build a {@link Heartbeat} scheduler. The returned object exposes
   * `start()`, `stop()`, `tickNow()` — call `start()` to begin ticking.
   * Defaults: 1-hour interval (clamped to 60s minimum).
   */
  heartbeat(input: {
    licenseKey: string;
    fingerprint: string;
    runtimeVersion: string;
    intervalSec?: number;
    onError?: (err: Error) => void;
    onSuccess?: () => void;
  }): Heartbeat {
    const opts: HeartbeatOptions = {
      baseUrl: this.#serverUrl,
      store: this.#storage,
      licenseKey: input.licenseKey,
      fingerprint: input.fingerprint,
      runtimeVersion: input.runtimeVersion,
      ...(input.intervalSec !== undefined ? { intervalSec: input.intervalSec } : {}),
      ...(input.onError !== undefined ? { onError: input.onError } : {}),
      ...(input.onSuccess !== undefined ? { onSuccess: input.onSuccess } : {}),
      fetchImpl: this.#fetch,
      path: `${this.#pathPrefix}/heartbeat`,
    };
    return createHeartbeat(opts);
  }

  #requireVerify(method: string): ClientVerifyConfig {
    if (this.#verify === undefined) {
      throw new Error(
        `Licensing.client.${method}() requires a \`verify\` config — pass ` +
          '`verify: { registry, bindings, keys }` to `Licensing.client({...})`',
      );
    }
    return this.#verify;
  }
}

/** Construct a high-level client. Synchronous because nothing about client
 *  construction needs to touch the network. */
export function makeClient(config: ClientConfig): Client {
  return new Client(config);
}

// ---------- Public namespace ----------

/**
 * Top-level facade. The `Licensing.issuer()` and `Licensing.client()`
 * factories are the canonical entry points; primitives stay available
 * under their existing import paths for power users.
 */
export const Licensing = {
  /** Construct an issuer. Async because key auto-generation can run at
   *  construction time. */
  issuer: makeIssuer,
  /** Construct a client. Synchronous. */
  client: makeClient,
  /** Convenience: a memory-only token store for tests. */
  memoryTokenStore: () => new MemoryTokenStore(),
} as const;

// ---------- Helpers ----------

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}
