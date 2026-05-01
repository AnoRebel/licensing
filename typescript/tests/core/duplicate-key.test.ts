/**
 * Strict duplicate-key parser tests.
 *
 * The canonical-JSON encoder has always rejected duplicate keys, but the
 * parser used during verification was previously a vanilla `JSON.parse`
 * that silently last-wins on duplicates. A tampered token containing
 * e.g. `{"status":"revoked","status":"active"}` would deserialize as
 * `status=active`. The signature is over the canonical issuer-produced
 * bytes (which can't have duplicates), so this was not exploitable in
 * practice — but the defence-in-depth fix is to reject the duplicate at
 * parse time, before the signature is verified.
 *
 * These tests prove the rejection happens with the right error code on
 * every shape an attacker might try.
 */

import { describe, expect, it } from 'bun:test';
import { encode as b64urlEncode } from '../../src/base64url.ts';
import { decodeUnverified } from '../../src/lic1.ts';
import { StrictJsonError, strictParse } from '../../src/strict-json.ts';

describe('strictParse — duplicate keys', () => {
  it('rejects a top-level duplicate key', () => {
    expect(() => strictParse('{"a":1,"a":2}')).toThrow(StrictJsonError);
    try {
      strictParse('{"a":1,"a":2}');
    } catch (e) {
      expect(e).toBeInstanceOf(StrictJsonError);
      expect((e as StrictJsonError).code).toBe('CanonicalJSONDuplicateKey');
      expect((e as StrictJsonError).message).toContain('duplicate key: a');
    }
  });

  it('rejects a duplicate key inside a nested object', () => {
    try {
      strictParse('{"x":{"y":1,"y":2}}');
      throw new Error('parser did not reject nested duplicate');
    } catch (e) {
      expect(e).toBeInstanceOf(StrictJsonError);
      expect((e as StrictJsonError).code).toBe('CanonicalJSONDuplicateKey');
      expect((e as StrictJsonError).message).toContain('duplicate key: y');
    }
  });

  it('rejects a duplicate key inside an object inside an array', () => {
    try {
      strictParse('{"items":[{"k":1,"k":2}]}');
      throw new Error('parser did not reject array-nested duplicate');
    } catch (e) {
      expect(e).toBeInstanceOf(StrictJsonError);
      expect((e as StrictJsonError).code).toBe('CanonicalJSONDuplicateKey');
    }
  });

  it('accepts repeated values at distinct keys (only key collision matters)', () => {
    const out = strictParse('{"a":"same","b":"same"}') as Record<string, unknown>;
    expect(out.a).toBe('same');
    expect(out.b).toBe('same');
  });

  it('accepts identical key names in sibling scopes (scope is local)', () => {
    const out = strictParse('{"a":{"x":1},"b":{"x":2}}') as Record<string, Record<string, unknown>>;
    expect(out.a?.x).toBe(1);
    expect(out.b?.x).toBe(2);
  });
});

describe('strictParse — round-trip parity with JSON.parse on valid inputs', () => {
  // For every valid (non-duplicate) input, strictParse must produce the
  // same shape JSON.parse does. This is the property that lets us swap it
  // in transparently without breaking any existing fixture.
  const cases: string[] = [
    '{}',
    '{"a":1}',
    '{"unicode":"héllo/"}',
    '{"astral":"😀"}',
    '{"escape":"\\""}',
    '{"int":9007199254740991}',
    '{"neg":-9007199254740991}',
    '{"empty_array":[]}',
    '{"empty_obj":{}}',
    '{"null":null}',
    '{"bool":true,"otherbool":false}',
    '{"deep":{"a":{"b":{"c":{"d":1}}}}}',
    '{"arr":[1,2,3]}',
    '{"mixed":["x",{"y":2},null,true]}',
    '{"frac":1.5}',
    '{"exp":1e10}',
    '{"neg-frac":-0.25}',
  ];
  for (const c of cases) {
    it(`round-trips ${c}`, () => {
      expect(strictParse(c)).toEqual(JSON.parse(c));
    });
  }
});

describe('decodeUnverified — rejects duplicate-key tokens before signature check', () => {
  it('surfaces CanonicalJSONDuplicateKey at parse time, not TokenSignatureInvalid', async () => {
    // Hand-build a wire token with a duplicate-key payload. Sig is junk;
    // the test asserts we never reach signature verification — with the
    // strict parser, the response must be CanonicalJSONDuplicateKey
    // instead of TokenSignatureInvalid.
    const enc = new TextEncoder();
    const header = '{"v":1,"typ":"lic","alg":"ed25519","kid":"x"}';
    const payload = '{"jti":"a","jti":"b"}';
    const headerB64 = b64urlEncode(enc.encode(header));
    const payloadB64 = b64urlEncode(enc.encode(payload));
    const sigB64 = b64urlEncode(enc.encode('not-a-real-signature'));
    const token = `LIC1.${headerB64}.${payloadB64}.${sigB64}`;

    try {
      await decodeUnverified(token);
      throw new Error('decodeUnverified did not reject duplicate-key token');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('CanonicalJSONDuplicateKey');
    }
  });
});
