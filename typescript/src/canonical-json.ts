/**
 * Canonical JSON serializer for LIC1 token headers and payloads.
 *
 * See `fixtures/README.md` for the normative specification. This module is
 * the authoritative TypeScript implementation; the Go port in
 * `licensing/canonical.go` must produce byte-identical output for every
 * input in the fixture corpus.
 *
 * Rules (summary):
 *   - Top level MUST be a plain object.
 *   - Allowed value types: null, boolean, string, safe integer, array, object.
 *   - No floats, NaN, Infinity, bigint outside safe range, or non-plain objects.
 *   - Keys sorted by UTF-16 code-unit sequence (ascending).
 *   - No whitespace anywhere.
 *   - Strings: \" \\ \b \t \n \f \r escaped; other C0 controls \u00XX lowercase.
 *   - Slash (`/`) NOT escaped. Astral codepoints emitted as raw UTF-8, never
 *     as \uXXXX\uXXXX surrogate pairs.
 *   - Integers only, range [-(2^53-1), 2^53-1]. No -0, no leading 0s.
 *   - Duplicate keys in the input are rejected.
 *
 * Return value is a `Uint8Array` of the canonical UTF-8 byte sequence —
 * callers never consume the intermediate string, because JS string ↔ UTF-8
 * round-trip has historically been a source of silent corruption.
 */

import { errors, type LicensingError } from './errors.ts';

const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 2^53 - 1
const MIN_SAFE = Number.MIN_SAFE_INTEGER; // -(2^53 - 1)

const TEXT_ENCODER = new TextEncoder();

/**
 * Canonicalize a JSON-like value into a UTF-8 byte sequence.
 *
 * Throws {@link LicensingError} with `CanonicalJSON*` codes on any violation
 * of the rules above.
 */
export function canonicalize(value: unknown): Uint8Array {
  if (!isPlainObject(value)) {
    throw errors.canonicalInvalidTopLevel('canonical JSON top-level must be a plain object');
  }
  const out: string[] = [];
  writeObject(value as Record<string, unknown>, out);
  return TEXT_ENCODER.encode(out.join(''));
}

/**
 * Convenience wrapper returning the canonical form as a UTF-8 string.
 * The string round-trips losslessly through `TextDecoder('utf-8')`, but
 * when you actually want to sign bytes use {@link canonicalize}.
 */
export function canonicalizeToString(value: unknown): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(canonicalize(value));
}

// ---------- internals ----------

function writeValue(v: unknown, out: string[]): void {
  if (v === null) {
    out.push('null');
    return;
  }
  switch (typeof v) {
    case 'boolean':
      out.push(v ? 'true' : 'false');
      return;
    case 'number':
      writeNumber(v, out);
      return;
    case 'string':
      writeString(v, out);
      return;
    case 'bigint': {
      // Accept bigint but require it inside the safe integer range; emit as
      // a decimal integer (no 'n' suffix, no quotes).
      if (v > BigInt(MAX_SAFE) || v < BigInt(MIN_SAFE)) {
        throw errors.canonicalInvalidNumber('bigint outside safe integer range', {
          value: v.toString(),
        });
      }
      out.push(v.toString());
      return;
    }
    case 'object': {
      if (Array.isArray(v)) {
        writeArray(v, out);
        return;
      }
      if (isPlainObject(v)) {
        writeObject(v as Record<string, unknown>, out);
        return;
      }
      // Date, Map, Set, class instances, typed arrays — all rejected.
      throw errors.canonicalInvalidType(
        `unsupported object type: ${v.constructor ? v.constructor.name : 'unknown'}`,
      );
    }
    default:
      throw errors.canonicalInvalidType(`unsupported type: ${typeof v}`);
  }
}

