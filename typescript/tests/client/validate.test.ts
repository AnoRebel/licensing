import { describe, expect, it } from 'bun:test';
import { LicensingClientError } from '../../src/client/errors.ts';
import { peek, validate } from '../../src/client/validate.ts';
import { forgeToken } from './_helpers.ts';

describe('validate — happy path', () => {
  it('accepts an active, in-window token with matching fingerprint', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken({ usage_fingerprint: 'fp-x' }, { nowSec: now });
    const result = await validate(f.token, {
      registry: f.registry,
      bindings: f.bindings,
      keys: f.keys,
      fingerprint: 'fp-x',
      nowSec: now,
    });
    expect(result.status).toBe('active');
    expect(result.kid).toBe(f.kid);
    expect(result.license_id).toBe('lic-1');
  });

  it('accepts status=grace', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken({ usage_fingerprint: 'fp-x', status: 'grace' }, { nowSec: now });
    const result = await validate(f.token, {
      registry: f.registry,
      bindings: f.bindings,
      keys: f.keys,
      fingerprint: 'fp-x',
      nowSec: now,
    });
    expect(result.status).toBe('grace');
  });
});

describe('validate — temporal', () => {
  it('rejects a token whose exp is in the past beyond skew', async () => {
    const f = await forgeToken({ usage_fingerprint: 'fp-x' });
    const expClaim = (await import('../../src/client/validate.ts')).peek(f.token).exp;
    await expect(
      validate(f.token, {
        registry: f.registry,
        bindings: f.bindings,
        keys: f.keys,
        fingerprint: 'fp-x',
        nowSec: expClaim + 1000,
        skewSec: 60,
      }),
    ).rejects.toMatchObject({ code: 'TokenExpired' });
  });

  it('rejects a token whose nbf is in the future beyond skew', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken(
      { usage_fingerprint: 'fp-x', nbf: now + 1000, iat: now, exp: now + 2000 },
      { nowSec: now },
    );
    await expect(
      validate(f.token, {
        registry: f.registry,
        bindings: f.bindings,
        keys: f.keys,
        fingerprint: 'fp-x',
        nowSec: now,
        skewSec: 60,
      }),
    ).rejects.toMatchObject({ code: 'TokenNotYetValid' });
  });

  it('accepts exp within the skew window', async () => {
    const now = 2_000_000_000;
    // exp is 10s in the past but skew is 60s, so it should pass temporal check.
    const f = await forgeToken(
      { usage_fingerprint: 'fp-x', nbf: now - 3600, iat: now - 3600, exp: now - 10 },
      { nowSec: now },
    );
    const r = await validate(f.token, {
      registry: f.registry,
      bindings: f.bindings,
      keys: f.keys,
      fingerprint: 'fp-x',
      nowSec: now,
      skewSec: 60,
    });
    expect(r.status).toBe('active');
  });
});

describe('validate — status', () => {
  for (const { status, code } of [
    { status: 'suspended', code: 'LicenseSuspended' },
    { status: 'revoked', code: 'LicenseRevoked' },
    { status: 'expired', code: 'TokenExpired' },
  ] as const) {
    it(`surfaces ${status} → ${code}`, async () => {
      const now = 2_000_000_000;
      const f = await forgeToken({ usage_fingerprint: 'fp-x', status }, { nowSec: now });
      await expect(
        validate(f.token, {
          registry: f.registry,
          bindings: f.bindings,
          keys: f.keys,
          fingerprint: 'fp-x',
          nowSec: now,
        }),
      ).rejects.toMatchObject({ code });
    });
  }
});

