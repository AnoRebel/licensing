/**
 * License-key generation and normalization.
 *
 * Covers:
 *   - Generated keys match the canonical regex.
 *   - Lowercase input normalizes to uppercase on lookup.
 *   - Keys containing visually-ambiguous letters (I / L / O / U) are rejected.
 *   - Entropy: repeated generation yields distinct keys.
 */

import { describe, expect, it } from 'bun:test';

import {
  assertLicenseKey,
  errors,
  generateLicenseKey,
  LICENSE_KEY_REGEX,
  normalizeLicenseKey,
} from '../../src/index.ts';

describe('license-key generation', () => {
  it('generated keys match the canonical regex', () => {
    for (let i = 0; i < 64; i++) {
      const key = generateLicenseKey();
      expect(key).toMatch(LICENSE_KEY_REGEX);
      // 8 groups × 4 chars = 32 chars after `LIC-`, total length 4 + 32 + 7 = 43
      expect(key.length).toBe(4 + 32 + 7);
    }
  });

  it('100 generations produce 100 distinct keys (entropy sanity)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(generateLicenseKey());
    expect(seen.size).toBe(100);
  });
});

describe('license-key normalization', () => {
  it('uppercases a lowercase input', () => {
    const key = generateLicenseKey();
    expect(normalizeLicenseKey(key.toLowerCase())).toBe(key);
  });

  it('trims surrounding whitespace', () => {
    const key = generateLicenseKey();
    expect(normalizeLicenseKey(`  ${key}  `)).toBe(key);
  });

  it('rejects keys containing visually-ambiguous letters', () => {
    // I, L, O, U are NOT in the Crockford alphabet — they fail validation
    // rather than silently being rewritten to 1 / 0 / V.
    expect(normalizeLicenseKey('LIC-IIII-AAAA-BBBB-CCCC-DDDD')).toBeNull();
    expect(normalizeLicenseKey('LIC-LLLL-AAAA-BBBB-CCCC-DDDD')).toBeNull();
    expect(normalizeLicenseKey('LIC-OOOO-AAAA-BBBB-CCCC-DDDD')).toBeNull();
    expect(normalizeLicenseKey('LIC-UUUU-AAAA-BBBB-CCCC-DDDD')).toBeNull();
  });

  it('rejects keys missing the LIC- prefix', () => {
    expect(normalizeLicenseKey('AAAA-BBBB-CCCC-DDDD-EEEE')).toBeNull();
    expect(normalizeLicenseKey('FOO-AAAA-BBBB-CCCC-DDDD-EEEE')).toBeNull();
  });

  it('rejects keys with fewer than 5 groups after the prefix', () => {
    expect(normalizeLicenseKey('LIC-AAAA-BBBB-CCCC-DDDD')).toBeNull();
  });

  it('accepts keys with more than 5 groups (forward-compatible)', () => {
    expect(normalizeLicenseKey('LIC-AAAA-BBBB-CCCC-DDDD-EEEE')).toBe(
      'LIC-AAAA-BBBB-CCCC-DDDD-EEEE',
    );
    expect(normalizeLicenseKey('LIC-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH')).toBe(
      'LIC-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH',
    );
  });
});

describe('license-key assertion', () => {
  it('returns normalized form on valid input', () => {
    expect(assertLicenseKey(' lic-aaaa-bbbb-cccc-dddd-eeee ')).toBe('LIC-AAAA-BBBB-CCCC-DDDD-EEEE');
  });

  it('throws InvalidLicenseKey on malformed input', () => {
    expect(() => assertLicenseKey('not-a-license-key')).toThrow();
    try {
      assertLicenseKey('not-a-license-key');
    } catch (e) {
      expect((e as { code: string }).code).toBe('InvalidLicenseKey');
    }
    // Sanity: the helper returns a matching error object when invoked directly.
    expect(errors.invalidLicenseKey().code).toBe('InvalidLicenseKey');
  });
});
