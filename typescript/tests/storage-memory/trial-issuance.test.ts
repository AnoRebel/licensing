/**
 * TrialIssuance CRUD on the memory adapter.
 *
 * Covers the storage contract: record, find, delete, NULLS-NOT-DISTINCT
 * uniqueness on (template_id, fingerprint_hash). Cooldown enforcement
 * lives one layer up (issuer-side) and is tested separately.
 */

import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../src/storage/memory/index.ts';
import type { UUIDv7 } from '../../src/types.ts';

const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);

async function freshTemplate(s: MemoryStorage, name: string): Promise<UUIDv7> {
  const tmpl = await s.createTemplate({
    scope_id: null,
    parent_id: null,
    name,
    max_usages: 5,
    trial_duration_sec: 86400,
    trial_cooldown_sec: 86400 * 7,
    grace_duration_sec: 0,
    force_online_after_sec: null,
    entitlements: {},
    meta: {},
  });
  return tmpl.id;
}

describe('memory adapter — TrialIssuance', () => {
  it('records a trial issuance and finds it back', async () => {
    const s = new MemoryStorage();
    const tmpl = await freshTemplate(s, 't1');
    const recorded = await s.recordTrialIssuance({ template_id: tmpl, fingerprint_hash: FP_A });
    expect(recorded.template_id).toBe(tmpl);
    expect(recorded.fingerprint_hash).toBe(FP_A);
    const found = await s.findTrialIssuance({ template_id: tmpl, fingerprint_hash: FP_A });
    expect(found?.id).toBe(recorded.id);
  });

  it('rejects duplicate (template_id, fingerprint_hash) with UniqueConstraintViolation', async () => {
    const s = new MemoryStorage();
    const tmpl = await freshTemplate(s, 't1');
    await s.recordTrialIssuance({ template_id: tmpl, fingerprint_hash: FP_A });
    await expect(
      s.recordTrialIssuance({ template_id: tmpl, fingerprint_hash: FP_A }),
    ).rejects.toMatchObject({ code: 'UniqueConstraintViolation' });
  });

  it('treats NULL template_id as its own group (NULLS-NOT-DISTINCT)', async () => {
    const s = new MemoryStorage();
    await s.recordTrialIssuance({ template_id: null, fingerprint_hash: FP_A });
    await expect(
      s.recordTrialIssuance({ template_id: null, fingerprint_hash: FP_A }),
    ).rejects.toMatchObject({ code: 'UniqueConstraintViolation' });
    // But a different fingerprint with NULL template is allowed.
    const ok = await s.recordTrialIssuance({ template_id: null, fingerprint_hash: FP_B });
    expect(ok.template_id).toBeNull();
  });

  it('different templates can hold the same fingerprint', async () => {
    const s = new MemoryStorage();
    const t1 = await freshTemplate(s, 't1');
    const t2 = await freshTemplate(s, 't2');
    await s.recordTrialIssuance({ template_id: t1, fingerprint_hash: FP_A });
    const second = await s.recordTrialIssuance({ template_id: t2, fingerprint_hash: FP_A });
    expect(second.template_id).toBe(t2);
  });

  it('findTrialIssuance returns null when no row matches', async () => {
    const s = new MemoryStorage();
    const got = await s.findTrialIssuance({ template_id: null, fingerprint_hash: FP_A });
    expect(got).toBeNull();
  });

  it('deleteTrialIssuance frees the (template, fingerprint) pair for reuse', async () => {
    const s = new MemoryStorage();
    const tmpl = await freshTemplate(s, 't1');
    const first = await s.recordTrialIssuance({ template_id: tmpl, fingerprint_hash: FP_A });
    await s.deleteTrialIssuance(first.id);
    // After delete, a new issuance for the same pair must succeed.
    const second = await s.recordTrialIssuance({ template_id: tmpl, fingerprint_hash: FP_A });
    expect(second.id).not.toBe(first.id);
  });
});
