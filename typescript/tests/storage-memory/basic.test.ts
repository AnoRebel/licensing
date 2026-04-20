/**
 * Smoke coverage for the memory adapter's CRUD + uniqueness + transaction
 * semantics. The three scenario-driven tests (schema-parity, immutability,
 * cursor-pagination) each live in their own file so a failure message
 * points at the failing scenario directly.
 */

import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../src/storage/memory/index.ts';

function sampleLicenseInput(
  overrides: Partial<Parameters<MemoryStorage['createLicense']>[0]> = {},
) {
  return {
    scope_id: null,
    template_id: null,
    licensable_type: 'User',
    licensable_id: 'user-1',
    license_key: 'LIC-AAAA-BBBB-CCCC-DDDD',
    status: 'active' as const,
    max_usages: 5,
    activated_at: null,
    expires_at: null,
    grace_until: null,
    meta: {},
    ...overrides,
  };
}

describe('MemoryStorage — CRUD', () => {
  it('creates and round-trips a license', async () => {
    const s = new MemoryStorage();
    const created = await s.createLicense(sampleLicenseInput());
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.license_key).toBe('LIC-AAAA-BBBB-CCCC-DDDD');
    const fetched = await s.getLicense(created.id);
    expect(fetched).toEqual(created);
    const byKey = await s.getLicenseByKey('LIC-AAAA-BBBB-CCCC-DDDD');
    expect(byKey).toEqual(created);
  });

  it('updates preserve id + created_at, bump updated_at', async () => {
    const s = new MemoryStorage();
    const created = await s.createLicense(sampleLicenseInput());
    // Bun's isoFromMs only has ms resolution plus `000` microseconds —
    // force distinct updated_at by waiting 2ms.
    await new Promise((r) => setTimeout(r, 2));
    const updated = await s.updateLicense(created.id, { status: 'suspended' });
    expect(updated.id).toBe(created.id);
    expect(updated.created_at).toBe(created.created_at);
    expect(updated.updated_at >= created.updated_at).toBe(true);
    expect(updated.status).toBe('suspended');
  });

  it('rejects missing license by id on update', async () => {
    const s = new MemoryStorage();
    await expect(
      s.updateLicense('00000000-0000-7000-8000-000000000000', { status: 'active' }),
    ).rejects.toMatchObject({ code: 'LicenseNotFound' });
  });
});

describe('MemoryStorage — Uniqueness', () => {
  it('rejects duplicate license_key with LicenseKeyConflict', async () => {
    const s = new MemoryStorage();
    await s.createLicense(sampleLicenseInput());
    await expect(
      s.createLicense(sampleLicenseInput({ licensable_id: 'user-2' })),
    ).rejects.toMatchObject({ code: 'LicenseKeyConflict' });
  });

  it('rejects duplicate (licensable_type, licensable_id, scope_id) triple', async () => {
    const s = new MemoryStorage();
    await s.createLicense(sampleLicenseInput());
    await expect(
      s.createLicense(sampleLicenseInput({ license_key: 'LIC-EEEE-FFFF-GGGG-HHHH' })),
    ).rejects.toMatchObject({ code: 'UniqueConstraintViolation' });
  });

  it('allows same licensable across different scopes', async () => {
    const s = new MemoryStorage();
    const scopeA = await s.createScope({ slug: 'scope-a', name: 'A', meta: {} });
    const scopeB = await s.createScope({ slug: 'scope-b', name: 'B', meta: {} });
    await s.createLicense(sampleLicenseInput({ scope_id: scopeA.id }));
    const b = await s.createLicense(
      sampleLicenseInput({
        scope_id: scopeB.id,
        license_key: 'LIC-EEEE-FFFF-GGGG-HHHH',
      }),
    );
    expect(b.scope_id).toBe(scopeB.id);
  });

  it('enforces partial unique on active usages', async () => {
    const s = new MemoryStorage();
    const lic = await s.createLicense(sampleLicenseInput());
    const fp = 'a'.repeat(64);
    await s.createUsage({
      license_id: lic.id,
      fingerprint: fp,
      status: 'active',
      registered_at: new Date().toISOString(),
      revoked_at: null,
      client_meta: {},
    });
    await expect(
      s.createUsage({
        license_id: lic.id,
        fingerprint: fp,
        status: 'active',
        registered_at: new Date().toISOString(),
        revoked_at: null,
        client_meta: {},
      }),
    ).rejects.toMatchObject({ code: 'UniqueConstraintViolation' });
  });

  it('allows re-register on same fingerprint after revocation', async () => {
    const s = new MemoryStorage();
    const lic = await s.createLicense(sampleLicenseInput());
    const fp = 'b'.repeat(64);
    const first = await s.createUsage({
      license_id: lic.id,
      fingerprint: fp,
      status: 'active',
      registered_at: new Date().toISOString(),
      revoked_at: null,
      client_meta: {},
    });
    await s.updateUsage(first.id, {
      status: 'revoked',
      revoked_at: new Date().toISOString(),
    });
    const second = await s.createUsage({
      license_id: lic.id,
      fingerprint: fp,
      status: 'active',
      registered_at: new Date().toISOString(),
      revoked_at: null,
      client_meta: {},
    });
    expect(second.status).toBe('active');
    expect(second.id).not.toBe(first.id);
  });
});

describe('MemoryStorage — Transactions', () => {
  it('commits on successful return', async () => {
    const s = new MemoryStorage();
    const lic = await s.withTransaction(async (tx) => {
      return tx.createLicense(sampleLicenseInput());
    });
    expect(await s.getLicense(lic.id)).toEqual(lic);
  });

  it('rolls back every write on a thrown error', async () => {
    const s = new MemoryStorage();
    await expect(
      s.withTransaction(async (tx) => {
        await tx.createLicense(sampleLicenseInput());
        await tx.createLicense(sampleLicenseInput({ license_key: 'LIC-EEEE-FFFF-GGGG-HHHH' }));
        // Third insert collides on (licensable_type, licensable_id, scope_id).
        await tx.createLicense(sampleLicenseInput({ license_key: 'LIC-IIII-JJJJ-KKKK-LLLL' }));
      }),
    ).rejects.toMatchObject({ code: 'UniqueConstraintViolation' });
    const page = await s.listLicenses({}, { limit: 100 });
    expect(page.items).toHaveLength(0);
  });

  it('rejects nested withTransaction', async () => {
    const s = new MemoryStorage();
    await expect(
      s.withTransaction(async (tx) => {
        await (tx as unknown as MemoryStorage).withTransaction(async () => undefined);
      }),
    ).rejects.toThrow(/nested/);
  });
});
