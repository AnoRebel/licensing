#!/usr/bin/env bun
/**
 * interop-sign: canonicalize + sign an arbitrary (header, payload) via the
 * TypeScript implementation and emit the resulting LIC1 token.
 *
 * stdin:
 *   {
 *     "alg":      "ed25519" | "rs256-pss" | "hs256",
 *     "key_ref":  "ed25519" | "rsa" | "hmac",
 *     "kid":      "fixture-...",
 *     "header":   { ... },
 *     "payload":  { ... }
 *   }
 *
 * stdout (success):
 *   { "ok": true, "value": { "token": "LIC1....." } }
 *
 * The caller (the Go interop test) hands the token to Go's verifier and
 * asserts it parses + checks out — closing the TS-sign → Go-verify half of
 * the interop loop.
 */

import {
  ed25519Backend,
  hmacBackend,
  rsaPssBackend,
  type SignatureBackend,
} from '@anorebel/licensing/crypto';
import { encode } from '@anorebel/licensing/lic1';

import { runCli } from '../src/io.ts';
import { type KeyAlg, type KeyRef, loadFixtureKey } from '../src/keys.ts';

interface SignInput {
  alg: KeyAlg;
  key_ref: KeyRef;
  kid: string;
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
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
  const input = raw as SignInput;
  if (!input.alg || !input.key_ref || !input.kid || !input.header || !input.payload) {
    throw new Error('sign: missing required field (alg, key_ref, kid, header, payload)');
  }
  const record = loadFixtureKey(input.key_ref, input.alg, input.kid);
  const backend = backendFor(input.alg);
  const priv = await backend.importPrivate(record.alg === 'hs256' ? record.raw : record);

  // Drive the SHIPPED encoder. This harness previously rebuilt the token
  // inline — canonicalize, base64, concatenate — which meant the Go-side
  // interop suite compared Go's output against a *copy* of the TS algorithm
  // rather than against the TS implementation. A regression in the real
  // encode() passed the whole suite.
  const token = await encode({
    header: input.header as never,
    payload: input.payload,
    privateKey: priv,
    backend,
  });
  return { token };
});
