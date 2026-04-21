/**
 * Canned admin API fixtures for the a11y suite. Shapes are hand-kept in
 * sync with the OpenAPI schema; when a field lands or renames, the axe
 * suite starts crashing on undefined access rather than silently
 * drifting — treat that as a useful signal, not a flake.
 *
 * The goal is *realistic enough* data to exercise every conditional
 * branch that affects a11y (badges, disabled actions, empty states,
 * long content that wraps, etc.), not *complete* data.
 */

const now = new Date('2026-04-19T10:00:00Z');
const iso = (d: Date) => d.toISOString();

const LICENSE_ID = '018df9f1-0000-7000-8000-000000000001';
const SCOPE_ID = '018df9f1-0000-7000-8000-000000000010';
const KEY_ID = '018df9f1-0000-7000-8000-000000000020';
const USAGE_ID = '018df9f1-0000-7000-8000-000000000030';
const TEMPLATE_ID = '018df9f1-0000-7000-8000-000000000040';

export const sampleScope = {
  id: SCOPE_ID,
  name: 'ACME Production',
  slug: 'acme-production',
  created_at: iso(now),
  updated_at: iso(now),
};

export const sampleLicense = {
  id: LICENSE_ID,
  status: 'active',
  template_id: null,
  max_usages: 10,
  active_usages: 3,
  expires_at: iso(new Date('2026-10-19T10:00:00Z')),
  activated_at: iso(new Date('2026-01-10T10:00:00Z')),
  created_at: iso(new Date('2026-01-10T09:00:00Z')),
  updated_at: iso(now),
  entitlements: { seats: 10, features: ['sso', 'audit'] },
  meta: { customer: 'ACME Corp' },
};

export const sampleKey = {
  id: KEY_ID,
  scope_id: SCOPE_ID,
  state: 'active' as const,
  kid: 'k_018df9f1_active',
  algorithm: 'ed25519',
  not_before: iso(new Date('2026-01-01T00:00:00Z')),
  retires_at: null as string | null,
  revoked_at: null as string | null,
  created_at: iso(new Date('2026-01-01T00:00:00Z')),
};

export const sampleUsage = {
  id: USAGE_ID,
  license_id: LICENSE_ID,
  fingerprint_hash: 'sha256:ff00aa11',
  client_type: 'web',
  client_version: '1.2.3',
  registered_at: iso(new Date('2026-02-01T10:00:00Z')),
  last_seen_at: iso(new Date('2026-04-18T10:00:00Z')),
  revoked_at: null as string | null,
  revoked_reason: null as string | null,
};

export const sampleAuditEntry = {
  id: '018df9f1-0000-7000-8000-000000000100',
  occurred_at: iso(new Date('2026-04-19T09:55:00Z')),
  event: 'license.created',
  actor_type: 'api-key',
  actor_id: 'api-key:root',
  license_id: LICENSE_ID,
  scope_id: SCOPE_ID,
  prior_state: null,
  new_state: { id: LICENSE_ID, status: 'pending' },
};

export const sampleTemplate = {
  id: TEMPLATE_ID,
  scope_id: SCOPE_ID,
  name: 'Enterprise 10-seat',
  max_usages: 10,
  trial_duration_sec: 0,
  grace_duration_sec: 60 * 60 * 24 * 7,
  force_online_after_sec: 60 * 60 * 24 * 30,
  entitlements: { seats: 10, features: ['sso', 'audit'] },
  meta: { sku: 'ENT-10' },
  created_at: iso(new Date('2026-01-10T09:00:00Z')),
  updated_at: iso(now),
};

export const cursorPage = <T>(items: T[]) => ({
  data: { items, next_cursor: null as string | null },
});

export const IDS = { LICENSE_ID, SCOPE_ID, KEY_ID, USAGE_ID, TEMPLATE_ID };
