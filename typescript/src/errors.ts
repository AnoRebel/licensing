/**
 * Typed error hierarchy for the licensing issuer core.
 *
 * Every thrown error in `@anorebel/licensing` (and the sibling crypto / storage
 * packages) is a subclass of `LicensingError`. Consumers can discriminate via
 * the `.code` string — stable across versions and matched 1:1 with the Go
 * sentinel-error identifiers in `github.com/AnoRebel/licensing`.
 *
 * The code set is the authoritative error taxonomy. When adding a new code,
 * update both this file and `licensing/errors.go` in lockstep — the
 * cross-language interop test asserts parity.
 */

export type LicensingErrorCode =
  // Canonical JSON
  | 'CanonicalJSONInvalidType'
  | 'CanonicalJSONInvalidNumber'
  | 'CanonicalJSONInvalidUTF8'
  | 'CanonicalJSONInvalidTopLevel'
  | 'CanonicalJSONDuplicateKey'
  | 'CanonicalJSONUnknownField'
  // Token format
  | 'UnsupportedTokenFormat'
  | 'TokenMalformed'
  | 'TokenSignatureInvalid'
  | 'TokenExpired'
  | 'TokenNotYetValid'
  // Crypto
  | 'UnsupportedAlgorithm'
  | 'AlgorithmAlreadyRegistered'
  | 'AlgorithmMismatch'
  | 'UnknownKid'
  | 'InsufficientKeyStrength'
  | 'MissingKeyPassphrase'
  | 'KeyDecryptionFailed'
  // Licenses & usages
  | 'LicenseKeyConflict'
  | 'LicenseNotFound'
  | 'LicenseRevoked'
  | 'LicenseSuspended'
  | 'LicenseExpired'
  | 'IllegalLifecycleTransition'
  | 'SeatLimitExceeded'
  | 'FingerprintRejected'
  | 'InvalidLicenseKey'
  // Storage
  | 'ImmutableAuditLog'
  | 'UniqueConstraintViolation'
  | 'TemplateCycle'
  // Grace / client
  | 'GraceExpired'
  // Auth / transport
  | 'Unauthenticated'
  | 'RateLimited';

/** Base class for every error thrown by the licensing libraries. */
export class LicensingError extends Error {
  public readonly code: LicensingErrorCode;
  public readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: LicensingErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    if (details !== undefined) this.details = details;
    // Preserve the original stack frame that native Error would have captured.
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, new.target);
    }
  }
}

// -- Convenience subclasses so callers can `catch (e instanceof ...)` when
// -- they want structural discrimination instead of a `.code` switch.

export class CanonicalJSONError extends LicensingError {}
export class TokenFormatError extends LicensingError {}
export class CryptoError extends LicensingError {}
export class LifecycleError extends LicensingError {}
export class StorageError extends LicensingError {}
export class TransportError extends LicensingError {}

