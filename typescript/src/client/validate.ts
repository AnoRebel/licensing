/**
 * Offline token validation.
 *
 * Validation runs entirely offline against a pre-configured public-key
 * registry. Order matters and is chosen for minimum-information-leak:
 *
 *   1. Parse + verify signature. Malformed envelopes and bad signatures
 *      never get the chance to be examined for other fields.
 *   2. `nbf` / `exp` with a skew tolerance (default ±60s).
 *   3. Claim shape: required claims present and typed correctly. Without
 *      this, a malicious issuer with a compromised key could hand us a
 *      well-signed but structurally incomplete token.
 *   4. Status: must be `active` or `grace`. Suspended / revoked / expired
 *      get distinct error codes.
 *   5. `force_online_after` — if the deadline is past, validation fails
 *      with `RequiresOnlineRefresh` regardless of signature/exp. The
 *      caller (usually `refresh()`) decides whether to enter grace.
 *   6. Fingerprint match. Checked last so that an expired token produces
 *      `TokenExpired` even when the fingerprint also mismatches (the more
 *      informative error wins).
 */

import type { AlgorithmRegistry, KeyAlgBindings, KeyRecord } from '../crypto/index.ts';
import { decodeUnverified, type LIC1DecodedParts, verify } from '../lic1.ts';

import { clientErrors } from './errors.ts';

export interface ValidateOptions {
  /** Algorithm registry (populated with the same backends the issuer uses).
   *  Clients typically register only the one algorithm they were provisioned
   *  for — e.g. just `ed25519Backend` — to keep the attack surface narrow. */
  readonly registry: AlgorithmRegistry;
  /** Pre-registered kid → alg bindings. Prevents alg-confusion: a token
   *  whose header `alg` disagrees with the bound alg for its kid fails. */
  readonly bindings: KeyAlgBindings;
  /** Public keys the client trusts, keyed by kid. Private key halves MAY
   *  be null — clients never need to sign. */
  readonly keys: ReadonlyMap<string, KeyRecord>;
  /** The device's current fingerprint. Usually derived via
   *  {@link collectFingerprint}; here passed explicitly so validation is
   *  pure (no I/O inside). */
  readonly fingerprint: string;
  /** Current wall-clock unix seconds. Injected for testability — real
   *  callers pass `Math.floor(Date.now() / 1000)`. */
  readonly nowSec: number;
  /** Clock-skew tolerance applied to `nbf` and `exp` checks in both
   *  directions. Default 60s. Set to 0 for strict checks. */
  readonly skewSec?: number;
}

export interface ValidateResult {
  readonly kid: string;
  readonly alg: string;
  readonly license_id: string;
  readonly usage_id: string;
  readonly scope: string;
  readonly status: 'active' | 'grace';
  readonly max_usages: number;
  readonly iat: number;
  readonly nbf: number;
  readonly exp: number;
  /** Absolute unix-seconds deadline, absent when the token doesn't carry one. */
  readonly forceOnlineAfter: number | null;
  readonly entitlements: Readonly<Record<string, unknown>> | null;
}

/**
 * Validate a stored token entirely offline. Returns the decoded result on
 * success; throws a {@link LicensingClientError} with a specific `.code`
 * on any failure.
 */
export async function validate(token: string, opts: ValidateOptions): Promise<ValidateResult> {
  const skew = opts.skewSec ?? 60;

  // 1. Parse + cryptographic verify. `verify` already gates on kid binding
  //    (alg-confusion), unknown kid, and signature validity — we translate
  //    those core errors into client-facing codes below.
  let parts: LIC1DecodedParts;
  try {
    parts = await verify(token, {
      registry: opts.registry,
      bindings: opts.bindings,
      keys: opts.keys,
    });
  } catch (err) {
    throw translateVerifyError(err);
  }

  const { header, payload } = parts;
  const claims = assertClaimShape(payload);

  // 2. nbf / exp.
  if (claims.nbf > opts.nowSec + skew) {
    throw clientErrors.tokenNotYetValid(`nbf=${claims.nbf} now=${opts.nowSec} skew=${skew}`);
  }
  if (claims.exp + skew < opts.nowSec) {
    throw clientErrors.tokenExpired(`exp=${claims.exp} now=${opts.nowSec} skew=${skew}`);
  }

  // 3. Status — usable set is {'active', 'grace'}. Other values would
  //    only appear if the issuer misbehaves, but we handle them
  //    explicitly for a clearer error taxonomy.
  switch (claims.status) {
    case 'active':
    case 'grace':
      break;
    case 'suspended':
      throw clientErrors.licenseSuspended();
    case 'revoked':
      throw clientErrors.licenseRevoked();
    case 'expired':
      throw clientErrors.tokenExpired('token carries status=expired');
    default:
      throw clientErrors.invalidTokenFormat(`unknown status: ${claims.status}`);
  }

  // 4. force_online_after — if present and past, client MUST refresh.
  //    Skew doesn't apply here: the deadline is a hard operational boundary
  //    the issuer chose; treating it fuzzily defeats the purpose.
  if (claims.force_online_after !== null && claims.force_online_after <= opts.nowSec) {
    throw clientErrors.requiresOnlineRefresh(
      `force_online_after=${claims.force_online_after} now=${opts.nowSec}`,
    );
  }

  // 5. Fingerprint match — last so earlier failures dominate. A fingerprint
  //    mismatch usually means the user moved hardware and needs activation,
  //    whereas exp/status failures are recoverable differently.
  if (claims.usage_fingerprint !== opts.fingerprint) {
    throw clientErrors.fingerprintMismatch();
  }

  return {
    kid: header.kid,
    alg: header.alg,
    license_id: claims.license_id,
    usage_id: claims.usage_id,
    scope: claims.scope,
    status: claims.status,
    max_usages: claims.max_usages,
    iat: claims.iat,
    nbf: claims.nbf,
    exp: claims.exp,
    forceOnlineAfter: claims.force_online_after,
    entitlements: claims.entitlements,
  };
}

