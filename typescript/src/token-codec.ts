/**
 * Token codec registry — prefix → codec routing.
 *
 * Before this module existed, `registerFormat` maintained a bare list of
 * permitted prefixes and every token that passed the check was handed to
 * the LIC1 parser. That made a second format impossible to add safely:
 * registering `v4.public.` would have routed a PASETO token into the LIC1
 * parser, which would then have failed with a LIC1-shaped `TokenMalformed`
 * instead of the real reason. The old code said so in a comment and told
 * callers not to register anything else until this landed.
 *
 * A codec owns three things for its format:
 *
 *   - `decode`   — token string → decoded envelope
 *   - `signingInput` — the bytes a signature is computed over
 *   - `encode`   — claims + signature → token string
 *
 * `signingInput` is per-codec because the constructions genuinely differ:
 * LIC1 concatenates `<header_b64>.<payload_b64>` as ASCII, while PASETO
 * uses PAE (pre-authentication encoding) over a length-prefixed vector.
 * Verification therefore asks the token's own codec for its signing input
 * and never assumes a shared shape.
 */

import type { KeyRecord, PrivateKeyHandle, SignatureBackend } from './crypto/types.ts';
import { errors } from './errors.ts';
import type { KeyAlg } from './types.ts';

/**
 * The common envelope every codec decodes to. `header` carries the fields
 * verification needs regardless of format — which key, which algorithm —
 * so the verify path stays format-agnostic.
 */
export interface DecodedEnvelope {
  readonly header: {
    readonly alg: KeyAlg;
    readonly kid: string;
  };
  readonly payload: Readonly<Record<string, unknown>>;
  readonly signingInput: Uint8Array;
  readonly signature: Uint8Array;
}

/** Inputs a codec needs to produce a token. */
export interface CodecEncodeInput {
  readonly alg: KeyAlg;
  readonly kid: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly privateKey: PrivateKeyHandle;
  readonly backend: SignatureBackend;
}

/**
 * One token format. Implementations must not read or parse tokens that do
 * not carry their own prefix.
 */
export interface TokenCodec {
  /** ASCII prefix this codec owns, including the trailing separator. */
  readonly prefix: string;
  /** Algorithms this codec can sign and verify with. A codec that supports
   *  fewer algorithms than the system as a whole (LIC2 is Ed25519-only)
   *  declares that here so callers can reject early with a clear error. */
  readonly supportedAlgs: ReadonlySet<KeyAlg>;
  /** Parse without verifying. Throws this codec's own typed errors. */
  decode(token: string): DecodedEnvelope;
  /** Build a signed token. */
  encode(input: CodecEncodeInput): Promise<string>;
}

/** Key-record shape codecs may need when importing a public key. */
export type CodecKeyRecord = KeyRecord;

// ---------- registry ----------

const codecs = new Map<string, TokenCodec>();

/**
 * Register a codec under its prefix. Duplicate registration is rejected so
 * a second registration cannot silently displace the first — the previously
 * registered codec stays in effect.
 */
export function registerCodec(codec: TokenCodec): void {
  if (codecs.has(codec.prefix)) {
    throw errors.unsupportedTokenFormat(codec.prefix);
  }
  codecs.set(codec.prefix, codec);
}

/** Registered prefixes, for diagnostics and tests. */
export function registeredPrefixes(): readonly string[] {
  return [...codecs.keys()];
}

/**
 * Select the codec owning this token's prefix.
 *
 * Rejects an unregistered prefix before any base64 decoding, payload
 * parsing, or signature verification happens. The error names the offending
 * prefix clipped to a bounded length, so a caller pasting a large binary
 * blob cannot expand the log line.
 */
export function codecFor(token: string): TokenCodec {
  for (const codec of codecs.values()) {
    if (token.startsWith(codec.prefix)) return codec;
  }
  const firstDot = token.indexOf('.');
  const prefix = firstDot >= 0 ? token.slice(0, firstDot + 1) : token.slice(0, 16);
  throw errors.unsupportedTokenFormat(prefix);
}

/** Test-only: drop a registered codec so a suite can register a stub.
 *  Not exported from the package entry point. */
export function unregisterCodecForTesting(prefix: string): void {
  codecs.delete(prefix);
}
