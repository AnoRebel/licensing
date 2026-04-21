#!/usr/bin/env bun
/**
 * One-shot scaffolder for the initial 24-vector corpus.
 *
 * Authored separately from the main CLI because it's a one-time bootstrap:
 * once the inputs.json files live in the repo, vectors evolve via normal PRs
 * (edit inputs.json → re-run `build-all`). Re-running this script overwrites
 * existing inputs.json files, which is the intended behavior during corpus
 * redesign but destructive on a stable corpus — hence keeping it as a
 * separate bin entry rather than folding it into `licensing-fixtures`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TamperManifest, TamperSpec, ValidInputs } from '../src/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const tokensDir = join(repoRoot, 'fixtures', 'tokens');

interface VectorDef {
  readonly id: string;
  readonly inputs: ValidInputs;
  readonly tampers?: readonly TamperSpec[];
}

// ---------- claim builders ----------

const BASE_IAT = 1_700_000_000; // 2023-11-14T22:13:20Z — stable, deterministic

/** Minimal valid payload for a given status. `exp` sits beyond `iat` by a
 *  generous TTL so status-independent validation tests aren't tripped. */
function basePayload(
  status: 'active' | 'grace' | 'suspended',
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    jti: `jti-${status}-${Object.keys(extra).length}`,
    iat: BASE_IAT,
    nbf: BASE_IAT,
    exp: BASE_IAT + 86_400 * 30, // +30 days
    force_online_after: null,
    scope: 'example.app',
    license_id: '00000000-0000-4000-8000-000000000001',
    usage_id: '00000000-0000-4000-8000-000000000002',
    usage_fingerprint: 'a'.repeat(64),
    status,
    max_usages: 5,
    entitlements: { seats: 5 },
    meta: {},
    ...extra,
  };
}

function header(alg: ValidInputs['alg'], kid: string): Record<string, unknown> {
  return { v: 1, typ: 'lic', alg, kid };
}

// ---------- vector definitions ----------

