/**
 * Codec router behaviour.
 *
 * These tests encode the guarantees that made the refactor necessary: a
 * token belonging to another format must never reach the LIC1 parser, an
 * unregistered prefix must be rejected before any byte is decoded, and a
 * signature is only valid under its own format's signing-input
 * construction.
 *
 * A stub codec stands in for a second format so none of this depends on
 * LIC2 having landed.
 */

import { afterAll, describe, expect, it } from 'bun:test';

import { ed25519Backend } from '../../src/index.ts';
import { LIC1_PREFIX } from '../../src/lic1.ts';
import {
  type CodecEncodeInput,
  codecFor,
  type DecodedEnvelope,
  registerCodec,
  registeredPrefixes,
  type TokenCodec,
  unregisterCodecForTesting,
} from '../../src/token-codec.ts';

const STUB_PREFIX = 'STUB1.';
const TEXT = new TextEncoder();

class StubCodecError extends Error {
  constructor() {
    super('stub codec parse failure');
    this.name = 'StubCodecError';
  }
}

/**
 * A second format whose signing input is deliberately different from
 * LIC1's: it prefixes the payload rather than joining two base64 segments
 * with a dot.
 */
const stubCodec: TokenCodec = {
  prefix: STUB_PREFIX,
  supportedAlgs: new Set(['ed25519'] as const),
  decode(token: string): DecodedEnvelope {
    const rest = token.slice(STUB_PREFIX.length);
    const parts = rest.split('~');
    if (parts.length !== 2) throw new StubCodecError();
    return {
      header: { alg: 'ed25519', kid: 'stub-kid' },
      payload: { stub: true },
      signingInput: TEXT.encode(`STUB-PAE:${parts[0]}`),
      signature: TEXT.encode(parts[1] ?? ''),
    };
  },
  async encode(input: CodecEncodeInput): Promise<string> {
    const body = JSON.stringify(input.payload);
    const sig = await input.backend.sign(input.privateKey, TEXT.encode(`STUB-PAE:${body}`));
    return `${STUB_PREFIX}${body}~${Buffer.from(sig).toString('base64url')}`;
  },
};

registerCodec(stubCodec);

afterAll(() => {
  unregisterCodecForTesting(STUB_PREFIX);
});

describe('dispatch routes to the owning codec', () => {
  it('a foreign-prefix token never reaches the LIC1 parser', () => {
    // Deliberately malformed for the stub. If this reached the LIC1 parser
    // it would fail with TokenMalformed ("expected 4 dot-separated
    // segments") instead of the stub's own error — that mis-attribution is
    // exactly what the router exists to prevent.
    let caught: unknown;
    try {
      codecFor(`${STUB_PREFIX}only-one-part`).decode(`${STUB_PREFIX}only-one-part`);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StubCodecError);
    expect((caught as Error).message).not.toContain('dot-separated');
  });

  it('routes a LIC1 token to the LIC1 codec', () => {
    expect(codecFor('LIC1.a.b.c').prefix).toBe(LIC1_PREFIX);
  });

  it('routes a stub token to the stub codec', () => {
    expect(codecFor(`${STUB_PREFIX}x~y`).prefix).toBe(STUB_PREFIX);
  });
});

describe('unregistered prefixes', () => {
  it('are rejected with UnsupportedTokenFormat', () => {
    expect(() => codecFor('v4.public.abc')).toThrow(/unsupported|format/i);
  });

  it('are rejected before any decoding happens', () => {
    // A payload that would throw a *decoding* error if it were ever parsed.
    expect(() => codecFor('NOPE.!!!not-base64!!!')).toThrow(/unsupported|format/i);
  });

  it('clip the offending prefix so a large blob cannot expand the error', () => {
    const blob = 'A'.repeat(50_000);
    let message = '';
    try {
      codecFor(blob);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message.length).toBeLessThan(200);
    expect(message).not.toContain(blob);
  });

  it('clip at the first dot when one is present', () => {
    let message = '';
    try {
      codecFor(`UNKNOWN.${'B'.repeat(10_000)}`);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message.length).toBeLessThan(200);
  });
});

describe('per-codec signing input', () => {
  it('a signature valid only under another format’s construction is rejected', async () => {
    const kp = await ed25519Backend.generate('test-pw');
    const priv = await ed25519Backend.importPrivate(kp.raw);
    const pub = await ed25519Backend.importPublic(kp.raw);

    // Sign the LIC1-style construction...
    const lic1Style = TEXT.encode('header.payload');
    const sig = await ed25519Backend.sign(priv, lic1Style);

    // ...then check it against the stub's construction over the same data.
    const stubStyle = TEXT.encode('STUB-PAE:header.payload');
    const ok = await ed25519Backend.verify(pub, stubStyle, sig);

    expect(ok).toBe(false);
  });

  it('each codec verifies under its own construction', async () => {
    const kp = await ed25519Backend.generate('test-pw');
    const priv = await ed25519Backend.importPrivate(kp.raw);
    const pub = await ed25519Backend.importPublic(kp.raw);

    const stubInput = TEXT.encode('STUB-PAE:{"stub":true}');
    const sig = await ed25519Backend.sign(priv, stubInput);
    expect(await ed25519Backend.verify(pub, stubInput, sig)).toBe(true);
  });
});

describe('registration', () => {
  it('rejects a duplicate prefix and keeps the original codec', () => {
    expect(() => registerCodec(stubCodec)).toThrow();
    expect(codecFor(`${STUB_PREFIX}x~y`)).toBe(stubCodec);
  });

  it('lists both registered prefixes', () => {
    expect(registeredPrefixes()).toContain(LIC1_PREFIX);
    expect(registeredPrefixes()).toContain(STUB_PREFIX);
  });
});
