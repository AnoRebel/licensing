/**
 * Transparency-hook tests for `issueToken`.
 *
 * Covers (mirrors licensing/transparency_hook_test.go):
 *
 *   1. Hook fires once per successful issue with the right metadata.
 *   2. tokenSha256 matches an independent SHA-256 of the wire-token
 *      bytes — third-party logs can do the same hash and compare.
 *   3. Hook does NOT fire when issuance fails (wrong passphrase).
 *   4. Undefined hook is a zero-cost no-op.
 *   5. A hook that throws DOES propagate the throw — operators are
 *      expected to wrap their hook with try/catch if needed. This
 *      contract is pinned explicitly so a future "we should sandbox
 *      the hook" change is a deliberate decision, not an accidental
 *      drift.
 *   6. Concurrent issues fire the hook concurrently; each event is
 *      delivered exactly once with a distinct jti.
 */

import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';

import { MemoryStorage } from '@anorebel/licensing/storage/memory';
import type { SignatureBackend } from '../../src/crypto/types.ts';
import type { Clock } from '../../src/id.ts';
import {
  createAdvancingClock,
  createLicense,
  ed25519Backend,
  generateRootKey,
  issueInitialSigningKey,
  issueToken,
  registerUsage,
  type TokenIssuedEvent,
} from '../../src/index.ts';
import type { Storage } from '../../src/storage/index.ts';
import type { KeyAlg, License, LicenseUsage } from '../../src/types.ts';

function mkBackends(): ReadonlyMap<KeyAlg, SignatureBackend> {
  return new Map<KeyAlg, SignatureBackend>([['ed25519', ed25519Backend]]);
}

async function setup(): Promise<{
  s: Storage;
  clock: Clock;
  license: License;
  usage: LicenseUsage;
  signingKid: string;
}> {
  const clock = createAdvancingClock('2026-05-01T10:00:00.000000Z');
  const s = new MemoryStorage({ clock });
  const root = await generateRootKey(s, clock, mkBackends(), {
    scope_id: null,
    alg: 'ed25519',
    passphrase: 'root-pw',
  });
  const signing = await issueInitialSigningKey(s, clock, mkBackends(), {
    scope_id: null,
    alg: 'ed25519',
    rootKid: root.kid,
    rootPassphrase: 'root-pw',
    signingPassphrase: 'sign-pw',
  });
  const initial = await createLicense(s, clock, {
    scope_id: null,
    template_id: null,
    licensable_type: 'User',
    licensable_id: 'u-1',
    max_usages: 5,
  });
  // registerUsage activates the license on first use; we want the
  // post-registration row (status=active) for issueToken.
  const reg = await registerUsage(s, clock, {
    license_id: initial.id,
    fingerprint: 'a'.repeat(64),
  });
  return { s, clock, license: reg.license, usage: reg.usage, signingKid: signing.kid };
}

