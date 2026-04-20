import { describe, expect, it } from 'bun:test';
import { TokenFormatError } from '../../src/errors.ts';
import { decodeUnverified } from '../../src/lic1.ts';

describe('LIC1 format dispatch', () => {
  it('rejects v4.public.* (PASETO) with UnsupportedTokenFormat', () => {
    const paseto = 'v4.public.eyJmb28iOiJiYXIifQ.signature-placeholder';
    expect(() => decodeUnverified(paseto)).toThrow(TokenFormatError);
    try {
      decodeUnverified(paseto);
    } catch (e) {
      expect((e as TokenFormatError).code).toBe('UnsupportedTokenFormat');
    }
  });

  it('rejects JWT-style eyJ prefix', () => {
    expect(() => decodeUnverified('eyJhbGciOiJIUzI1NiJ9.eyJmIjoxfQ.sig')).toThrow(TokenFormatError);
  });

  it('rejects LIC2.* (reserved for a future revision)', () => {
    expect(() => decodeUnverified('LIC2.a.b.c')).toThrow(TokenFormatError);
  });

  it('rejects a token with no dots at all', () => {
    expect(() => decodeUnverified('no-dots-here')).toThrow(TokenFormatError);
  });
});

describe('LIC1 segment layout', () => {
  it('rejects a token with fewer than 4 segments', () => {
    expect(() => decodeUnverified('LIC1.abc.def')).toThrow(TokenFormatError);
  });

  it('rejects a token with more than 4 segments', () => {
    expect(() => decodeUnverified('LIC1.a.b.c.d')).toThrow(TokenFormatError);
  });

  it('rejects padded base64 segments', () => {
    // 'LIC1.' prefix is accepted; the header segment carries invalid padding.
    expect(() => decodeUnverified('LIC1.e30=.e30.AA')).toThrow(TokenFormatError);
  });

  it('rejects non-base64url characters', () => {
    expect(() => decodeUnverified('LIC1.!!!.e30.AA')).toThrow(TokenFormatError);
  });
});

describe('LIC1 header validation', () => {
  function makeToken(headerObj: unknown, payloadObj: unknown = {}): string {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `LIC1.${enc(headerObj)}.${enc(payloadObj)}.AA`;
  }

  it('rejects header missing v', () => {
    expect(() => decodeUnverified(makeToken({ typ: 'lic', alg: 'ed25519', kid: 'k1' }))).toThrow(
      TokenFormatError,
    );
  });

  it('rejects header with unknown field', () => {
    expect(() =>
      decodeUnverified(makeToken({ v: 1, typ: 'lic', alg: 'ed25519', kid: 'k1', extra: 'nope' })),
    ).toThrow(TokenFormatError);
  });

  it('rejects non-"lic" typ', () => {
    expect(() =>
      decodeUnverified(makeToken({ v: 1, typ: 'jwt', alg: 'ed25519', kid: 'k1' })),
    ).toThrow(TokenFormatError);
  });

  it('rejects wrong v value', () => {
    expect(() =>
      decodeUnverified(makeToken({ v: 2, typ: 'lic', alg: 'ed25519', kid: 'k1' })),
    ).toThrow(TokenFormatError);
  });

  it('rejects unsupported alg', () => {
    expect(() =>
      decodeUnverified(makeToken({ v: 1, typ: 'lic', alg: 'xchacha20', kid: 'k1' })),
    ).toThrow();
  });

  it('accepts a well-formed header', () => {
    const parts = decodeUnverified(makeToken({ v: 1, typ: 'lic', alg: 'ed25519', kid: 'k1' }));
    expect(parts.header).toEqual({ v: 1, typ: 'lic', alg: 'ed25519', kid: 'k1' });
  });
});
