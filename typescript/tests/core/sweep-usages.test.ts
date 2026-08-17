/**
 * Inactivity sweep — seat reclamation.
 *
 * Covers, across every backend:
 *   - A newly registered seat inherits `last_seen_at` from `registered_at`,
 *     so inactivity is measurable without a "never reported" special case.
 *   - A dry run reports stale seats without mutating anything.
 *   - A live sweep revokes only seats past the threshold.
 *   - The sweep emits the same `usage.revoked` audit row as an admin
 *     revoke, so a swept history is not differently shaped.
 *   - A non-positive window is rejected rather than revoking every seat.
 *
 * Mirrors Go's TestSweepInactiveUsages.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '@anorebel/licensing/storage/memory';
import { SqliteStorage } from '@anorebel/licensing/storage/sqlite';
import { applyMigrations as applySqliteMigrations } from '@anorebel/licensing/storage/sqlite/migrations';

import { createFixedClock } from '../../src/id.ts';
import { createLicense } from '../../src/license-service.ts';
import type { Storage } from '../../src/storage/types.ts';
import { registerUsage, sweepInactiveUsages } from '../../src/usage-service.ts';

const NOW = '2026-06-01T00:00:00.000000Z';
const DAY_SEC = 24 * 60 * 60;

const FP_FRESH = 'a'.repeat(64);
const FP_STALE = 'b'.repeat(64);

interface Backend {
  readonly name: string;
  readonly make: () => Promise<{ s: Storage; cleanup: () => void }>;
}

const BACKENDS: readonly Backend[] = [
  {
    name: 'memory',
    make: async () => ({
      s: new MemoryStorage({ clock: createFixedClock(NOW) }),
      cleanup: () => undefined,
    }),
  },
  {
    name: 'sqlite',
    make: async () => {
      const db = new Database(':memory:');
      applySqliteMigrations(db);
      return {
        s: new SqliteStorage(db, { clock: createFixedClock(NOW), skipWalPragma: true }),
        cleanup: () => db.close(),
      };
    },
  },
];

for (const backend of BACKENDS) {
  describe(`sweepInactiveUsages (${backend.name})`, () => {
    it('revokes only seats past the inactivity window', async () => {
      const { s, cleanup } = await backend.make();
      try {
        const clock = createFixedClock(NOW);
        const license = await createLicense(s, clock, {
          scope_id: null,
          template_id: null,
          licensable_type: 'User',
          licensable_id: 'u-sweep',
          max_usages: 5,
        });

        // Registration stamps last_seen_at from the registering clock, so
        // each seat is aged by registering it under a different instant.
        const fresh = await registerUsage(s, createFixedClock('2026-05-31T23:00:00.000000Z'), {
          license_id: license.id,
          fingerprint: FP_FRESH,
        });
        const stale = await registerUsage(s, createFixedClock('2026-04-01T00:00:00.000000Z'), {
          license_id: license.id,
          fingerprint: FP_STALE,
        });

        const freshUsage = await s.getUsage(fresh.usage.id);
        expect(freshUsage?.last_seen_at).toBe('2026-05-31T23:00:00.000000Z');

        // Dry run reports without mutating.
        const dry = await sweepInactiveUsages(s, clock, {
          inactiveForSec: 30 * DAY_SEC,
          dryRun: true,
        });
        expect(dry.stale).toEqual([stale.usage.id]);
        expect(dry.revoked).toEqual([]);
        expect((await s.getUsage(stale.usage.id))?.status).toBe('active');

        // Live run revokes only the stale seat.
        const res = await sweepInactiveUsages(s, clock, { inactiveForSec: 30 * DAY_SEC });
        expect(res.revoked).toEqual([stale.usage.id]);
        expect((await s.getUsage(stale.usage.id))?.status).toBe('revoked');
        expect((await s.getUsage(fresh.usage.id))?.status).toBe('active');

        // The sweep must leave the same trail as an admin revoke.
        // NOTE: the TS filter field is `event` (string | string[]); Go's is
        // `Events`. Passing `events` here would be silently ignored as an
        // unknown property and assert nothing.
        const audit = await s.listAudit({ event: 'usage.revoked' }, { limit: 10 });
        expect(audit.items).toHaveLength(1);
      } finally {
        cleanup();
      }
    });

    it('rejects a non-positive window instead of revoking everything', async () => {
      const { s, cleanup } = await backend.make();
      try {
        await expect(
          sweepInactiveUsages(s, createFixedClock(NOW), { inactiveForSec: 0 }),
        ).rejects.toThrow(/positive inactiveForSec/);
      } finally {
        cleanup();
      }
    });
  });
}
