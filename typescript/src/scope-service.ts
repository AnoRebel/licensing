/**
 * LicenseScope create / list / rotate-key flows.
 *
 * Semantics:
 *
 *   1. `createScope` persists a new scope atomically with a `scope.created`
 *      audit row. Slug uniqueness has two layers: (a) a pre-check inside
 *      the tx that converts the common case into a typed
 *      `UniqueConstraintViolation('scope.slug', <slug>)` with an identical
 *      error surface across backends, and (b) the adapter-level UNIQUE
 *      INDEX `license_scopes_slug_key` that backstops concurrent inserts —
 *      the pre-check alone is racy, the unique index alone would surface
 *      adapter-specific errors. Together they give us typed errors for the
 *      common path plus a true invariant for the race.
 *
 *   2. `generateRootKey` and `issueInitialSigningKey` bootstrap a scope's
 *      key hierarchy: caller `generateRootKey` once per scope (passphrase
 *      locked away in a KMS/HSM in prod), then `issueInitialSigningKey` to
 *      mint the first active signing key. Each writes `key.root.issued` /
 *      `key.signing.issued` audit rows in the same tx as the insert, so
 *      there's no "key exists but no audit trail" window.
 *
 *   3. `rotateSigningKey` orchestrates `KeyHierarchy.rotateSigning` against
 *      a `StorageTx`-backed `KeyStore`, then writes a `key.rotated` audit
 *      row referencing the outgoing + incoming kids. All of it runs inside
 *      a single `withTransaction`, so the `retiring` demotion, new `active`
 *      issuance, root-attestation signing, and audit row are one unit:
 *      either every write lands or none do. Outstanding tokens keep
 *      validating against the `retiring` key until its `not_after`, so a
 *      rotation does not invalidate live tokens.
 *
 * ### Why a Storage-backed KeyStore instead of InMemoryKeyStore
 *
 * `KeyHierarchy` was designed against a minimal `KeyStore` interface so it
 * could work with CLI-era `JsonFileKeyStore` and test-only `InMemoryKeyStore`.
 * Production issuers need persistence + transactional consistency with audit
 * rows, so we wrap a `StorageTx` (or `Storage` outside a tx) as a `KeyStore`.
 * The adapter delegates `put` → `createKey` / `update` → `updateKey`,
 * `findByKid` → `getKeyByKid`, `list` → `listKeys`, and translates page
 * iteration into the flat array the `KeyStore` contract expects.
 */

import type { SignatureBackend } from './crypto/types.ts';
import { errors } from './errors.ts';
import type { Clock } from './id.ts';
import { KeyHierarchy, type KeyStore, type KeyStoreFilter } from './key-hierarchy.ts';
import type { Storage, StorageTx } from './storage/types.ts';
import type { JSONValue, KeyAlg, LicenseKey, LicenseScope, UUIDv7 } from './types.ts';

export interface CreateScopeInput {
  readonly slug: string;
  readonly name: string;
  readonly meta?: Readonly<Record<string, JSONValue>>;
}

export interface CreateScopeOptions {
  readonly actor?: string;
}

/**
 * Create a new scope. Slug must be unique (pre-checked inside the tx to get
 * a stable typed error across backends). Emits a `scope.created` audit row.
 */
export async function createScope(
  storage: Storage,
  clock: Clock,
  input: CreateScopeInput,
  opts: CreateScopeOptions = {},
): Promise<LicenseScope> {
  return storage.withTransaction(async (tx) => {
    const existing = await tx.getScopeBySlug(input.slug);
    if (existing !== null) {
      throw errors.uniqueConstraintViolation('scope.slug', input.slug);
    }

    const scope = await tx.createScope({
      slug: input.slug,
      name: input.name,
      meta: input.meta ?? {},
    });

    await tx.appendAudit({
      license_id: null,
      scope_id: scope.id,
      actor: opts.actor ?? 'system',
      event: 'scope.created',
      prior_state: null,
      new_state: {
        scope_id: scope.id,
        slug: scope.slug,
        name: scope.name,
      },
      occurred_at: clock.nowIso(),
    });

    return scope;
  });
}

