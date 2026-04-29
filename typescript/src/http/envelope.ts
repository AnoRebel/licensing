/**
 * Envelope helpers. Every handler response flows through `ok()` or `err()`
 * so the wire format stays consistent and contract-testable.
 */

import { LicensingError, type LicensingErrorCode } from '../errors.ts';
import type { HandlerResponse, JsonValue } from './types.ts';

/** Success envelope + HTTP status. 200 is the universal default; CRUD
 *  creates use 201, idempotent deletes use 204 (via `noContent()`). */
export function ok<T extends JsonValue>(data: T, status = 200): HandlerResponse {
  return { status, body: { success: true, data } };
}

/** 201 Created helper. */
export function created<T extends JsonValue>(data: T): HandlerResponse {
  return ok(data, 201);
}

/** 204 No Content. Adapters MUST omit the body entirely (not serialize
 *  `null`), which is why `body` is `undefined` — not `null`. */
export function noContent(): HandlerResponse {
  return { status: 204 };
}

/** Error envelope + HTTP status. Extra headers (e.g., `Retry-After`) may
 *  be supplied for specific error classes. */
export function err(
  status: number,
  code: string,
  message: string,
  headers?: Readonly<Record<string, string>>,
): HandlerResponse {
  const response: HandlerResponse = {
    status,
    body: { success: false, error: { code, message } },
  };
  if (headers !== undefined) {
    return { ...response, headers };
  }
  return response;
}

/** Map a `LicensingErrorCode` to its canonical HTTP status. Unlisted codes
 *  default to 500 — callers SHOULD surface every code explicitly from their
 *  handler logic rather than relying on this fallback. */
const ERROR_STATUS: Readonly<Record<LicensingErrorCode, number>> = {
  // 400 — malformed input / canonical JSON failures
  CanonicalJSONInvalidType: 400,
  CanonicalJSONInvalidNumber: 400,
  CanonicalJSONInvalidUTF8: 400,
  CanonicalJSONInvalidTopLevel: 400,
  CanonicalJSONDuplicateKey: 400,
  CanonicalJSONUnknownField: 400,
  TokenMalformed: 400,
  UnsupportedTokenFormat: 400,
  InvalidLicenseKey: 404, // "Activate with invalid key returns 404"
  // 401 — auth
  Unauthenticated: 401,
  TokenSignatureInvalid: 401,
  TokenExpired: 401,
  TokenNotYetValid: 401,
  // 403 — policy / lifecycle block at the door
  FingerprintRejected: 403,
  LicenseSuspended: 403,
  LicenseRevoked: 403,
  LicenseExpired: 403,
  GraceExpired: 403,
  // 404 — not found
  LicenseNotFound: 404,
  UnknownKid: 404,
  // 409 — conflicts
  LicenseKeyConflict: 409,
  UniqueConstraintViolation: 409,
  SeatLimitExceeded: 409,
  IllegalLifecycleTransition: 409,
  TemplateCycle: 409,
  // 422 — crypto preconditions the caller got wrong
  UnsupportedAlgorithm: 422,
  AlgorithmAlreadyRegistered: 422,
  AlgorithmMismatch: 422,
  InsufficientKeyStrength: 422,
  MissingKeyPassphrase: 422,
  KeyDecryptionFailed: 422,
  // 429 — rate limit
  RateLimited: 429,
  // 500 — write-side invariants that should never escape to a client,
  // but are here for completeness so the table type-checks.
  ImmutableAuditLog: 500,
};

/** Translate a thrown `LicensingError` into a canonical error envelope.
 *  Non-`LicensingError` throws become a generic 500 with code
 *  `InternalError` — those are the caller's bugs and must not leak
 *  their `.message` (often stack traces) onto the wire. */
export function errFromLicensing(e: unknown): HandlerResponse {
  if (e instanceof LicensingError) {
    const status = ERROR_STATUS[e.code] ?? 500;
    return err(status, e.code, e.message);
  }
  // Intentionally opaque — see doc comment above.
  return err(500, 'InternalError', 'an unexpected error occurred');
}
