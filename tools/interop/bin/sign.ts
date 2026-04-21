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

import { canonicalize } from '@anorebel/licensing/canonical-json';
import {
  ed25519Backend,
  hmacBackend,
  rsaPssBackend,
  type SignatureBackend,
} from '@anorebel/licensing/crypto';

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

function b64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

await runCli(async (raw) => {
  const input = raw as SignInput;
  if (!input.alg || !input.key_ref || !input.kid || !input.header || !input.payload) {
    throw new Error('sign: missing required field (alg, key_ref, kid, header, payload)');
  }
  const record = loadFixtureKey(input.key_ref, input.alg, input.kid);
  const backend = backendFor(input.alg);
  const priv = await backend.importPrivate(record.alg === 'hs256' ? record.raw : record);

  const headerBytes = canonicalize(input.header);
  const payloadBytes = canonicalize(input.payload);
  const headerB64 = b64url(headerBytes);
  const payloadB64 = b64url(payloadBytes);
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const sig = await backend.sign(priv, signingInput);
  const token = `LIC1.${headerB64}.${payloadB64}.${b64url(sig)}`;
  return { token };
});