function writeNumber(n: number, out: string[]): void {
  if (!Number.isFinite(n)) {
    throw errors.canonicalInvalidNumber('NaN or Infinity not permitted');
  }
  if (!Number.isInteger(n)) {
    throw errors.canonicalInvalidNumber('non-integer number not permitted', { value: n });
  }
  if (n === 0 && 1 / n === -Infinity) {
    // Negative zero.
    throw errors.canonicalInvalidNumber('negative zero not permitted');
  }
  if (n > MAX_SAFE || n < MIN_SAFE) {
    throw errors.canonicalInvalidNumber('integer outside safe range', { value: n });
  }
  // Number.toString() already emits the minimal canonical decimal form for
  // safe integers: no leading '+', no leading zeros, a single '-' for negatives.
  out.push(n.toString(10));
}

function writeArray(a: readonly unknown[], out: string[]): void {
  out.push('[');
  for (let i = 0; i < a.length; i++) {
    if (i > 0) out.push(',');
    writeValue(a[i], out);
  }
  out.push(']');
}

function writeObject(o: Record<string, unknown>, out: string[]): void {
  // Build key list, detect duplicates (Object.keys never yields dupes, but a
  // caller may construct an object via Object.defineProperty or a proxy; we
  // additionally guard by explicitly rejecting symbol keys and inherited
  // enumerable properties).
  const keys = Object.keys(o);
  // Sort by UTF-16 code-unit sequence — this is exactly what the default
  // string comparator does in JS, and it MUST match Go's string-as-UTF-16
  // comparator in the canonical-json port.
  keys.sort(compareUtf16);

  out.push('{');
  let first = true;
  const seen = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) throw errors.canonicalDuplicateKey(k);
    seen.add(k);
    if (!first) out.push(',');
    first = false;
    writeString(k, out);
    out.push(':');
    writeValue((o as Record<string, unknown>)[k], out);
  }
  out.push('}');
}

function compareUtf16(a: string, b: string): number {
  // JS default string comparison IS UTF-16 code-unit comparison.
  return a < b ? -1 : a > b ? 1 : 0;
}

const HEX = '0123456789abcdef';

function writeString(s: string, out: string[]): void {
  // Reject unpaired surrogates by forcing a UTF-8 round-trip with fatal=true.
  // We do this upfront so the rest of the function can assume well-formed
  // UTF-16 — every \uDXXX we see is paired.
  validateUtf16(s);

  out.push('"');
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);

    // Paired surrogate: emit the astral codepoint verbatim (TextEncoder at
    // the end handles UTF-8 encoding), never as a \uXXXX\uXXXX escape.
    if (c >= 0xd800 && c <= 0xdbff) {
      // High surrogate; next char must be a low surrogate per validateUtf16.
      out.push(s[i] as string);
      i++;
      out.push(s[i] as string);
      continue;
    }

    if (c === 0x22) {
      out.push('\\"');
      continue;
    }
    if (c === 0x5c) {
      out.push('\\\\');
      continue;
    }
    if (c === 0x08) {
      out.push('\\b');
      continue;
    }
    if (c === 0x09) {
      out.push('\\t');
      continue;
    }
    if (c === 0x0a) {
      out.push('\\n');
      continue;
    }
    if (c === 0x0c) {
      out.push('\\f');
      continue;
    }
    if (c === 0x0d) {
      out.push('\\r');
      continue;
    }
    if (c < 0x20) {
      // Other C0 control: \u00XX with lowercase hex.
      out.push('\\u00');
      out.push(HEX[(c >> 4) & 0xf] as string);
      out.push(HEX[c & 0xf] as string);
      continue;
    }
    // Everything else — including '/', the full BMP above 0x1F, and
    // non-astral non-escapable chars — is emitted raw. TextEncoder will
    // re-encode to UTF-8 at the end.
    out.push(s[i] as string);
  }
  out.push('"');
}

function validateUtf16(s: string): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      // High surrogate — must be followed by a low surrogate.
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) {
        throw errors.canonicalInvalidUTF8('unpaired high surrogate in string input', { offset: i });
      }
      i++; // skip the low surrogate
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      throw errors.canonicalInvalidUTF8('unpaired low surrogate in string input', {
        offset: i,
      });
    }
  }
}

/**
 * Return true iff `v` is a plain object (`{}`), not an array, class
 * instance, or other exotic. We accept null-prototype objects because
 * record-shaped config maps commonly use `Object.create(null)`.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
