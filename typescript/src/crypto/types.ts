/**
 * Signature backend interface, algorithm registry, and the key-identity
 * binding layer that blocks algorithm-confusion attacks.
 *
 * Concrete backends (Ed25519, RSA-PSS, HMAC-SHA-256) live as siblings in
 * this directory (`./ed25519.ts`, `./rsa.ts`, `./hmac.ts`) and register
 * themselves into an {@link AlgorithmRegistry} supplied by the caller.
 * This types module is backend-agnostic by construction.
 */

import { errors } from '../errors.ts';
import type { KeyAlg } from '../types.ts';

/** Raw key material exposed alongside PEM. */
export interface RawKeyMaterial {
  /** Raw private-key bytes in the algorithm's canonical representation:
   *  - Ed25519: 32-byte seed (NOT the 64-byte expanded form, NOT PKCS#8).
   *  - RSA: RFC 8017 DER.
   *  - HMAC: the raw secret.
   *  Null when the adapter holds only the public half. */
  readonly privateRaw: Uint8Array | null;
  /** Raw public-key bytes:
   *  - Ed25519: 32 bytes.
   *  - RSA: SubjectPublicKeyInfo DER-unwrapped (i.e. the inner BIT STRING).
   *  - HMAC: same bytes as `privateRaw` (symmetric).
   */
  readonly publicRaw: Uint8Array;
}

/** PEM-encoded key material (PKCS#8 for private, SPKI for public). */
export interface PemKeyMaterial {
  /** Encrypted PKCS#8 PEM; null when only the public half is held. */
  readonly privatePem: string | null;
  readonly publicPem: string;
}

/** A key storage adapter's view of one (kid, alg) binding. */
export interface KeyRecord extends PemKeyMaterial {
  readonly kid: string;
  readonly alg: KeyAlg;
  readonly raw: RawKeyMaterial;
}

/** Backend-supplied handles. Opaque to the core; backends unwrap internally. */
export type PrivateKeyHandle = { readonly __private: unique symbol };
export type PublicKeyHandle = { readonly __public: unique symbol };

export interface Signer {
  readonly alg: KeyAlg;
  /** Import raw or PEM key material into a usable handle. Throws on shape
   *  mismatch or insufficient strength (RSA <2048, HMAC <32 bytes, etc.). */
  importPrivate(
    material: PemKeyMaterial | RawKeyMaterial,
    passphrase?: string,
  ): Promise<PrivateKeyHandle>;
  sign(key: PrivateKeyHandle, data: Uint8Array): Promise<Uint8Array>;
}

export interface Verifier {
  readonly alg: KeyAlg;
  importPublic(material: PemKeyMaterial | RawKeyMaterial): Promise<PublicKeyHandle>;
  verify(key: PublicKeyHandle, data: Uint8Array, signature: Uint8Array): Promise<boolean>;
}

export interface KeyGenerator {
  readonly alg: KeyAlg;
  /** Produce a fresh keypair. Private material is encrypted with the
   *  supplied passphrase before the adapter stores it at rest. */
  generate(passphrase: string): Promise<{ pem: PemKeyMaterial; raw: RawKeyMaterial }>;
}

/** A full backend = signer + verifier + generator. */
export interface SignatureBackend extends Signer, Verifier, KeyGenerator {}

/**
 * Registry keyed by `alg`. Backends MUST register exactly once per alg.
 * A second registration for the same alg fails with
 * `AlgorithmAlreadyRegistered`.
 */
export class AlgorithmRegistry {
  #backends = new Map<KeyAlg, SignatureBackend>();

  register(backend: SignatureBackend): void {
    if (this.#backends.has(backend.alg)) {
      throw errors.algorithmAlreadyRegistered(backend.alg);
    }
    this.#backends.set(backend.alg, backend);
  }

  get(alg: string): SignatureBackend {
    const b = this.#backends.get(alg as KeyAlg);
    if (!b) throw errors.unsupportedAlgorithm(alg);
    return b;
  }

  has(alg: string): boolean {
    return this.#backends.has(alg as KeyAlg);
  }

  /** Iterate registered algs, stable insertion order. */
  algs(): readonly KeyAlg[] {
    return Array.from(this.#backends.keys());
  }
}

/**
 * Kid → alg pre-registration map. The core consults this BEFORE invoking
 * any backend, so a token whose header `alg` disagrees with the kid's
 * registered alg fails fast with `AlgorithmMismatch` — the classic
 * alg-confusion mitigation.
 */
export class KeyAlgBindings {
  #bindings = new Map<string, KeyAlg>();

  bind(kid: string, alg: KeyAlg): void {
    const existing = this.#bindings.get(kid);
    if (existing !== undefined && existing !== alg) {
      throw errors.algorithmMismatch(existing, alg);
    }
    this.#bindings.set(kid, alg);
  }

  /** Assert the incoming header's (kid, alg) matches a pre-registered pair.
   *  Throws `UnknownKid` if the kid was never bound; `AlgorithmMismatch`
   *  if the algs disagree. */
  expect(kid: string, alg: string): KeyAlg {
    const bound = this.#bindings.get(kid);
    if (bound === undefined) throw errors.unknownKid(kid);
    if (bound !== alg) throw errors.algorithmMismatch(bound, alg);
    return bound;
  }

  get(kid: string): KeyAlg | undefined {
    return this.#bindings.get(kid);
  }
}
