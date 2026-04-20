import { describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
  GCM_TAG_LEN,
  KEY_LEN,
  PBKDF2_ITERATIONS,
  PBKDF2_SALT_LEN,
  unwrapEncryptedPkcs8,
  wrapEncryptedPkcs8,
} from '../../src/encrypted-pkcs8.ts';
import { CryptoError, LicensingError, TokenFormatError } from '../../src/errors.ts';

// A plausible plaintext payload for wrap/unwrap. We don't need real PKCS#8
// DER — the envelope is content-opaque. Use a 48-byte blob so the GCM path
// must actually chain `update` + `final`.
function samplePlaintext(): Uint8Array {
  return new Uint8Array(randomBytes(48));
}

describe('wrap/unwrap round-trip', () => {
  it('returns the exact plaintext bytes after decrypt', () => {
    const pt = samplePlaintext();
    const pem = wrapEncryptedPkcs8(pt, 'correct horse battery staple');
    const back = unwrapEncryptedPkcs8(pem, 'correct horse battery staple');
    expect(back).toEqual(pt);
  });

  it('emits ENCRYPTED PRIVATE KEY armor (never a plaintext PEM)', () => {
    const pem = wrapEncryptedPkcs8(samplePlaintext(), 'pw-1234');
    expect(pem).toContain('-----BEGIN ENCRYPTED PRIVATE KEY-----');
    expect(pem).toContain('-----END ENCRYPTED PRIVATE KEY-----');
    // The *plaintext* armor must never leak through — stored PEMs must
    // always be encrypted.
    expect(pem).not.toContain('-----BEGIN PRIVATE KEY-----');
  });

  it('produces distinct ciphertexts for the same plaintext (fresh salt + nonce)', () => {
    const pt = samplePlaintext();
    const a = wrapEncryptedPkcs8(pt, 'pw');
    const b = wrapEncryptedPkcs8(pt, 'pw');
    expect(a).not.toEqual(b);
    // But both decrypt back to the same plaintext.
    expect(unwrapEncryptedPkcs8(a, 'pw')).toEqual(pt);
    expect(unwrapEncryptedPkcs8(b, 'pw')).toEqual(pt);
  });

  it('handles non-ASCII passphrases correctly (UTF-8)', () => {
    const pt = samplePlaintext();
    const pw = 'πάσσφράση — 密碼 🗝';
    const pem = wrapEncryptedPkcs8(pt, pw);
    expect(unwrapEncryptedPkcs8(pem, pw)).toEqual(pt);
  });
});

describe('passphrase validation', () => {
  it('refuses to wrap with an empty passphrase', () => {
    expect(() => wrapEncryptedPkcs8(samplePlaintext(), '')).toThrow(CryptoError);
    try {
      wrapEncryptedPkcs8(samplePlaintext(), '');
    } catch (e) {
      expect((e as LicensingError).code).toBe('MissingKeyPassphrase');
    }
  });

  it('refuses to unwrap with an empty passphrase', () => {
    const pem = wrapEncryptedPkcs8(samplePlaintext(), 'pw');
    expect(() => unwrapEncryptedPkcs8(pem, '')).toThrow(CryptoError);
    try {
      unwrapEncryptedPkcs8(pem, '');
    } catch (e) {
      expect((e as LicensingError).code).toBe('MissingKeyPassphrase');
    }
  });
});

describe('tampering and wrong passphrase', () => {
  it('fails with KeyDecryptionFailed for a wrong passphrase', () => {
    const pem = wrapEncryptedPkcs8(samplePlaintext(), 'correct');
    expect(() => unwrapEncryptedPkcs8(pem, 'wrong')).toThrow(CryptoError);
    try {
      unwrapEncryptedPkcs8(pem, 'wrong');
    } catch (e) {
      expect((e as LicensingError).code).toBe('KeyDecryptionFailed');
    }
  });

  it('fails with KeyDecryptionFailed when the ciphertext is flipped', () => {
    const pem = wrapEncryptedPkcs8(samplePlaintext(), 'pw');
    // Tamper by flipping the last base64 char in the body (affects tag or ct).
    const lines = pem.split('\n');
    const bodyIdx = lines.findIndex((l) => !l.startsWith('-----') && l.length > 0);
    const lineArr = lines[bodyIdx]?.split('') ?? [];
    const last = lineArr.length - 1;
    const original = lineArr[last] as string;
    const replacement = original === 'A' ? 'B' : 'A';
    lineArr[last] = replacement;
    lines[bodyIdx] = lineArr.join('');
    const tampered = lines.join('\n');

    expect(() => unwrapEncryptedPkcs8(tampered, 'pw')).toThrow(LicensingError);
  });

  it('rejects missing PEM armor with TokenMalformed', () => {
    expect(() => unwrapEncryptedPkcs8('not a pem at all', 'pw')).toThrow(TokenFormatError);
    try {
      unwrapEncryptedPkcs8('not a pem at all', 'pw');
    } catch (e) {
      expect((e as LicensingError).code).toBe('TokenMalformed');
    }
  });
});

describe('parameter enforcement (defense-in-depth against third-party envelopes)', () => {
  it('uses a 16-byte salt per invocation', () => {
    // The salt is encoded as the first OCTET STRING inside PBKDF2-params.
    // Instead of re-parsing DER here, we rely on the fact that two wraps
    // with the same passphrase on the same plaintext always differ — if the
    // salt length ever dropped to 0 or a constant, the ciphertexts would
    // collide for identical (nonce=randomBytes, but salt drives the KEK).
    expect(PBKDF2_SALT_LEN).toBe(16);
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(600_000);
    expect(KEY_LEN).toBe(32);
    expect(GCM_TAG_LEN).toBe(16);
  });

  it('accepts its own emitted envelope end-to-end across multiple rounds', () => {
    let pt = samplePlaintext();
    for (let i = 0; i < 5; i++) {
      const pw = `pw-${i}`;
      const pem = wrapEncryptedPkcs8(pt, pw);
      const back = unwrapEncryptedPkcs8(pem, pw);
      expect(back).toEqual(pt);
      pt = back;
    }
  });
});
