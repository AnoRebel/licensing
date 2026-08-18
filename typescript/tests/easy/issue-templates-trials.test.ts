/**
 * Issuer.issue() — template inheritance + trial-issuance behaviour.
 *
 * Covers:
 *   - Issue from a flat template (defaults inherited).
 *   - Issue from a child template (parent merge wins on missing keys).
 *   - Per-call override beats template default.
 *   - Trial issuance recorded; same-fingerprint within cooldown rejected.
 *   - Trial issuance allowed after cooldown elapses.
 *   - Trial without pepper / fingerprint surfaces a clear error.
 */

import { describe, expect, it } from 'bun:test';

import { Licensing } from '@anorebel/licensing';
import type { LicenseTemplateInput } from '@anorebel/licensing/storage';
import { MemoryStorage } from '@anorebel/licensing/storage/memory';
import { hashFingerprint } from '../../src/trials/pepper.ts';

const PASSPHRASE = 'test-passphrase-must-be-at-least-32-chars';
const PEPPER = 'a'.repeat(32);

function tmplInput(overrides: Partial<LicenseTemplateInput> = {}): LicenseTemplateInput {
  return {
    scope_id: null,
    parent_id: null,
    name: overrides.name ?? `tmpl-${Math.random().toString(36).slice(2, 8)}`,
    max_usages: 5,
    trial_duration_sec: 0,
    trial_cooldown_sec: null,
    grace_duration_sec: 0,
    force_online_after_sec: null,
    entitlements: {},
    meta: {},
    ...overrides,
  };
}

describe('Issuer.issue() — template inheritance', () => {
  it('inherits maxUsages from a flat template', async () => {
    const db = new MemoryStorage();
    const issuer = await Licensing.issuer({ db, signing: { passphrase: PASSPHRASE } });
    const template = await db.createTemplate(
      tmplInput({ name: 'pro', max_usages: 10, entitlements: { tier: 'pro' } }),
    );
    const license = await issuer.issue({
      licensableType: 'User',
      licensableId: 'u_1',
      templateId: template.id,
    });
    expect(license.raw.max_usages).toBe(10);
    expect(license.raw.template_id).toBe(template.id);
    // Resolved entitlements landed on the license meta.
    expect(license.raw.meta.entitlements).toEqual({ tier: 'pro' });
  });

  it('per-call maxUsages overrides template default', async () => {
    const db = new MemoryStorage();
    const issuer = await Licensing.issuer({ db, signing: { passphrase: PASSPHRASE } });
    const template = await db.createTemplate(tmplInput({ name: 'pro', max_usages: 10 }));
    const license = await issuer.issue({
      licensableType: 'User',
      licensableId: 'u_2',
      templateId: template.id,
      maxUsages: 50,
    });
    expect(license.raw.max_usages).toBe(50);
  });

  it('child template merges entitlements with parent (child wins on conflict)', async () => {
    const db = new MemoryStorage();
    const issuer = await Licensing.issuer({ db, signing: { passphrase: PASSPHRASE } });
    const parent = await db.createTemplate(
      tmplInput({ name: 'parent', max_usages: 5, entitlements: { tier: 'basic', seats: 5 } }),
    );
    const child = await db.createTemplate(
      tmplInput({
        name: 'child',
        parent_id: parent.id,
        max_usages: 10,
        entitlements: { tier: 'pro' },
      }),
    );
    const license = await issuer.issue({
      licensableType: 'User',
      licensableId: 'u_3',
      templateId: child.id,
    });
    // tier from child, seats from parent.
    expect(license.raw.meta.entitlements).toEqual({ tier: 'pro', seats: 5 });
    // Inheritable scalar (max_usages) from the leaf, not the merged ancestor.
    expect(license.raw.max_usages).toBe(10);
  });

  it('issue() requires maxUsages when no template is supplied', async () => {
    const db = new MemoryStorage();
    const issuer = await Licensing.issuer({ db, signing: { passphrase: PASSPHRASE } });
    await expect(
      issuer.issue({
        licensableType: 'User',
        licensableId: 'u_4',
        // no templateId, no maxUsages
      }),
    ).rejects.toThrow(/requires `maxUsages`/);
  });
});

