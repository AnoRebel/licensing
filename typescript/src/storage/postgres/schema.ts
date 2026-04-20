/**
 * Postgres adapter's view of the canonical schema.
 *
 * This mirrors `MEMORY_SCHEMA` in `@licensing/sdk/storage/memory` exactly — both
 * adapters are describing the SAME entities with the SAME fields. The
 * difference is purely where/how it's stored (Postgres native types vs
 * JS Maps). The schema-parity test accepts either adapter and diffs against
 * `fixtures/schema/entities.md` — divergence between the two adapters'
 * schema descriptions would ALSO fail the parity test (via the shared fixture).
 *
 * Keep this file in lockstep with `storage-memory/src/schema.ts`. A helper
 * integration test at the workspace level asserts the two are
 * structurally identical (same columns, same flags, same constraint names).
 */

import type { SchemaDescription } from '../index.ts';

export const POSTGRES_SCHEMA: SchemaDescription = [
  {
    name: 'License',
    columns: [
      { name: 'id', type: 'uuid', nullable: false, unique: ['pk'] },
      { name: 'scope_id', type: 'uuid', nullable: true, unique: ['licensable_scope'] },
      { name: 'template_id', type: 'uuid', nullable: true, unique: [] },
      {
        name: 'licensable_type',
        type: 'string',
        nullable: false,
        unique: ['licensable_scope'],
      },
      { name: 'licensable_id', type: 'string', nullable: false, unique: ['licensable_scope'] },
      { name: 'license_key', type: 'string', nullable: false, unique: ['license_key'] },
      { name: 'status', type: 'enum', nullable: false, unique: [] },
      { name: 'max_usages', type: 'int', nullable: false, unique: [] },
      { name: 'activated_at', type: 'timestamp', nullable: true, unique: [] },
      { name: 'expires_at', type: 'timestamp', nullable: true, unique: [] },
      { name: 'grace_until', type: 'timestamp', nullable: true, unique: [] },
      { name: 'meta', type: 'json', nullable: false, unique: [] },
      { name: 'created_at', type: 'timestamp', nullable: false, unique: [] },
      { name: 'updated_at', type: 'timestamp', nullable: false, unique: [] },
    ],
  },
  {
    name: 'LicenseScope',
    columns: [
      { name: 'id', type: 'uuid', nullable: false, unique: ['pk'] },
      { name: 'slug', type: 'string', nullable: false, unique: ['slug'] },
      { name: 'name', type: 'string', nullable: false, unique: [] },
      { name: 'meta', type: 'json', nullable: false, unique: [] },
      { name: 'created_at', type: 'timestamp', nullable: false, unique: [] },
      { name: 'updated_at', type: 'timestamp', nullable: false, unique: [] },
    ],
  },
  {
    name: 'LicenseTemplate',
    columns: [
      { name: 'id', type: 'uuid', nullable: false, unique: ['pk'] },
      { name: 'scope_id', type: 'uuid', nullable: true, unique: ['scope_name'] },
      { name: 'name', type: 'string', nullable: false, unique: ['scope_name'] },
      { name: 'max_usages', type: 'int', nullable: false, unique: [] },
      { name: 'trial_duration_sec', type: 'int', nullable: false, unique: [] },
      { name: 'grace_duration_sec', type: 'int', nullable: false, unique: [] },
      { name: 'force_online_after_sec', type: 'int', nullable: true, unique: [] },
      { name: 'entitlements', type: 'json', nullable: false, unique: [] },
      { name: 'meta', type: 'json', nullable: false, unique: [] },
      { name: 'created_at', type: 'timestamp', nullable: false, unique: [] },
      { name: 'updated_at', type: 'timestamp', nullable: false, unique: [] },
    ],
  },
  {
    name: 'LicenseUsage',
    columns: [
      { name: 'id', type: 'uuid', nullable: false, unique: ['pk'] },
      { name: 'license_id', type: 'uuid', nullable: false, unique: ['license_fingerprint_active'] },
      {
        name: 'fingerprint',
        type: 'string',
        nullable: false,
        unique: ['license_fingerprint_active'],
      },
      { name: 'status', type: 'enum', nullable: false, unique: [] },
      { name: 'registered_at', type: 'timestamp', nullable: false, unique: [] },
      { name: 'revoked_at', type: 'timestamp', nullable: true, unique: [] },
      { name: 'client_meta', type: 'json', nullable: false, unique: [] },
      { name: 'created_at', type: 'timestamp', nullable: false, unique: [] },
      { name: 'updated_at', type: 'timestamp', nullable: false, unique: [] },
    ],
  },
  {
    name: 'LicenseKey',
    columns: [
      { name: 'id', type: 'uuid', nullable: false, unique: ['pk'] },
      { name: 'scope_id', type: 'uuid', nullable: true, unique: ['scope_active_signing'] },
      { name: 'kid', type: 'string', nullable: false, unique: ['kid'] },
      { name: 'alg', type: 'enum', nullable: false, unique: [] },
      { name: 'role', type: 'enum', nullable: false, unique: ['scope_active_signing'] },
      { name: 'state', type: 'enum', nullable: false, unique: [] },
      { name: 'public_pem', type: 'text', nullable: false, unique: [] },
      { name: 'private_pem_enc', type: 'text', nullable: true, unique: [] },
      { name: 'rotated_from', type: 'uuid', nullable: true, unique: [] },
      { name: 'rotated_at', type: 'timestamp', nullable: true, unique: [] },
      { name: 'not_before', type: 'timestamp', nullable: false, unique: [] },
      { name: 'not_after', type: 'timestamp', nullable: true, unique: [] },
      { name: 'meta', type: 'json', nullable: false, unique: [] },
      { name: 'created_at', type: 'timestamp', nullable: false, unique: [] },
      { name: 'updated_at', type: 'timestamp', nullable: false, unique: [] },
    ],
  },
  {
    name: 'AuditLog',
    columns: [
      { name: 'id', type: 'uuid', nullable: false, unique: ['pk'] },
      { name: 'license_id', type: 'uuid', nullable: true, unique: [] },
      { name: 'scope_id', type: 'uuid', nullable: true, unique: [] },
      { name: 'actor', type: 'string', nullable: false, unique: [] },
      { name: 'event', type: 'string', nullable: false, unique: [] },
      { name: 'prior_state', type: 'json', nullable: true, unique: [] },
      { name: 'new_state', type: 'json', nullable: true, unique: [] },
      { name: 'occurred_at', type: 'timestamp', nullable: false, unique: [] },
    ],
  },
];
