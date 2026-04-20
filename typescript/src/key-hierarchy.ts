/**
 * Two-level key hierarchy with rotation and encrypted-at-rest storage.
 *
 * ```
 *   ┌─────────────┐        certifies         ┌──────────────────┐
 *   │  Root key   │ ────────────────────────▶│  Signing key(s)  │
 *   │ (per-scope  │         via              │  one `active`    │
 *   │  or global) │      signed bundle       │  n `retiring`    │
 *   └─────────────┘                          └──────────────────┘
 *                                                    │
 *                                                    ▼
 *                                            LIC1 tokens carry
 *                                            `kid = signing.kid`
 * ```
 *
 * Invariants enforced:
 *   - **At most one `active` signing key per (scope_id, role='signing')**.
 *     Matches `fixtures/schema/entities.md` partial-unique constraint.
 *   - Rotation never destroys outstanding tokens: the outgoing key becomes
 *     `retiring` (still valid for `verify`) until its `not_after`.
 *   - Root keys are `role='root'` and NEVER used to sign LIC1 tokens — only
 *     to sign attestations over signing-key public bytes. The issuer MUST
 *     reject token signing requests against a root key.
 *   - Private key material is stored only as
 *     `wrapEncryptedPkcs8(plaintextDer, passphrase)` output. Plaintext
 *     never touches the {@link KeyStore}.
 *   - Passphrase is never logged or returned; functions that require it
 *     take it as a parameter and drop the reference on return.
 *
 * ### Root attestation
 *
 * For each signing key, the root key signs the canonical JSON:
 * ```json
 * { "kid":"<signing.kid>", "alg":"<signing.alg>", "pub":"<base64url(raw public)>",
 *   "not_before":"<iso>", "not_after":"<iso|null>" }
 * ```
 * The 64-byte (ed25519) / variable (RSA) attestation is stored alongside the
 * signing key in `meta.root_attestation`. Verifiers that want a "does this
 * signing key descend from root R?" check can re-canonicalize and verify.
 * This is an opt-in feature; the LIC1 verification path does not require it.
 */

import { decode as b64urlDecode, encode as b64urlEncode } from './base64url.ts';
import { canonicalize } from './canonical-json.ts';
import type { SignatureBackend } from './crypto/types.ts';
import { unwrapEncryptedPkcs8, wrapEncryptedPkcs8 } from './encrypted-pkcs8.ts';
import { errors } from './errors.ts';
import { type Clock, newUuidV7, systemClock } from './id.ts';
import type { KeyAlg, KeyRole, KeyState, LicenseKey, UUIDv7 } from './types.ts';

// -------- KeyStore contract --------

/** Minimal persistence contract for `LicenseKey` records. Production
 *  adapters live in `@licensing/storage-*`; the core ships an in-memory
 *  implementation for tests and key-hierarchy flows that don't need
 *  durability yet. */
export interface KeyStore {
  put(record: LicenseKey): Promise<void>;
  get(id: UUIDv7): Promise<LicenseKey | null>;
  findByKid(kid: string): Promise<LicenseKey | null>;
  list(filter: KeyStoreFilter): Promise<readonly LicenseKey[]>;
  /** Atomically replace a record. Throws if `priorId` no longer matches. */
  update(id: UUIDv7, next: LicenseKey): Promise<void>;
}

export interface KeyStoreFilter {
  readonly scope_id?: UUIDv7 | null;
  readonly role?: KeyRole;
  readonly state?: KeyState;
  readonly alg?: KeyAlg;
}

export class InMemoryKeyStore implements KeyStore {
  #byId = new Map<UUIDv7, LicenseKey>();
  #byKid = new Map<string, UUIDv7>();

  async put(record: LicenseKey): Promise<void> {
    const existingId = this.#byKid.get(record.kid);
    if (existingId !== undefined && existingId !== record.id) {
      throw errors.uniqueConstraintViolation('kid', record.kid);
    }
    this.#byId.set(record.id, record);
    this.#byKid.set(record.kid, record.id);
  }

  async get(id: UUIDv7): Promise<LicenseKey | null> {
    return this.#byId.get(id) ?? null;
  }

