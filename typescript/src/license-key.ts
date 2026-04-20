/**
 * License key generation, normalization, and validation.
 *
 * Key format:
 *   - Crockford Base32 alphabet (`0-9 A-H J K M N P-T V-Z`; no I, L, O, U).
 *   - Grouped in 4-character segments separated by hyphens.
 *   - Product prefix `LIC-`.
 *   - Total payload (excluding prefix and separators) encodes at least 160 bits
 *     of entropy.
 *
 * We emit 5 groups of 4 Crockford characters = 20 chars × 5 bits = 100 bits
 * per row, so 5 groups alone only gets us 100 bits. To reach ≥160 bits while
 * staying human-friendly, we emit 8 groups = 32 chars × 5 bits = 160 bits.
 * The format allows "4 or more" groups after the first, so 8 groups is
 * compliant.
 *
 * Normalization is case-insensitive: lookups uppercase before matching, and
 * the alphabet excludes visually-ambiguous letters (I/1, L/1, O/0, U/V) by
 * construction — a lowercase `l` or `o` typed by a user is simply invalid,
 * not quietly rewritten to `1`/`0`. Stricter than Crockford's canonical
 * "accept I as 1" rule; we trade permissiveness for determinism so two keys
 * can never decode identically.
 */

import { randomFillSync } from 'node:crypto';

import { errors } from './errors.ts';

/** Crockford Base32 alphabet. 32 symbols, no I/L/O/U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Regex matching a well-formed license key: `LIC-` + ≥5 groups of 4 Crockford chars. */
export const LICENSE_KEY_REGEX = /^LIC-[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){4,}$/;

/**
 * Generate a fresh license key with 160 bits of entropy.
 *
 * Layout: `LIC-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX` — 8 groups of 4
 * Crockford-Base32 characters after the prefix = 160 bits.
 */
export function generateLicenseKey(): string {
  // 160 bits = 20 bytes of randomness. We map to 32 base32 chars.
  const bytes = new Uint8Array(20);
  randomFillSync(bytes);
  return `LIC-${formatGroups(base32Encode(bytes), 4)}`;
}

/**
 * Normalize a user-supplied key to canonical form: uppercased, whitespace
 * trimmed. Returns null if the normalized form does not match the required
 * shape — callers should treat null as `InvalidLicenseKey`.
 *
 * This is the single point where case-insensitive lookup is implemented.
 */
export function normalizeLicenseKey(input: string): string | null {
  const trimmed = input.trim().toUpperCase();
  if (!LICENSE_KEY_REGEX.test(trimmed)) return null;
  return trimmed;
}

/** Validate a license key; throws `InvalidLicenseKey` if malformed.
 *  Returns the normalized (uppercase) form on success. */
export function assertLicenseKey(input: string): string {
  const normalized = normalizeLicenseKey(input);
  if (normalized === null) throw errors.invalidLicenseKey();
  return normalized;
}

// ---------- internals ----------

/** Encode a byte array to Crockford Base32. Output length is
 *  `Math.ceil(bytes.length * 8 / 5)` — for 20 bytes, that's 32 chars. */
function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    buf = (buf << 8) | (bytes[i] as number);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buf >> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += ALPHABET[(buf << (5 - bits)) & 0x1f];
  }
  return out;
}

/** Split a string into groups of `size` characters, joined by `-`. */
function formatGroups(s: string, size: number): string {
  const parts: string[] = [];
  for (let i = 0; i < s.length; i += size) {
    parts.push(s.slice(i, i + size));
  }
  return parts.join('-');
}
