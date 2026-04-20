/**
 * Ed25519 signature backend.
 *
 * Uses Node/Bun's built-in `node:crypto` — which already ships Ed25519 via
 * OpenSSL. No third-party curve library is pulled in; auditors only need to
 * trust the runtime.
 *
 * What this module owns:
 *   - Key import from raw 32-byte seed / SPKI / PKCS#8 (plaintext PEM).
 *   - Key generation (plaintext PEM + raw seed / raw public).
 *   - Signing and verification over arbitrary byte sequences.
 *
 * What this module does NOT own:
 *   - Encrypted-at-rest PEM. Envelope encryption (PBES2 + PBKDF2 + AES-256-GCM)
 *     is the key-hierarchy layer's job (`../key-hierarchy.ts`). That layer
 *     takes plaintext key material from this backend and wraps it for storage;
 *     on load, it unwraps and hands us plaintext PEM or raw bytes again.
 *   - Key-record metadata (`kid`, `alg`, `state`). That lives in the storage
 *     adapter.
 */

import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';

import { errors, LicensingError } from '../errors.ts';
import type {
  KeyGenerator,
  PemKeyMaterial,
  PrivateKeyHandle,
  PublicKeyHandle,
  RawKeyMaterial,
  SignatureBackend,
  Signer,
  Verifier,
} from './types.ts';

// `node:crypto` hands us opaque `KeyObject`s; we brand them as the core's
// structural handle types. The brand is phantom-only — the runtime value is a
// plain KeyObject reference.
interface Ed25519PrivateHandle extends PrivateKeyHandle {
  readonly __ed25519Private: KeyObject;
}
interface Ed25519PublicHandle extends PublicKeyHandle {
  readonly __ed25519Public: KeyObject;
}

export const ED25519_RAW_KEY_LEN = 32;
export const ED25519_SIG_LEN = 64;

function wrapPrivate(k: KeyObject): Ed25519PrivateHandle {
  return { __ed25519Private: k } as Ed25519PrivateHandle;
}
function wrapPublic(k: KeyObject): Ed25519PublicHandle {
  return { __ed25519Public: k } as Ed25519PublicHandle;
}
function unwrapPrivate(h: PrivateKeyHandle): KeyObject {
  return (h as Ed25519PrivateHandle).__ed25519Private;
}
function unwrapPublic(h: PublicKeyHandle): KeyObject {
  return (h as Ed25519PublicHandle).__ed25519Public;
}

/**
 * PKCS#8 DER prefix for an unencrypted Ed25519 private key
 * (RFC 8410 §7). Appending the 32-byte seed yields a valid DER blob we can
 * feed to `createPrivateKey`. The 16 bytes below are literally the ASN.1
 * header for `OneAsymmetricKey { version=0, alg=id-Ed25519, privateKey=OCTET
 * STRING containing OCTET STRING(32) }`.
 */
const PKCS8_ED25519_PREFIX = Uint8Array.from([
  0x30,
  0x2e, // SEQUENCE, 46 bytes
  0x02,
  0x01,
  0x00, // INTEGER 0
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x70, // AlgorithmIdentifier: 1.3.101.112
  0x04,
  0x22, // OCTET STRING, 34 bytes
  0x04,
  0x20, // inner OCTET STRING, 32 bytes
]);

/** SPKI DER prefix for an Ed25519 public key (RFC 8410 §4). Appending the
 *  32-byte public key yields a valid SubjectPublicKeyInfo. */
const SPKI_ED25519_PREFIX = Uint8Array.from([
  0x30,
  0x2a, // SEQUENCE, 42 bytes
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x70, // AlgorithmIdentifier: 1.3.101.112
  0x03,
  0x21,
  0x00, // BIT STRING, 33 bytes, 0 unused bits
]);

export function seedToPkcs8Der(seed: Uint8Array): Uint8Array {
  if (seed.length !== ED25519_RAW_KEY_LEN) {
    throw errors.insufficientKeyStrength(
      `ed25519 seed must be ${ED25519_RAW_KEY_LEN} bytes, got ${seed.length}`,
    );
  }
  const out = new Uint8Array(PKCS8_ED25519_PREFIX.length + seed.length);
  out.set(PKCS8_ED25519_PREFIX, 0);
  out.set(seed, PKCS8_ED25519_PREFIX.length);
  return out;
}

export function publicToSpkiDer(pub: Uint8Array): Uint8Array {
  if (pub.length !== ED25519_RAW_KEY_LEN) {
    throw errors.insufficientKeyStrength(
      `ed25519 public key must be ${ED25519_RAW_KEY_LEN} bytes, got ${pub.length}`,
    );
  }
  const out = new Uint8Array(SPKI_ED25519_PREFIX.length + pub.length);
  out.set(SPKI_ED25519_PREFIX, 0);
  out.set(pub, SPKI_ED25519_PREFIX.length);
  return out;
}

/**
 * Extract the 32-byte raw seed from a PKCS#8 Ed25519 KeyObject.
 * Node's `KeyObject.export({format:'jwk'})` returns `{ crv:'Ed25519', d, x }`
 * for an Ed25519 private key — `d` is the base64url-encoded 32-byte seed.
 */
