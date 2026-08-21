/**
 * LIC2 token envelope: PASETO v4.public.
 *
 *   v4.public.<base64url(message || signature)>
 *
 * LIC2 is the second registered token format. Unlike LIC1 — which carries a
 * header segment naming `alg` and `kid` — PASETO deliberately forbids
 * algorithm agility: the version string *is* the algorithm commitment. v4
 * means Ed25519, always. There is no header field an attacker can tamper
 * with to select a weaker primitive.
 *
 * Because there is no header, the `kid` travels in the PASETO **footer**,
 * which is authenticated (it is fed into PAE) but not encrypted. That is
 * the standard place for key identification and is what lets a verifier
 * select a key before checking the signature.
 *
 * Implementation note: v4.public is Ed25519 over a PAE-encoded string and
 * nothing more. The signing primitive therefore comes from the same
 * runtime-backed backend LIC1 uses (`node:crypto` via `ed25519Backend`),
 * keeping the property stated in `crypto/ed25519.ts`: no third-party curve
 * library, auditors only need to trust the runtime. Correctness against an
 * independent implementation is asserted in the tests.
 */

import { decode as b64urlDecode, encode as b64urlEncode } from './base64url.ts';
import { canonicalize } from './canonical-json.ts';
import { errors } from './errors.ts';
import { strictParse } from './strict-json.ts';
import {
  type CodecEncodeInput,
  type DecodedEnvelope,
  registerCodec,
  type TokenCodec,
} from './token-codec.ts';
import type { KeyAlg } from './types.ts';

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });
const TEXT_ENCODER = new TextEncoder();

/** ASCII prefix this codec owns. PASETO's header includes the trailing dot. */
export const LIC2_PREFIX = 'v4.public.';

/** Ed25519 detached signature length. */
const SIG_LEN = 64;

/**
 * LIC2 supports Ed25519 only.
 *
 * This is not a project restriction but a property of PASETO: a v4 token
 * commits to Ed25519 by its version string. There is no v4 encoding for
 * RSA-PSS, and the symmetric mode (`v4.local`) is a different purpose with
 * different security properties, deliberately out of scope.
 */
const LIC2_ALGS: ReadonlySet<KeyAlg> = new Set<KeyAlg>(['ed25519']);

/**
 * LE64 — a 64-bit unsigned little-endian length.
 *
 * The spec requires the most significant bit to be cleared, "for
 * interoperability with programming languages that do not have unsigned
 * integer support". Lengths that large are unreachable here, but the
 * clearing is part of the encoding and is applied unconditionally.
 */
function le64(n: number): Uint8Array {
  const out = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  out[7] = (out[7] as number) & 0x7f;
  return out;
}

/**
 * PAE — Pre-Authentication Encoding.
 *
 * `LE64(count) || (LE64(len(piece)) || piece)...`
 *
 * The length prefixes are what make the encoding unambiguous: two different
 * piece vectors cannot produce the same byte string, so an attacker cannot
 * shift bytes between the header, payload, footer, and implicit assertion.
 */
export function pae(pieces: readonly Uint8Array[]): Uint8Array {
  let total = 8;
  for (const p of pieces) total += 8 + p.length;

  const out = new Uint8Array(total);
  let off = 0;
  out.set(le64(pieces.length), off);
  off += 8;
  for (const p of pieces) {
    out.set(le64(p.length), off);
    off += 8;
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Footer shape. `kid` lets a verifier select a key before verifying. */
interface LIC2Footer {
  readonly kid: string;
}

/**
 * Build the bytes a v4.public signature covers:
 * `PAE([h, m, f, i])` where `i` (implicit assertion) is empty for LIC2.
 */
function signingInputFor(message: Uint8Array, footer: Uint8Array): Uint8Array {
  return pae([TEXT_ENCODER.encode(LIC2_PREFIX), message, footer, new Uint8Array(0)]);
}

function parseFooter(bytes: Uint8Array): LIC2Footer {
  let text: string;
  try {
    text = TEXT_DECODER.decode(bytes);
  } catch {
    throw errors.tokenMalformed('LIC2 footer is not valid UTF-8');
  }
  const obj = strictParse(text);
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw errors.tokenMalformed('LIC2 footer must be a JSON object');
  }
  const kid = (obj as Record<string, unknown>).kid;
  if (typeof kid !== 'string' || kid.length === 0) {
    throw errors.tokenMalformed('LIC2 footer.kid must be a non-empty string');
  }
  return { kid };
}

/** Parse a LIC2 token. Assumes the prefix has already been matched. */
function decodeLIC2(token: string): DecodedEnvelope {
  const rest = token.slice(LIC2_PREFIX.length);
  if (rest.length === 0) {
    throw errors.tokenMalformed('LIC2 token has no payload segment');
  }

  // At most one footer segment. PASETO tokens are `h.payload[.footer]`, and
  // the header already consumed its own dots, so anything beyond a single
  // separator here is malformed.
  const segments = rest.split('.');
  if (segments.length > 2) {
    throw errors.tokenMalformed(
      `LIC2 token has ${segments.length} segments after the header, expected 1 or 2`,
    );
  }
  const [payloadB64, footerB64] = segments as [string, string | undefined];

  const body = b64urlDecode(payloadB64);
  if (body.length <= SIG_LEN) {
    throw errors.tokenMalformed(
      `LIC2 payload is ${body.length} bytes, too short to contain a ${SIG_LEN}-byte signature`,
    );
  }
  const message = body.subarray(0, body.length - SIG_LEN);
  const signature = body.subarray(body.length - SIG_LEN);

  const footerBytes = footerB64 === undefined ? new Uint8Array(0) : b64urlDecode(footerB64);
  if (footerBytes.length === 0) {
    throw errors.tokenMalformed('LIC2 requires a footer carrying kid');
  }
  const footer = parseFooter(footerBytes);

  let payloadText: string;
  try {
    payloadText = TEXT_DECODER.decode(message);
  } catch {
    throw errors.tokenMalformed('LIC2 payload is not valid UTF-8');
  }
  const payload = strictParse(payloadText);
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw errors.tokenMalformed('LIC2 payload must be a JSON object');
  }

  return {
    header: { alg: 'ed25519', kid: footer.kid },
    payload: payload as Readonly<Record<string, unknown>>,
    signingInput: signingInputFor(message, footerBytes),
    signature,
  };
}

/** The registered LIC2 codec. */
export const lic2Codec: TokenCodec = {
  prefix: LIC2_PREFIX,
  supportedAlgs: LIC2_ALGS,
  decode(token: string): DecodedEnvelope {
    return decodeLIC2(token);
  },
  async encode(input: CodecEncodeInput): Promise<string> {
    if (!LIC2_ALGS.has(input.alg)) {
      throw errors.unsupportedAlgorithm(
        `LIC2 (PASETO v4.public) supports ed25519 only, got ${input.alg} — ` +
          'either switch the signing algorithm to ed25519, or issue LIC1 tokens instead',
      );
    }
    // Canonical JSON keeps LIC2 byte-comparable across ports, exactly as it
    // does for LIC1. PASETO does not mandate a serialisation, so without
    // this the two ports could emit equivalent-but-different JSON.
    const message = canonicalize(input.payload);
    const footer = canonicalize({ kid: input.kid });
    const sig = await input.backend.sign(input.privateKey, signingInputFor(message, footer));

    const body = new Uint8Array(message.length + sig.length);
    body.set(message, 0);
    body.set(sig, message.length);

    return `${LIC2_PREFIX}${b64urlEncode(body)}.${b64urlEncode(footer)}`;
  },
};

registerCodec(lic2Codec);