describe('validate — force_online_after', () => {
  it('rejects with RequiresOnlineRefresh when deadline passed', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken(
      { usage_fingerprint: 'fp-x', force_online_after: now - 1 },
      { nowSec: now },
    );
    await expect(
      validate(f.token, {
        registry: f.registry,
        bindings: f.bindings,
        keys: f.keys,
        fingerprint: 'fp-x',
        nowSec: now,
      }),
    ).rejects.toMatchObject({ code: 'RequiresOnlineRefresh' });
  });

  it('ignores skew on force_online_after (hard deadline)', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken(
      { usage_fingerprint: 'fp-x', force_online_after: now - 10 },
      { nowSec: now },
    );
    // Even with a 60s skew, force_online_after is a hard boundary.
    await expect(
      validate(f.token, {
        registry: f.registry,
        bindings: f.bindings,
        keys: f.keys,
        fingerprint: 'fp-x',
        nowSec: now,
        skewSec: 60,
      }),
    ).rejects.toMatchObject({ code: 'RequiresOnlineRefresh' });
  });
});

describe('validate — fingerprint', () => {
  it('rejects when device fingerprint differs', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken({ usage_fingerprint: 'fp-bound' }, { nowSec: now });
    await expect(
      validate(f.token, {
        registry: f.registry,
        bindings: f.bindings,
        keys: f.keys,
        fingerprint: 'fp-different',
        nowSec: now,
      }),
    ).rejects.toMatchObject({ code: 'FingerprintMismatch' });
  });

  it('exp failure dominates fingerprint mismatch (more informative error wins)', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken(
      { usage_fingerprint: 'fp-bound', exp: now - 3600, nbf: now - 7200 },
      { nowSec: now },
    );
    await expect(
      validate(f.token, {
        registry: f.registry,
        bindings: f.bindings,
        keys: f.keys,
        fingerprint: 'fp-other',
        nowSec: now,
      }),
    ).rejects.toMatchObject({ code: 'TokenExpired' });
  });
});

describe('validate — signature / format', () => {
  it('rejects tampered signature', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken({ usage_fingerprint: 'fp-x' }, { nowSec: now });
    // Tamper a middle character of the signature segment. We avoid the
    // last char because in base64url the trailing char encodes only a
    // partial byte and swapping can round-trip to the same bytes; a
    // middle char is a full 6-bit group and is guaranteed to mutate.
    const parts = f.token.split('.');
    const sig = parts[3];
    expect(sig).toBeDefined();
    if (!sig) throw new Error('unreachable');
    const midIdx = Math.floor(sig.length / 2);
    const midCh = sig[midIdx];
    if (midCh === undefined) throw new Error('unreachable');
    const flipped = midCh === 'A' ? 'B' : 'A';
    parts[3] = sig.slice(0, midIdx) + flipped + sig.slice(midIdx + 1);
    const tampered = parts.join('.');
    await expect(
      validate(tampered, {
        registry: f.registry,
        bindings: f.bindings,
        keys: f.keys,
        fingerprint: 'fp-x',
        nowSec: now,
      }),
    ).rejects.toMatchObject({ code: 'InvalidTokenFormat' });
  });

  it('rejects unknown kid', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken({ usage_fingerprint: 'fp-x' }, { kid: 'unknown-kid', nowSec: now });
    // Build a verify context for a DIFFERENT kid so UnknownKid surfaces.
    const otherF = await forgeToken(
      { usage_fingerprint: 'fp-x' },
      { kid: 'registered-kid', nowSec: now },
    );
    await expect(
      validate(f.token, {
        registry: otherF.registry,
        bindings: otherF.bindings,
        keys: otherF.keys,
        fingerprint: 'fp-x',
        nowSec: now,
      }),
    ).rejects.toBeInstanceOf(LicensingClientError);
  });
});

describe('peek', () => {
  it('returns header + lifetime claims without verifying', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken({ usage_fingerprint: 'fp-x' }, { nowSec: now });
    const p = peek(f.token);
    expect(p.kid).toBe(f.kid);
    expect(p.alg).toBe('ed25519');
    expect(p.iat).toBe(now);
    expect(p.exp).toBe(now + 3600);
    expect(p.forceOnlineAfter).toBeNull();
  });

  it('throws InvalidTokenFormat on garbage input', () => {
    expect(() => peek('not-a-token')).toThrow(/InvalidTokenFormat|could not be parsed/);
  });
});