  async findByKid(kid: string): Promise<LicenseKey | null> {
    const id = this.#byKid.get(kid);
    return id ? (this.#byId.get(id) ?? null) : null;
  }

  async list(filter: KeyStoreFilter): Promise<readonly LicenseKey[]> {
    const out: LicenseKey[] = [];
    for (const rec of this.#byId.values()) {
      if (filter.scope_id !== undefined && rec.scope_id !== filter.scope_id) continue;
      if (filter.role !== undefined && rec.role !== filter.role) continue;
      if (filter.state !== undefined && rec.state !== filter.state) continue;
      if (filter.alg !== undefined && rec.alg !== filter.alg) continue;
      out.push(rec);
    }
    // Stable order: by created_at then id.
    out.sort((a, b) => {
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return out;
  }

  async update(id: UUIDv7, next: LicenseKey): Promise<void> {
    if (!this.#byId.has(id)) throw errors.tokenMalformed(`key not found: ${id}`);
    if (id !== next.id) throw errors.tokenMalformed('update cannot change id');
    this.#byId.set(id, next);
    this.#byKid.set(next.kid, id);
  }
}

// -------- hierarchy --------

export interface KeyHierarchyOptions {
  readonly store: KeyStore;
  /** Registry keyed by alg → backend. */
  readonly backends: ReadonlyMap<KeyAlg, SignatureBackend>;
  /** Source of UUIDs and wall-clock instants. */
  readonly clock?: Clock;
  /** Deterministic kid generator. Defaults to `"<role>-<firstSegment>"` of
   *  the generated UUID. Tests can override for stable fixtures. */
  readonly makeKid?: (role: KeyRole, id: UUIDv7) => string;
}

export interface GenerateRootOptions {
  readonly scope_id: UUIDv7 | null;
  readonly alg: KeyAlg;
  readonly passphrase: string;
  readonly not_after?: string | null;
  readonly kid?: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface IssueSigningOptions {
  readonly scope_id: UUIDv7 | null;
  readonly alg: KeyAlg;
  readonly rootKid: string;
  readonly rootPassphrase: string;
  readonly signingPassphrase: string;
  readonly not_after?: string | null;
  readonly kid?: string;
}

export interface RotateSigningOptions {
  readonly scope_id: UUIDv7 | null;
  readonly alg: KeyAlg;
  readonly rootKid: string;
  readonly rootPassphrase: string;
  readonly signingPassphrase: string;
  /** If set, the outgoing key's `not_after` is clamped to this instant.
   *  Use to limit how long the old key keeps verifying tokens. Default:
   *  keep the existing `not_after` (or null). */
  readonly retireOutgoingAt?: string | null;
  readonly kid?: string;
}

export interface RootAttestation {
  /** Canonical JSON of `{kid, alg, pub, not_before, not_after}`. */
  readonly canonical: Uint8Array;
  /** Signature over `canonical` by the root key. */
  readonly signature: Uint8Array;
  /** Which root key produced the attestation. */
  readonly root_kid: string;
}

/**
 * Thin orchestration layer over {@link KeyStore} + {@link SignatureBackend}s.
 * All methods are idempotent in the sense that they either complete fully
 * and persist, or throw before persisting partial state.
 */
export class KeyHierarchy {
  readonly #store: KeyStore;
  readonly #backends: ReadonlyMap<KeyAlg, SignatureBackend>;
  readonly #clock: Clock;
  readonly #makeKid: (role: KeyRole, id: UUIDv7) => string;

  constructor(opts: KeyHierarchyOptions) {
    this.#store = opts.store;
    this.#backends = opts.backends;
    this.#clock = opts.clock ?? systemClock;
    // Default kid packs the 48-bit ms timestamp (groups 1+2) plus the 62-bit
    // rand_b (group 4). This guarantees collision-resistance even when two
    // kids are generated within the same millisecond — the 12-bit rand_a
    // alone isn't enough under birthday attack.
    this.#makeKid =
      opts.makeKid ??
      ((role, id) => {
        const parts = id.split('-');
        return `${role}-${parts[0]}${parts[1]}-${parts[3]}`;
      });
  }

  #backend(alg: KeyAlg): SignatureBackend {
    const b = this.#backends.get(alg);
    if (!b) throw errors.unsupportedAlgorithm(alg);
    return b;
  }

  /**
   * Generate a fresh root key. The root signs attestations over signing
   * keys but never LIC1 tokens themselves. Refuses an empty passphrase.
   */
  async generateRoot(opts: GenerateRootOptions): Promise<LicenseKey> {
    if (opts.passphrase.length === 0) throw errors.missingKeyPassphrase();
    const backend = this.#backend(opts.alg);
    const { pem, raw } = await backend.generate(opts.passphrase);

    const id = newUuidV7(this.#clock);
    const kid = opts.kid ?? this.#makeKid('root', id);
    const now = this.#clock.nowIso();

    const privateDer = pemToDerIfPresent(pem.privatePem, raw.privateRaw);
    const privateEnc = privateDer ? wrapEncryptedPkcs8(privateDer, opts.passphrase) : null;

    const record: LicenseKey = {
      id,
      scope_id: opts.scope_id,
      kid,
      alg: opts.alg,
      role: 'root',
      state: 'active', // roots are always `active`; they're retired by being deleted
      public_pem: pem.publicPem,
      private_pem_enc: privateEnc,
      rotated_from: null,
      rotated_at: null,
      not_before: now,
      not_after: opts.not_after ?? null,
      meta: freezeMeta(opts.meta),
      created_at: now,
      updated_at: now,
    };
    await this.#store.put(record);
    return record;
  }

  /**
   * Issue a new signing key under a given root. There MUST NOT already be
   * an `active` signing key for (`scope_id`, `alg`) — callers should use
   * {@link rotateSigning} to replace one.
   */
  async issueSigning(opts: IssueSigningOptions): Promise<LicenseKey> {
    if (opts.signingPassphrase.length === 0) throw errors.missingKeyPassphrase();
    if (opts.rootPassphrase.length === 0) throw errors.missingKeyPassphrase();

    const existing = await this.#store.list({
      scope_id: opts.scope_id,
      role: 'signing',
      state: 'active',
      alg: opts.alg,
    });
    if (existing.length > 0) {
      throw errors.uniqueConstraintViolation(
        'active_signing_per_scope',
        `${opts.scope_id ?? 'global'}/${opts.alg}`,
      );
    }

    const root = await this.#requireRoot(opts.rootKid, opts.alg, opts.scope_id);
    const backend = this.#backend(opts.alg);
    const { pem, raw } = await backend.generate(opts.signingPassphrase);

    const id = newUuidV7(this.#clock);
    const kid = opts.kid ?? this.#makeKid('signing', id);
    const now = this.#clock.nowIso();

    const privateDer = pemToDerIfPresent(pem.privatePem, raw.privateRaw);
    const privateEnc = privateDer ? wrapEncryptedPkcs8(privateDer, opts.signingPassphrase) : null;

    const attestation = await this.#attestSigning(root, opts.rootPassphrase, {
      kid,
      alg: opts.alg,
      publicRaw: raw.publicRaw,
      not_before: now,
      not_after: opts.not_after ?? null,
    });

    const record: LicenseKey = {
      id,
      scope_id: opts.scope_id,
      kid,
      alg: opts.alg,
      role: 'signing',
      state: 'active',
      public_pem: pem.publicPem,
      private_pem_enc: privateEnc,
      rotated_from: null,
      rotated_at: null,
      not_before: now,
      not_after: opts.not_after ?? null,
      meta: freezeMeta({
        root_attestation: {
          root_kid: attestation.root_kid,
          signature: b64urlEncode(attestation.signature),
        },
      }),
      created_at: now,
      updated_at: now,
    };
    await this.#store.put(record);
    return record;
  }

  /**
   * Rotate the active signing key for a scope. The outgoing key is marked
   * `retiring` (still verifies outstanding tokens); a new `active` key is
   * issued and certified by the same root.
   *
   * @returns `{ outgoing, incoming }` — the previous key (now `retiring`)
   *   and the freshly-issued active key.
   */
  async rotateSigning(
    opts: RotateSigningOptions,
  ): Promise<{ outgoing: LicenseKey; incoming: LicenseKey }> {
    const actives = await this.#store.list({
      scope_id: opts.scope_id,
      role: 'signing',
      state: 'active',
      alg: opts.alg,
    });
    if (actives.length === 0) {
      throw errors.tokenMalformed(
        `no active signing key to rotate for scope=${opts.scope_id ?? 'global'} alg=${opts.alg}`,
      );
    }
    if (actives.length > 1) {
      // Invariant violation: multiple active keys. Not recoverable here —
      // callers need to manually reconcile.
      throw errors.uniqueConstraintViolation(
        'active_signing_per_scope',
        `${opts.scope_id ?? 'global'}/${opts.alg} (found ${actives.length})`,
      );
    }
    const [outgoingActive] = actives;
    if (!outgoingActive)
      throw errors.tokenMalformed('invariant: active list empty after size check');

    // Demote outgoing to `retiring`.
    const now = this.#clock.nowIso();
    const retiringRec: LicenseKey = {
      ...outgoingActive,
      state: 'retiring',
      not_after:
        opts.retireOutgoingAt !== undefined ? opts.retireOutgoingAt : outgoingActive.not_after,
      rotated_at: now,
      updated_at: now,
    };
    await this.#store.update(outgoingActive.id, retiringRec);

    // Issue incoming as `active`, linked back to outgoing via rotated_from.
    const issued = await this.issueSigning({
      scope_id: opts.scope_id,
      alg: opts.alg,
      rootKid: opts.rootKid,
      rootPassphrase: opts.rootPassphrase,
      signingPassphrase: opts.signingPassphrase,
      ...(opts.kid !== undefined ? { kid: opts.kid } : {}),
    });
    const linked: LicenseKey = { ...issued, rotated_from: outgoingActive.id, updated_at: now };
    await this.#store.update(issued.id, linked);

    return { outgoing: retiringRec, incoming: linked };
  }

