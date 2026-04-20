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
 * The format registry below dispatches on the ASCII prefix ("LIC1", "LIC2",
 * "v4.public.", etc.). Only LIC1 is registered today; unknown prefixes fail
 * fast with `UnsupportedTokenFormat`, guaranteeing forward-compat seams
 * (PASETO, a future LIC2) cannot be exploited by a tampered header.
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
import { errors, TokenFormatError } from './errors.ts';
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

/** Shallow parse without signature verification. Rejects unknown format
 *  prefixes and malformed segment layout. */
export function decodeUnverified(token: string): LIC1DecodedParts {
  dispatchFormat(token); // throws UnsupportedTokenFormat for non-LIC1
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

/** Parse + verify. On success returns the decoded parts; on failure throws
 *  a typed `LicensingError` (TokenFormatError / CryptoError subtree). */
export async function verify(token: string, opts: VerifyOptions): Promise<LIC1DecodedParts> {
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

// ---------- format dispatch ----------

/**
 * Minimal format-prefix ALLOWLIST. The only entry today is `LIC1.`; any
 * other prefix (`v4.public.`, JWT-style `eyJ...`, `LIC2.`, anything else)
 * is rejected before we touch the bytes.
 *
 * This registry is intentionally prefix-only — it does NOT route to
 * different parsers. `decodeUnverified` below is the only parser, and it
 * is LIC1-specific. Adding `v4.public.` here would let a PASETO-shaped
 * token *reach* the LIC1 parser, which would then fail with a wrong
 * `TokenMalformed` code. So: do NOT register a non-LIC1 prefix here until
 * the broader token-codec refactor lands (see note below).
 *
 * ─────────────────────────────────────────────────────────────────────
 * Future LIC2 / PASETO seam:
 * When we add a second token format, lift `LIC1DecodedParts` to an
 * interface that each codec implements, and turn this allowlist into an
 * actual parser router: `registerFormat(prefix, parseFn)` where `parseFn`
 * returns the common envelope type. `verify()` will also need its own
 * dispatch because the signing-input construction differs per codec
 * (LIC1 concatenates `<h>.<p>` ASCII; PASETO uses PAE).
 * ─────────────────────────────────────────────────────────────────────
 */

const formatPrefixes: string[] = [];

export function registerFormat(prefix: string): void {
  // Enforce uniqueness to prevent accidental overrides.
  if (formatPrefixes.includes(prefix)) {
    throw new TokenFormatError(
      'UnsupportedTokenFormat',
      `format prefix already registered: ${prefix}`,
    );
  }
  formatPrefixes.push(prefix);
}

/** Built-in LIC1 prefix (idempotent). */
if (!formatPrefixes.includes('LIC1.')) {
  registerFormat('LIC1.');
}

function dispatchFormat(token: string): void {
  for (const p of formatPrefixes) {
    if (token.startsWith(p)) return;
  }
  // Extract a plausible prefix for the error message — everything up to the
  // first dot, capped to avoid throwing MBs back at a caller if someone
  // pastes a binary blob.
  const firstDot = token.indexOf('.');
  const prefix = firstDot >= 0 ? token.slice(0, firstDot + 1) : token.slice(0, 16);
  throw errors.unsupportedTokenFormat(prefix);
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

function parseJSONObject(bytes: Uint8Array, label: string): Readonly<Record<string, unknown>> {
  let text: string;
  try {
    text = TEXT_DECODER.decode(bytes);
  } catch {
    throw errors.tokenMalformed(`${label} is not valid UTF-8`);
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw errors.tokenMalformed(`${label} JSON parse failed: ${(e as Error).message}`);
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw errors.tokenMalformed(`${label} must decode to a JSON object`);
  }
  return v as Readonly<Record<string, unknown>>;
}
