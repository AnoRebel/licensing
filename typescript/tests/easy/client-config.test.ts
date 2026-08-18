/**
 * Client constructor config validation.
 *
 * `Client` is the device-side half of the SDK: it speaks HTTP to an issuer.
 * Constructing it like the in-process `Issuer` — `new Client({ db, signing })`
 * — used to fail deep inside a private URL helper with
 * "undefined is not an object (evaluating 's.endsWith')", which names an
 * internal function rather than the missing field. Go's `easy.NewClient`
 * already rejected an empty ServerURL; these tests hold the ports to the
 * same behaviour.
 */

import { describe, expect, it } from 'bun:test';

import { Client } from '@anorebel/licensing';

describe('new Client() config validation', () => {
  it('rejects a missing serverUrl with an actionable message', () => {
    // @ts-expect-error — deliberately omitting the required field, which is
    // what a JavaScript (untypechecked) caller can actually do.
    expect(() => new Client({})).toThrow(/requires `serverUrl`/);
  });

  it('names both halves of the SDK so the caller can self-correct', () => {
    let message = '';
    try {
      // @ts-expect-error — see above.
      new Client({});
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('device-side');
    expect(message).toContain('Issuer');
    // The old failure leaked a private helper's internals.
    expect(message).not.toContain('endsWith');
  });

  it('rejects an empty serverUrl', () => {
    expect(() => new Client({ serverUrl: '' })).toThrow(/requires `serverUrl`/);
  });

  it('rejects the Issuer-shaped config a reader of the README might try', () => {
    // @ts-expect-error — the exact shape that motivated this guard.
    expect(() => new Client({ db: {}, signing: { passphrase: 'pw' } })).toThrow(
      /requires `serverUrl`/,
    );
  });

  it('accepts a valid serverUrl', () => {
    expect(() => new Client({ serverUrl: 'https://license.example.com' })).not.toThrow();
  });

  it('still normalises a trailing slash', () => {
    expect(() => new Client({ serverUrl: 'https://license.example.com/' })).not.toThrow();
  });
});
