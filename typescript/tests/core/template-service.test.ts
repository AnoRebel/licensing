/**
 * LicenseTemplate CRUD + createLicenseFromTemplate.
 *
 * Covers:
 *   - Creating a license from a template copies defaults onto the new row.
 *   - Caller overrides win over template defaults, field-by-field.
 *
 * Additional coverage:
 *   - Validation on creation (max_usages >= 1, durations >= 0).
 *   - Trial expiry computation from `trial_duration_sec`.
 *   - Grace expiry computation from `grace_duration_sec` relative to
 *     `expires_at`.
 *   - `expires_at: null` caller override short-circuits the trial computation.
 *   - Entitlements are snapshotted onto `license.meta.entitlements` at
 *     creation time (template edits afterward don't rewrite the license).
 *   - `force_online_after_sec` is mirrored into `license.meta`.
 *   - `template.created` audit row emitted atomically.
 *   - `license.created` audit row carries the `template_id`.
 *
 * Backend matrix matches `usage-service.test.ts`: memory, sqlite, and
 * postgres (opt-in via `LICENSING_PG_URL`).
 */

import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, it } from 'bun:test';

import { MemoryStorage } from '@anorebel/licensing/storage/memory';
import { PostgresStorage } from '@anorebel/licensing/storage/postgres';
import { applyMigrations as applyPgMigrations } from '@anorebel/licensing/storage/postgres/migrations';
import { SqliteStorage } from '@anorebel/licensing/storage/sqlite';
import { applyMigrations as applySqliteMigrations } from '@anorebel/licensing/storage/sqlite/migrations';
import { Pool } from 'pg';
import type { Clock } from '../../src/id.ts';
import {
  createAdvancingClock,
  createLicenseFromTemplate,
  createTemplate,
} from '../../src/index.ts';
import type { Storage } from '../../src/storage/index.ts';

type Backend = {
  name: string;
  make: () => Promise<{ s: Storage; clock: Clock; cleanup: () => Promise<void> }>;
};

const PG_URL = process.env.LICENSING_PG_URL;

let pgMaster: Pool | null = null;
function masterPool(): Pool {
  if (pgMaster === null) {
    pgMaster = new Pool({ connectionString: PG_URL });
  }
  return pgMaster;
}

