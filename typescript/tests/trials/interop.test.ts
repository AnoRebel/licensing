/**
 * Cross-port hash parity. Both ports load fixtures/trials/canonical.json and
 * MUST produce the same SHA-256 hex. If either side drifts the interop CI
 * matrix catches it. The Go counterpart lives at
 * licensing/trials/interop_test.go.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { hashFingerprint } from '../../src/trials/pepper.ts';

interface CanonicalFixture {
  readonly pepper: string;
  readonly fingerprint_input: string;
  readonly fingerprint_hash: string;
}

const FIXTURES_PATH = join(import.meta.dir, '../../../fixtures/trials/canonical.json');

describe('trial-pepper cross-port hash parity', () => {
  it('hashFingerprint matches the canonical fixture', () => {
    const fx = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8')) as CanonicalFixture;
    const got = hashFingerprint(fx.pepper, fx.fingerprint_input);
    expect(got).toBe(fx.fingerprint_hash);
  });
});
