#!/usr/bin/env bun

/**
 * interop-classify: run the TS client's validate() against a token+tuple
 * and emit the classification code. The Go side runs the identical tuple
 * through its Validate() and asserts the code matches — this closes the
 * grace-period / lifecycle transition-table half of the interop loop.
 *
 * stdin:
 *   {
 *     "token":       "LIC1....",
 *     "alg":         "ed25519" | "rs256-pss" | "hs256",
 *     "key_ref":     "ed25519" | "rsa" | "hmac",
 *     "kid":         "fixture-...",
 *     "fingerprint": "<64-hex>",
 *     "now_sec":     1700000000,
 *     "skew_sec":    60            (optional; default 60)
 *   }
 *
 * stdout (always ok, meaning "the harness ran"):
 *   {
 *     "ok": true,
 *     "value": {
 *       "code":   "Ok" | "TokenExpired" | "TokenNotYetValid" |
 *                 "LicenseSuspended" | "LicenseRevoked" |
 *                 "FingerprintMismatch" | "RequiresOnlineRefresh" |
 *                 "TokenSignatureInvalid" | "<other>",
 *       "detail": "optional short error message"
 *     }
 *   }
 *
 * Only a genuine harness failure (bad input, unreadable key, etc.) exits
 * with ok=false — classification failures are successful runs.
 */

import { LicensingClientError, validate } from '@anorebel/licensing/client';
import {
  AlgorithmRegistry,
  ed25519Backend,
  hmacBackend,
  KeyAlgBindings,
  type KeyRecord,
  rsaPssBackend,
} from '@anorebel/licensing/crypto';

import { runCli } from '../src/io.ts';
import { type KeyAlg, type KeyRef, loadFixtureKey } from '../src/keys.ts';

interface ClassifyInput {
  token: string;
  alg: KeyAlg;
  key_ref: KeyRef;
  kid: string;
  fingerprint: string;
  now_sec: number;
  skew_sec?: number;
}

function backendFor(alg: KeyAlg) {
  switch (alg) {
    case 'ed25519':
      return ed25519Backend;
    case 'rs256-pss':
      return rsaPssBackend;
    case 'hs256':
      return hmacBackend;
  }
}

await runCli(async (raw) => {
  const input = raw as ClassifyInput;
  if (
    !input.token ||
    !input.alg ||
    !input.key_ref ||
    !input.kid ||
    typeof input.now_sec !== 'number' ||
    typeof input.fingerprint !== 'string'
  ) {
    throw new Error('classify: missing required field');
  }
  const registry = new AlgorithmRegistry();
  registry.register(backendFor(input.alg));
  const bindings = new KeyAlgBindings();
  bindings.bind(input.kid, input.alg);
  const record = loadFixtureKey(input.key_ref, input.alg, input.kid);
  const keys = new Map<string, KeyRecord>([[input.kid, record]]);

  try {
    await validate(input.token, {
      registry,
      bindings,
      keys,
      fingerprint: input.fingerprint,
      nowSec: input.now_sec,
      skewSec: input.skew_sec ?? 60,
    });
    return { code: 'Ok' };
  } catch (err) {
    if (err instanceof LicensingClientError) {
      return { code: err.code, detail: err.message };
    }
    if (err && typeof err === 'object' && 'code' in err) {
      return {
        code: String((err as { code: unknown }).code ?? 'UnknownError'),
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    return {
      code: 'UnknownError',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
});
