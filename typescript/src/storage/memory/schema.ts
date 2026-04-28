/**
 * Canonical schema description the memory adapter reports via
 * `describeSchema()`. Must match `fixtures/schema/entities.md` exactly in
 * field names, type categories, nullability, and uniqueness membership.
 *
 * This file is the adapter's view. The schema-parity test parses
 * `fixtures/schema/entities.md` and compares it against this structure; a
 * drift on either side fails CI.
 *
 * When the canonical schema changes, update BOTH:
 *   1. `fixtures/schema/entities.md` (the canonical source)
 *   2. this file (the adapter's report)
 * …and every other adapter's equivalent.
 */

import type { SchemaDescription } from '../index.ts';

export const MEMORY_SCHEMA: SchemaDescription = [
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
      { name: 'is_trial', type: 'bool', nullable: false, unique: [] },
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
      { name: 'parent_id', type: 'uuid', nullable: true, unique: [] },
      { name: 'name', type: 'string', nullable: false, unique: ['scope_name'] },
      { name: 'max_usages', type: 'int', nullable: false, unique: [] },
      { name: 'trial_duration_sec', type: 'int', nullable: false, unique: [] },
      { name: 'trial_cooldown_sec', type: 'int', nullable: true, unique: [] },
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
  {
    name: 'TrialIssuance',
    columns: [
      { name: 'id', type: 'uuid', nullable: false, unique: ['pk'] },
      // template_id and fingerprint_hash share two split partial uniques —
      // `(template_id, fingerprint_hash) WHERE template_id IS NOT NULL` and
      // `(fingerprint_hash) WHERE template_id IS NULL`. Both reduce to "this
      // pair is unique against the documented composite group", so they share
      // a single constraint name in the adapter's report.
      { name: 'template_id', type: 'uuid', nullable: true, unique: ['template_fingerprint'] },
      {
        name: 'fingerprint_hash',
        type: 'string',
        nullable: false,
        unique: ['template_fingerprint'],
      },
      { name: 'issued_at', type: 'timestamp', nullable: false, unique: [] },
    ],
  },
];