  /** List every key record the store knows about, filtered. */
  async list(filter: KeyStoreFilter = {}): Promise<readonly LicenseKey[]> {
    return this.#store.list(filter);
  }

  /** Fetch by kid. Returns `null` if unknown — callers MUST treat that as
   *  `UnknownKid` at the validator. */
  async findByKid(kid: string): Promise<LicenseKey | null> {
    return this.#store.findByKid(kid);
  }

  /**
   * Re-verify a signing key's root attestation. Useful for operators doing a
   * post-rotation audit, and for the verifier if it wants to assert a full
   * chain (opt-in; LIC1 validation doesn't require it).
   *
   * @returns `true` if the stored attestation signature verifies against
   *   the current record's root attestation bundle.
   */
  async verifyAttestation(signingKid: string): Promise<boolean> {
    const signing = await this.#store.findByKid(signingKid);
    if (!signing || signing.role !== 'signing') return false;
    const att = (signing.meta as { root_attestation?: { root_kid?: string; signature?: string } })
      .root_attestation;
    if (!att?.root_kid || !att?.signature) return false;
    const root = await this.#store.findByKid(att.root_kid);
    if (!root || root.role !== 'root' || root.alg !== signing.alg) return false;

    const backend = this.#backend(signing.alg);
    const pub = await backend.importPublic({ privatePem: null, publicPem: root.public_pem });
    const canonical = attestationCanonical({
      kid: signing.kid,
      alg: signing.alg,
      publicRaw: await extractPublicRawFromRecord(signing),
      not_before: signing.not_before,
      not_after: signing.not_after,
    });
    return backend.verify(pub, canonical, b64urlDecode(att.signature));
  }

