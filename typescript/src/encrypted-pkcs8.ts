/**
 * PKCS#8 wrapping with PBES2 / PBKDF2-HMAC-SHA-256 / AES-256-GCM.
 *
 * Node's built-in `KeyObject.export({ cipher, passphrase })` only emits
 * PBES2 + AES-CBC. We require **AES-GCM**, so we hand-build the DER
 * envelope.
 *
 * ### Structure (RFC 8018 §6.2, RFC 5084 §3)
 * ```
 *   EncryptedPrivateKeyInfo ::= SEQUENCE {
 *     encryptionAlgorithm  AlgorithmIdentifier,   -- PBES2
 *     encryptedData        OCTET STRING           -- AES-GCM ciphertext || tag
 *   }
 *
 *   AlgorithmIdentifier for PBES2:
 *     id-PBES2 (1.2.840.113549.1.5.13)
 *     PBES2-params ::= SEQUENCE {
 *       keyDerivationFunc  AlgorithmIdentifier,    -- PBKDF2
 *       encryptionScheme   AlgorithmIdentifier     -- AES-256-GCM
 *     }
 *
 *   KDF:  id-PBKDF2 (1.2.840.113549.1.5.12), PBKDF2-params {
 *           salt OCTET STRING(16),
 *           iterationCount INTEGER,
 *           keyLength INTEGER(32),
 *           prf AlgorithmIdentifier = hmac-with-SHA256 (1.2.840.113549.2.9)
 *         }
 *   Cipher: id-aes256-GCM (2.16.840.1.101.3.4.1.46), GCMParameters ::= SEQUENCE {
 *             aes-nonce OCTET STRING(12),
 *             aes-ICVlen INTEGER DEFAULT 12  -- we use 16 and encode it explicitly
 *           }
 * ```
 *
 * Parameters are fixed:
 *   - Salt: 16 random bytes
 *   - PBKDF2 iterations: 600_000 (OWASP 2024 guidance for PBKDF2-HMAC-SHA-256)
 *   - KDF output length: 32 bytes
 *   - GCM nonce: 12 random bytes
 *   - GCM tag length: 16 bytes
 *
 * The emitted PEM uses the `ENCRYPTED PRIVATE KEY` armor, matching the
 * spec's `#### Scenario: Stored PEM is encrypted`.
 */

import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { errors } from './errors.ts';

export const PBKDF2_ITERATIONS = 600_000;
export const PBKDF2_SALT_LEN = 16;
export const KEY_LEN = 32;
export const GCM_NONCE_LEN = 12;
export const GCM_TAG_LEN = 16;

// -------- minimal DER encoder (length-prefixed TLVs, DER rules) --------

