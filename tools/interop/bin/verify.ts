#!/usr/bin/env bun
/**
 * interop-verify: verify a LIC1 token via the TypeScript implementation.
 * Caller supplies the token + the fixture key reference that should be
 * trusted for its kid. On success returns the decoded header + payload so
 * the Go side can assert byte-equality against its own decode output.
 *
 * stdin:
 *   {
 *     "token":   "LIC1....",
 *     "alg":     "ed25519" | "rs256-pss" | "hs256",
 *     "key_ref": "ed25519" | "rsa" | "hmac",
 *     "kid":     "fixture-..."
 *   }
 *
 * stdout (success):
 *   { "ok": true, "value": { "header": {...}, "payload": {...} } }
 *
 * stdout (failure):
 *   { "ok": false, "error": "ErrorName: message" }
 *
 * The HMAC path goes through a hand-rolled decode + importPublic(record.raw)
 * + backend.verify sequence because the core `verify()` entry point hands
 * the whole `KeyRecord` to the backend, and HMAC's `importPublic` demands
 * raw bytes (no PEM). Asymmetric algs keep the high-level path.
 */

import { errors } from '@anorebel/licensing';
import {
  AlgorithmRegistry,
  ed25519Backend,
  hmacBackend,
  KeyAlgBindings,
  type KeyRecord,
  rsaPssBackend,
  type SignatureBackend,
} from '@anorebel/licensing/crypto';
import { decodeUnverified, verify } from '@anorebel/licensing/lic1';

import { runCli } from '../src/io.ts';
import { type KeyAlg, type KeyRef, loadFixtureKey } from '../src/keys.ts';

interface VerifyInput {
  token: string;
  alg: KeyAlg;
  key_ref: KeyRef;
  kid: string;
}

function backendFor(alg: KeyAlg): SignatureBackend {
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
  const input = raw as VerifyInput;
  if (!input.token || !input.alg || !input.key_ref || !input.kid) {
    throw new Error('verify: missing required field (token, alg, key_ref, kid)');
  }
  const record = loadFixtureKey(input.key_ref, input.alg, input.kid);

  if (input.alg === 'hs256') {
    // HMAC path: skip the high-level verify() because it would pass the
    // whole KeyRecord (with `publicPem:''`) to importPublic, which HMAC
    // rejects. Do the decode-verify-dance manually against record.raw.
    const parts = decodeUnverified(input.token);
    if (parts.header.kid !== input.kid) {
      throw errors.unknownKid(parts.header.kid);
    }
    if (parts.header.alg !== input.alg) {
      throw errors.algorithmMismatch(parts.header.alg, input.alg);
    }
    const backend = hmacBackend;
    const key = await backend.importPublic(record.raw);
    const ok = await backend.verify(key, parts.signingInput, parts.signature);
    if (!ok) throw errors.tokenSignatureInvalid();
    return { header: parts.header, payload: parts.payload };
  }

  const registry = new AlgorithmRegistry();
  registry.register(backendFor(input.alg));
  const bindings = new KeyAlgBindings();
  bindings.bind(input.kid, input.alg);
  const keys = new Map<string, KeyRecord>([[input.kid, record]]);

  const parts = await verify(input.token, { registry, bindings, keys });
  return {
    header: parts.header,
    payload: parts.payload,
  };
});