const vectors: readonly VectorDef[] = [
  // 1-3: baseline active
  {
    id: '001-ed25519-active',
    inputs: mkInputs('ed25519', 'ed25519', 'fixture-ed25519-1', basePayload('active')),
  },
  {
    id: '002-rs256-pss-active',
    inputs: mkInputs('rs256-pss', 'rsa', 'fixture-rsa-1', basePayload('active')),
  },
  {
    id: '003-hs256-active',
    inputs: mkInputs('hs256', 'hmac', 'fixture-hmac-1', basePayload('active')),
  },

  // 4-6: grace
  {
    id: '004-ed25519-grace',
    inputs: mkInputs('ed25519', 'ed25519', 'fixture-ed25519-1', basePayload('grace')),
  },
  {
    id: '005-rs256-pss-grace',
    inputs: mkInputs('rs256-pss', 'rsa', 'fixture-rsa-1', basePayload('grace')),
  },
  {
    id: '006-hs256-grace',
    inputs: mkInputs('hs256', 'hmac', 'fixture-hmac-1', basePayload('grace')),
  },

  // 7-9: suspended
  {
    id: '007-ed25519-suspended',
    inputs: mkInputs('ed25519', 'ed25519', 'fixture-ed25519-1', basePayload('suspended')),
  },
  {
    id: '008-rs256-pss-suspended',
    inputs: mkInputs('rs256-pss', 'rsa', 'fixture-rsa-1', basePayload('suspended')),
  },
  {
    id: '009-hs256-suspended',
    inputs: mkInputs('hs256', 'hmac', 'fixture-hmac-1', basePayload('suspended')),
  },

  // 10-12: rich entitlements object
  {
    id: '010-ed25519-entitlements',
    inputs: mkInputs(
      'ed25519',
      'ed25519',
      'fixture-ed25519-1',
      basePayload('active', {
        entitlements: { seats: 25, features: ['sso', 'audit-log', 'api'], tier: 'enterprise' },
      }),
    ),
  },
  {
    id: '011-rs256-pss-entitlements',
    inputs: mkInputs(
      'rs256-pss',
      'rsa',
      'fixture-rsa-1',
      basePayload('active', {
        entitlements: { seats: 25, features: ['sso', 'audit-log', 'api'], tier: 'enterprise' },
      }),
    ),
  },
  {
    id: '012-hs256-entitlements',
    inputs: mkInputs(
      'hs256',
      'hmac',
      'fixture-hmac-1',
      basePayload('active', {
        entitlements: { seats: 25, features: ['sso', 'audit-log', 'api'], tier: 'enterprise' },
      }),
    ),
  },

  // 13-15: arbitrary meta
  {
    id: '013-ed25519-meta',
    inputs: mkInputs(
      'ed25519',
      'ed25519',
      'fixture-ed25519-1',
      basePayload('active', {
        meta: { org: 'Acme', plan: 'Pro', seats_assigned: 3 },
      }),
    ),
  },
  {
    id: '014-rs256-pss-meta',
    inputs: mkInputs(
      'rs256-pss',
      'rsa',
      'fixture-rsa-1',
      basePayload('active', {
        meta: { org: 'Acme', plan: 'Pro', seats_assigned: 3 },
      }),
    ),
  },
  {
    id: '015-hs256-meta',
    inputs: mkInputs(
      'hs256',
      'hmac',
      'fixture-hmac-1',
      basePayload('active', {
        meta: { org: 'Acme', plan: 'Pro', seats_assigned: 3 },
      }),
    ),
  },

  // 16: unicode + `/` char per canonical-JSON §1.10
  {
    id: '016-ed25519-unicode',
    inputs: mkInputs(
      'ed25519',
      'ed25519',
      'fixture-ed25519-1',
      basePayload('active', {
        meta: { note: 'héllo/世界', path: '/api/v1/licenses' },
      }),
    ),
  },

  // 17: empty entitlements object — shakes out {} vs null distinction
  {
    id: '017-ed25519-empty-entitlements',
    inputs: mkInputs(
      'ed25519',
      'ed25519',
      'fixture-ed25519-1',
      basePayload('active', { entitlements: {} }),
    ),
  },

  // 18: array value inside meta
  {
    id: '018-ed25519-array-in-meta',
    inputs: mkInputs(
      'ed25519',
      'ed25519',
      'fixture-ed25519-1',
      basePayload('active', {
        meta: { tags: ['a', 'b', 'c'], counts: [1, 2, 3] },
      }),
    ),
  },

  // 19: timestamps at 0 — boundary case for integer canonicalization
  {
    id: '019-ed25519-min-timestamps',
    inputs: mkInputs('ed25519', 'ed25519', 'fixture-ed25519-1', {
      ...basePayload('active'),
      iat: 0,
      nbf: 0,
      exp: 1,
    }),
  },

  // 20: max safe integer — exercises the JS safe-integer boundary
  {
    id: '020-ed25519-max-safe-int',
    inputs: mkInputs(
      'ed25519',
      'ed25519',
      'fixture-ed25519-1',
      basePayload('active', {
        max_usages: Number.MAX_SAFE_INTEGER, // 2^53 - 1
      }),
    ),
  },

  // 21: negative integer inside meta
  {
    id: '021-ed25519-negative-int',
    inputs: mkInputs(
      'ed25519',
      'ed25519',
      'fixture-ed25519-1',
      basePayload('active', {
        meta: { adjustment: -7 },
      }),
    ),
  },

  // 22: explicitly null force_online_after (the baseline)
  {
    id: '022-ed25519-force-online-null',
    inputs: mkInputs(
      'ed25519',
      'ed25519',
      'fixture-ed25519-1',
      basePayload('active', {
        force_online_after: null,
      }),
    ),
  },

  // 23: force_online_after set to a real timestamp
  {
    id: '023-ed25519-force-online-set',
    inputs: mkInputs(
      'ed25519',
      'ed25519',
      'fixture-ed25519-1',
      basePayload('active', {
        force_online_after: BASE_IAT + 86_400 * 7,
      }),
    ),
  },

  // 24: minimal — just the required claims, nothing optional beyond the base
  {
    id: '024-ed25519-baseline',
    inputs: mkInputs('ed25519', 'ed25519', 'fixture-ed25519-1', basePayload('active')),
  },
];

// ---------- tamper manifests ----------

/** Apply a uniform tamper suite to the three alg-baseline vectors (001/002/003).
 *  Other vectors reuse the same LIC1 envelope so duplicating tamper variants
 *  across every vector would inflate the corpus without adding signal. */
const baselineTampers: readonly TamperSpec[] = [
  { variant: 'sig-bitflip', kind: 'sig-bitflip' },
  { variant: 'header-bitflip', kind: 'header-bitflip' },
  { variant: 'payload-bitflip', kind: 'payload-bitflip' },
  { variant: 'wrong-kid', kind: 'wrong-kid' },
  { variant: 'missing-exp', kind: 'missing-required-claim', claim: 'exp' },
  { variant: 'expired', kind: 'expired' },
  { variant: 'nbf-in-future', kind: 'nbf-in-future' },
];

const tamperedVectors = new Set(['001-ed25519-active', '002-rs256-pss-active', '003-hs256-active']);

// ---------- execution ----------

for (const v of vectors) {
  const dir = join(tokensDir, v.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'inputs.json'), `${JSON.stringify(v.inputs, null, 2)}\n`);
  if (tamperedVectors.has(v.id)) {
    const manifest: TamperManifest = { source: v.id, variants: baselineTampers };
    writeFileSync(join(dir, 'tampers.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

console.info(`scaffolded ${vectors.length} vectors under ${tokensDir}`);

// ---------- helpers ----------

function mkInputs(
  alg: ValidInputs['alg'],
  key_ref: ValidInputs['key_ref'],
  kid: string,
  payload: Record<string, unknown>,
): ValidInputs {
  return { alg, kid, key_ref, header: header(alg, kid), payload };
}
