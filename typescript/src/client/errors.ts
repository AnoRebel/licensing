/**
 * Client-side error taxonomy.
 *
 * Consumers branch on `error.code` (stable machine-readable identifier)
 * rather than matching on `.message` or `instanceof` trees; the code set is
 * the contract.
 *
 * We diverge from core's error module (which has its own identifiers
 * matching the issuer-side surface) because the client operates against a
 * narrower surface — issuer RPCs plus local token checks — and most codes
 * here map to either a client-local decision (e.g. `NoToken`, `GraceExpired`)
 * or an issuer
 * response (e.g. `RateLimited`, `InvalidLicenseKey`).
 */

/** Stable machine-readable identifiers for the client error taxonomy;
 *  the literal union doubles as the `code` field's type. */
export type ClientErrorCode =
  | 'InvalidLicenseKey'
  | 'FingerprintMismatch'
  | 'TokenExpired'
  | 'TokenNotYetValid'
  | 'SeatLimitExceeded'
  | 'LicenseRevoked'
  | 'LicenseSuspended'
  | 'RequiresOnlineRefresh'
  | 'GraceExpired'
  | 'NoToken'
  | 'IssuerUnreachable'
  | 'IssuerProtocolError'
  | 'RateLimited'
  | 'InvalidTokenFormat'
  | 'UnsupportedAlgorithm'
  | 'AlgorithmMismatch'
  | 'UnknownKid';

/**
 * Single concrete error class. All client failures surface as
 * `LicensingClientError`; consumers branch on `.code` (a typed union) rather
 * than on class identity. This mirrors core's single-class-with-code pattern,
 * keeping consumer-side type guards simple:
 *
 *   if (err instanceof LicensingClientError && err.code === 'SeatLimitExceeded') {…}
 *
 * A single class also sidesteps the class-identity trap across realm
 * boundaries (Web Workers, SSR/edge splits, dual-bundle consumers): `code`
 * is a string that survives serialization and module duplication.
 */
export class LicensingClientError extends Error {
  readonly code: ClientErrorCode;
  /** Optional HTTP status from the issuer (set on RPC-sourced errors). */
  readonly httpStatus?: number;
  /** Optional `Retry-After` seconds (set on 429 responses). */
  readonly retryAfterSec?: number;
  /** Optional underlying cause (network error, JSON parse failure, etc.). */
  override readonly cause?: unknown;

  constructor(
    code: ClientErrorCode,
    message: string,
    opts: {
      httpStatus?: number;
      retryAfterSec?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'LicensingClientError';
    this.code = code;
    if (opts.httpStatus !== undefined) this.httpStatus = opts.httpStatus;
    if (opts.retryAfterSec !== undefined) this.retryAfterSec = opts.retryAfterSec;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

/** Curried factory map — terser at call sites than `new LicensingClientError(...)`. */
export const clientErrors = {
  invalidLicenseKey: (msg = 'license key not recognized'): LicensingClientError =>
    new LicensingClientError('InvalidLicenseKey', msg),
  fingerprintMismatch: (
    msg = 'token fingerprint does not match current device',
  ): LicensingClientError => new LicensingClientError('FingerprintMismatch', msg),
  tokenExpired: (
    msg = 'token exp is in the past beyond the skew tolerance',
  ): LicensingClientError => new LicensingClientError('TokenExpired', msg),
  tokenNotYetValid: (
    msg = 'token nbf is in the future beyond the skew tolerance',
  ): LicensingClientError => new LicensingClientError('TokenNotYetValid', msg),
  seatLimitExceeded: (msg = 'license seat limit exceeded'): LicensingClientError =>
    new LicensingClientError('SeatLimitExceeded', msg),
  licenseRevoked: (msg = 'license has been revoked'): LicensingClientError =>
    new LicensingClientError('LicenseRevoked', msg),
  licenseSuspended: (msg = 'license is suspended'): LicensingClientError =>
    new LicensingClientError('LicenseSuspended', msg),
  requiresOnlineRefresh: (
    msg = 'token requires an online refresh (force_online_after passed)',
  ): LicensingClientError => new LicensingClientError('RequiresOnlineRefresh', msg),
  graceExpired: (
    msg = 'grace window has expired without a successful issuer contact',
  ): LicensingClientError => new LicensingClientError('GraceExpired', msg),
  noToken: (msg = 'no token stored locally'): LicensingClientError =>
    new LicensingClientError('NoToken', msg),
  issuerUnreachable: (
    msg = 'issuer endpoint could not be reached',
    cause?: unknown,
  ): LicensingClientError =>
    new LicensingClientError('IssuerUnreachable', msg, cause !== undefined ? { cause } : {}),
  issuerProtocolError: (
    msg = 'issuer process is up but the requested route is broken',
  ): LicensingClientError => new LicensingClientError('IssuerProtocolError', msg),
  rateLimited: (
    retryAfterSec: number,
    msg = 'issuer rate-limited this client',
  ): LicensingClientError =>
    new LicensingClientError('RateLimited', msg, { httpStatus: 429, retryAfterSec }),
  invalidTokenFormat: (
    msg = 'token is not a well-formed LIC1 envelope',
    cause?: unknown,
  ): LicensingClientError =>
    new LicensingClientError('InvalidTokenFormat', msg, cause !== undefined ? { cause } : {}),
  unsupportedAlgorithm: (alg: string): LicensingClientError =>
    new LicensingClientError('UnsupportedAlgorithm', `algorithm not registered: ${alg}`),
  algorithmMismatch: (expected: string, actual: string): LicensingClientError =>
    new LicensingClientError(
      'AlgorithmMismatch',
      `expected alg ${expected} for kid, got ${actual}`,
    ),
  unknownKid: (kid: string): LicensingClientError =>
    new LicensingClientError('UnknownKid', `no public key registered for kid: ${kid}`),
} as const;

/** Map an issuer-returned error code string (from the JSON envelope's
 *  `error.code`) to a client-side error. Unknown codes degrade to
 *  `IssuerUnreachable` with the original text preserved — better to treat
 *  an unrecognized failure as "try again later" than to silently drop it. */
export function fromIssuerCode(
  code: string,
  message: string,
  httpStatus: number,
  retryAfterSec?: number,
): LicensingClientError {
  const known = ISSUER_CODE_MAP[code];
  if (known !== undefined) {
    return new LicensingClientError(
      known,
      message,
      retryAfterSec !== undefined ? { httpStatus, retryAfterSec } : { httpStatus },
    );
  }
  return new LicensingClientError(
    'IssuerUnreachable',
    `unrecognized issuer error code ${code}: ${message}`,
    { httpStatus },
  );
}

/** Issuer-side error codes → client codes. Kept deliberately narrow;
 *  everything else falls through to `IssuerUnreachable`. */
const ISSUER_CODE_MAP: Readonly<Record<string, ClientErrorCode>> = {
  InvalidLicenseKey: 'InvalidLicenseKey',
  FingerprintRejected: 'FingerprintMismatch',
  SeatLimitExceeded: 'SeatLimitExceeded',
  LicenseRevoked: 'LicenseRevoked',
  LicenseSuspended: 'LicenseSuspended',
  LicenseExpired: 'TokenExpired',
  RateLimited: 'RateLimited',
  UnknownKid: 'UnknownKid',
  AlgorithmMismatch: 'AlgorithmMismatch',
  UnsupportedAlgorithm: 'UnsupportedAlgorithm',
};
