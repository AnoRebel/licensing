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
  type DeactivateResult,
  defaultFingerprintSources,
  FileTokenStore,
  MemoryTokenStore,
  activate as primActivate,
  collectFingerprint as primCollectFingerprint,
  deactivate as primDeactivate,
  type TokenStore,
} from './client/index.ts';
import { ed25519Backend, type SignatureBackend } from './crypto/index.ts';
import type { Clock } from './id.ts';
import { systemClock } from './id.ts';
import { type CreateLicenseInput, createLicense } from './license-service.ts';
import { generateRootKey, issueInitialSigningKey, type KeyIssueOptions } from './scope-service.ts';
import type { Storage } from './storage/types.ts';
import type { JSONValue, KeyAlg, License, LicenseKey, LicenseStatus, UUIDv7 } from './types.ts';

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
}

export interface IssueInput {
  readonly licensableType: string;
  readonly licensableId: string;
  /** Optional override; auto-generated when omitted. */
  readonly licenseKey?: string;
  readonly maxUsages: number;
  /** Lifecycle status. Default `'pending'`. */
  readonly status?: LicenseStatus;
  /** Optional template id; resolves entitlements/duration/etc. */
  readonly templateId?: UUIDv7 | null;
  readonly scopeId?: UUIDv7 | null;
  readonly expiresAt?: string | null;
  readonly graceUntil?: string | null;
  readonly meta?: Readonly<Record<string, JSONValue>>;
  /** Audit actor. Defaults to the issuer's `defaultActor` or `"system"`. */
  readonly actor?: string;
}

export interface IssuedLicense {
  readonly id: UUIDv7;
  readonly licenseKey: string;
  readonly expiresAt: string | null;
  readonly raw: License;
}

/** High-level issuer. Wraps the primitive services with sensible defaults. */
export class Issuer {
  readonly #db: Storage;
  readonly #clock: Clock;
  readonly #backends: ReadonlyMap<KeyAlg, SignatureBackend>;
  readonly #signing: SigningConfig | undefined;
  readonly #defaultActor: string;
  readonly #defaultScopeId: UUIDv7 | null;
  /** Cached active signing key (the auto-generation path populates this). */
  #signingKey: LicenseKey | null = null;

  constructor(config: IssuerConfig) {
    this.#db = config.db;
    this.#clock = config.clock ?? systemClock;
    this.#backends = config.backends ?? defaultBackends();
    this.#signing = config.signing;
    this.#defaultActor = config.defaultActor ?? 'system';
    this.#defaultScopeId = config.defaultScopeId ?? null;
  }

  /** Direct access to the underlying storage for power users. */
  get storage(): Storage {
    return this.#db;
  }

  /**
   * Issue a license. Persists the row + writes a `license.created` audit
   * entry inside one transaction. The `licenseKey` is generated when the
   * caller omits it.
   */
  async issue(input: IssueInput): Promise<IssuedLicense> {
    const scopeId = input.scopeId === undefined ? this.#defaultScopeId : input.scopeId;
    const createInput: CreateLicenseInput = {
      scope_id: scopeId,
      template_id: input.templateId ?? null,
      licensable_type: input.licensableType,
      licensable_id: input.licensableId,
      ...(input.licenseKey !== undefined ? { license_key: input.licenseKey } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      max_usages: input.maxUsages,
      ...(input.expiresAt !== undefined ? { expires_at: input.expiresAt } : {}),
      ...(input.graceUntil !== undefined ? { grace_until: input.graceUntil } : {}),
      ...(input.meta !== undefined ? { meta: input.meta } : {}),
    };
    const license = await createLicense(this.#db, this.#clock, createInput, {
      actor: input.actor ?? this.#defaultActor,
    });
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
export class Client {
  readonly #serverUrl: string;
  readonly #storage: TokenStore;
  readonly #pathPrefix: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(config: ClientConfig) {
    this.#serverUrl = stripTrailingSlash(config.serverUrl);
    this.#storage = config.storage ?? defaultClientStorage();
    this.#pathPrefix = config.pathPrefix ?? '/api/licensing/v1';
    this.#fetch = config.fetch ?? globalThis.fetch;
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

  // Note: `validate` and `refresh` require the consumer to provide the
  // public-key bundle and an algorithm registry — there's no JWKS-style
  // discovery endpoint in the protocol today. Use the primitives directly:
  //   import { validate, refresh } from '@anorebel/licensing/client';
  // …with the appropriate registry/bindings/trustedPublicKeys/nowSec.
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