export function privateKeyObjectToRawSeed(k: KeyObject): Uint8Array {
  const jwk = k.export({ format: 'jwk' }) as { crv?: string; d?: string };
  if (jwk.crv !== 'Ed25519' || typeof jwk.d !== 'string') {
    throw errors.tokenMalformed('expected Ed25519 private JWK with `d`');
  }
  const seed = Buffer.from(jwk.d, 'base64url');
  if (seed.length !== ED25519_RAW_KEY_LEN) {
    throw errors.insufficientKeyStrength(
      `decoded seed length ${seed.length} ≠ ${ED25519_RAW_KEY_LEN}`,
    );
  }
  return new Uint8Array(seed);
}

export function publicKeyObjectToRawBytes(k: KeyObject): Uint8Array {
  const jwk = k.export({ format: 'jwk' }) as { crv?: string; x?: string };
  if (jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw errors.tokenMalformed('expected Ed25519 public JWK with `x`');
  }
  const x = Buffer.from(jwk.x, 'base64url');
  if (x.length !== ED25519_RAW_KEY_LEN) {
    throw errors.insufficientKeyStrength(
      `decoded public length ${x.length} ≠ ${ED25519_RAW_KEY_LEN}`,
    );
  }
  return new Uint8Array(x);
}

function isRaw(m: PemKeyMaterial | RawKeyMaterial): m is RawKeyMaterial {
  return 'publicRaw' in m && m.publicRaw instanceof Uint8Array;
}

function isPem(m: PemKeyMaterial | RawKeyMaterial): m is PemKeyMaterial {
  return 'publicPem' in m && typeof (m as PemKeyMaterial).publicPem === 'string';
}

class Ed25519Backend implements SignatureBackend, Signer, Verifier, KeyGenerator {
  readonly alg = 'ed25519' as const;

  async importPrivate(
    material: PemKeyMaterial | RawKeyMaterial,
    passphrase?: string,
  ): Promise<PrivateKeyHandle> {
    try {
      if (isRaw(material)) {
        if (!material.privateRaw) {
          throw errors.tokenMalformed('raw material has no privateRaw');
        }
        const der = seedToPkcs8Der(material.privateRaw);
        // Pass a Buffer view so Node's type defs accept it without a cast.
        return wrapPrivate(
          createPrivateKey({ key: Buffer.from(der), format: 'der', type: 'pkcs8' }),
        );
      }
      if (isPem(material)) {
        if (!material.privatePem) {
          throw errors.tokenMalformed('PEM material has no privatePem');
        }
        const opts: Parameters<typeof createPrivateKey>[0] = { key: material.privatePem };
        if (passphrase !== undefined) {
          (opts as { passphrase?: string }).passphrase = passphrase;
        }
        return wrapPrivate(createPrivateKey(opts));
      }
      throw errors.tokenMalformed('unrecognized key material shape');
    } catch (e) {
      // Preserve typed LicensingErrors; any other throw (bad passphrase,
      // malformed PEM, bad DER) maps to the generic key-decryption code so we
      // don't leak OpenSSL internals to callers.
      if (e instanceof LicensingError) throw e;
      throw errors.keyDecryptionFailed();
    }
  }

  async importPublic(material: PemKeyMaterial | RawKeyMaterial): Promise<PublicKeyHandle> {
    if (isRaw(material)) {
      const der = publicToSpkiDer(material.publicRaw);
      return wrapPublic(createPublicKey({ key: Buffer.from(der), format: 'der', type: 'spki' }));
    }
    if (isPem(material)) {
      return wrapPublic(createPublicKey(material.publicPem));
    }
    throw errors.tokenMalformed('unrecognized key material shape');
  }

  async sign(key: PrivateKeyHandle, data: Uint8Array): Promise<Uint8Array> {
    // Ed25519 uses `null` as the digest algorithm — the curve signs the raw
    // message. Node returns a Buffer; we expose a fresh Uint8Array view.
    const sig = cryptoSign(null, data, unwrapPrivate(key));
    if (sig.length !== ED25519_SIG_LEN) {
      throw errors.tokenSignatureInvalid();
    }
    return new Uint8Array(sig.buffer, sig.byteOffset, sig.byteLength);
  }

  async verify(key: PublicKeyHandle, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
    if (signature.length !== ED25519_SIG_LEN) return false;
    return cryptoVerify(null, data, unwrapPublic(key), signature);
  }

  async generate(_passphrase: string): Promise<{ pem: PemKeyMaterial; raw: RawKeyMaterial }> {
    // Passphrase-based encryption happens in the key-hierarchy layer.
    // Here we just hand back plaintext PEM + raw bytes; the caller wraps them.
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privateRaw = privateKeyObjectToRawSeed(privateKey);
    const publicRaw = publicKeyObjectToRawBytes(publicKey);
    const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    return {
      pem: { privatePem, publicPem },
      raw: { privateRaw, publicRaw },
    };
  }
}

/** Single frozen backend instance. Callers pass this to
 *  `AlgorithmRegistry.register()`. */
export const ed25519Backend: SignatureBackend = new Ed25519Backend();
