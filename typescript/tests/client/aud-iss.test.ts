/**
 * Optional `aud` (audience) and `iss` (issuer) claim validation.
 *
 * Both claims are advisory by default — when the verifier does not pin
 * an expected value, the claims are parsed if present (so they round-trip
 * into the result) but never enforced. When the verifier pins an expected
 * value, mismatches throw `AudienceMismatch` / `IssuerMismatch`.
 */

import { describe, expect, it } from 'bun:test';

import { validate } from '../../src/client/validate.ts';
import { forgeToken } from './_helpers.ts';

const FP = 'fp-x';

describe('validate — aud (audience pin)', () => {
  it('accepts a token whose aud (string) matches the verifier pin', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken({ usage_fingerprint: FP, aud: 'app-a' }, { nowSec: now });
    const result = await validate(f.token, {
      registry: f.registry,
      bindings: f.bindings,
      keys: f.keys,
      fingerprint: FP,
      nowSec: now,
      expectedAudience: 'app-a',
    });
    expect(result.aud).toBe('app-a');
  });

  it('accepts a token whose aud (array) contains the verifier pin', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken(
      { usage_fingerprint: FP, aud: ['app-a', 'app-b', 'app-c'] },
      { nowSec: now },
    );
    const result = await validate(f.token, {
      registry: f.registry,
      bindings: f.bindings,
      keys: f.keys,
      fingerprint: FP,
      nowSec: now,
      expectedAudience: 'app-b',
    });
    expect(result.aud).toEqual(['app-a', 'app-b', 'app-c']);
  });

  it('rejects with AudienceMismatch when string aud differs from pin', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken({ usage_fingerprint: FP, aud: 'app-a' }, { nowSec: now });
    await expect(
      validate(f.token, {
        registry: f.registry,
        bindings: f.bindings,
        keys: f.keys,
        fingerprint: FP,
        nowSec: now,
        expectedAudience: 'app-b',
      }),
    ).rejects.toMatchObject({ code: 'AudienceMismatch' });
  });

  it('rejects with AudienceMismatch when array aud lacks the pin', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken({ usage_fingerprint: FP, aud: ['app-a', 'app-b'] }, { nowSec: now });
    await expect(
      validate(f.token, {
        registry: f.registry,
        bindings: f.bindings,
        keys: f.keys,
        fingerprint: FP,
        nowSec: now,
        expectedAudience: 'app-c',
      }),
    ).rejects.toMatchObject({ code: 'AudienceMismatch' });
  });

  it('rejects with AudienceMismatch when verifier pins but token has no aud', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken({ usage_fingerprint: FP }, { nowSec: now });
    await expect(
      validate(f.token, {
        registry: f.registry,
        bindings: f.bindings,
        keys: f.keys,
        fingerprint: FP,
        nowSec: now,
        expectedAudience: 'app-a',
      }),
    ).rejects.toMatchObject({ code: 'AudienceMismatch' });
  });

  it('ignores aud when verifier does not pin (advisory)', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken({ usage_fingerprint: FP, aud: 'app-a' }, { nowSec: now });
    const result = await validate(f.token, {
      registry: f.registry,
      bindings: f.bindings,
      keys: f.keys,
      fingerprint: FP,
      nowSec: now,
      // no expectedAudience
    });
    expect(result.aud).toBe('app-a');
  });

  it('rejects with InvalidTokenFormat when aud is the wrong type', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken({ usage_fingerprint: FP, aud: 42 }, { nowSec: now });
    await expect(
      validate(f.token, {
        registry: f.registry,
        bindings: f.bindings,
        keys: f.keys,
        fingerprint: FP,
        nowSec: now,
      }),
    ).rejects.toMatchObject({ code: 'InvalidTokenFormat' });
  });

  it('rejects with InvalidTokenFormat when aud array contains non-strings', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken({ usage_fingerprint: FP, aud: ['app-a', 7] }, { nowSec: now });
    await expect(
      validate(f.token, {
        registry: f.registry,
        bindings: f.bindings,
        keys: f.keys,
        fingerprint: FP,
        nowSec: now,
      }),
    ).rejects.toMatchObject({ code: 'InvalidTokenFormat' });
  });
});