/**
 * Peek at a token's header + payload without verifying the signature. Useful
 * when the client needs to decide whether a refresh is due ("how much
 * lifetime is left?") before paying the verification cost. Consumers MUST
 * NOT trust the returned data for authorization decisions.
 */
export function peek(token: string): PeekResult {
  try {
    const { header, payload } = decodeUnverified(token);
    const claims = assertClaimShape(payload);
    return {
      kid: header.kid,
      alg: header.alg,
      iat: claims.iat,
      nbf: claims.nbf,
      exp: claims.exp,
      forceOnlineAfter: claims.force_online_after,
    };
  } catch (err) {
    throw clientErrors.invalidTokenFormat(
      `token could not be parsed`,
      err instanceof Error ? err : new Error(String(err)),
    );
  }
}

export interface PeekResult {
  readonly kid: string;
  readonly alg: string;
  readonly iat: number;
  readonly nbf: number;
  readonly exp: number;
  readonly forceOnlineAfter: number | null;
}

// ---------- internals ----------

/** Narrow validated-claims view over the opaque `LIC1Payload`. */
interface RequiredClaims {
  readonly jti: string;
  readonly iat: number;
  readonly nbf: number;
  readonly exp: number;
  readonly scope: string;
  readonly license_id: string;
  readonly usage_id: string;
  readonly usage_fingerprint: string;
  readonly status: string;
  readonly max_usages: number;
  readonly force_online_after: number | null;
  readonly entitlements: Readonly<Record<string, unknown>> | null;
}

function assertClaimShape(payload: Readonly<Record<string, unknown>>): RequiredClaims {
  const req = (key: string) => {
    if (!(key in payload)) {
      throw clientErrors.invalidTokenFormat(`missing required claim: ${key}`);
    }
    return payload[key];
  };
  const asString = (key: string, v: unknown): string => {
    if (typeof v !== 'string') {
      throw clientErrors.invalidTokenFormat(`claim ${key} is not a string`);
    }
    return v;
  };
  const asNumber = (key: string, v: unknown): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw clientErrors.invalidTokenFormat(`claim ${key} is not a finite number`);
    }
    return v;
  };

  return {
    jti: asString('jti', req('jti')),
    iat: asNumber('iat', req('iat')),
    nbf: asNumber('nbf', req('nbf')),
    exp: asNumber('exp', req('exp')),
    scope: asString('scope', req('scope')),
    license_id: asString('license_id', req('license_id')),
    usage_id: asString('usage_id', req('usage_id')),
    usage_fingerprint: asString('usage_fingerprint', req('usage_fingerprint')),
    status: asString('status', req('status')),
    max_usages: asNumber('max_usages', req('max_usages')),
    force_online_after:
      'force_online_after' in payload && payload.force_online_after !== null
        ? asNumber('force_online_after', payload.force_online_after)
        : null,
    entitlements:
      'entitlements' in payload && payload.entitlements !== null
        ? (() => {
            const v = payload.entitlements;
            if (typeof v !== 'object' || Array.isArray(v)) {
              throw clientErrors.invalidTokenFormat('entitlements must be an object');
            }
            return v as Readonly<Record<string, unknown>>;
          })()
        : null,
  };
}

/** Translate a core `verify()` error into the client-side taxonomy. Core
 *  raises `LicensingError` instances with a `.code` matching the issuer-side
 *  enum; we map the subset that can surface on a client offline. */
function translateVerifyError(err: unknown): Error {
  const code = (err as { code?: unknown })?.code;
  const message = err instanceof Error ? err.message : String(err);
  switch (code) {
    case 'UnknownKid':
      return clientErrors.unknownKid(message);
    case 'AlgorithmMismatch':
      return clientErrors.algorithmMismatch('?', message);
    case 'UnsupportedAlgorithm':
      return clientErrors.unsupportedAlgorithm(message);
    case 'TokenSignatureInvalid':
    case 'TokenFormat':
    case 'UnsupportedTokenFormat':
      return clientErrors.invalidTokenFormat(message, err);
    default:
      return clientErrors.invalidTokenFormat(`unexpected verify failure: ${message}`, err);
  }
}