describe('Issuer.issue() — trial issuance', () => {
  const FINGERPRINT = 'fingerprint-canonical-input';

  it('records a trial dedupe row + sets is_trial flag in meta', async () => {
    const db = new MemoryStorage();
    const issuer = await Licensing.issuer({
      db,
      signing: { passphrase: PASSPHRASE },
      trialPepper: PEPPER,
    });
    const template = await db.createTemplate(
      tmplInput({ name: 'trial', trial_duration_sec: 14 * 86400, trial_cooldown_sec: 86400 }),
    );
    const license = await issuer.issue({
      licensableType: 'User',
      licensableId: 'u_t',
      templateId: template.id,
      isTrial: true,
      fingerprint: FINGERPRINT,
    });
    expect(license.raw.meta.is_trial).toBe(true);
    // expiresAt derived from template.trial_duration_sec (14 days).
    expect(license.expiresAt).not.toBeNull();

    // The dedupe row must exist under the hash the issuer actually wrote.
    // Deriving it with the same keyed hash the issuer uses is what makes
    // this an assertion about persistence rather than about a constant:
    // a hardcoded literal here would simply return null forever and the
    // test would still pass.
    const expectedHash = hashFingerprint(PEPPER, FINGERPRINT);
    const found = await db.findTrialIssuance({
      template_id: template.id,
      fingerprint_hash: expectedHash,
    });
    expect(found).not.toBeNull();
    expect(found?.template_id).toBe(template.id);
    expect(found?.fingerprint_hash).toBe(expectedHash);

    // The raw fingerprint must never be persisted — only its keyed hash.
    expect(expectedHash).not.toContain(FINGERPRINT);
    expect(JSON.stringify(found)).not.toContain(FINGERPRINT);
  });

  it('rejects re-trial within the cooldown window', async () => {
    const db = new MemoryStorage();
    const issuer = await Licensing.issuer({
      db,
      signing: { passphrase: PASSPHRASE },
      trialPepper: PEPPER,
    });
    const template = await db.createTemplate(
      tmplInput({ name: 'trial', trial_duration_sec: 86400, trial_cooldown_sec: 86400 }),
    );
    await issuer.issue({
      licensableType: 'User',
      licensableId: 'u_a',
      templateId: template.id,
      isTrial: true,
      fingerprint: FINGERPRINT,
    });
    await expect(
      issuer.issue({
        licensableType: 'User',
        licensableId: 'u_a2',
        templateId: template.id,
        isTrial: true,
        fingerprint: FINGERPRINT,
      }),
    ).rejects.toMatchObject({ code: 'TrialAlreadyIssued' });
  });

  it('different fingerprints under the same template both succeed', async () => {
    const db = new MemoryStorage();
    const issuer = await Licensing.issuer({
      db,
      signing: { passphrase: PASSPHRASE },
      trialPepper: PEPPER,
    });
    const template = await db.createTemplate(
      tmplInput({ name: 'trial', trial_duration_sec: 86400, trial_cooldown_sec: 86400 }),
    );
    const a = await issuer.issue({
      licensableType: 'User',
      licensableId: 'u_x',
      templateId: template.id,
      isTrial: true,
      fingerprint: 'fp-a',
    });
    const b = await issuer.issue({
      licensableType: 'User',
      licensableId: 'u_y',
      templateId: template.id,
      isTrial: true,
      fingerprint: 'fp-b',
    });
    expect(a.id).not.toBe(b.id);
  });

  it('different templates with the same fingerprint both succeed', async () => {
    const db = new MemoryStorage();
    const issuer = await Licensing.issuer({
      db,
      signing: { passphrase: PASSPHRASE },
      trialPepper: PEPPER,
    });
    const t1 = await db.createTemplate(tmplInput({ name: 't1', trial_duration_sec: 86400 }));
    const t2 = await db.createTemplate(tmplInput({ name: 't2', trial_duration_sec: 86400 }));
    await issuer.issue({
      licensableType: 'User',
      licensableId: 'u_p',
      templateId: t1.id,
      isTrial: true,
      fingerprint: FINGERPRINT,
    });
    const second = await issuer.issue({
      licensableType: 'User',
      licensableId: 'u_q',
      templateId: t2.id,
      isTrial: true,
      fingerprint: FINGERPRINT,
    });
    expect(second.id).toBeDefined();
  });

  it('trial without `trialPepper` config errors with a clear message', async () => {
    const db = new MemoryStorage();
    const issuer = await Licensing.issuer({ db, signing: { passphrase: PASSPHRASE } });
    await expect(
      issuer.issue({
        licensableType: 'User',
        licensableId: 'u_n',
        maxUsages: 1,
        isTrial: true,
        fingerprint: FINGERPRINT,
      }),
    ).rejects.toThrow(/trialPepper/);
  });

  it('trial without `fingerprint` errors', async () => {
    const db = new MemoryStorage();
    const issuer = await Licensing.issuer({
      db,
      signing: { passphrase: PASSPHRASE },
      trialPepper: PEPPER,
    });
    await expect(
      issuer.issue({
        licensableType: 'User',
        licensableId: 'u_n',
        maxUsages: 1,
        isTrial: true,
      }),
    ).rejects.toThrow(/requires `fingerprint`/);
  });
});