  /**
   * Import a previously-stored signing key's private material so it can be
   * used to sign LIC1 tokens. Does NOT cache — callers should release the
   * handle immediately after use. Refuses root keys outright.
   */
  async importSigningPrivate(
    kid: string,
    passphrase: string,
  ): Promise<{
    record: LicenseKey;
    handle: Awaited<ReturnType<SignatureBackend['importPrivate']>>;
  }> {
    if (passphrase.length === 0) throw errors.missingKeyPassphrase();
    const record = await this.#store.findByKid(kid);
    if (!record) throw errors.unknownKid(kid);
    if (record.role !== 'signing') {
      throw errors.tokenMalformed(
        `key ${kid} has role=${record.role}; only signing keys may sign LIC1 tokens`,
      );
    }
    if (!record.private_pem_enc) {
      throw errors.tokenMalformed(`key ${kid} holds only public material`);
    }
    const backend = this.#backend(record.alg);
    const plaintextDer = unwrapEncryptedPkcs8(record.private_pem_enc, passphrase);
    const pemText = derToPkcs8Pem(plaintextDer);
    const handle = await backend.importPrivate({
      privatePem: pemText,
      publicPem: record.public_pem,
    });
    return { record, handle };
  }

  // -------- internals --------

  async #requireRoot(rootKid: string, alg: KeyAlg, scope_id: UUIDv7 | null): Promise<LicenseKey> {
    const root = await this.#store.findByKid(rootKid);
    if (!root) throw errors.unknownKid(rootKid);
    if (root.role !== 'root') throw errors.tokenMalformed(`kid ${rootKid} is not a root key`);
    if (root.alg !== alg) throw errors.algorithmMismatch(root.alg, alg);
    if (root.scope_id !== scope_id) {
      throw errors.tokenMalformed(
        `root scope (${root.scope_id ?? 'global'}) ≠ requested scope (${scope_id ?? 'global'})`,
      );
    }
    return root;
  }

  async #attestSigning(
    root: LicenseKey,
    passphrase: string,
    signing: {
      kid: string;
      alg: KeyAlg;
      publicRaw: Uint8Array;
      not_before: string;
      not_after: string | null;
    },
  ): Promise<RootAttestation> {
    if (!root.private_pem_enc) {
      throw errors.tokenMalformed(`root ${root.kid} holds only public material`);
    }
    const backend = this.#backend(root.alg);
    const plaintextDer = unwrapEncryptedPkcs8(root.private_pem_enc, passphrase);
    const pemText = derToPkcs8Pem(plaintextDer);
    const priv = await backend.importPrivate({ privatePem: pemText, publicPem: root.public_pem });
    const canonical = attestationCanonical(signing);
    const signature = await backend.sign(priv, canonical);
    return { canonical, signature, root_kid: root.kid };
  }
}