// ---------- Root + initial signing key issuance ----------

export interface GenerateRootKeyInput {
  readonly scope_id: UUIDv7 | null;
  readonly alg: KeyAlg;
  readonly passphrase: string;
  /** Optional expiry for the root itself. `null` = no expiry (default). */
  readonly not_after?: string | null;
  /** Optional deterministic kid override — prefer the default (derived from
   *  the UUID) unless reproducing fixtures. */
  readonly kid?: string;
}

export interface KeyIssueOptions {
  readonly actor?: string;
}

/**
 * Generate a fresh root key for a scope (or the global scope). Writes a
 * `key.root.issued` audit row. Root keys are ONLY used to sign attestations
 * over signing keys — never LIC1 tokens themselves. The passphrase is
 * consumed in-frame and never persisted; the returned record holds only
 * the encrypted PKCS8 blob.
 */
export async function generateRootKey(
  storage: Storage,
  clock: Clock,
  backends: ReadonlyMap<KeyAlg, SignatureBackend>,
  input: GenerateRootKeyInput,
  opts: KeyIssueOptions = {},
): Promise<LicenseKey> {
  return storage.withTransaction(async (tx) => {
    const store = new StorageKeyStore(tx);
    const hierarchy = new KeyHierarchy({ store, backends, clock });
    const root = await hierarchy.generateRoot({
      scope_id: input.scope_id,
      alg: input.alg,
      passphrase: input.passphrase,
      ...(input.not_after !== undefined ? { not_after: input.not_after } : {}),
      ...(input.kid !== undefined ? { kid: input.kid } : {}),
    });
    // The hierarchy-assigned id was translated to the adapter's id by put().
    // We read back by kid so the audit row + return value carry the
    // authoritative (adapter-side) id.
    const persisted = await tx.getKeyByKid(root.kid);
    if (persisted === null) {
      throw errors.tokenMalformed(`root key disappeared after issuance: ${root.kid}`);
    }
    await tx.appendAudit({
      license_id: null,
      scope_id: input.scope_id,
      actor: opts.actor ?? 'system',
      event: 'key.root.issued',
      prior_state: null,
      new_state: {
        kid: persisted.kid,
        alg: persisted.alg,
        role: persisted.role,
        not_after: persisted.not_after,
      },
      occurred_at: clock.nowIso(),
    });
    return persisted;
  });
}

export interface IssueInitialSigningKeyInput {
  readonly scope_id: UUIDv7 | null;
  readonly alg: KeyAlg;
  readonly rootKid: string;
  readonly rootPassphrase: string;
  readonly signingPassphrase: string;
  readonly not_after?: string | null;
  readonly kid?: string;
}

/**
 * Mint the first active signing key for a scope, attested by the given
 * root. There MUST NOT already be an active signing key for `(scope_id,
 * alg)` — use {@link rotateSigningKey} to replace an existing one. Writes
 * a `key.signing.issued` audit row.
 */
