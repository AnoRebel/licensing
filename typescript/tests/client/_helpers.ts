/**
 * Shared test helpers — a miniature issuer-side token forge so validate/
 * RPC tests don't have to reimplement the LIC1 pipeline.
 */

import { AlgorithmRegistry, KeyAlgBindings, type KeyRecord } from '@licensing/sdk/crypto';
import { ed25519Backend } from '@licensing/sdk/crypto/ed25519';
import { type LIC1Header, encode as lic1Encode } from '@licensing/sdk/lic1';

export interface ForgedToken {
  readonly token: string;
  readonly registry: AlgorithmRegistry;
  readonly bindings: KeyAlgBindings;
  readonly keys: ReadonlyMap<string, KeyRecord>;
  readonly kid: string;
  readonly alg: 'ed25519';
}

/**
 * Produce a valid LIC1 token and a matching verify-context in one shot.
 * Caller passes a partial payload; required claims default to sensible
 * values.
 */
export async function forgeToken(
  payloadOverrides: Readonly<Record<string, unknown>> = {},
  opts: { kid?: string; nowSec?: number } = {},
): Promise<ForgedToken> {
  const kid = opts.kid ?? 'test-kid';
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const { pem, raw } = await ed25519Backend.generate('');
  const privateHandle = await ed25519Backend.importPrivate(pem, '');

  const header: LIC1Header = { v: 1, typ: 'lic', alg: 'ed25519', kid };
  const payload = {
    jti: 'test-jti',
    iat: now,
    nbf: now - 60,
    exp: now + 3600,
    scope: 'test-scope',
    license_id: 'lic-1',
    usage_id: 'use-1',
    usage_fingerprint: 'fp-test',
    status: 'active',
    max_usages: 1,
    ...payloadOverrides,
  };
  const token = await lic1Encode({
    header,
    payload,
    privateKey: privateHandle,
    backend: ed25519Backend,
  });

  const registry = new AlgorithmRegistry();
  registry.register(ed25519Backend);
  const bindings = new KeyAlgBindings();
  bindings.bind(kid, 'ed25519');
  const keys = new Map<string, KeyRecord>([
    [
      kid,
      {
        kid,
        alg: 'ed25519',
        publicPem: pem.publicPem,
        privatePem: null,
        raw: { publicRaw: raw.publicRaw, privateRaw: null },
      },
    ],
  ]);
  return { token, registry, bindings, keys, kid, alg: 'ed25519' };
}

/** Tiny `fetch` mock. Returns a function mimicking the fetch signature
 *  that yields a JSON response with the given status + body. */
export function mockFetchJson(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): (url: string, init?: RequestInit) => Promise<Response> {
  return async (_url: string, _init?: RequestInit) => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  };
}

/** Fetch mock that throws a network error on every call. */
export function mockFetchNetworkError(
  message = 'ECONNREFUSED',
): (url: string, init?: RequestInit) => Promise<Response> {
  return async (_url: string, _init?: RequestInit) => {
    throw new Error(message);
  };
}
