/**
 * License-key rotation — leak response.
 *
 * Rotation replaces the license_key AND revokes every active seat. Both
 * halves matter: a rotation that left existing devices running would not
 * contain a leaked key, which is its only purpose.
 *
 * Mirrors Go's TestRotateLicenseKey_* in licensing/rotate_key_test.go.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '@anorebel/licensing/storage/memory';
import { SqliteStorage } from '@anorebel/licensing/storage/sqlite';
import { applyMigrations as applySqliteMigrations } from '@anorebel/licensing/storage/sqlite/migrations';

import { createFixedClock } from '../../src/id.ts';
import { generateLicenseKey } from '../../src/license-key.ts';
import { createLicense, rotateLicenseKey } from '../../src/license-service.ts';
import { revoke } from '../../src/lifecycle.ts';
import type { Storage } from '../../src/storage/types.ts';
import { registerUsage } from '../../src/usage-service.ts';

const NOW = '2026-06-01T00:00:00.000000Z';
const clock = createFixedClock(NOW);

interface Backend {
  readonly name: string;
  readonly make: () => Promise<{ s: Storage; cleanup: () => void }>;
}

const BACKENDS: readonly Backend[] = [
  {
    name: 'memory',
    make: async () => ({ s: new MemoryStorage({ clock }), cleanup: () => undefined }),
  },
  {
    name: 'sqlite',
    make: async () => {
      const db = new Database(':memory:');
      applySqliteMigrations(db);
      return {
        s: new SqliteStorage(db, { clock, skipWalPragma: true }),
        cleanup: () => db.close(),
      };
    },
  },
];

async function newLicense(s: Storage) {
  return createLicense(
    s,
    clock,
    {
      scope_id: null,
      template_id: null,
      licensable_type: 'User',
      licensable_id: 'rot-1',
      license_key: generateLicenseKey(),
      max_usages: 5,
    },
    {},
  );
}

for (const backend of BACKENDS) {
  describe(`rotateLicenseKey (${backend.name})`, () => {
    it('replaces the key and revokes every seat', async () => {
      const { s, cleanup } = await backend.make();
      try {
        const license = await newLicense(s);
        const oldKey = license.license_key;

        for (const prefix of ['a', 'b']) {
          await registerUsage(s, clock, {
            license_id: license.id,
            fingerprint: `${prefix}1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2`,
          });
        }

        const res = await rotateLicenseKey(s, clock, license.id, {
          actor: 'admin:rotate-key',
          actorKind: 'admin',
        });

        expect(res.license.license_key).not.toBe(oldKey);
        expect(res.revokedUsageIds).toHaveLength(2);

        // The old key must stop resolving; the new one must start.
        expect(await s.getLicenseByKey(oldKey)).toBeNull();
        expect(await s.getLicenseByKey(res.license.license_key)).not.toBeNull();

        // No live seats remain, so every device must re-activate.
        const page = await s.listUsages(
          { license_id: license.id, status: ['active'] },
          { limit: 10 },
        );
        expect(page.items).toHaveLength(0);
      } finally {
        cleanup();
      }
    });

    it('records the rotation without writing either key to the audit log', async () => {
      const { s, cleanup } = await backend.make();
      try {
        const license = await newLicense(s);
        const oldKey = license.license_key;

        const res = await rotateLicenseKey(s, clock, license.id, {
          actor: 'admin:rotate-key',
          actorKind: 'admin',
        });

        const audit = await s.listAudit({ event: 'license.key_rotated' }, { limit: 10 });
        expect(audit.items).toHaveLength(1);
        expect(audit.items[0]?.actor_kind).toBe('admin');

        // An append-only log that support staff can read must not carry the
        // secret the rotation exists to protect.
        const serialised = JSON.stringify([audit.items[0]?.prior_state, audit.items[0]?.new_state]);
        expect(serialised).not.toContain(oldKey);
        expect(serialised).not.toContain(res.license.license_key);
      } finally {
        cleanup();
      }
    });

    it('refuses to rotate a revoked license', async () => {
      const { s, cleanup } = await backend.make();
      try {
        const license = await newLicense(s);
        await s.withTransaction(async (tx) => {
          const cur = await tx.getLicense(license.id);
          if (cur !== null) await revoke(tx, cur, clock, {});
        });

        // Revoked is terminal; a new key would imply it could still be used.
        await expect(rotateLicenseKey(s, clock, license.id, {})).rejects.toMatchObject({
          code: 'LicenseRevoked',
        });
      } finally {
        cleanup();
      }
    });
  });
}