export async function issueInitialSigningKey(
  storage: Storage,
  clock: Clock,
  backends: ReadonlyMap<KeyAlg, SignatureBackend>,
  input: IssueInitialSigningKeyInput,
  opts: KeyIssueOptions = {},
): Promise<LicenseKey> {
  return storage.withTransaction(async (tx) => {
    const store = new StorageKeyStore(tx);
    const hierarchy = new KeyHierarchy({ store, backends, clock });
    const signing = await hierarchy.issueSigning({
      scope_id: input.scope_id,
      alg: input.alg,
      rootKid: input.rootKid,
      rootPassphrase: input.rootPassphrase,
      signingPassphrase: input.signingPassphrase,
      ...(input.not_after !== undefined ? { not_after: input.not_after } : {}),
      ...(input.kid !== undefined ? { kid: input.kid } : {}),
    });
    const persisted = await tx.getKeyByKid(signing.kid);
    if (persisted === null) {
      throw errors.tokenMalformed(`signing key disappeared after issuance: ${signing.kid}`);
    }
    await tx.appendAudit({
      license_id: null,
      scope_id: input.scope_id,
      actor: opts.actor ?? 'system',
      event: 'key.signing.issued',
      prior_state: null,
      new_state: {
        kid: persisted.kid,
        alg: persisted.alg,
        role: persisted.role,
        root_kid: input.rootKid,
        not_after: persisted.not_after,
      },
      occurred_at: clock.nowIso(),
    });
    return persisted;
  });
}

export interface RotateSigningKeyInput {
  readonly scope_id: UUIDv7 | null;
  readonly alg: KeyAlg;
  readonly rootKid: string;
  readonly rootPassphrase: string;
  readonly signingPassphrase: string;
  /** Optional clamp on the outgoing key's `not_after`. See
   *  {@link RotateSigningOptions.retireOutgoingAt}. */
  readonly retireOutgoingAt?: string | null;
  readonly kid?: string;
}

export interface RotateSigningKeyOptions {
  readonly actor?: string;
}

export interface RotateSigningKeyResult {
  readonly outgoing: LicenseKey;
  readonly incoming: LicenseKey;
}

/**
 * Rotate the active signing key for a scope (or the global scope if
 * `scope_id === null`). Emits a `key.rotated` audit row. The outgoing key
 * is demoted to `retiring` so unexpired tokens keep validating until their
 * `exp`; a new `active` key is issued and root-attested.
 */
export async function rotateSigningKey(
  storage: Storage,
  clock: Clock,
  backends: ReadonlyMap<KeyAlg, SignatureBackend>,
  input: RotateSigningKeyInput,
  opts: RotateSigningKeyOptions = {},
): Promise<RotateSigningKeyResult> {
  return storage.withTransaction(async (tx) => {
    const store = new StorageKeyStore(tx);
    const hierarchy = new KeyHierarchy({ store, backends, clock });
    const result = await hierarchy.rotateSigning({
      scope_id: input.scope_id,
      alg: input.alg,
      rootKid: input.rootKid,
      rootPassphrase: input.rootPassphrase,
      signingPassphrase: input.signingPassphrase,
      ...(input.retireOutgoingAt !== undefined ? { retireOutgoingAt: input.retireOutgoingAt } : {}),
      ...(input.kid !== undefined ? { kid: input.kid } : {}),
    });

    await tx.appendAudit({
      license_id: null,
      scope_id: input.scope_id,
      actor: opts.actor ?? 'system',
      event: 'key.rotated',
      prior_state: {
        kid: result.outgoing.kid,
        state: 'active',
      },
      new_state: {
        outgoing_kid: result.outgoing.kid,
        outgoing_state: result.outgoing.state,
        incoming_kid: result.incoming.kid,
        incoming_state: result.incoming.state,
        alg: input.alg,
      },
      occurred_at: clock.nowIso(),
    });

    return result;
  });
}

// ---------- Storage-backed KeyStore adapter ----------

/**
 * Adapter that presents a `Storage` (or `StorageTx`) as a {@link KeyStore}.
 * Translates the page-based `listKeys` into the flat array the `KeyStore`
 * contract returns. Because `KeyHierarchy` only calls this during a single
 * rotation (one list + one put + one update), walking all pages is fine —
 * realistic key counts per scope are single digits.
 */
/**
 * Translates between the `KeyStore` contract (caller supplies ids) and the
 * `Storage.createKey` contract (adapter assigns ids). Because adapters own
 * uuidv7 generation — their clocks may differ from ours, and their schemas
 * enforce server-assigned ids — we keep a per-rotation id translation map:
 * when `put` is called with a hierarchy-assigned id, we insert via
 * `createKey` (which returns the adapter's id), remember
 * `hierarchyId → adapterId`, and answer subsequent `get`/`update` calls by
 * translating through the map. Kid is used as a stable cross-id handle for
 * anything we haven't observed via put.
 */
