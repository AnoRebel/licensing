/**
 * Smoke coverage for the SQLite adapter's CRUD + uniqueness + transaction
 * semantics. Parallel to `storage-memory/tests/basic.test.ts` — the same
 * scenarios, same assertions, against an in-memory SQLite DB with the
 * migration freshly applied. The three scenario-driven tests
 * (schema-parity, immutability, cursor-pagination) each live in their own
 * file so a failure points at the failing scenario directly.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { SqliteStorage } from '../../src/storage/sqlite/index.ts';
import { applyMigrations } from '../../src/storage/sqlite/migrations.ts';

function fresh(): { db: Database; s: SqliteStorage } {
  const db = new Database(':memory:');
  applyMigrations(db);
  const s = new SqliteStorage(db, { skipWalPragma: true });
  return { db, s };
}

function sampleLicenseInput(
  overrides: Partial<Parameters<SqliteStorage['createLicense']>[0]> = {},
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

describe('SqliteStorage — CRUD', () => {
  it('creates and round-trips a license', async () => {
    const { s, db } = fresh();
    const created = await s.createLicense(sampleLicenseInput());
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.license_key).toBe('LIC-AAAA-BBBB-CCCC-DDDD');
    expect(created.meta).toEqual({});
    const fetched = await s.getLicense(created.id);
    expect(fetched).toEqual(created);
    const byKey = await s.getLicenseByKey('LIC-AAAA-BBBB-CCCC-DDDD');
    expect(byKey).toEqual(created);
    db.close();
  });

  it('round-trips non-trivial JSON meta', async () => {
    const { s, db } = fresh();
    const meta = { nested: { k: [1, 2, 3] }, s: 'hi', n: 42, b: true, nil: null };
    const created = await s.createLicense(sampleLicenseInput({ meta }));
    expect(created.meta).toEqual(meta);
    const fetched = await s.getLicense(created.id);
    expect(fetched?.meta).toEqual(meta);
    db.close();
  });

  it('updates preserve id + created_at, bump updated_at', async () => {
    const { s, db } = fresh();
    const created = await s.createLicense(sampleLicenseInput());
    await new Promise((r) => setTimeout(r, 2));
    const updated = await s.updateLicense(created.id, { status: 'suspended' });
    expect(updated.id).toBe(created.id);
    expect(updated.created_at).toBe(created.created_at);
    expect(updated.updated_at >= created.updated_at).toBe(true);
    expect(updated.status).toBe('suspended');
    db.close();
  });

  it('rejects missing license by id on update', async () => {
    const { s, db } = fresh();
    await expect(
      s.updateLicense('00000000-0000-7000-8000-000000000000', { status: 'active' }),
    ).rejects.toMatchObject({ code: 'LicenseNotFound' });
    db.close();
  });
});

describe('SqliteStorage — Uniqueness', () => {
  it('rejects duplicate license_key with LicenseKeyConflict', async () => {
    const { s, db } = fresh();
    await s.createLicense(sampleLicenseInput());
    await expect(
      s.createLicense(sampleLicenseInput({ licensable_id: 'user-2' })),
    ).rejects.toMatchObject({ code: 'LicenseKeyConflict' });
    db.close();
  });

  it('rejects duplicate (licensable_type, licensable_id, scope_id) triple', async () => {
    const { s, db } = fresh();
    await s.createLicense(sampleLicenseInput());
    await expect(
      s.createLicense(sampleLicenseInput({ license_key: 'LIC-EEEE-FFFF-GGGG-HHHH' })),
    ).rejects.toMatchObject({ code: 'UniqueConstraintViolation' });
    db.close();
  });

  it('allows same licensable across different scopes', async () => {
    const { s, db } = fresh();
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
    db.close();
  });

  it('enforces partial unique on active usages', async () => {
    const { s, db } = fresh();
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
    db.close();
  });

  it('allows re-register on same fingerprint after revocation', async () => {
    const { s, db } = fresh();
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
    db.close();
  });

  it('enforces one-active-signing-key-per-scope', async () => {
    const { s, db } = fresh();
    const scope = await s.createScope({ slug: 'a', name: 'A', meta: {} });
    const now = new Date().toISOString();
    await s.createKey({
      scope_id: scope.id,
      kid: 'k1',
      alg: 'ed25519',
      role: 'signing',
      state: 'active',
      public_pem: 'pem',
      private_pem_enc: null,
      rotated_from: null,
      rotated_at: null,
      not_before: now,
      not_after: null,
      meta: {},
    });
    await expect(
      s.createKey({
        scope_id: scope.id,
        kid: 'k2',
        alg: 'ed25519',
        role: 'signing',
        state: 'active',
        public_pem: 'pem2',
        private_pem_enc: null,
        rotated_from: null,
        rotated_at: null,
        not_before: now,
        not_after: null,
        meta: {},
      }),
    ).rejects.toMatchObject({ code: 'UniqueConstraintViolation' });
    db.close();
  });
});

describe('SqliteStorage — Transactions', () => {
  it('commits on successful return', async () => {
    const { s, db } = fresh();
    const lic = await s.withTransaction(async (tx) => {
      return tx.createLicense(sampleLicenseInput());
    });
    expect(await s.getLicense(lic.id)).toEqual(lic);
    db.close();
  });

  it('rolls back every write on a thrown error', async () => {
    const { s, db } = fresh();
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
    db.close();
  });

  it('rejects nested withTransaction', async () => {
    const { s, db } = fresh();
    await expect(
      s.withTransaction(async (tx) => {
        await (tx as unknown as SqliteStorage).withTransaction(async () => undefined);
      }),
    ).rejects.toThrow(/nested/);
    db.close();
  });
});

describe('SqliteStorage — Migrations', () => {
  it('is idempotent (running twice is a no-op)', () => {
    const db = new Database(':memory:');
    const first = applyMigrations(db);
    expect(first.length).toBeGreaterThan(0);
    const second = applyMigrations(db);
    expect(second).toEqual([]);
    db.close();
  });
});
