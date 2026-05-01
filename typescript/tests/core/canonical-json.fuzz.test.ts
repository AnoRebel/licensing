/**
 * Property tests for the canonical-JSON encoder.
 *
 * Bun's built-in fuzzer is still maturing; we approximate by running each
 * property over a fixed number of randomly-generated inputs. The properties
 * mirror the Go fuzz targets in licensing/canonical_fuzz_test.go so both
 * ports exercise the same invariants.
 *
 * Properties checked:
 *
 *   1. NoPanic / typed errors only — every input is either canonicalised or
 *      rejected with a typed `CanonicalJSONError`. Never an uncaught throw.
 *   2. Idempotence — `canonicalize(parse(canonicalize(x)))` byte-equals
 *      `canonicalize(x)` for every accepted input.
 *   3. Key-ordering agnostic — two objects with the same logical contents
 *      produce identical canonical bytes regardless of insertion order.
 *   4. Number canonicalisation — every accepted integer round-trips with
 *      no leading `+`, no leading zero, no fractional/exponent form, and
 *      no `-0`.
 */

import { describe, expect, it } from 'bun:test';

import { canonicalize, canonicalizeToString } from '../../src/canonical-json.ts';
import { CanonicalJSONError } from '../../src/errors.ts';

const ITERATIONS = 500;

// ---------- generator ----------

function rngInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

/** Mulberry32 — deterministic seedable PRNG. Fixed seed gives a stable
 *  test run; bump the seed to find new edge cases. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const STRING_POOL = [
  '',
  'a',
  'abc',
  'héllo',
  '😀',
  '/',
  '\\',
  '"',
  '\n\t\r',
  '\x01',
  'a'.repeat(64),
  'mixed/é\\"',
];

function randomString(rng: () => number): string {
  return STRING_POOL[rngInt(rng, 0, STRING_POOL.length - 1)] as string;
}

function randomKey(rng: () => number): string {
  // Keys must be valid UTF-8 strings; reuse the string pool.
  return randomString(rng);
}

function randomScalar(rng: () => number): unknown {
  switch (rngInt(rng, 0, 5)) {
    case 0:
      return null;
    case 1:
      return rng() < 0.5;
    case 2:
      return randomString(rng);
    case 3:
      return rngInt(rng, -1_000_000, 1_000_000);
    case 4:
      return rngInt(rng, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    default:
      return 0;
  }
}

function randomValue(rng: () => number, depth: number): unknown {
  if (depth >= 3 || rng() < 0.5) return randomScalar(rng);
  if (rng() < 0.5) {
    const len = rngInt(rng, 0, 4);
    const arr: unknown[] = [];
    for (let i = 0; i < len; i++) arr.push(randomValue(rng, depth + 1));
    return arr;
  }
  return randomObject(rng, depth + 1);
}

function randomObject(rng: () => number, depth: number): Record<string, unknown> {
  const len = rngInt(rng, 0, 4);
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < len; i++) {
    obj[randomKey(rng)] = randomValue(rng, depth);
  }
  return obj;
}

/** Re-shuffle an object's keys by re-creating it with a different
 *  insertion order. Tests the key-ordering-agnostic property. */
