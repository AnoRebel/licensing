/**
 * Trial-pepper smoke tests. Cross-port byte-compat lives in the interop
 * suite; here we assert determinism, env-var validation, and that the
 * helper is a thin wrapper.
 */

import { describe, expect, it } from 'bun:test';

import { hashFingerprint, pepperFromEnv, TrialPepperStore } from '../../src/trials/pepper.ts';

const ROCK = 'a'.repeat(32);

describe('trial-pepper', () => {
  it('hashFingerprint is deterministic and lowercase 64-char hex', () => {
    const a = hashFingerprint(ROCK, 'fp:User:u1');
    const b = hashFingerprint(ROCK, 'fp:User:u1');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different pepper produces different hash', () => {
    const a = hashFingerprint(ROCK, 'fp:User:u1');
    const b = hashFingerprint('b'.repeat(32), 'fp:User:u1');
    expect(a).not.toBe(b);
  });

  it('pepperFromEnv requires the env var', () => {
    expect(() => pepperFromEnv({})).toThrow(/LICENSING_TRIAL_PEPPER is required/);
  });

  it('pepperFromEnv enforces minimum length', () => {
    expect(() => pepperFromEnv({ LICENSING_TRIAL_PEPPER: 'short' })).toThrow(
      /at least 32 characters/,
    );
  });

  it('TrialPepperStore.fromEnv resolves the pepper and hashes consistently', () => {
    const store = TrialPepperStore.fromEnv({ LICENSING_TRIAL_PEPPER: ROCK });
    const a = store.hash('fp:User:u1');
    const b = hashFingerprint(ROCK, 'fp:User:u1');
    expect(a).toBe(b);
  });

  it('TrialPepperStore constructor rejects short peppers', () => {
    expect(() => new TrialPepperStore('short')).toThrow(/at least 32 characters/);
  });
});
