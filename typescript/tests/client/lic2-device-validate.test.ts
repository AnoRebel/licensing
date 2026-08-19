/**
 * A device that imports only the client subpath must be able to validate a
 * LIC2 token offline.
 *
 * This is a regression test for a real defect: `client/validate.ts`
 * imported `../lic1.ts` but not `../lic2.ts`, so a consumer importing
 * `@anorebel/licensing/client` had no LIC2 codec registered. A LIC2 token
 * failed on the device with `unsupported token format prefix: "v4."` —
 * making LIC2 useless for offline validation, which is the flow it exists
 * to serve.
 *
 * The import in validate.ts is load-bearing. If it is ever removed as
 * "unused" (it has no named bindings), this test fails.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Deliberately the client entry point only — importing the package root
// would register LIC2 as a side effect and mask the defect.
import { validate } from '../../src/client/index.ts';
import {
  AlgorithmRegistry,
  ed25519Backend,
  KeyAlgBindings,
  type KeyRecord,
} from '../../src/crypto/index.ts';

const FIXTURES = join(import.meta.dir, '../../../fixtures');

function verifyOpts() {
  const pub = readFileSync(join(FIXTURES, 'keys/ed25519/public.pem'), 'utf8');
  const registry = new AlgorithmRegistry();
  registry.register(ed25519Backend);
  const bindings = new KeyAlgBindings();
  bindings.bind('fixture-ed25519-1', 'ed25519');
  const record: KeyRecord = {
    kid: 'fixture-ed25519-1',
    alg: 'ed25519',
    publicPem: pub,
    privatePem: null,
    raw: { publicRaw: null as unknown as Uint8Array, privateRaw: null },
  };
  return { registry, bindings, keys: new Map([['fixture-ed25519-1', record]]) };
}

function committedToken(family: string, id: string): string {
  return readFileSync(join(FIXTURES, family, id, 'expected_token.txt'), 'utf8').trim();
}

describe('device-side validation accepts both formats', () => {
  it('validates a committed LIC2 token from the client entry point', async () => {
    const result = await validate(committedToken('tokens-lic2', '001-lic2-active'), {
      ...verifyOpts(),
      nowSec: 1700000100,
      fingerprint: 'a'.repeat(64),
    });
    expect(result.license_id).toBe('00000000-0000-4000-8000-000000000001');
    expect(result.status).toBe('active');
    expect(result.alg).toBe('ed25519');
  });

  it('validates a committed LIC1 token from the same entry point', async () => {
    const result = await validate(committedToken('tokens', '001-ed25519-active'), {
      ...verifyOpts(),
      nowSec: 1700000100,
      fingerprint: 'a'.repeat(64),
    });
    expect(result.license_id).toBe('00000000-0000-4000-8000-000000000001');
    expect(result.status).toBe('active');
  });

  it('still rejects an unregistered prefix on the device', async () => {
    await expect(
      validate('v9.public.abc.def', {
        ...verifyOpts(),
        nowSec: 1700000100,
        fingerprint: 'a'.repeat(64),
      }),
    ).rejects.toThrow();
  });
});
