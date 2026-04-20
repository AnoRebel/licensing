/**
 * HMAC-SHA-256 signature backend.
 *
 * Profile:
 *   - Algorithm: HMAC-SHA-256 (RFC 2104).
 *   - Secret length: **minimum 32 bytes** enforced at import / generate.
 *     Shorter secrets are rejected with `InsufficientKeyStrength`.
 *   - Signature size: 32 bytes.
 *   - Verification uses `crypto.timingSafeEqual` — never `===` — to avoid
 *     timing side-channels.
 *
 * Caveats (documented for operators):
 *   - HMAC is **symmetric**. The "public key" is the same secret as the
 *     "private key". Distributing the secret to multiple verifiers means
 *     each verifier can also forge tokens. Use only in self-contained
 *     deployments where issuer and verifier are the same trust boundary
 *     (e.g., a single process, or a cluster sharing one signing key over
 *     trusted transport).
 *   - PEM is not a natural representation for HMAC; this backend accepts
 *     raw bytes only. The `PemKeyMaterial` input path is rejected with a
 *     clear error so operators can't accidentally wire a PEM key into HMAC.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { errors } from '../errors.ts';
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

export const HMAC_MIN_SECRET_LEN = 32;
export const HMAC_SIG_LEN = 32;
export const HMAC_DEFAULT_SECRET_LEN = 32;
export const HMAC_HASH = 'sha256' as const;

interface HMACHandle extends PrivateKeyHandle, PublicKeyHandle {
  readonly __hmacSecret: Uint8Array;
}

function wrap(secret: Uint8Array): HMACHandle {
  return { __hmacSecret: secret } as HMACHandle;
}
function unwrap(h: PrivateKeyHandle | PublicKeyHandle): Uint8Array {
  return (h as HMACHandle).__hmacSecret;
}

function isRaw(m: PemKeyMaterial | RawKeyMaterial): m is RawKeyMaterial {
  return 'publicRaw' in m && m.publicRaw instanceof Uint8Array;
}

function assertSecretStrength(secret: Uint8Array): void {
  if (secret.length < HMAC_MIN_SECRET_LEN) {
    throw errors.insufficientKeyStrength(
      `HMAC secret must be ≥ ${HMAC_MIN_SECRET_LEN} bytes, got ${secret.length}`,
    );
  }
}

class HMACBackend implements SignatureBackend, Signer, Verifier, KeyGenerator {
  readonly alg = 'hs256' as const;

  async importPrivate(
    material: PemKeyMaterial | RawKeyMaterial,
    _passphrase?: string,
  ): Promise<PrivateKeyHandle> {
    if (!isRaw(material)) {
      throw errors.tokenMalformed('HMAC does not support PEM material — pass raw bytes');
    }
    const secret = material.privateRaw ?? material.publicRaw;
    assertSecretStrength(secret);
    // Copy so later mutation of the caller's array can't invalidate the handle.
    return wrap(new Uint8Array(secret));
  }

  async importPublic(material: PemKeyMaterial | RawKeyMaterial): Promise<PublicKeyHandle> {
    if (!isRaw(material)) {
      throw errors.tokenMalformed('HMAC does not support PEM material — pass raw bytes');
    }
    // For a symmetric scheme the "public" handle is the same secret. This
    // intentionally mirrors importPrivate so the signature backend interface
    // stays uniform across algorithms.
    assertSecretStrength(material.publicRaw);
    return wrap(new Uint8Array(material.publicRaw));
  }

  async sign(key: PrivateKeyHandle, data: Uint8Array): Promise<Uint8Array> {
    const mac = createHmac(HMAC_HASH, unwrap(key)).update(data).digest();
    return new Uint8Array(mac.buffer, mac.byteOffset, mac.byteLength);
  }

  async verify(key: PublicKeyHandle, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
    const expected = createHmac(HMAC_HASH, unwrap(key)).update(data).digest();
    if (signature.length !== expected.length) return false;
    // timingSafeEqual requires both to be Buffers of identical length.
    return timingSafeEqual(Buffer.from(signature), expected);
  }

  async generate(_passphrase: string): Promise<{ pem: PemKeyMaterial; raw: RawKeyMaterial }> {
    const secret = new Uint8Array(randomBytes(HMAC_DEFAULT_SECRET_LEN));
    // No PEM representation for HMAC; we surface null/empty strings and
    // require downstream to consume `raw`. The core's `KeyRecord` type
    // allows `privatePem: null`, and `publicPem` is documented as "same
    // bytes as privateRaw" for the symmetric case.
    return {
      pem: {
        privatePem: null,
        publicPem: '',
      },
      raw: {
        privateRaw: secret,
        publicRaw: secret,
      },
    };
  }
}

export const hmacBackend: SignatureBackend = new HMACBackend();
