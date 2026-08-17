/**
 * Audit attribution: actor_kind / actor_id.
 *
 * `actor` was a single free-form string carrying two concepts at once —
 * "system", "admin", "admin:renew". That answers "was this automatic?" only
 * by string-matching, and cannot answer "WHICH operator?" at all, so a
 * multi-operator deployment could not attribute an action to a person.
 *
 * Mirrors Go's TestDeriveActorKind_ClassifiesLegacyLabels and the
 * adapter-level assertions in licensing/http/admin_actor_test.go.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '@anorebel/licensing/storage/memory';
import { SqliteStorage } from '@anorebel/licensing/storage/sqlite';
import { applyMigrations as applySqliteMigrations } from '@anorebel/licensing/storage/sqlite/migrations';

import { createFixedClock } from '../../src/id.ts';
import type { Storage } from '../../src/storage/types.ts';
import { deriveActorKind } from '../../src/storage/types.ts';

const NOW = '2026-06-01T00:00:00.000000Z';

describe('deriveActorKind', () => {
  // Must agree with Go's DeriveActorKind exactly: the same label has to
  // classify identically in both ports, or a row written by one and read
  // by the other disagrees about who acted.
  it.each([
    ['system', 'system'],
    ['system:sweep', 'system'],
    ['admin', 'admin'],
    ['admin:renew', 'admin'],
    ['client', 'client'],
    ['someone-else', 'unknown'],
    ['', 'unknown'],
  ])('classifies %p as %p', (label, expected) => {
    expect(deriveActorKind(label as string)).toBe(expected as never);
  });
});

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
  describe(`audit actor identity (${backend.name})`, () => {
    it('records an explicit kind and operator id', async () => {
      const { s, cleanup } = await backend.make();
      try {
        await s.appendAudit({
          license_id: null,
          scope_id: null,
          actor: 'admin:renew',
          actor_kind: 'admin',
          actor_id: 'ops@example.com',
          event: 'license.renewed',
          prior_state: null,
          new_state: null,
          occurred_at: NOW,
        });
        const page = await s.listAudit({}, { limit: 10 });
        expect(page.items[0]?.actor_kind).toBe('admin');
        expect(page.items[0]?.actor_id).toBe('ops@example.com');
        // The legacy label is preserved, not replaced.
        expect(page.items[0]?.actor).toBe('admin:renew');
      } finally {
        cleanup();
      }
    });

    it('derives the kind when a caller supplies none', async () => {
      // The compatibility guarantee: a call site that was never updated
      // still produces usable attribution rather than defaulting to
      // "system", which would mislabel every admin action.
      const { s, cleanup } = await backend.make();
      try {
        await s.appendAudit({
          license_id: null,
          scope_id: null,
          actor: 'admin:revoke',
          event: 'usage.revoked',
          prior_state: null,
          new_state: null,
          occurred_at: NOW,
        });
        const page = await s.listAudit({}, { limit: 10 });
        expect(page.items[0]?.actor_kind).toBe('admin');
        expect(page.items[0]?.actor_id).toBeNull();
      } finally {
        cleanup();
      }
    });

    it('classifies an unrecognised label as unknown, not system', async () => {
      const { s, cleanup } = await backend.make();
      try {
        await s.appendAudit({
          license_id: null,
          scope_id: null,
          actor: 'some-integration',
          event: 'license.created',
          prior_state: null,
          new_state: null,
          occurred_at: NOW,
        });
        const page = await s.listAudit({}, { limit: 10 });
        expect(page.items[0]?.actor_kind).toBe('unknown');
      } finally {
        cleanup();
      }
    });
  });
}