class StorageKeyStore implements KeyStore {
  readonly #tx: Pick<
    StorageTx | Storage,
    'createKey' | 'getKey' | 'getKeyByKid' | 'listKeys' | 'updateKey'
  >;
  /** hierarchy-assigned id → adapter-assigned id, populated on put(). */
  readonly #idMap = new Map<UUIDv7, UUIDv7>();

  constructor(
    tx: Pick<
      StorageTx | Storage,
      'createKey' | 'getKey' | 'getKeyByKid' | 'listKeys' | 'updateKey'
    >,
  ) {
    this.#tx = tx;
  }

  /** Resolve a hierarchy-facing id into the adapter-side id. Falls back to
   *  the input when we've never seen it (e.g. rows that existed before this
   *  rotation started). */
  #resolve(id: UUIDv7): UUIDv7 {
    return this.#idMap.get(id) ?? id;
  }

  async put(record: LicenseKey): Promise<void> {
    const existing = await this.#tx.getKeyByKid(record.kid);
    if (existing !== null) {
      throw errors.uniqueConstraintViolation('kid', record.kid);
    }
    const persisted = await this.#tx.createKey({
      scope_id: record.scope_id,
      kid: record.kid,
      alg: record.alg,
      role: record.role,
      state: record.state,
      public_pem: record.public_pem,
      private_pem_enc: record.private_pem_enc,
      rotated_from: record.rotated_from,
      rotated_at: record.rotated_at,
      not_before: record.not_before,
      not_after: record.not_after,
      meta: record.meta,
    });
    // Always record the translation, even when adapter happens to agree
    // with the hierarchy-assigned id on this put. Skipping the identity
    // case leaves `#resolve` falling back to the input id — fine today
    // because both our adapters mint server-side uuidv7s, but it's a
    // silent footgun the day an adapter preserves client-supplied ids:
    // subsequent rotations within the same tx would read through the
    // hierarchy id and miss this map entirely for records they DID store.
    this.#idMap.set(record.id, persisted.id);
  }

  async get(id: UUIDv7): Promise<LicenseKey | null> {
    return this.#tx.getKey(this.#resolve(id));
  }

  async findByKid(kid: string): Promise<LicenseKey | null> {
    return this.#tx.getKeyByKid(kid);
  }

  async list(filter: KeyStoreFilter): Promise<readonly LicenseKey[]> {
    const out: LicenseKey[] = [];
    let cursor: string | null | undefined;
    while (true) {
      const page = await this.#tx.listKeys(
        {
          ...(filter.scope_id !== undefined ? { scope_id: filter.scope_id } : {}),
          ...(filter.role !== undefined ? { role: filter.role } : {}),
          ...(filter.state !== undefined ? { state: filter.state } : {}),
          ...(filter.alg !== undefined ? { alg: filter.alg } : {}),
        },
        cursor === null || cursor === undefined ? { limit: 500 } : { limit: 500, cursor },
      );
      out.push(...page.items);
      if (page.cursor === null) return out;
      cursor = page.cursor;
    }
  }

  async update(id: UUIDv7, next: LicenseKey): Promise<void> {
    const realId = this.#resolve(id);
    const existing = await this.#tx.getKey(realId);
    if (existing === null) throw errors.tokenMalformed(`key not found: ${realId}`);
    if (existing.id !== realId) throw errors.tokenMalformed('update cannot change id');
    await this.#tx.updateKey(realId, {
      state: next.state,
      rotated_from: next.rotated_from,
      rotated_at: next.rotated_at,
      not_after: next.not_after,
      meta: next.meta,
    });
  }
}