function shuffleObjectKeys(o: Record<string, unknown>, rng: () => number): Record<string, unknown> {
  const keys = Object.keys(o);
  for (let i = keys.length - 1; i > 0; i--) {
    const j = rngInt(rng, 0, i);
    [keys[i], keys[j]] = [keys[j] as string, keys[i] as string];
  }
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = o[k];
    out[k] = isPlainObject(v) ? shuffleObjectKeys(v as Record<string, unknown>, rng) : v;
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------- properties ----------

/** Bytewise compare two Uint8Arrays. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

describe('canonicalize — property: never panics, only typed errors', () => {
  it(`survives ${ITERATIONS} random inputs without uncaught throws`, () => {
    const rng = makeRng(0xc0ffee);
    for (let i = 0; i < ITERATIONS; i++) {
      const obj = randomObject(rng, 0);
      try {
        canonicalize(obj);
      } catch (e) {
        expect(e).toBeInstanceOf(CanonicalJSONError);
      }
    }
  });
});

describe('canonicalize — property: idempotent', () => {
  it(`canonicalize(parse(canonicalize(x))) byte-equals canonicalize(x) for ${ITERATIONS} inputs`, () => {
    const rng = makeRng(0xabcdef);
    const decoder = new TextDecoder();
    let checked = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const obj = randomObject(rng, 0);
      let first: Uint8Array;
      try {
        first = canonicalize(obj);
      } catch {
        continue; // skip rejected inputs
      }
      const reparsed = JSON.parse(decoder.decode(first));
      let second: Uint8Array;
      try {
        second = canonicalize(reparsed);
      } catch (e) {
        throw new Error(
          `idempotence violated: re-canonicalize errored on ${decoder.decode(first)}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      if (!bytesEqual(first, second)) {
        throw new Error(
          `idempotence violated:\nfirst:  ${decoder.decode(first)}\nsecond: ${decoder.decode(second)}`,
        );
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('canonicalize — property: key-ordering agnostic', () => {
  it(`identical-content objects with shuffled keys produce identical bytes`, () => {
    const rng = makeRng(0x123456);
    let checked = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const obj = randomObject(rng, 0);
      let outA: Uint8Array;
      try {
        outA = canonicalize(obj);
      } catch {
        continue;
      }
      const shuffled = shuffleObjectKeys(obj, rng);
      const outB = canonicalize(shuffled);
      if (!bytesEqual(outA, outB)) {
        const dec = new TextDecoder();
        throw new Error(
          `shuffled keys produced different bytes:\nA: ${dec.decode(outA)}\nB: ${dec.decode(outB)}`,
        );
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('canonicalize — property: number canonicalisation', () => {
  it(`integers serialize without leading zeros, leading +, fractional, or -0`, () => {
    const rng = makeRng(0xdeadbeef);
    for (let i = 0; i < ITERATIONS; i++) {
      const n = rngInt(rng, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      let out: string;
      try {
        out = canonicalizeToString({ n });
      } catch {
        continue;
      }
      const m = out.match(/^\{"n":(.+)\}$/);
      expect(m).not.toBeNull();
      const numStr = (m as RegExpMatchArray)[1] as string;
      expect(numStr.startsWith('+')).toBe(false);
      expect(numStr.includes('.')).toBe(false);
      expect(numStr.toLowerCase().includes('e')).toBe(false);
      // Allow "0" itself; reject "01", "07" etc.
      if (numStr.length > 1 && numStr[0] === '0') {
        throw new Error(`leading zero: ${numStr}`);
      }
      // Reject "-0" but allow "-1", "-2" etc.
      if (numStr === '-0') {
        throw new Error(`negative zero leaked: ${numStr}`);
      }
    }
  });
});

describe('canonicalize — known tricky inputs (regression)', () => {
  const cases = [
    { in: {}, out: '{}' },
    { in: { a: 1 }, out: '{"a":1}' },
    { in: { z: 1, a: 2 }, out: '{"a":2,"z":1}' },
    { in: { '': 1 }, out: '{"":1}' },
    { in: { unicode: 'é' }, out: '{"unicode":"é"}' },
    { in: { slash: '/' }, out: '{"slash":"/"}' },
    { in: { quote: '"' }, out: '{"quote":"\\""}' },
    { in: { tab: '\t' }, out: '{"tab":"\\t"}' },
    { in: { ctrl: '\x01' }, out: '{"ctrl":"\\u0001"}' },
    {
      in: { max: Number.MAX_SAFE_INTEGER },
      out: `{"max":${Number.MAX_SAFE_INTEGER}}`,
    },
    {
      in: { min: -Number.MAX_SAFE_INTEGER },
      out: `{"min":${-Number.MAX_SAFE_INTEGER}}`,
    },
    { in: { astral: '😀' }, out: '{"astral":"😀"}' },
  ];
  for (const tc of cases) {
    it(`canonicalises ${JSON.stringify(tc.in)}`, () => {
      expect(canonicalizeToString(tc.in as Record<string, unknown>)).toBe(tc.out);
    });
  }
});
