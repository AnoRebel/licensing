/**
 * LIC1 token envelope: encode, decode, sign, verify.
 *
 *   LIC1.<header_b64>.<payload_b64>.<sig_b64>
 *
 * All base64url segments are padding-free (RFC 4648 §5 without `=`). The
 * signing input is the literal byte sequence
 *   `<header_b64> "." <payload_b64>`
 * — i.e. the first two segments joined by a dot, in ASCII, with NO trailing
 * newline.
 *
 * Dispatch lives in `token-codec.ts`: this module registers LIC1 as a codec
 * under the `LIC1.` prefix and never sees a token belonging to another
 * format. Unknown prefixes fail fast with `UnsupportedTokenFormat` before
 * any byte is decoded.
 */

import { decode as b64urlDecode, encode as b64urlEncode } from './base64url.ts';
import { canonicalize } from './canonical-json.ts';
import type {
  AlgorithmRegistry,
  KeyAlgBindings,
  KeyRecord,
  PrivateKeyHandle,
  PublicKeyHandle,
  SignatureBackend,
} from './crypto/types.ts';
import { errors } from './errors.ts';
import { StrictJsonError, strictParse } from './strict-json.ts';
import {
  type CodecEncodeInput,
  codecFor,
  type DecodedEnvelope,
  registerCodec,
  type TokenCodec,
} from './token-codec.ts';
import type { KeyAlg } from './types.ts';

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });
const TEXT_ENCODER = new TextEncoder();

/** The header object is strict — unknown fields are rejected. */
export interface LIC1Header {
  readonly v: 1;
  readonly typ: 'lic';
  readonly alg: KeyAlg;
  readonly kid: string;
}

/** Payload shape is domain-driven. The codec treats it as an opaque JSON
 *  object with strict canonicalization. */
export type LIC1Payload = Readonly<Record<string, unknown>>;

export interface LIC1DecodedParts {
  readonly header: LIC1Header;
  readonly payload: LIC1Payload;
  readonly signingInput: Uint8Array;
  readonly signature: Uint8Array;
}

export interface EncodeOptions {
  readonly header: LIC1Header;
  readonly payload: LIC1Payload;
  readonly privateKey: PrivateKeyHandle;
  readonly backend: SignatureBackend;
}

/** Build a LIC1 token from its constituent parts. Canonicalizes, signs, and
 *  emits the four-part base64url string. */
export async function encode(opts: EncodeOptions): Promise<string> {
  const headerBytes = canonicalize(opts.header);
  const payloadBytes = canonicalize(opts.payload);
  const headerB64 = b64urlEncode(headerBytes);
  const payloadB64 = b64urlEncode(payloadBytes);
  const signingInput = TEXT_ENCODER.encode(`${headerB64}.${payloadB64}`);
  const sig = await opts.backend.sign(opts.privateKey, signingInput);
  return `LIC1.${headerB64}.${payloadB64}.${b64urlEncode(sig)}`;
}

/**
 * Shallow parse without signature verification.
 *
 * Routes through the codec registry: a token whose prefix belongs to
 * another format is decoded by that format's codec, and an unregistered
 * prefix is rejected before any bytes are touched. Only a token bearing
 * the `LIC1.` prefix reaches `decodeLIC1` below.
 */
export function decodeUnverified(token: string): DecodedEnvelope {
  return codecFor(token).decode(token);
}

/** LIC1-specific parse. Assumes the prefix has already been matched. */
function decodeLIC1(token: string): LIC1DecodedParts {
  const parts = token.split('.');
  if (parts.length !== 4) {
    throw errors.tokenMalformed(`expected 4 dot-separated segments, got ${parts.length}`);
  }
  const [, headerB64, payloadB64, sigB64] = parts as [string, string, string, string];
  const headerBytes = b64urlDecode(headerB64);
  const payloadBytes = b64urlDecode(payloadB64);
  const signature = b64urlDecode(sigB64);
  const header = parseHeader(headerBytes);
  const payload = parsePayload(payloadBytes);
  const signingInput = TEXT_ENCODER.encode(`${headerB64}.${payloadB64}`);
  return { header, payload, signingInput, signature };
}

export interface VerifyOptions {
  readonly registry: AlgorithmRegistry;
  readonly bindings: KeyAlgBindings;
  readonly keys: ReadonlyMap<string, KeyRecord>;
}

/**
 * Parse + verify. On success returns the decoded envelope; on failure throws
 * a typed `LicensingError` (TokenFormatError / CryptoError subtree).
 *
 * The signing input comes from the codec that owns the token's prefix, so a
 * signature valid only under a different format's construction is rejected.
 */
export async function verify(token: string, opts: VerifyOptions): Promise<DecodedEnvelope> {
  const parts = decodeUnverified(token);
  // Algorithm-confusion guard: MUST come before any backend call.
  opts.bindings.expect(parts.header.kid, parts.header.alg);
  const backend = opts.registry.get(parts.header.alg);
  const record = opts.keys.get(parts.header.kid);
  if (!record) throw errors.unknownKid(parts.header.kid);
  if (record.alg !== parts.header.alg) {
    throw errors.algorithmMismatch(record.alg, parts.header.alg);
  }
  const publicKey: PublicKeyHandle = await backend.importPublic(record);
  const ok = await backend.verify(publicKey, parts.signingInput, parts.signature);
  if (!ok) throw errors.tokenSignatureInvalid();
  return parts;
}

