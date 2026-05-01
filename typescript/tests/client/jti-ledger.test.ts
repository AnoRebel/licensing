/**
 * In-memory JtiLedger contract tests.
 *
 * Mirrors the Go reference suite in licensing/client/jti_ledger_test.go;
 * the SQLite + Postgres adapters' tests check the same matrix so every
 * implementation is held to one contract.
 */

import { describe, expect, it } from 'bun:test';

import { MemoryJtiLedger } from '../../src/client/jti-ledger.ts';
import { validate } from '../../src/client/validate.ts';
import { forgeToken } from './_helpers.ts';

const FP = 'fp-x';

describe('MemoryJtiLedger', () => {
  it('first use is recorded and reported as first', async () => {
    const l = new MemoryJtiLedger();
    expect(await l.recordJtiUse('jti-a', 2_000_000_100)).toBe(true);
    expect(l.size).toBe(1);
  });

  it('second use of the same jti is rejected', async () => {
    const l = new MemoryJtiLedger();
    await l.recordJtiUse('jti-a', 2_000_000_100);
    expect(await l.recordJtiUse('jti-a', 2_000_000_100)).toBe(false);
  });

  it('distinct jtis coexist as first-use', async () => {
    const l = new MemoryJtiLedger();
    for (const jti of ['a', 'b', 'c']) {
      expect(await l.recordJtiUse(jti, 2_000_000_100)).toBe(true);
    }
    expect(l.size).toBe(3);
  });

  it('pruneExpired removes rows whose expSec ≤ nowSec', async () => {
    const l = new MemoryJtiLedger();
    await l.recordJtiUse('expired-1', 100);
    await l.recordJtiUse('expired-2', 200);
    await l.recordJtiUse('alive', 9_000_000_000);
    expect(await l.pruneExpired(500)).toBe(2);
    expect(l.size).toBe(1);
    // Idempotent.
    expect(await l.pruneExpired(500)).toBe(0);
  });

  it('pruneExpired boundary is inclusive', async () => {
    const l = new MemoryJtiLedger();
    await l.recordJtiUse('exact', 1_000);
    expect(await l.pruneExpired(1_000)).toBe(1);
  });
});

describe('validate — jti ledger integration', () => {
  it('first validate succeeds and records the jti', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken({ usage_fingerprint: FP }, { nowSec: now });
    const ledger = new MemoryJtiLedger();
    const res = await validate(f.token, {
      registry: f.registry,
      bindings: f.bindings,
      keys: f.keys,
      fingerprint: FP,
      nowSec: now,
      jtiLedger: ledger,
    });
    expect(res.license_id).toBe('lic-1');
    expect(ledger.size).toBe(1);
  });

  it('second validate of the same token surfaces TokenReplayed', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken({ usage_fingerprint: FP }, { nowSec: now });
    const ledger = new MemoryJtiLedger();
    const opts = {
      registry: f.registry,
      bindings: f.bindings,
      keys: f.keys,
      fingerprint: FP,
      nowSec: now,
      jtiLedger: ledger,
    };
    await validate(f.token, opts);
    await expect(validate(f.token, opts)).rejects.toMatchObject({
      code: 'TokenReplayed',
    });
  });

  it('does not burn a ledger entry when an upstream check fails', async () => {
    // A fingerprint mismatch fires before the ledger step. The legitimate
    // validate that follows (with the right fingerprint) MUST still
    // succeed because the ledger never recorded the failed attempt.
    const now = 2_000_000_000;
    const f = await forgeToken({ usage_fingerprint: FP }, { nowSec: now });
    const ledger = new MemoryJtiLedger();
    await expect(
      validate(f.token, {
        registry: f.registry,
        bindings: f.bindings,
        keys: f.keys,
        fingerprint: 'WRONG-FP',
        nowSec: now,
        jtiLedger: ledger,
      }),
    ).rejects.toMatchObject({ code: 'FingerprintMismatch' });
    expect(ledger.size).toBe(0);

    // Now the legitimate validate succeeds.
    const res = await validate(f.token, {
      registry: f.registry,
      bindings: f.bindings,
      keys: f.keys,
      fingerprint: FP,
      nowSec: now,
      jtiLedger: ledger,
    });
    expect(res.license_id).toBe('lic-1');
  });

  it('absent ledger leaves replay protection disabled', async () => {
    // The offline-first use case — no ledger configured — must be able
    // to validate the same token any number of times.
    const now = 2_000_000_000;
    const f = await forgeToken({ usage_fingerprint: FP }, { nowSec: now });
    const opts = {
      registry: f.registry,
      bindings: f.bindings,
      keys: f.keys,
      fingerprint: FP,
      nowSec: now,
    };
    await validate(f.token, opts);
    await validate(f.token, opts);
    // No throw — this is the offline-first guarantee.
  });
});