describe('validate — iss (issuer pin)', () => {
  it('accepts a token whose iss matches the verifier pin', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken(
      { usage_fingerprint: FP, iss: 'https://issuer.example' },
      { nowSec: now },
    );
    const result = await validate(f.token, {
      registry: f.registry,
      bindings: f.bindings,
      keys: f.keys,
      fingerprint: FP,
      nowSec: now,
      expectedIssuer: 'https://issuer.example',
    });
    expect(result.iss).toBe('https://issuer.example');
  });

  it('rejects with IssuerMismatch when iss differs from pin', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken(
      { usage_fingerprint: FP, iss: 'https://attacker.example' },
      { nowSec: now },
    );
    await expect(
      validate(f.token, {
        registry: f.registry,
        bindings: f.bindings,
        keys: f.keys,
        fingerprint: FP,
        nowSec: now,
        expectedIssuer: 'https://issuer.example',
      }),
    ).rejects.toMatchObject({ code: 'IssuerMismatch' });
  });

  it('rejects with IssuerMismatch when verifier pins but token has no iss', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken({ usage_fingerprint: FP }, { nowSec: now });
    await expect(
      validate(f.token, {
        registry: f.registry,
        bindings: f.bindings,
        keys: f.keys,
        fingerprint: FP,
        nowSec: now,
        expectedIssuer: 'https://issuer.example',
      }),
    ).rejects.toMatchObject({ code: 'IssuerMismatch' });
  });

  it('ignores iss when verifier does not pin (advisory)', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken(
      { usage_fingerprint: FP, iss: 'https://issuer.example' },
      { nowSec: now },
    );
    const result = await validate(f.token, {
      registry: f.registry,
      bindings: f.bindings,
      keys: f.keys,
      fingerprint: FP,
      nowSec: now,
      // no expectedIssuer
    });
    expect(result.iss).toBe('https://issuer.example');
  });

  it('rejects with InvalidTokenFormat when iss is the wrong type', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken({ usage_fingerprint: FP, iss: 42 }, { nowSec: now });
    await expect(
      validate(f.token, {
        registry: f.registry,
        bindings: f.bindings,
        keys: f.keys,
        fingerprint: FP,
        nowSec: now,
      }),
    ).rejects.toMatchObject({ code: 'InvalidTokenFormat' });
  });
});

describe('validate — aud + iss together', () => {
  it('accepts a token where both pins match', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken(
      {
        usage_fingerprint: FP,
        aud: ['app-a', 'app-b'],
        iss: 'https://issuer.example',
      },
      { nowSec: now },
    );
    const result = await validate(f.token, {
      registry: f.registry,
      bindings: f.bindings,
      keys: f.keys,
      fingerprint: FP,
      nowSec: now,
      expectedAudience: 'app-a',
      expectedIssuer: 'https://issuer.example',
    });
    expect(result.aud).toEqual(['app-a', 'app-b']);
    expect(result.iss).toBe('https://issuer.example');
  });

  it('aud check fires before iss check (per spec ordering)', async () => {
    const now = 2_000_000_000;
    // Both pins mismatch; aud should fire first per validation step 6 → 7.
    const f = await forgeToken(
      {
        usage_fingerprint: FP,
        aud: 'app-x',
        iss: 'https://attacker.example',
      },
      { nowSec: now },
    );
    await expect(
      validate(f.token, {
        registry: f.registry,
        bindings: f.bindings,
        keys: f.keys,
        fingerprint: FP,
        nowSec: now,
        expectedAudience: 'app-a',
        expectedIssuer: 'https://issuer.example',
      }),
    ).rejects.toMatchObject({ code: 'AudienceMismatch' });
  });

  it('result.aud and result.iss are null when not present in token', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken({ usage_fingerprint: FP }, { nowSec: now });
    const result = await validate(f.token, {
      registry: f.registry,
      bindings: f.bindings,
      keys: f.keys,
      fingerprint: FP,
      nowSec: now,
    });
    expect(result.aud).toBeNull();
    expect(result.iss).toBeNull();
  });
});
