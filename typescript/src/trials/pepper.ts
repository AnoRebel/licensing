/**
 * Per-installation pepper for trial-issuance fingerprint hashing.
 *
 * The hash stored in `trial_issuances.fingerprint_hash` is
 * `SHA-256(pepper || canonical_fingerprint_input)`. Hashing protects raw
 * fingerprints if the table leaks; the pepper makes a stolen table useless
 * outside the deployment that wrote it.
 *
 * The pepper is **operator-managed** — same model as `NUXT_SESSION_PASSWORD`
 * in the admin UI. We deliberately do NOT persist it inside the licensing
 * database, because:
 *
 *   1. A pepper stored alongside the data it protects is just an obfuscation —
 *      anyone who steals the DB has both halves.
 *   2. Operators already have a place for secrets (env vars, secret managers,
 *      KMS); piggybacking on that path matches the rest of the system.
 *
 * The default pepper source is the `LICENSING_TRIAL_PEPPER` environment
 * variable. Tests + dev pass the value in directly.
 *
 * Cross-port byte parity: the Go port computes the same hash with the same
 * pepper, so a pair `(template_id, fingerprint)` deduplicates regardless of
 * which port issues the trial. The interop suite asserts this.
 */

import { createHash } from 'node:crypto';

/** Minimum pepper length (in chars) we accept. 16 bytes of randomness is
 *  the floor for the hash to be unrecoverable in a leaked table. */
const MIN_PEPPER_LENGTH = 32;

/**
 * Read the pepper from `process.env.LICENSING_TRIAL_PEPPER` and validate it.
 * Throws when missing or too short.
 */
export function pepperFromEnv(env = process.env): string {
  const v = env.LICENSING_TRIAL_PEPPER;
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(
      'LICENSING_TRIAL_PEPPER is required for trial issuance (>= 32 chars; e.g. `openssl rand -hex 32`)',
    );
  }
  if (v.length < MIN_PEPPER_LENGTH) {
    throw new Error(
      `LICENSING_TRIAL_PEPPER must be at least ${MIN_PEPPER_LENGTH} characters (got ${v.length})`,
    );
  }
  return v;
}

/**
 * Hash a canonical fingerprint input with the supplied pepper. The output
 * is lowercase SHA-256 hex, 64 chars — the exact shape persisted in
 * `trial_issuances.fingerprint_hash`.
 */
export function hashFingerprint(pepper: string, fingerprintInput: string): string {
  if (pepper.length < MIN_PEPPER_LENGTH) {
    throw new Error(
      `pepper must be at least ${MIN_PEPPER_LENGTH} characters (got ${pepper.length})`,
    );
  }
  return createHash('sha256').update(pepper).update(fingerprintInput).digest('hex').toLowerCase();
}

/**
 * High-level facade most consumers will use: `Trials.hash(input)` reads the
 * pepper from env once and produces a fingerprint hash. Callers may also
 * construct a `TrialPepperStore` directly to inject a non-env pepper (tests,
 * KMS-resolved secrets).
 */
export class TrialPepperStore {
  readonly #pepper: string;

  constructor(pepper: string) {
    if (pepper.length < MIN_PEPPER_LENGTH) {
      throw new Error(
        `pepper must be at least ${MIN_PEPPER_LENGTH} characters (got ${pepper.length})`,
      );
    }
    this.#pepper = pepper;
  }

  /** Construct from `process.env.LICENSING_TRIAL_PEPPER`. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): TrialPepperStore {
    return new TrialPepperStore(pepperFromEnv(env));
  }

  /** Hash a canonical fingerprint input. */
  hash(fingerprintInput: string): string {
    return hashFingerprint(this.#pepper, fingerprintInput);
  }
}
