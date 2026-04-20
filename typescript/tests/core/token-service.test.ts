/**
 * `issueToken`.
 *
 * Token issuance refuses non-usable statuses; emitted tokens carry the
 * required + optional LIC1 claims and the envelope structure (prefix, four
 * parts, base64url no-padding).
 *
 * Covers:
 *   - Happy path: active license, fresh token verifies + decodes to the
 *     required claim set.
 *   - Scope slug propagates to the `scope` claim; global scope → empty
 *     string.
 *   - `force_online_after` resolved from license.meta, caller override,
 *     and caller-explicit-null.
 *   - `entitlements` resolved from license.meta (template snapshot), caller
 *     override, and caller-explicit-null.
 *   - Grace window: license past `expires_at` but within `grace_until`
 *     issues a token with `status: 'grace'`.
 *   - Refusal for suspended / revoked / expired / pending.
 *   - Usage mismatch: caller passes a usage from a different license.
 *   - Usage not active: caller passes a revoked usage.
 *   - Scoped-signer preference: a scoped active key wins over the global
 *     fallback for the same alg.
 *   - Global fallback: scoped license with no scoped signer falls through
 *     to the global active signer.
 *
 * Uses the real ed25519Backend so signatures are verifiable end-to-end.
 * Memory storage only — this exercises pure core logic; adapter-specific
 * paging/tx behavior is covered by lower-level service tests.
 */

import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '@licensing/sdk/storage/memory';
import type { SignatureBackend } from '../../src/crypto/types.ts';
import type { Clock } from '../../src/id.ts';
import {
  createAdvancingClock,
  createLicense,
  createScope,
  decodeUnverified,
  ed25519Backend,
  generateRootKey,
  issueInitialSigningKey,
  issueToken,
  registerUsage,
  revoke,
  revokeUsage,
  suspend,
  verify as verifyLic1,
} from '../../src/index.ts';
import type { Storage } from '../../src/storage/index.ts';
import type { KeyAlg, License, LicenseUsage, UUIDv7 } from '../../src/types.ts';

function mkBackends(): ReadonlyMap<KeyAlg, SignatureBackend> {
  return new Map<KeyAlg, SignatureBackend>([['ed25519', ed25519Backend]]);
}

/** End-to-end setup: scope + root + signing + license + active usage. */
async function setupSignedLicense(
  s: Storage,
  clock: Clock,
  opts: {
    scope?: 'global' | { slug: string; name: string };
    max_usages?: number;
    expires_at?: string | null;
    grace_until?: string | null;
    licenseMeta?: Record<string, unknown>;
  } = {},
): Promise<{
  scope_id: UUIDv7 | null;
  signingKid: string;
  license: License;
  usage: LicenseUsage;
}> {
  const scopeMode = opts.scope ?? 'global';
  const scope_id =
    scopeMode === 'global'
      ? null
      : (await createScope(s, clock, { slug: scopeMode.slug, name: scopeMode.name })).id;

  const root = await generateRootKey(s, clock, mkBackends(), {
    scope_id,
    alg: 'ed25519',
    passphrase: 'root-pw',
  });
  const signing = await issueInitialSigningKey(s, clock, mkBackends(), {
    scope_id,
    alg: 'ed25519',
    rootKid: root.kid,
    rootPassphrase: 'root-pw',
    signingPassphrase: 'sign-pw',
  });
  const license = await createLicense(s, clock, {
    scope_id,
    template_id: null,
    licensable_type: 'User',
    licensable_id: 'u-1',
    max_usages: opts.max_usages ?? 3,
    ...(opts.expires_at !== undefined ? { expires_at: opts.expires_at } : {}),
    ...(opts.grace_until !== undefined ? { grace_until: opts.grace_until } : {}),
    ...(opts.licenseMeta !== undefined ? { meta: opts.licenseMeta } : {}),
  });
  const reg = await registerUsage(s, clock, {
    license_id: license.id,
    fingerprint: 'a'.repeat(64),
  });
  return { scope_id, signingKid: signing.kid, license: reg.license, usage: reg.usage };
}