// ---------- codec registration ----------

/** ASCII prefix this codec owns. */
export const LIC1_PREFIX = 'LIC1.';

/** Algorithms LIC1 can carry. */
const LIC1_ALGS: ReadonlySet<KeyAlg> = new Set<KeyAlg>(['ed25519', 'rs256-pss', 'hs256']);

/**
 * LIC1 as a registered codec.
 *
 * `decode` assumes the prefix has already been matched by the router, so a
 * token belonging to another format never reaches the LIC1 parser and can
 * never fail with a misleading LIC1-shaped `TokenMalformed`.
 */
export const lic1Codec: TokenCodec = {
  prefix: LIC1_PREFIX,
  supportedAlgs: LIC1_ALGS,
  decode(token: string): DecodedEnvelope {
    return decodeLIC1(token);
  },
  async encode(input: CodecEncodeInput): Promise<string> {
    return encode({
      header: { v: 1, typ: 'lic', alg: input.alg, kid: input.kid },
      payload: input.payload,
      privateKey: input.privateKey,
      backend: input.backend,
    });
  },
};

registerCodec(lic1Codec);

/**
 * Back-compat shim for the previous prefix-allowlist API.
 *
 * The old `registerFormat(prefix)` only recorded a permitted prefix; it had
 * no parser to route to. A prefix with no codec behind it is exactly the
 * hazard the router removes, so this now throws rather than accepting a
 * registration it cannot honour. Register a `TokenCodec` instead.
 */
export function registerFormat(prefix: string): never {
  throw errors.unsupportedTokenFormat(
    `${prefix} — registerFormat() no longer takes a bare prefix; register a TokenCodec via registerCodec()`,
  );
}

// ---------- header / payload parsing ----------

const HEADER_REQUIRED: ReadonlySet<string> = new Set(['v', 'typ', 'alg', 'kid']);
const HEADER_ALLOWED_ALGS: ReadonlySet<string> = new Set<KeyAlg>(['ed25519', 'rs256-pss', 'hs256']);

function parseHeader(bytes: Uint8Array): LIC1Header {
  const obj = parseJSONObject(bytes, 'header');
  // Strict field whitelist. Unknown header fields are a token-shape problem
  // (TokenMalformed), distinct from canonicalization-side rejection.
  for (const k of Object.keys(obj)) {
    if (!HEADER_REQUIRED.has(k)) throw errors.tokenMalformed(`header contains unknown field: ${k}`);
  }
  for (const required of HEADER_REQUIRED) {
    if (!(required in obj)) throw errors.tokenMalformed(`header missing field: ${required}`);
  }
  if (obj.v !== 1) throw errors.tokenMalformed(`header.v must be 1, got ${String(obj.v)}`);
  if (obj.typ !== 'lic') {
    throw errors.tokenMalformed(`header.typ must be "lic", got ${JSON.stringify(obj.typ)}`);
  }
  if (typeof obj.alg !== 'string' || !HEADER_ALLOWED_ALGS.has(obj.alg)) {
    throw errors.unsupportedAlgorithm(String(obj.alg));
  }
  if (typeof obj.kid !== 'string' || obj.kid.length === 0) {
    throw errors.tokenMalformed('header.kid must be a non-empty string');
  }
  return {
    v: 1,
    typ: 'lic',
    alg: obj.alg as KeyAlg,
    kid: obj.kid,
  };
}

function parsePayload(bytes: Uint8Array): LIC1Payload {
  const obj = parseJSONObject(bytes, 'payload');
  return obj;
}

/**
 * Strict JSON parse used during verification.
 *
 * Rejects duplicate keys with `CanonicalJSONDuplicateKey` BEFORE signature
 * verification runs, closing the gap where the stdlib `JSON.parse` silently
 * last-wins on duplicates. Output is otherwise byte-identical to the
 * previous `JSON.parse`-based implementation, so existing fixtures and
 * round-trip tests continue to pass unchanged.
 */
function parseJSONObject(bytes: Uint8Array, label: string): Readonly<Record<string, unknown>> {
  let text: string;
  try {
    text = TEXT_DECODER.decode(bytes);
  } catch {
    throw errors.tokenMalformed(`${label} is not valid UTF-8`);
  }
  let v: unknown;
  try {
    v = strictParse(text);
  } catch (e) {
    if (e instanceof StrictJsonError && e.code === 'CanonicalJSONDuplicateKey') {
      const key = (e.details as { key?: string } | undefined)?.key ?? '';
      throw errors.canonicalDuplicateKey(key);
    }
    throw errors.tokenMalformed(`${label} JSON parse failed: ${(e as Error).message}`);
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw errors.tokenMalformed(`${label} must decode to a JSON object`);
  }
  return v as Readonly<Record<string, unknown>>;
}