/** Helper factories keep the constructor boilerplate out of call sites. */
export const errors = {
  canonicalInvalidType: (message: string, details?: Record<string, unknown>): CanonicalJSONError =>
    new CanonicalJSONError('CanonicalJSONInvalidType', message, details),
  canonicalInvalidNumber: (
    message: string,
    details?: Record<string, unknown>,
  ): CanonicalJSONError => new CanonicalJSONError('CanonicalJSONInvalidNumber', message, details),
  canonicalInvalidUTF8: (message: string, details?: Record<string, unknown>): CanonicalJSONError =>
    new CanonicalJSONError('CanonicalJSONInvalidUTF8', message, details),
  canonicalInvalidTopLevel: (message: string): CanonicalJSONError =>
    new CanonicalJSONError('CanonicalJSONInvalidTopLevel', message),
  canonicalDuplicateKey: (key: string): CanonicalJSONError =>
    new CanonicalJSONError('CanonicalJSONDuplicateKey', `duplicate key: ${key}`, { key }),
  canonicalUnknownField: (field: string): CanonicalJSONError =>
    new CanonicalJSONError('CanonicalJSONUnknownField', `unknown field: ${field}`, { field }),

  unsupportedTokenFormat: (prefix: string): TokenFormatError =>
    new TokenFormatError(
      'UnsupportedTokenFormat',
      `unsupported token format prefix: ${JSON.stringify(prefix)}`,
      { prefix },
    ),
  tokenMalformed: (reason: string): TokenFormatError =>
    new TokenFormatError('TokenMalformed', `malformed LIC1 token: ${reason}`),
  tokenSignatureInvalid: (): TokenFormatError =>
    new TokenFormatError('TokenSignatureInvalid', 'token signature verification failed'),
  tokenExpired: (): TokenFormatError => new TokenFormatError('TokenExpired', 'token has expired'),
  tokenNotYetValid: (): TokenFormatError =>
    new TokenFormatError('TokenNotYetValid', 'token is not yet valid'),

  unsupportedAlgorithm: (alg: string): CryptoError =>
    new CryptoError('UnsupportedAlgorithm', `no backend registered for alg: ${alg}`, { alg }),
  algorithmAlreadyRegistered: (alg: string): CryptoError =>
    new CryptoError(
      'AlgorithmAlreadyRegistered',
      `a backend is already registered for alg: ${alg}`,
      { alg },
    ),
  algorithmMismatch: (expected: string, actual: string): CryptoError =>
    new CryptoError(
      'AlgorithmMismatch',
      `alg mismatch for kid: expected ${expected}, got ${actual}`,
      { expected, actual },
    ),
  unknownKid: (kid: string): CryptoError =>
    new CryptoError('UnknownKid', `unknown kid: ${kid}`, { kid }),
  insufficientKeyStrength: (reason: string): CryptoError =>
    new CryptoError('InsufficientKeyStrength', reason),
  missingKeyPassphrase: (): CryptoError =>
    new CryptoError('MissingKeyPassphrase', 'key passphrase is required and must not be empty'),
  keyDecryptionFailed: (): CryptoError =>
    new CryptoError('KeyDecryptionFailed', 'private key decryption failed (bad passphrase?)'),

  // Storage
  uniqueConstraintViolation: (constraint: string, value: string): StorageError =>
    new StorageError(
      'UniqueConstraintViolation',
      `unique constraint violated: ${constraint} = ${value}`,
      { constraint, value },
    ),
  immutableAuditLog: (): StorageError =>
    new StorageError('ImmutableAuditLog', 'audit log rows are append-only and cannot be mutated'),
  /** Inserting/updating a template such that the parent chain forms a cycle. */
  templateCycle: (templateId: string, parentChain: readonly string[]): StorageError =>
    new StorageError('TemplateCycle', `template parent chain forms a cycle through ${templateId}`, {
      templateId,
      parentChain: [...parentChain],
    }),

  // Lifecycle
  licenseNotFound: (id: string): LifecycleError =>
    new LifecycleError('LicenseNotFound', `license not found: ${id}`, { id }),
  licenseRevoked: (): LifecycleError => new LifecycleError('LicenseRevoked', 'license is revoked'),
  licenseSuspended: (): LifecycleError =>
    new LifecycleError('LicenseSuspended', 'license is suspended'),
  licenseExpired: (): LifecycleError => new LifecycleError('LicenseExpired', 'license has expired'),
  seatLimitExceeded: (max: number, current: number): LifecycleError =>
    new LifecycleError('SeatLimitExceeded', `seat limit exceeded: ${current}/${max}`, {
      max,
      current,
    }),
  fingerprintRejected: (reason: string): LifecycleError =>
    new LifecycleError('FingerprintRejected', reason),
  illegalLifecycleTransition: (from: string, to: string): LifecycleError =>
    new LifecycleError(
      'IllegalLifecycleTransition',
      `illegal lifecycle transition: ${from} → ${to}`,
      { from, to },
    ),
  invalidLicenseKey: (): LifecycleError =>
    new LifecycleError('InvalidLicenseKey', 'license key format is invalid or unrecognized'),
  licenseKeyConflict: (key: string): LifecycleError =>
    new LifecycleError('LicenseKeyConflict', `license key already exists: ${key}`, { key }),

  // Grace / client
  graceExpired: (): LifecycleError =>
    new LifecycleError('GraceExpired', 'grace period exhausted; license is now expired'),

  // Transport
  unauthenticated: (): TransportError =>
    new TransportError('Unauthenticated', 'request is missing or presents invalid credentials'),
  rateLimited: (): TransportError =>
    new TransportError('RateLimited', 'request rate limit exceeded'),
};