function encodeLen(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.from([n]);
  if (n < 0x100) return Uint8Array.from([0x81, n]);
  if (n < 0x10000) return Uint8Array.from([0x82, n >> 8, n & 0xff]);
  if (n < 0x1000000) return Uint8Array.from([0x83, n >> 16, (n >> 8) & 0xff, n & 0xff]);
  return Uint8Array.from([0x84, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}

function tlv(tag: number, content: Uint8Array): Uint8Array {
  const len = encodeLen(content.length);
  const out = new Uint8Array(1 + len.length + content.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(content, 1 + len.length);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const SEQUENCE = 0x30;
const OCTET_STRING = 0x04;
const OBJECT_IDENTIFIER = 0x06;
const INTEGER = 0x02;
const NULL = 0x05;

function oidBody(dotted: string): Uint8Array {
  const parts = dotted.split('.').map((s) => Number.parseInt(s, 10));
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error(`bad OID: ${dotted}`);
  }
  const first = parts.shift() ?? 0;
  const second = parts.shift() ?? 0;
  const body: number[] = [first * 40 + second];
  for (const n of parts) {
    const base128: number[] = [];
    let v = n;
    do {
      base128.unshift(v & 0x7f);
      v >>>= 7;
    } while (v > 0);
    for (let i = 0; i < base128.length - 1; i++) (base128[i] as number) |= 0x80;
    body.push(...base128);
  }
  return Uint8Array.from(body);
}

function oid(dotted: string): Uint8Array {
  return tlv(OBJECT_IDENTIFIER, oidBody(dotted));
}

// Pre-encoded OID bodies used by `unwrapEncryptedPkcs8`'s profile check.
// We compare the raw OID bytes (not a parsed dotted string) because
// byte-equality is both faster and impossible to fool with leading-zero
// re-encodings — BER allows alternate encodings that an attacker could
// use to route a profile check around a string comparison.
const OID_PBES2 = oidBody('1.2.840.113549.1.5.13');
const OID_PBKDF2 = oidBody('1.2.840.113549.1.5.12');
const OID_HMAC_SHA256 = oidBody('1.2.840.113549.2.9');
const OID_AES256_GCM = oidBody('2.16.840.1.101.3.4.1.46');

function oidEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function der_integer(n: number): Uint8Array {
  // Only positive, 32-bit values needed here (iterations, key length).
  if (n < 0 || n >= 2 ** 31) throw new Error(`integer out of range: ${n}`);
  const bytes: number[] = [];
  let v = n;
  if (v === 0) bytes.push(0);
  else {
    while (v > 0) {
      bytes.unshift(v & 0xff);
      v >>>= 8;
    }
    // Prepend 0x00 if MSB is set — keeps the integer non-negative in DER.
    if (((bytes[0] as number) & 0x80) !== 0) bytes.unshift(0);
  }
  return tlv(INTEGER, Uint8Array.from(bytes));
}

function der_octets(b: Uint8Array): Uint8Array {
  return tlv(OCTET_STRING, b);
}

function der_sequence(...children: Uint8Array[]): Uint8Array {
  return tlv(SEQUENCE, concat(children));
}

function der_null(): Uint8Array {
  return tlv(NULL, new Uint8Array(0));
}

// -------- PEM helpers --------

function toPem(der: Uint8Array, armor: 'ENCRYPTED PRIVATE KEY'): string {
  const b64 = Buffer.from(der).toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return `-----BEGIN ${armor}-----\n${lines.join('\n')}\n-----END ${armor}-----\n`;
}

function fromPem(pem: string, armor: 'ENCRYPTED PRIVATE KEY'): Uint8Array {
  const begin = `-----BEGIN ${armor}-----`;
  const end = `-----END ${armor}-----`;
  const bi = pem.indexOf(begin);
  const ei = pem.indexOf(end);
  if (bi < 0 || ei < 0 || ei <= bi) {
    throw errors.tokenMalformed(`missing PEM armor: ${armor}`);
  }
  const b64 = pem.slice(bi + begin.length, ei).replace(/\s+/g, '');
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

// -------- minimal DER parser (just enough for our known structure) --------

interface ParsedTlv {
  readonly tag: number;
  readonly content: Uint8Array;
  readonly total: number; // bytes consumed including header
}

function parseTlv(buf: Uint8Array, offset: number): ParsedTlv {
  if (offset >= buf.length) throw errors.tokenMalformed('DER: truncated at tag');
  const tag = buf[offset] as number;
  let lp = offset + 1;
  if (lp >= buf.length) throw errors.tokenMalformed('DER: truncated at length');
  const first = buf[lp] as number;
  lp += 1;
  let len: number;
  if ((first & 0x80) === 0) {
    len = first;
  } else {
    const n = first & 0x7f;
    if (n === 0 || n > 4) throw errors.tokenMalformed('DER: bad length form');
    len = 0;
    for (let i = 0; i < n; i++) {
      if (lp >= buf.length) throw errors.tokenMalformed('DER: truncated multi-byte length');
      len = (len << 8) | (buf[lp] as number);
      lp += 1;
    }
  }
  if (lp + len > buf.length) throw errors.tokenMalformed('DER: content exceeds buffer');
  return { tag, content: buf.slice(lp, lp + len), total: lp + len - offset };
}

function expectTag(tlv: ParsedTlv, tag: number, where: string): void {
  if (tlv.tag !== tag) {
    throw errors.tokenMalformed(`DER: expected tag 0x${tag.toString(16)} at ${where}`);
  }
}

// -------- public API --------

/**
 * Wrap plaintext PKCS#8 DER (e.g., `KeyObject.export({format:'der',type:'pkcs8'})`)
 * into an encrypted `-----BEGIN ENCRYPTED PRIVATE KEY-----` PEM armored payload.
 *
 * @throws `MissingKeyPassphrase` if the passphrase is empty.
 */
export function wrapEncryptedPkcs8(plaintextDer: Uint8Array, passphrase: string): string {
  if (passphrase.length === 0) throw errors.missingKeyPassphrase();

  const salt = randomBytes(PBKDF2_SALT_LEN);
  const nonce = randomBytes(GCM_NONCE_LEN);
  const kek = pbkdf2Sync(
    Buffer.from(passphrase, 'utf8'),
    salt,
    PBKDF2_ITERATIONS,
    KEY_LEN,
    'sha256',
  );

  const cipher = createCipheriv('aes-256-gcm', kek, nonce, { authTagLength: GCM_TAG_LEN });
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintextDer)), cipher.final()]);
  const tag = cipher.getAuthTag();

  // encryptionAlgorithm = AlgorithmIdentifier { id-PBES2, PBES2-params }
  const pbkdf2AlgId = der_sequence(
    oid('1.2.840.113549.1.5.12'), // id-PBKDF2
    der_sequence(
      der_octets(new Uint8Array(salt)),
      der_integer(PBKDF2_ITERATIONS),
      der_integer(KEY_LEN),
      der_sequence(oid('1.2.840.113549.2.9'), der_null()), // hmac-with-SHA256
    ),
  );
  const gcmAlgId = der_sequence(
    oid('2.16.840.1.101.3.4.1.46'), // id-aes256-GCM
    der_sequence(der_octets(new Uint8Array(nonce)), der_integer(GCM_TAG_LEN)),
  );
  const pbes2Params = der_sequence(pbkdf2AlgId, gcmAlgId);
  const algId = der_sequence(oid('1.2.840.113549.1.5.13'), pbes2Params);

  const encryptedData = concat([new Uint8Array(ct), new Uint8Array(tag)]);
  const outer = der_sequence(algId, der_octets(encryptedData));
  return toPem(outer, 'ENCRYPTED PRIVATE KEY');
}