async function makePgStorage(): Promise<{
  s: Storage;
  clock: Clock;
  cleanup: () => Promise<void>;
}> {
  const master = masterPool();
  const schema = `t_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
  await master.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: PG_URL, max: 6 });
  pool.on('connect', (c) => {
    c.query(`SET search_path TO "${schema}"`).catch(() => undefined);
  });
  await applyPgMigrations(pool);
  const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
  const s = new PostgresStorage(pool, { clock });
  return {
    s,
    clock,
    cleanup: async () => {
      await pool.end();
      await master.query(`DROP SCHEMA "${schema}" CASCADE`);
    },
  };
}

const BACKENDS: readonly Backend[] = [
  {
    name: 'memory',
    make: async () => {
      const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
      const s = new MemoryStorage({ clock });
      return { s, clock, cleanup: async () => undefined };
    },
  },
  {
    name: 'sqlite',
    make: async () => {
      const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
      const db = new Database(':memory:');
      applySqliteMigrations(db);
      const s = new SqliteStorage(db, { clock, skipWalPragma: true });
      return {
        s,
        clock,
        cleanup: async () => {
          db.close();
        },
      };
    },
  },
  ...(PG_URL ? [{ name: 'postgres', make: makePgStorage } satisfies Backend] : []),
];

afterAll(async () => {
  if (pgMaster !== null) {
    await pgMaster.end();
    pgMaster = null;
  }
});

describe('template-service', () => {
  for (const b of BACKENDS) {
    describe(b.name, () => {
      it('createTemplate persists + emits template.created audit', async () => {
        const { s, clock, cleanup } = await b.make();
        try {
          const tpl = await createTemplate(
            s,
            clock,
            {
              scope_id: null,
              name: 'standard',
              max_usages: 5,
              trial_duration_sec: 3600,
              grace_duration_sec: 600,
              force_online_after_sec: null,
              entitlements: { seats: 5 },
              meta: { tier: 'pro' },
            },
            { actor: 'admin-1' },
          );
          expect(tpl.name).toBe('standard');
          expect(tpl.max_usages).toBe(5);
          expect(tpl.entitlements).toEqual({ seats: 5 });

          const audit = await s.listAudit({}, { limit: 10 });
          const created = audit.items.find((r) => r.event === 'template.created');
          expect(created).toBeDefined();
          expect(created?.actor).toBe('admin-1');
          expect((created?.new_state as { template_id: string }).template_id).toBe(tpl.id);
        } finally {
          await cleanup();
        }
      });

      it('createTemplate rejects invalid durations and max_usages', async () => {
        const { s, clock, cleanup } = await b.make();
        try {
          await expect(
            createTemplate(s, clock, {
              scope_id: null,
              name: 'bad-max',
              max_usages: 0,
              trial_duration_sec: 0,
              grace_duration_sec: 0,
              force_online_after_sec: null,
            }),
          ).rejects.toThrow(/max_usages/);

          await expect(
            createTemplate(s, clock, {
              scope_id: null,
              name: 'bad-trial',
              max_usages: 1,
              trial_duration_sec: -1,
              grace_duration_sec: 0,
              force_online_after_sec: null,
            }),
          ).rejects.toThrow(/trial_duration_sec/);

          await expect(
            createTemplate(s, clock, {
              scope_id: null,
              name: 'bad-grace',
              max_usages: 1,
              trial_duration_sec: 0,
              grace_duration_sec: -1,
              force_online_after_sec: null,
            }),
          ).rejects.toThrow(/grace_duration_sec/);
        } finally {
          await cleanup();
        }
      });

      it('createLicenseFromTemplate copies template defaults onto the new license', async () => {
        const { s, clock, cleanup } = await b.make();
        try {
          const tpl = await createTemplate(s, clock, {
            scope_id: null,
            name: 'copy-defaults',
            max_usages: 3,
            trial_duration_sec: 7200, // 2h
            grace_duration_sec: 1800, // 30m
            force_online_after_sec: 86400,
            entitlements: { seats: 3, featureFlags: ['export'] },
          });
          const lic = await createLicenseFromTemplate(s, clock, {
            template_id: tpl.id,
            licensable_type: 'User',
            licensable_id: 'u-1',
          });
          expect(lic.template_id).toBe(tpl.id);
          expect(lic.scope_id).toBeNull();
          expect(lic.max_usages).toBe(3);
          expect(lic.expires_at).not.toBeNull();
          expect(lic.grace_until).not.toBeNull();
          // expires_at = now + 2h, grace_until = expires_at + 30m.
          // now is advancing (~µs per tick), so we just check the gaps.
          const expMs = Date.parse(lic.expires_at as string);
          const graceMs = Date.parse(lic.grace_until as string);
          expect(graceMs - expMs).toBe(1800 * 1000);

          // Entitlements + force_online snapshotted into meta.
          const meta = lic.meta as Record<string, unknown>;
          expect(meta.entitlements).toEqual({ seats: 3, featureFlags: ['export'] });
          expect(meta.force_online_after_sec).toBe(86400);

          // license.created audit row carries template_id.
          const audit = await s.listAudit({ license_id: lic.id }, { limit: 5 });
          const licAudit = audit.items.find((r) => r.event === 'license.created');
          expect(licAudit).toBeDefined();
          expect((licAudit?.new_state as { template_id?: string }).template_id).toBe(tpl.id);
        } finally {
          await cleanup();
        }
      });

      it('caller override wins over template defaults, field-by-field', async () => {
        const { s, clock, cleanup } = await b.make();
        try {
          const tpl = await createTemplate(s, clock, {
            scope_id: null,
            name: 'overrides',
            max_usages: 10,
            trial_duration_sec: 86400,
            grace_duration_sec: 3600,
            force_online_after_sec: null,
          });
          const lic = await createLicenseFromTemplate(s, clock, {
            template_id: tpl.id,
            licensable_type: 'User',
            licensable_id: 'u-2',
            max_usages: 2,
            expires_at: '2030-01-01T00:00:00.000000Z',
            grace_until: '2030-01-02T00:00:00.000000Z',
          });
          expect(lic.max_usages).toBe(2);
          expect(lic.expires_at).toBe('2030-01-01T00:00:00.000000Z');
          expect(lic.grace_until).toBe('2030-01-02T00:00:00.000000Z');
        } finally {
          await cleanup();
        }
      });

      it('explicit null expires_at short-circuits trial computation', async () => {
        const { s, clock, cleanup } = await b.make();
        try {
          const tpl = await createTemplate(s, clock, {
            scope_id: null,
            name: 'no-expiry-override',
            max_usages: 1,
            trial_duration_sec: 3600,
            grace_duration_sec: 600,
            force_online_after_sec: null,
          });
          const lic = await createLicenseFromTemplate(s, clock, {
            template_id: tpl.id,
            licensable_type: 'User',
            licensable_id: 'u-3',
            expires_at: null,
          });
          expect(lic.expires_at).toBeNull();
          // grace_until auto-computes but expires_at is null, so it must be null.
          expect(lic.grace_until).toBeNull();
        } finally {
          await cleanup();
        }
      });

      it('template with trial_duration_sec=0 produces a license with no expiry', async () => {
        const { s, clock, cleanup } = await b.make();
        try {
          const tpl = await createTemplate(s, clock, {
            scope_id: null,
            name: 'perpetual',
            max_usages: 1,
            trial_duration_sec: 0,
            grace_duration_sec: 0,
            force_online_after_sec: null,
          });
          const lic = await createLicenseFromTemplate(s, clock, {
            template_id: tpl.id,
            licensable_type: 'User',
            licensable_id: 'u-4',
          });
          expect(lic.expires_at).toBeNull();
          expect(lic.grace_until).toBeNull();
        } finally {
          await cleanup();
        }
      });

      it('entitlements snapshot is frozen at creation — later template meta edits do not affect old licenses', async () => {
        const { s, clock, cleanup } = await b.make();
        try {
          const tpl = await createTemplate(s, clock, {
            scope_id: null,
            name: 'snap',
            max_usages: 1,
            trial_duration_sec: 0,
            grace_duration_sec: 0,
            force_online_after_sec: null,
            entitlements: { seats: 1, tier: 'basic' },
          });
          const lic = await createLicenseFromTemplate(s, clock, {
            template_id: tpl.id,
            licensable_type: 'User',
            licensable_id: 'u-5',
          });
          const licMeta = lic.meta as Record<string, unknown>;
          expect(licMeta.entitlements).toEqual({ seats: 1, tier: 'basic' });
          // Snapshot is a copy, not a live reference — re-reading the license
          // later should show the same values we captured, even if a future
          // admin-side flow edits the template row (not exercised here, but
          // the `meta` column on `licenses` is independent storage).
          const refreshed = await s.getLicense(lic.id);
          expect((refreshed?.meta as Record<string, unknown>).entitlements).toEqual({
            seats: 1,
            tier: 'basic',
          });
        } finally {
          await cleanup();
        }
      });

      it('caller-supplied meta merges on top of template-derived meta', async () => {
        const { s, clock, cleanup } = await b.make();
        try {
          const tpl = await createTemplate(s, clock, {
            scope_id: null,
            name: 'merge-meta',
            max_usages: 1,
            trial_duration_sec: 0,
            grace_duration_sec: 0,
            force_online_after_sec: 600,
            entitlements: { seats: 1 },
          });
          const lic = await createLicenseFromTemplate(s, clock, {
            template_id: tpl.id,
            licensable_type: 'User',
            licensable_id: 'u-6',
            meta: { custom: 'value', force_online_after_sec: 300 },
          });
          const meta = lic.meta as Record<string, unknown>;
          // Caller override wins for overlapping keys.
          expect(meta.force_online_after_sec).toBe(300);
          expect(meta.custom).toBe('value');
          // Template-only keys are preserved.
          expect(meta.entitlements).toEqual({ seats: 1 });
        } finally {
          await cleanup();
        }
      });

      it('rejects unknown template_id', async () => {
        const { s, clock, cleanup } = await b.make();
        try {
          await expect(
            createLicenseFromTemplate(s, clock, {
              // Well-formed uuidv7 that doesn't exist.
              template_id: '01890000-0000-7000-8000-000000000000' as never,
              licensable_type: 'User',
              licensable_id: 'u-7',
            }),
          ).rejects.toThrow(/template not found/);
        } finally {
          await cleanup();
        }
      });
    });
  }
});
