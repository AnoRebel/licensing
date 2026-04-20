/**
 * createLicense orchestrator.
 *
 * Covers creating a license and rejecting duplicate license keys:
 *   - Auto key generation when `license_key` is omitted.
 *   - Default status of `pending`.
 *   - Case-insensitive explicit-key input normalizes before insert.
 *   - Duplicate key raises `LicenseKeyConflict` (from adapter, surfaced here).
 *   - `license.created` audit row written atomically with the row insert.
 */

import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '@licensing/sdk/storage/memory';

import {
  createAdvancingClock,
  createLicense,
  findLicenseByKey,
  LICENSE_KEY_REGEX,
} from '../../src/index.ts';

function newStorage() {
  const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
  const s = new MemoryStorage({ clock });
  return { s, clock };
}

describe('createLicense', () => {
  it('auto-generates a compliant license key when none is passed', async () => {
    const { s, clock } = newStorage();
    const lic = await createLicense(s, clock, {
      scope_id: null,
      template_id: null,
      licensable_type: 'User',
      licensable_id: 'user-1',
      max_usages: 5,
    });
    expect(lic.license_key).toMatch(LICENSE_KEY_REGEX);
    expect(lic.status).toBe('pending');
    expect(lic.activated_at).toBeNull();
  });

  it('normalizes an explicitly-provided key to uppercase', async () => {
    const { s, clock } = newStorage();
    const lic = await createLicense(s, clock, {
      scope_id: null,
      template_id: null,
      licensable_type: 'User',
      licensable_id: 'user-1',
      license_key: 'lic-aaaa-bbbb-cccc-dddd-eeee',
      max_usages: 5,
    });
    expect(lic.license_key).toBe('LIC-AAAA-BBBB-CCCC-DDDD-EEEE');
  });

  it('rejects malformed explicit keys with InvalidLicenseKey', async () => {
    const { s, clock } = newStorage();
    await expect(
      createLicense(s, clock, {
        scope_id: null,
        template_id: null,
        licensable_type: 'User',
        licensable_id: 'user-1',
        license_key: 'not-a-license-key',
        max_usages: 5,
      }),
    ).rejects.toMatchObject({ code: 'InvalidLicenseKey' });
  });

  it('surfaces LicenseKeyConflict when the key already exists', async () => {
    const { s, clock } = newStorage();
    const key = 'LIC-AAAA-BBBB-CCCC-DDDD-EEEE';
    await createLicense(s, clock, {
      scope_id: null,
      template_id: null,
      licensable_type: 'User',
      licensable_id: 'user-1',
      license_key: key,
      max_usages: 5,
    });
    await expect(
      createLicense(s, clock, {
        scope_id: null,
        template_id: null,
        licensable_type: 'User',
        licensable_id: 'user-2',
        license_key: key,
        max_usages: 5,
      }),
    ).rejects.toMatchObject({ code: 'LicenseKeyConflict' });
  });

  it('writes a license.created audit row atomically with the insert', async () => {
    const { s, clock } = newStorage();
    const lic = await createLicense(s, clock, {
      scope_id: null,
      template_id: null,
      licensable_type: 'User',
      licensable_id: 'user-1',
      max_usages: 5,
    });
    const audit = await s.listAudit({ license_id: lic.id }, { limit: 10 });
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]?.event).toBe('license.created');
    expect(audit.items[0]?.new_state).toMatchObject({
      status: 'pending',
      license_key: lic.license_key,
      max_usages: 5,
    });
  });

  it('tags the audit row with the supplied actor', async () => {
    const { s, clock } = newStorage();
    const lic = await createLicense(
      s,
      clock,
      {
        scope_id: null,
        template_id: null,
        licensable_type: 'User',
        licensable_id: 'user-1',
        max_usages: 5,
      },
      { actor: 'admin@example.com' },
    );
    const audit = await s.listAudit({ license_id: lic.id }, { limit: 10 });
    expect(audit.items[0]?.actor).toBe('admin@example.com');
  });
});

describe('findLicenseByKey', () => {
  it('finds a license by its exact stored key', async () => {
    const { s, clock } = newStorage();
    const lic = await createLicense(s, clock, {
      scope_id: null,
      template_id: null,
      licensable_type: 'User',
      licensable_id: 'u-1',
      max_usages: 1,
    });
    const found = await findLicenseByKey(s, lic.license_key);
    expect(found?.id).toBe(lic.id);
  });

  it('is case-insensitive: accepts mixed-case and lowercase input', async () => {
    const { s, clock } = newStorage();
    const lic = await createLicense(s, clock, {
      scope_id: null,
      template_id: null,
      licensable_type: 'User',
      licensable_id: 'u-2',
      max_usages: 1,
    });
    const lower = lic.license_key.toLowerCase();
    const mixed = lic.license_key
      .split('')
      .map((c, i) => (i % 2 === 0 ? c.toLowerCase() : c))
      .join('');
    expect((await findLicenseByKey(s, lower))?.id).toBe(lic.id);
    expect((await findLicenseByKey(s, mixed))?.id).toBe(lic.id);
  });

  it('trims surrounding whitespace', async () => {
    const { s, clock } = newStorage();
    const lic = await createLicense(s, clock, {
      scope_id: null,
      template_id: null,
      licensable_type: 'User',
      licensable_id: 'u-3',
      max_usages: 1,
    });
    const padded = `  ${lic.license_key}\n`;
    const found = await findLicenseByKey(s, padded);
    expect(found?.id).toBe(lic.id);
  });

  it('returns null for malformed input (I/L/O/U present, bad shape)', async () => {
    const { s, clock } = newStorage();
    await createLicense(s, clock, {
      scope_id: null,
      template_id: null,
      licensable_type: 'User',
      licensable_id: 'u-4',
      max_usages: 1,
    });
    // Disallowed Crockford letters.
    expect(await findLicenseByKey(s, 'LIC-IIII-IIII-IIII-IIII-IIII')).toBeNull();
    // Missing prefix.
    expect(await findLicenseByKey(s, 'AAAA-BBBB-CCCC-DDDD-EEEE')).toBeNull();
    // Too few groups.
    expect(await findLicenseByKey(s, 'LIC-AAAA-BBBB')).toBeNull();
  });

  it('returns null when key is well-formed but unknown', async () => {
    const { s } = newStorage();
    const unknown = 'LIC-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ';
    expect(await findLicenseByKey(s, unknown)).toBeNull();
  });
});
