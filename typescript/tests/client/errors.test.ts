import { describe, expect, it } from 'bun:test';
import { clientErrors, fromIssuerCode, LicensingClientError } from '../../src/client/errors.ts';

describe('LicensingClientError', () => {
  it('carries a stable .code field', () => {
    const err = clientErrors.fingerprintMismatch();
    expect(err).toBeInstanceOf(LicensingClientError);
    expect(err.code).toBe('FingerprintMismatch');
    expect(err.message.length).toBeGreaterThan(0);
  });

  it('preserves cause on IssuerUnreachable', () => {
    const root = new Error('ECONNREFUSED');
    const err = clientErrors.issuerUnreachable('boom', root);
    expect(err.code).toBe('IssuerUnreachable');
    expect(err.cause).toBe(root);
  });

  it('rateLimited carries retryAfterSec + 429', () => {
    const err = clientErrors.rateLimited(45);
    expect(err.code).toBe('RateLimited');
    expect(err.httpStatus).toBe(429);
    expect(err.retryAfterSec).toBe(45);
  });
});

describe('fromIssuerCode', () => {
  it('maps known issuer codes to client codes', () => {
    const err = fromIssuerCode('FingerprintRejected', 'bad fp', 403);
    expect(err.code).toBe('FingerprintMismatch');
    expect(err.httpStatus).toBe(403);
  });

  it('maps LicenseExpired → TokenExpired', () => {
    expect(fromIssuerCode('LicenseExpired', 'old', 400).code).toBe('TokenExpired');
  });

  it('preserves RateLimited retry hint', () => {
    const err = fromIssuerCode('RateLimited', 'slow down', 429, 30);
    expect(err.code).toBe('RateLimited');
    expect(err.retryAfterSec).toBe(30);
  });

  it('degrades unknown codes to IssuerUnreachable with original text', () => {
    const err = fromIssuerCode('InternalMeltdown', 'kaboom', 500);
    expect(err.code).toBe('IssuerUnreachable');
    expect(err.message).toContain('InternalMeltdown');
    expect(err.message).toContain('kaboom');
  });
});