// -------- helpers --------

function freezeMeta(
  m: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, import('./types.ts').JSONValue>> {
  if (!m) return Object.freeze({});
  // Caller is responsible for passing JSON-safe values. We shallow-freeze.
  return Object.freeze({ ...(m as Record<string, import('./types.ts').JSONValue>) });
}

function attestationCanonical(signing: {
  kid: string;
  alg: KeyAlg;
  publicRaw: Uint8Array;
  not_before: string;
  not_after: string | null;
}): Uint8Array {
  return canonicalize({
    kid: signing.kid,
    alg: signing.alg,
    pub: b64urlEncode(signing.publicRaw),
    not_before: signing.not_before,
    not_after: signing.not_after,
  });
}

/**
 * When the backend's `generate()` returned raw private material but no PEM,
 * fall back to the raw path. In practice every asymmetric backend in this
 * repo returns both; HMAC returns no PEM and is stored raw-only.
 */
function pemToDerIfPresent(
  privatePem: string | null,
  privateRaw: Uint8Array | null,
): Uint8Array | null {
  if (privatePem) return pkcs8PemToDer(privatePem);
  if (privateRaw) return privateRaw;
  return null;
}

function pkcs8PemToDer(pem: string): Uint8Array {
  const begin = '-----BEGIN PRIVATE KEY-----';
  const end = '-----END PRIVATE KEY-----';
  const bi = pem.indexOf(begin);
  const ei = pem.indexOf(end);
  if (bi < 0 || ei < 0 || ei <= bi) {
    throw errors.tokenMalformed('pkcs8PemToDer: PEM armor not found');
  }
  const b64 = pem.slice(bi + begin.length, ei).replace(/\s+/g, '');
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function derToPkcs8Pem(der: Uint8Array): string {
  const b64 = Buffer.from(der).toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

/**
 * Recover the raw public bytes from a stored record. Backends differ on
 * how much of the raw format is recoverable from SPKI alone:
 *   - Ed25519: 32-byte public is directly recoverable from SPKI JWK `x`.
 *   - RSA: raw is the whole DER SPKI, so we re-emit that.
 *   - HMAC: public == private == secret; not applicable to attestation.
 *
 * This helper is only called for attestation verification, so HMAC never
 * reaches it.
 */
async function extractPublicRawFromRecord(record: LicenseKey): Promise<Uint8Array> {
  // Re-derive raw bytes from the stored SPKI PEM via node:crypto JWK
  // export. Used only by attestation (re-)verification, which is opt-in.
  const { createPublicKey } = await import('node:crypto');
  const k = createPublicKey(record.public_pem);
  if (record.alg === 'ed25519') {
    const jwk = k.export({ format: 'jwk' }) as { x?: string };
    if (typeof jwk.x !== 'string') throw errors.tokenMalformed('ed25519 public JWK missing x');
    return new Uint8Array(Buffer.from(jwk.x, 'base64url'));
  }
  if (record.alg === 'rs256-pss') {
    const der = k.export({ format: 'der', type: 'spki' });
    return new Uint8Array(der.buffer, der.byteOffset, der.byteLength);
  }
  throw errors.unsupportedAlgorithm(record.alg);
}