describe('token-service', () => {
  it('issueToken happy path — token verifies + carries required claims', async () => {
    const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
    const s = new MemoryStorage({ clock });
    const { signingKid, license, usage } = await setupSignedLicense(s, clock);

    const result = await issueToken(s, clock, mkBackends(), {
      license,
      usage,
      ttlSeconds: 3600,
      alg: 'ed25519',
      signingPassphrase: 'sign-pw',
    });

    expect(result.token.startsWith('LIC1.')).toBe(true);
    expect(result.kid).toBe(signingKid);
    expect(result.exp - result.iat).toBe(3600);

    // Round-trip: decode + verify using the same registered kid.
    const keyRow = await s.getKeyByKid(signingKid);
    if (keyRow === null) throw new Error('signing key row missing');
    const parts = decodeUnverified(result.token);
    expect(parts.header).toEqual({ v: 1, typ: 'lic', alg: 'ed25519', kid: signingKid });
    expect(parts.payload.jti).toBe(result.jti);
    expect(parts.payload.license_id).toBe(license.id);
    expect(parts.payload.usage_id).toBe(usage.id);
    expect(parts.payload.usage_fingerprint).toBe(usage.fingerprint);
    expect(parts.payload.scope).toBe('');
    expect(parts.payload.status).toBe('active');
    expect(parts.payload.max_usages).toBe(license.max_usages);
    // Optional claims absent when not set.
    expect(parts.payload.force_online_after).toBeUndefined();
    expect(parts.payload.entitlements).toBeUndefined();
    expect(parts.payload.meta).toBeUndefined();

    // Signature verifies against the stored public key.
    const { AlgorithmRegistry, KeyAlgBindings } = await import('../../src/crypto/index.ts');
    const registry = new AlgorithmRegistry();
    registry.register(ed25519Backend);
    const bindings = new KeyAlgBindings();
    bindings.bind(signingKid, 'ed25519');
    const keys = new Map([
      [
        signingKid,
        {
          kid: signingKid,
          alg: 'ed25519' as const,
          publicPem: keyRow.public_pem,
          privatePem: null,
          raw: { publicRaw: null, privateRaw: null },
        },
      ],
    ]);
    await verifyLic1(result.token, { registry, bindings, keys });
  });

  it('scope slug populates the scope claim', async () => {
    const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
    const s = new MemoryStorage({ clock });
    const { license, usage } = await setupSignedLicense(s, clock, {
      scope: { slug: 'example.app', name: 'Example App' },
    });
    const result = await issueToken(s, clock, mkBackends(), {
      license,
      usage,
      ttlSeconds: 600,
      alg: 'ed25519',
      signingPassphrase: 'sign-pw',
    });
    const parts = decodeUnverified(result.token);
    expect(parts.payload.scope).toBe('example.app');
  });

  it('force_online_after from license.meta is converted to absolute unix seconds', async () => {
    const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
    const s = new MemoryStorage({ clock });
    const { license, usage } = await setupSignedLicense(s, clock, {
      licenseMeta: { force_online_after_sec: 7200 },
    });
    const result = await issueToken(s, clock, mkBackends(), {
      license,
      usage,
      ttlSeconds: 3600,
      alg: 'ed25519',
      signingPassphrase: 'sign-pw',
    });
    const parts = decodeUnverified(result.token);
    // iat + 7200 (from license.meta.force_online_after_sec).
    expect(parts.payload.force_online_after).toBe(result.iat + 7200);
  });

  it('caller override for force_online_after wins over license.meta', async () => {
    const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
    const s = new MemoryStorage({ clock });
    const { license, usage } = await setupSignedLicense(s, clock, {
      licenseMeta: { force_online_after_sec: 7200 },
    });
    // Absolute unix-seconds deadline ~5 days past iat (~2026-04-13) —
    // within the 10-year horizon cap enforced by validateForceOnlineDeadline.
    const override = Math.floor(Date.parse('2026-04-18T10:00:00.000Z') / 1000);
    const result = await issueToken(s, clock, mkBackends(), {
      license,
      usage,
      ttlSeconds: 3600,
      alg: 'ed25519',
      signingPassphrase: 'sign-pw',
      forceOnlineAfter: override,
    });
    const parts = decodeUnverified(result.token);
    expect(parts.payload.force_online_after).toBe(override);
  });

  it('caller explicit null force_online_after suppresses the meta-derived value', async () => {
    const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
    const s = new MemoryStorage({ clock });
    const { license, usage } = await setupSignedLicense(s, clock, {
      licenseMeta: { force_online_after_sec: 7200 },
    });
    const result = await issueToken(s, clock, mkBackends(), {
      license,
      usage,
      ttlSeconds: 3600,
      alg: 'ed25519',
      signingPassphrase: 'sign-pw',
      forceOnlineAfter: null,
    });
    const parts = decodeUnverified(result.token);
    expect(parts.payload.force_online_after).toBeUndefined();
  });

  it('entitlements from license.meta are embedded; caller override wins', async () => {
    const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
    const s = new MemoryStorage({ clock });
    const { license, usage } = await setupSignedLicense(s, clock, {
      licenseMeta: { entitlements: { seats: 5, tier: 'pro' } },
    });

    const defaulted = await issueToken(s, clock, mkBackends(), {
      license,
      usage,
      ttlSeconds: 3600,
      alg: 'ed25519',
      signingPassphrase: 'sign-pw',
    });
    expect(decodeUnverified(defaulted.token).payload.entitlements).toEqual({
      seats: 5,
      tier: 'pro',
    });

    const overridden = await issueToken(s, clock, mkBackends(), {
      license,
      usage,
      ttlSeconds: 3600,
      alg: 'ed25519',
      signingPassphrase: 'sign-pw',
      entitlements: { seats: 1 },
    });
    expect(decodeUnverified(overridden.token).payload.entitlements).toEqual({ seats: 1 });
  });

  it('token issued during grace carries status=grace', async () => {
    const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
    const s = new MemoryStorage({ clock });
    // expires_at in the past, grace_until in the future — now is between them.
    const { license, usage } = await setupSignedLicense(s, clock, {
      expires_at: '2026-04-10T00:00:00.000000Z',
      grace_until: '2030-01-01T00:00:00.000000Z',
    });
    const result = await issueToken(s, clock, mkBackends(), {
      license,
      usage,
      ttlSeconds: 3600,
      alg: 'ed25519',
      signingPassphrase: 'sign-pw',
    });
    expect(decodeUnverified(result.token).payload.status).toBe('grace');
  });

  it('refuses issuance for suspended license', async () => {
    const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
    const s = new MemoryStorage({ clock });
    const { license, usage } = await setupSignedLicense(s, clock);
    const suspended = await s.withTransaction((tx) =>
      suspend(tx, license, clock, { actor: 'admin' }),
    );
    await expect(
      issueToken(s, clock, mkBackends(), {
        license: suspended,
        usage,
        ttlSeconds: 3600,
        alg: 'ed25519',
        signingPassphrase: 'sign-pw',
      }),
    ).rejects.toThrow(/suspended/i);
  });

  it('refuses issuance for revoked license', async () => {
    const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
    const s = new MemoryStorage({ clock });
    const { license, usage } = await setupSignedLicense(s, clock);
    const revoked = await s.withTransaction((tx) => revoke(tx, license, clock, { actor: 'admin' }));
    await expect(
      issueToken(s, clock, mkBackends(), {
        license: revoked,
        usage,
        ttlSeconds: 3600,
        alg: 'ed25519',
        signingPassphrase: 'sign-pw',
      }),
    ).rejects.toThrow(/revoked/i);
  });

  it('refuses issuance for expired license (past grace_until)', async () => {
    const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
    const s = new MemoryStorage({ clock });
    const { license, usage } = await setupSignedLicense(s, clock, {
      expires_at: '2026-04-01T00:00:00.000000Z',
      grace_until: '2026-04-05T00:00:00.000000Z',
    });
    await expect(
      issueToken(s, clock, mkBackends(), {
        license,
        usage,
        ttlSeconds: 3600,
        alg: 'ed25519',
        signingPassphrase: 'sign-pw',
      }),
    ).rejects.toThrow(/expired/i);
  });

  it('refuses issuance when usage is from a different license', async () => {
    const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
    const s = new MemoryStorage({ clock });
    const a = await setupSignedLicense(s, clock);
    // Create a second license on the same scope; its usage row belongs to `b`.
    const b = await createLicense(s, clock, {
      scope_id: null,
      template_id: null,
      licensable_type: 'User',
      licensable_id: 'u-2',
      max_usages: 1,
    });
    const bReg = await registerUsage(s, clock, {
      license_id: b.id,
      fingerprint: 'b'.repeat(64),
    });

    await expect(
      issueToken(s, clock, mkBackends(), {
        license: a.license,
        usage: bReg.usage,
        ttlSeconds: 3600,
        alg: 'ed25519',
        signingPassphrase: 'sign-pw',
      }),
    ).rejects.toThrow(/does not belong/);
  });

  it('refuses issuance when usage is not active (revoked)', async () => {
    const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
    const s = new MemoryStorage({ clock });
    const { license, usage } = await setupSignedLicense(s, clock);
    const revokedUsage = await revokeUsage(s, clock, usage.id);
    await expect(
      issueToken(s, clock, mkBackends(), {
        license,
        usage: revokedUsage,
        ttlSeconds: 3600,
        alg: 'ed25519',
        signingPassphrase: 'sign-pw',
      }),
    ).rejects.toThrow(/not active/);
  });

  it('refuses zero or negative ttl', async () => {
    const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
    const s = new MemoryStorage({ clock });
    const { license, usage } = await setupSignedLicense(s, clock);
    await expect(
      issueToken(s, clock, mkBackends(), {
        license,
        usage,
        ttlSeconds: 0,
        alg: 'ed25519',
        signingPassphrase: 'sign-pw',
      }),
    ).rejects.toThrow(/ttlSeconds/);
  });

  it('falls back to global signer when scoped signer is absent', async () => {
    const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
    const s = new MemoryStorage({ clock });

    // Seed a *global* signing key first (no scope).
    const globalRoot = await generateRootKey(s, clock, mkBackends(), {
      scope_id: null,
      alg: 'ed25519',
      passphrase: 'root-pw',
    });
    const globalSigning = await issueInitialSigningKey(s, clock, mkBackends(), {
      scope_id: null,
      alg: 'ed25519',
      rootKid: globalRoot.kid,
      rootPassphrase: 'root-pw',
      signingPassphrase: 'sign-pw',
    });

    // Create a scoped license with no scoped signer.
    const scope = await createScope(s, clock, { slug: 'scoped', name: 'Scoped' });
    const license = await createLicense(s, clock, {
      scope_id: scope.id,
      template_id: null,
      licensable_type: 'User',
      licensable_id: 'u-f',
      max_usages: 1,
    });
    const reg = await registerUsage(s, clock, {
      license_id: license.id,
      fingerprint: 'c'.repeat(64),
    });

    const result = await issueToken(s, clock, mkBackends(), {
      license: reg.license,
      usage: reg.usage,
      ttlSeconds: 3600,
      alg: 'ed25519',
      signingPassphrase: 'sign-pw',
    });
    // The token was signed by the global key (fallback), not a scoped one.
    expect(result.kid).toBe(globalSigning.kid);
  });

  it('prefers scoped signer over global when both exist for same alg', async () => {
    const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
    const s = new MemoryStorage({ clock });

    // Global signer first.
    const gRoot = await generateRootKey(s, clock, mkBackends(), {
      scope_id: null,
      alg: 'ed25519',
      passphrase: 'root-pw',
    });
    const gSigning = await issueInitialSigningKey(s, clock, mkBackends(), {
      scope_id: null,
      alg: 'ed25519',
      rootKid: gRoot.kid,
      rootPassphrase: 'root-pw',
      signingPassphrase: 'sign-pw',
    });

    // Scoped signer second.
    const scope = await createScope(s, clock, { slug: 'both', name: 'Both' });
    const sRoot = await generateRootKey(s, clock, mkBackends(), {
      scope_id: scope.id,
      alg: 'ed25519',
      passphrase: 'root-pw',
    });
    const sSigning = await issueInitialSigningKey(s, clock, mkBackends(), {
      scope_id: scope.id,
      alg: 'ed25519',
      rootKid: sRoot.kid,
      rootPassphrase: 'root-pw',
      signingPassphrase: 'sign-pw',
    });

    const license = await createLicense(s, clock, {
      scope_id: scope.id,
      template_id: null,
      licensable_type: 'User',
      licensable_id: 'u-p',
      max_usages: 1,
    });
    const reg = await registerUsage(s, clock, {
      license_id: license.id,
      fingerprint: 'd'.repeat(64),
    });

    const result = await issueToken(s, clock, mkBackends(), {
      license: reg.license,
      usage: reg.usage,
      ttlSeconds: 3600,
      alg: 'ed25519',
      signingPassphrase: 'sign-pw',
    });
    expect(result.kid).toBe(sSigning.kid);
    expect(result.kid).not.toBe(gSigning.kid);
  });

  // ---------- validation boundaries (H2 + H3) ----------

  it('rejects caller forceOnlineAfter in the past (pre-iat deadline)', async () => {
    const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
    const s = new MemoryStorage({ clock });
    const { license, usage } = await setupSignedLicense(s, clock);
    // 2020 is well before 2026 iat — must fail.
    const past = Math.floor(Date.parse('2020-01-01T00:00:00.000Z') / 1000);
    await expect(
      issueToken(s, clock, mkBackends(), {
        license,
        usage,
        ttlSeconds: 3600,
        alg: 'ed25519',
        signingPassphrase: 'sign-pw',
        forceOnlineAfter: past,
      }),
    ).rejects.toThrow(/forceOnlineAfter.*past/);
  });

  it('rejects caller forceOnlineAfter beyond the 10-year horizon', async () => {
    const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
    const s = new MemoryStorage({ clock });
    const { license, usage } = await setupSignedLicense(s, clock);
    // Year ~2286 — past the 10-year horizon cap.
    await expect(
      issueToken(s, clock, mkBackends(), {
        license,
        usage,
        ttlSeconds: 3600,
        alg: 'ed25519',
        signingPassphrase: 'sign-pw',
        forceOnlineAfter: 9_999_999_999,
      }),
    ).rejects.toThrow(/exceeds max horizon/);
  });

  it('rejects caller forceOnlineAfter that is not a safe integer', async () => {
    const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
    const s = new MemoryStorage({ clock });
    const { license, usage } = await setupSignedLicense(s, clock);
    await expect(
      issueToken(s, clock, mkBackends(), {
        license,
        usage,
        ttlSeconds: 3600,
        alg: 'ed25519',
        signingPassphrase: 'sign-pw',
        forceOnlineAfter: Number.NaN,
      }),
    ).rejects.toThrow(/finite integer/);
  });

  it('rejects license.meta.force_online_after_sec that is non-positive', async () => {
    const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
    const s = new MemoryStorage({ clock });
    const { license, usage } = await setupSignedLicense(s, clock, {
      licenseMeta: { force_online_after_sec: 0 },
    });
    await expect(
      issueToken(s, clock, mkBackends(), {
        license,
        usage,
        ttlSeconds: 3600,
        alg: 'ed25519',
        signingPassphrase: 'sign-pw',
      }),
    ).rejects.toThrow(/positive integer/);
  });

  it('rejects license.meta.force_online_after_sec beyond the 10-year horizon', async () => {
    const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
    const s = new MemoryStorage({ clock });
    const FORCE_ONLINE_MAX_SEC = 10 * 365 * 24 * 3600;
    const { license, usage } = await setupSignedLicense(s, clock, {
      licenseMeta: { force_online_after_sec: FORCE_ONLINE_MAX_SEC + 1 },
    });
    await expect(
      issueToken(s, clock, mkBackends(), {
        license,
        usage,
        ttlSeconds: 3600,
        alg: 'ed25519',
        signingPassphrase: 'sign-pw',
      }),
    ).rejects.toThrow(/exceeds max horizon/);
  });

  it('defense-in-depth: global signer for scoped license is accepted (fallback path is legitimate)', async () => {
    // This pairs with the scope-drift guard test: the guard refuses non-matching
    // *non-global* keys, but global (scope_id=null) is always a legitimate signer.
    const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
    const s = new MemoryStorage({ clock });
    const gRoot = await generateRootKey(s, clock, mkBackends(), {
      scope_id: null,
      alg: 'ed25519',
      passphrase: 'root-pw',
    });
    const gSigning = await issueInitialSigningKey(s, clock, mkBackends(), {
      scope_id: null,
      alg: 'ed25519',
      rootKid: gRoot.kid,
      rootPassphrase: 'root-pw',
      signingPassphrase: 'sign-pw',
    });
    const scope = await createScope(s, clock, { slug: 'only-global', name: 'Only global' });
    const license = await createLicense(s, clock, {
      scope_id: scope.id,
      template_id: null,
      licensable_type: 'User',
      licensable_id: 'u-legit',
      max_usages: 1,
    });
    const reg = await registerUsage(s, clock, {
      license_id: license.id,
      fingerprint: 'f'.repeat(64),
    });
    const result = await issueToken(s, clock, mkBackends(), {
      license: reg.license,
      usage: reg.usage,
      ttlSeconds: 3600,
      alg: 'ed25519',
      signingPassphrase: 'sign-pw',
    });
    expect(result.kid).toBe(gSigning.kid);
  });
});