/**
 * Unwrap an encrypted PKCS#8 PEM produced by {@link wrapEncryptedPkcs8} back
 * to plaintext DER. Rejects any envelope that doesn't match our fixed
 * parameter set (PBES2 + PBKDF2-SHA-256 + AES-256-GCM).
 *
 * @throws `KeyDecryptionFailed` if the passphrase is wrong or the envelope
 *   has been tampered with (AES-GCM authentication fails).
 */
export function unwrapEncryptedPkcs8(encryptedPem: string, passphrase: string): Uint8Array {
  if (passphrase.length === 0) throw errors.missingKeyPassphrase();
  const outerDer = fromPem(encryptedPem, 'ENCRYPTED PRIVATE KEY');

  const outer = parseTlv(outerDer, 0);
  expectTag(outer, SEQUENCE, 'outer');
  const algIdTlv = parseTlv(outer.content, 0);
  expectTag(algIdTlv, SEQUENCE, 'algorithmIdentifier');
  const encDataTlv = parseTlv(outer.content, algIdTlv.total);
  expectTag(encDataTlv, OCTET_STRING, 'encryptedData');

  // Descend into PBES2 params.
  const pbes2Oid = parseTlv(algIdTlv.content, 0);
  expectTag(pbes2Oid, OBJECT_IDENTIFIER, 'pbes2-oid');
  const pbes2Params = parseTlv(algIdTlv.content, pbes2Oid.total);
  expectTag(pbes2Params, SEQUENCE, 'pbes2-params');

  const kdfAlg = parseTlv(pbes2Params.content, 0);
  expectTag(kdfAlg, SEQUENCE, 'kdf-alg');
  const encAlg = parseTlv(pbes2Params.content, kdfAlg.total);
  expectTag(encAlg, SEQUENCE, 'enc-alg');

  // KDF params.
  const pbkdf2Oid = parseTlv(kdfAlg.content, 0);
  expectTag(pbkdf2Oid, OBJECT_IDENTIFIER, 'pbkdf2-oid');
  const pbkdf2Params = parseTlv(kdfAlg.content, pbkdf2Oid.total);
  expectTag(pbkdf2Params, SEQUENCE, 'pbkdf2-params');
  const saltTlv = parseTlv(pbkdf2Params.content, 0);
  expectTag(saltTlv, OCTET_STRING, 'salt');
  const iterTlv = parseTlv(pbkdf2Params.content, saltTlv.total);
  expectTag(iterTlv, INTEGER, 'iter');
  const keyLenTlv = parseTlv(pbkdf2Params.content, saltTlv.total + iterTlv.total);
  expectTag(keyLenTlv, INTEGER, 'keylen');
  const prfAlg = parseTlv(pbkdf2Params.content, saltTlv.total + iterTlv.total + keyLenTlv.total);
  expectTag(prfAlg, SEQUENCE, 'pbkdf2-prf');
  const prfOid = parseTlv(prfAlg.content, 0);
  expectTag(prfOid, OBJECT_IDENTIFIER, 'pbkdf2-prf-oid');

  const iter = bufToUint(iterTlv.content);
  const keyLen = bufToUint(keyLenTlv.content);

  // Enc params.
  const encOid = parseTlv(encAlg.content, 0);
  expectTag(encOid, OBJECT_IDENTIFIER, 'enc-oid');
  const encParams = parseTlv(encAlg.content, encOid.total);
  expectTag(encParams, SEQUENCE, 'gcm-params');
  const nonceTlv = parseTlv(encParams.content, 0);
  expectTag(nonceTlv, OCTET_STRING, 'gcm-nonce');
  const tagLenTlv = parseTlv(encParams.content, nonceTlv.total);
  expectTag(tagLenTlv, INTEGER, 'gcm-taglen');
  const tagLen = bufToUint(tagLenTlv.content);

  // Enforce the fixed profile. All profile-mismatch failures collapse to
  // the same opaque `KeyDecryptionFailed` error so an attacker with only
  // an error-log channel can't distinguish "wrong passphrase" from
  // "crafted downgrade envelope" — these are all "this envelope cannot be
  // opened with this key," full stop. Structural DER failures above keep
  // their TokenMalformed class because those are clearly "this isn't an
  // encrypted-PKCS#8 envelope at all."
  //
  // This mirrors the Go side (licensing/encrypted_pkcs8.go:220-233). Before
  // B13 the TS side read the OID bytes and discarded them, so an attacker
  // who could craft an envelope with PBKDF2-HMAC-SHA-1 or a non-GCM cipher
  // could get it accepted as long as the ciphertext happened to decrypt —
  // a weakened-KDF downgrade.
  const profileOK =
    oidEquals(pbes2Oid.content, OID_PBES2) &&
    oidEquals(pbkdf2Oid.content, OID_PBKDF2) &&
    oidEquals(prfOid.content, OID_HMAC_SHA256) &&
    oidEquals(encOid.content, OID_AES256_GCM) &&
    keyLen === KEY_LEN &&
    iter >= 100_000 &&
    tagLen === GCM_TAG_LEN &&
    nonceTlv.content.length === GCM_NONCE_LEN;
  if (!profileOK) {
    throw errors.keyDecryptionFailed();
  }

  // Re-derive and decrypt.
  const salt = saltTlv.content;
  const nonce = nonceTlv.content;
  const kek = pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, iter, keyLen, 'sha256');
  const ctAndTag = encDataTlv.content;
  if (ctAndTag.length < GCM_TAG_LEN) {
    throw errors.tokenMalformed('encrypted PKCS#8: ciphertext too short');
  }
  const ct = ctAndTag.slice(0, ctAndTag.length - GCM_TAG_LEN);
  const tag = ctAndTag.slice(ctAndTag.length - GCM_TAG_LEN);
  try {
    const decipher = createDecipheriv('aes-256-gcm', kek, nonce, { authTagLength: GCM_TAG_LEN });
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(Buffer.from(ct)), decipher.final()]);
    return new Uint8Array(pt);
  } catch {
    throw errors.keyDecryptionFailed();
  }
}

function bufToUint(b: Uint8Array): number {
  let v = 0;
  for (const byte of b) v = v * 256 + byte;
  if (!Number.isSafeInteger(v)) throw errors.tokenMalformed('DER integer out of safe range');
  return v;
}
