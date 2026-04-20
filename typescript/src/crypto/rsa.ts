/**
 * RSA-PSS signature backend.
 *
 * Profile: RSASSA-PSS with SHA-256 digest, MGF1(SHA-256), salt length 32
 * bytes, minimum modulus 2048 bits. Keys are imported as PKCS#8 PEM (private)
 * or SPKI PEM (public); the raw-bytes material is the DER-encoded key
 * unwrapped (i.e. the bytes `openssl rsa -outform DER` emits) for the private
 * half and the inner SubjectPublicKey BIT STRING payload for the public half.
 *
 * Encrypted-at-rest PEM is NOT this module's responsibility — the key
 * hierarchy layer (`../key-hierarchy.ts`) wraps the plaintext PEM from
 * `generate()` in PBES2+AES-256-GCM before persistence.
 */

import {
  createPrivateKey,
  createPublicKey,
  constants as cryptoConstants,
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

export const RSA_MIN_BITS = 2048;
export const RSA_DEFAULT_BITS = 3072;
export const RSA_PSS_SALT_LEN = 32;
export const RSA_PSS_HASH = 'sha256' as const;

interface RSAPrivateHandle extends PrivateKeyHandle {
  readonly __rsaPrivate: KeyObject;
}
interface RSAPublicHandle extends PublicKeyHandle {
  readonly __rsaPublic: KeyObject;
}

function wrapPrivate(k: KeyObject): RSAPrivateHandle {
  return { __rsaPrivate: k } as RSAPrivateHandle;
}
function wrapPublic(k: KeyObject): RSAPublicHandle {
  return { __rsaPublic: k } as RSAPublicHandle;
}
function unwrapPrivate(h: PrivateKeyHandle): KeyObject {
  return (h as RSAPrivateHandle).__rsaPrivate;
}
function unwrapPublic(h: PublicKeyHandle): KeyObject {
  return (h as RSAPublicHandle).__rsaPublic;
}

function isRaw(m: PemKeyMaterial | RawKeyMaterial): m is RawKeyMaterial {
  return 'publicRaw' in m && m.publicRaw instanceof Uint8Array;
}

function isPem(m: PemKeyMaterial | RawKeyMaterial): m is PemKeyMaterial {
  return 'publicPem' in m && typeof (m as PemKeyMaterial).publicPem === 'string';
}

/** Enforce the 2048-bit lower bound. The asymmetric key details expose a
 *  `modulusLength` field for RSA keys. */
function assertMinimumStrength(k: KeyObject): void {
  const details = k.asymmetricKeyDetails;
  if (!details || typeof details.modulusLength !== 'number') {
    // Key type wasn't RSA (or Node didn't populate details) — the alg registry
    // would already have rejected non-RSA keys at import time.
    throw errors.insufficientKeyStrength('RSA key details missing modulus length');
  }
  if (details.modulusLength < RSA_MIN_BITS) {
    throw errors.insufficientKeyStrength(
      `RSA modulus ${details.modulusLength} bits < required ${RSA_MIN_BITS}`,
    );
  }
}

class RSAPSSBackend implements SignatureBackend, Signer, Verifier, KeyGenerator {
  readonly alg = 'rs256-pss' as const;

  async importPrivate(
    material: PemKeyMaterial | RawKeyMaterial,
    passphrase?: string,
  ): Promise<PrivateKeyHandle> {
    try {
      let k: KeyObject;
      if (isRaw(material)) {
        if (!material.privateRaw) {
          throw errors.tokenMalformed('raw material has no privateRaw');
        }
        // Raw RSA private is DER-encoded PKCS#8 (or PKCS#1; we accept both).
        // Feed to Node's loader and let it figure out the type.
        k = createPrivateKey({
          key: Buffer.from(material.privateRaw),
          format: 'der',
          type: 'pkcs8',
        });
      } else if (isPem(material)) {
        if (!material.privatePem) {
          throw errors.tokenMalformed('PEM material has no privatePem');
        }
        const opts: Parameters<typeof createPrivateKey>[0] = { key: material.privatePem };
        if (passphrase !== undefined) {
          (opts as { passphrase?: string }).passphrase = passphrase;
        }
        k = createPrivateKey(opts);
      } else {
        throw errors.tokenMalformed('unrecognized key material shape');
      }
      if (k.asymmetricKeyType !== 'rsa' && k.asymmetricKeyType !== 'rsa-pss') {
        throw errors.insufficientKeyStrength(
          `expected RSA key, got ${String(k.asymmetricKeyType)}`,
        );
      }
      assertMinimumStrength(k);
      return wrapPrivate(k);
    } catch (e) {
      if (e instanceof LicensingError) throw e;
      throw errors.keyDecryptionFailed();
    }
  }

  async importPublic(material: PemKeyMaterial | RawKeyMaterial): Promise<PublicKeyHandle> {
    let k: KeyObject;
    if (isRaw(material)) {
      k = createPublicKey({ key: Buffer.from(material.publicRaw), format: 'der', type: 'spki' });
    } else if (isPem(material)) {
      k = createPublicKey(material.publicPem);
    } else {
      throw errors.tokenMalformed('unrecognized key material shape');
    }
    if (k.asymmetricKeyType !== 'rsa' && k.asymmetricKeyType !== 'rsa-pss') {
      throw errors.insufficientKeyStrength(`expected RSA key, got ${String(k.asymmetricKeyType)}`);
    }
    assertMinimumStrength(k);
    return wrapPublic(k);
  }

  async sign(key: PrivateKeyHandle, data: Uint8Array): Promise<Uint8Array> {
    const sig = cryptoSign(RSA_PSS_HASH, data, {
      key: unwrapPrivate(key),
      padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
      saltLength: RSA_PSS_SALT_LEN,
    });
    return new Uint8Array(sig.buffer, sig.byteOffset, sig.byteLength);
  }

  async verify(key: PublicKeyHandle, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
    return cryptoVerify(
      RSA_PSS_HASH,
      data,
      {
        key: unwrapPublic(key),
        padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
        saltLength: RSA_PSS_SALT_LEN,
      },
      signature,
    );
  }

  async generate(_passphrase: string): Promise<{ pem: PemKeyMaterial; raw: RawKeyMaterial }> {
    // 3072-bit default (comfortably above the 2048 floor; matches fixture).
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: RSA_DEFAULT_BITS,
      publicExponent: 0x10001,
    });
    const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const privDer = privateKey.export({ format: 'der', type: 'pkcs8' });
    const pubDer = publicKey.export({ format: 'der', type: 'spki' });
    return {
      pem: { privatePem, publicPem },
      raw: {
        privateRaw: new Uint8Array(privDer.buffer, privDer.byteOffset, privDer.byteLength),
        publicRaw: new Uint8Array(pubDer.buffer, pubDer.byteOffset, pubDer.byteLength),
      },
    };
  }
}

export const rsaPssBackend: SignatureBackend = new RSAPSSBackend();
