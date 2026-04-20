/**
 * Canonical-JSON conformance tests. These enforce the rules specified in
 * `fixtures/README.md` §1 at the byte level. Once the fixture-generator
 * lands, an additional test file will diff against the committed
 * `canonical_*.bin` corpus.
 */

import { describe, expect, it } from 'bun:test';
import { canonicalize, canonicalizeToString } from '../../src/canonical-json.ts';
import { CanonicalJSONError } from '../../src/errors.ts';

const dec = (u: Uint8Array) => new TextDecoder('utf-8').decode(u);

describe('canonicalize — top-level enforcement', () => {
  it('accepts a plain object', () => {
    expect(dec(canonicalize({}))).toBe('{}');
  });

  it('rejects arrays at the top level', () => {
    expect(() => canonicalize([])).toThrow(CanonicalJSONError);
  });

  it('rejects primitives at the top level', () => {
    expect(() => canonicalize(null)).toThrow(CanonicalJSONError);
    expect(() => canonicalize(0)).toThrow(CanonicalJSONError);
    expect(() => canonicalize('str')).toThrow(CanonicalJSONError);
  });
});

describe('canonicalize — key ordering (UTF-16)', () => {
  it('sorts object keys ascending', () => {
    expect(canonicalizeToString({ b: 2, a: 1, c: 3 })).toBe('{"a":1,"b":2,"c":3}');
  });

  it('nested objects are recursively sorted', () => {
    expect(canonicalizeToString({ b: { z: 1, y: 2 }, a: [3, 1, 2] })).toBe(
      '{"a":[3,1,2],"b":{"y":2,"z":1}}',
    );
  });

  it('key order is UTF-16, not a locale comparator', () => {
    // Uppercase precedes lowercase in UTF-16 code units.
    expect(canonicalizeToString({ a: 1, A: 2 })).toBe('{"A":2,"a":1}');
  });
});

describe('canonicalize — whitespace', () => {
  it('emits no whitespace between members or after colons', () => {
    const s = canonicalizeToString({ b: 2, a: 1 });
    expect(s).toBe('{"a":1,"b":2}');
    expect(s).not.toContain(' ');
  });
});

describe('canonicalize — numbers', () => {
  it('accepts safe integers', () => {
    expect(canonicalizeToString({ n: 0 })).toBe('{"n":0}');
    expect(canonicalizeToString({ n: 42 })).toBe('{"n":42}');
    expect(canonicalizeToString({ n: -1 })).toBe('{"n":-1}');
    expect(canonicalizeToString({ n: Number.MAX_SAFE_INTEGER })).toBe(
      `{"n":${Number.MAX_SAFE_INTEGER}}`,
    );
  });

  it('rejects floats', () => {
    expect(() => canonicalize({ n: 1.5 })).toThrow(CanonicalJSONError);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => canonicalize({ n: Number.NaN })).toThrow(CanonicalJSONError);
    expect(() => canonicalize({ n: Number.POSITIVE_INFINITY })).toThrow(CanonicalJSONError);
    expect(() => canonicalize({ n: Number.NEGATIVE_INFINITY })).toThrow(CanonicalJSONError);
  });

  it('rejects unsafe integers', () => {
    expect(() => canonicalize({ n: Number.MAX_SAFE_INTEGER + 1 })).toThrow(CanonicalJSONError);
    expect(() => canonicalize({ n: Number.MIN_SAFE_INTEGER - 1 })).toThrow(CanonicalJSONError);
  });

  it('rejects negative zero', () => {
    expect(() => canonicalize({ n: -0 })).toThrow(CanonicalJSONError);
  });

  it('accepts bigint within safe range', () => {
    expect(canonicalizeToString({ n: 10n })).toBe('{"n":10}');
  });

  it('rejects bigint beyond safe range', () => {
    expect(() => canonicalize({ n: BigInt(Number.MAX_SAFE_INTEGER) + 1n })).toThrow(
      CanonicalJSONError,
    );
  });
});

describe('canonicalize — strings & escaping', () => {
  it('escapes only the seven required escapes plus other C0 controls', () => {
    const s = canonicalizeToString({
      s: 'a"b\\c\u0008\t\n\u000c\rd\u0001e',
    });
    expect(s).toBe('{"s":"a\\"b\\\\c\\b\\t\\n\\f\\rd\\u0001e"}');
  });

  it('does NOT escape forward slash', () => {
    expect(canonicalizeToString({ s: 'a/b' })).toBe('{"s":"a/b"}');
  });

  it('emits BMP characters as raw UTF-8', () => {
    const bytes = canonicalize({ s: 'héllo' });
    expect(Array.from(bytes)).toEqual([...new TextEncoder().encode('{"s":"héllo"}')]);
  });

  it('emits astral codepoints as raw UTF-8 (not surrogate escapes)', () => {
    // U+1F600 GRINNING FACE
    const s = canonicalize({ s: '\u{1F600}' });
    const expected = new TextEncoder().encode('{"s":"\u{1F600}"}');
    expect(Array.from(s)).toEqual([...expected]);
  });

  it('hex escapes use lowercase', () => {
    expect(canonicalizeToString({ s: '\u001f' })).toBe('{"s":"\\u001f"}');
  });

  it('rejects unpaired high surrogates', () => {
    // Construct an unpaired high surrogate via String.fromCharCode.
    const bad = `x${String.fromCharCode(0xd800)}y`;
    expect(() => canonicalize({ s: bad })).toThrow(CanonicalJSONError);
  });

  it('rejects unpaired low surrogates', () => {
    const bad = `x${String.fromCharCode(0xdc00)}y`;
    expect(() => canonicalize({ s: bad })).toThrow(CanonicalJSONError);
  });
});

describe('canonicalize — arrays', () => {
  it('preserves input order', () => {
    expect(canonicalizeToString({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
  });

  it('empty array renders as []', () => {
    expect(canonicalizeToString({ a: [] })).toBe('{"a":[]}');
  });
});

describe('canonicalize — exotic types rejected', () => {
  it('rejects Date', () => {
    expect(() => canonicalize({ d: new Date() })).toThrow(CanonicalJSONError);
  });

  it('rejects Map', () => {
    expect(() => canonicalize({ m: new Map() })).toThrow(CanonicalJSONError);
  });

  it('rejects class instances', () => {
    class Thing {}
    expect(() => canonicalize({ t: new Thing() })).toThrow(CanonicalJSONError);
  });

  it('rejects undefined', () => {
    expect(() => canonicalize({ u: undefined })).toThrow(CanonicalJSONError);
  });

  it('accepts null-prototype plain objects', () => {
    const obj = Object.create(null) as Record<string, number>;
    obj.a = 1;
    obj.b = 2;
    expect(canonicalizeToString({ nested: obj })).toBe('{"nested":{"a":1,"b":2}}');
  });
});

describe('canonicalize — worked example from fixtures/README.md §1.10', () => {
  it('matches the documented canonical bytes', () => {
    const input = {
      b: 2,
      a: [3, 1, 2],
      c: { z: 1, y: null, x: 'héllo/' },
    };
    expect(canonicalizeToString(input)).toBe(
      '{"a":[3,1,2],"b":2,"c":{"x":"héllo/","y":null,"z":1}}',
    );
  });
});