describe('issueToken — transparency hook', () => {
  it('fires once with the right metadata on successful issue', async () => {
    const { s, clock, license, usage, signingKid } = await setup();
    const captured: TokenIssuedEvent[] = [];
    const result = await issueToken(s, clock, mkBackends(), {
      license,
      usage,
      ttlSeconds: 3600,
      alg: 'ed25519',
      signingPassphrase: 'sign-pw',
      transparencyHook: (e) => captured.push(e),
    });
    expect(captured).toHaveLength(1);
    const ev = captured[0] as TokenIssuedEvent;
    expect(ev.jti).toBe(result.jti);
    expect(ev.licenseId).toBe(license.id);
    expect(ev.usageId).toBe(usage.id);
    expect(ev.kid).toBe(signingKid);
    expect(ev.iat).toBe(result.iat);
    expect(ev.exp).toBe(result.exp);
  });

  it('tokenSha256 matches an independent SHA-256 of the wire token', async () => {
    const { s, clock, license, usage } = await setup();
    let captured: TokenIssuedEvent | null = null;
    const result = await issueToken(s, clock, mkBackends(), {
      license,
      usage,
      ttlSeconds: 3600,
      alg: 'ed25519',
      signingPassphrase: 'sign-pw',
      transparencyHook: (e) => {
        captured = e;
      },
    });
    const want = createHash('sha256').update(result.token).digest('hex').toLowerCase();
    expect(captured).not.toBeNull();
    expect((captured as unknown as TokenIssuedEvent).tokenSha256).toBe(want);
    // Format invariant — 64 lowercase hex chars.
    expect((captured as unknown as TokenIssuedEvent).tokenSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not fire when issue fails (wrong passphrase)', async () => {
    const { s, clock, license, usage } = await setup();
    let called = false;
    await expect(
      issueToken(s, clock, mkBackends(), {
        license,
        usage,
        ttlSeconds: 3600,
        alg: 'ed25519',
        signingPassphrase: 'wrong-passphrase',
        transparencyHook: () => {
          called = true;
        },
      }),
    ).rejects.toBeDefined();
    expect(called).toBe(false);
  });

  it('undefined hook is a zero-cost no-op', async () => {
    const { s, clock, license, usage } = await setup();
    const result = await issueToken(s, clock, mkBackends(), {
      license,
      usage,
      ttlSeconds: 3600,
      alg: 'ed25519',
      signingPassphrase: 'sign-pw',
      // transparencyHook: undefined
    });
    expect(result.token.startsWith('LIC1.')).toBe(true);
  });

  it('throwing hook propagates — sandboxing is the operator wrapper job', async () => {
    const { s, clock, license, usage } = await setup();
    await expect(
      issueToken(s, clock, mkBackends(), {
        license,
        usage,
        ttlSeconds: 3600,
        alg: 'ed25519',
        signingPassphrase: 'sign-pw',
        transparencyHook: () => {
          throw new Error('hook explosion');
        },
      }),
    ).rejects.toThrow(/hook explosion/);
  });

  it('concurrent issues deliver distinct events with distinct jtis', async () => {
    // Setup with a license that has enough seat headroom for N parallel usages.
    const clock = createAdvancingClock('2026-05-01T10:00:00.000000Z');
    const s = new MemoryStorage({ clock });
    const root = await generateRootKey(s, clock, mkBackends(), {
      scope_id: null,
      alg: 'ed25519',
      passphrase: 'root-pw',
    });
    await issueInitialSigningKey(s, clock, mkBackends(), {
      scope_id: null,
      alg: 'ed25519',
      rootKid: root.kid,
      rootPassphrase: 'root-pw',
      signingPassphrase: 'sign-pw',
    });
    const N = 20;
    const initialLicense = await createLicense(s, clock, {
      scope_id: null,
      template_id: null,
      licensable_type: 'User',
      licensable_id: 'u-1',
      max_usages: N,
    });
    // Fingerprint is exactly 64 hex chars — pad the index into the
    // last few positions so each is distinct.
    const usages: LicenseUsage[] = [];
    let activated: License | null = null;
    for (let i = 0; i < N; i++) {
      const fp = ('a'.repeat(60) + i.toString(16).padStart(4, '0')).slice(0, 64);
      const reg = await registerUsage(s, clock, { license_id: initialLicense.id, fingerprint: fp });
      usages.push(reg.usage);
      activated = reg.license;
    }
    const license = activated as License;

    const seenJtis = new Set<string>();
    let dupSeen = false;
    const hook = (e: TokenIssuedEvent): void => {
      if (seenJtis.has(e.jti)) dupSeen = true;
      seenJtis.add(e.jti);
    };

    await Promise.all(
      usages.map((u) =>
        issueToken(s, clock, mkBackends(), {
          license,
          usage: u,
          ttlSeconds: 3600,
          alg: 'ed25519',
          signingPassphrase: 'sign-pw',
          transparencyHook: hook,
        }),
      ),
    );
    expect(dupSeen).toBe(false);
    expect(seenJtis.size).toBe(N);
  });
});
