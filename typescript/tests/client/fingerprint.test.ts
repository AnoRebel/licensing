import { describe, expect, it } from 'bun:test';
import {
  collectFingerprint,
  defaultFingerprintSources,
  type FingerprintSource,
  fingerprintFromSources,
} from '../../src/client/fingerprint.ts';

describe('fingerprintFromSources', () => {
  it('returns a 64-char lowercase hex SHA-256', () => {
    const fp = fingerprintFromSources(['a', 'b']);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across input order', () => {
    expect(fingerprintFromSources(['a', 'b', 'c'])).toBe(fingerprintFromSources(['c', 'a', 'b']));
  });

  it('differs for different inputs', () => {
    expect(fingerprintFromSources(['a'])).not.toBe(fingerprintFromSources(['b']));
  });

  it('rejects empty source list', () => {
    expect(() => fingerprintFromSources([])).toThrow('at least one source');
  });

  it('rejects empty strings', () => {
    expect(() => fingerprintFromSources([''])).toThrow('non-empty');
  });

  it('rejects embedded newlines', () => {
    expect(() => fingerprintFromSources(['a\nb'])).toThrow('newline');
  });
});

describe('collectFingerprint', () => {
  const src = (name: string, value: string | null): FingerprintSource => ({
    name,
    collect: () => value,
  });

  it('filters out nulls but still hashes remaining', async () => {
    const fp = await collectFingerprint([src('a', 'hello'), src('b', null)]);
    expect(fp).toBe(fingerprintFromSources(['hello']));
  });

  it('throws when every source returns null', async () => {
    await expect(collectFingerprint([src('a', null), src('b', null)])).rejects.toThrow(
      'all configured fingerprint sources returned null',
    );
  });

  it('awaits async sources', async () => {
    const asyncSrc: FingerprintSource = {
      name: 'x',
      collect: () => Promise.resolve('async-value'),
    };
    const fp = await collectFingerprint([asyncSrc]);
    expect(fp).toBe(fingerprintFromSources(['async-value']));
  });

  it('empty strings from sources are treated as null', async () => {
    const fp = await collectFingerprint([src('a', 'real'), src('b', '')]);
    expect(fp).toBe(fingerprintFromSources(['real']));
  });
});

describe('defaultFingerprintSources', () => {
  it('requires a non-empty salt', () => {
    expect(() => defaultFingerprintSources('')).toThrow('appSalt must be a non-empty');
  });

  it('returns the four default sources in a fixed order', () => {
    const srcs = defaultFingerprintSources('my-app');
    expect(srcs.map((s) => s.name)).toEqual(['os.id', 'machine.id', 'net.primaryMac', 'app.salt']);
  });

  it('salt source collects deterministically', async () => {
    const srcs = defaultFingerprintSources('my-app');
    const salt = srcs.find((s) => s.name === 'app.salt');
    expect(salt).toBeDefined();
    if (!salt) return; // narrow for TS; unreachable after the expect above
    expect(await salt.collect()).toBe('salt:my-app');
  });

  it('fingerprint is stable across two collections on this machine', async () => {
    const srcs = defaultFingerprintSources('test-salt');
    const a = await collectFingerprint(srcs);
    const b = await collectFingerprint(srcs);
    expect(a).toBe(b);
  });

  it('custom source list replaces defaults entirely', async () => {
    const custom: readonly FingerprintSource[] = [
      { name: 'only-one', collect: () => 'custom-value' },
    ];
    const fp = await collectFingerprint(custom);
    expect(fp).toBe(fingerprintFromSources(['custom-value']));
  });
});
