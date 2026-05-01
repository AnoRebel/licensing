/**
 * Strict JSON parser used by the LIC1 codec when decoding header / payload
 * bytes for verification.
 *
 * The canonical-JSON encoder has always rejected duplicate keys, but the
 * stdlib `JSON.parse` silently last-wins on duplicates. A tampered token
 * containing e.g. `{"status":"revoked","status":"active"}` would
 * deserialize as `status=active`. The signature is over the
 * issuer-produced canonical bytes (which can't have duplicates), so this
 * was not exploitable in practice — but the defence-in-depth fix is to
 * reject the duplicate at parse time, before the signature is verified.
 *
 * This module is **not** a general-purpose JSON parser — it is sized to
 * the LIC1 codec's needs. It accepts the same set of inputs `JSON.parse`
 * accepts (including loose whitespace, fractional numbers, etc.) so it
 * preserves backwards-compatibility for every existing fixture; it only
 * adds the duplicate-key rejection.
 *
 * Throws a plain Error with a stable `.code` of `'CanonicalJSONDuplicateKey'`
 * on duplicates and `'TokenMalformed'` on every other failure. The codec
 * translates these into the typed error envelope at the call boundary.
 */

export class StrictJsonError extends Error {
  readonly code: 'CanonicalJSONDuplicateKey' | 'TokenMalformed';
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: 'CanonicalJSONDuplicateKey' | 'TokenMalformed',
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'StrictJsonError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * Parse `text` as JSON, rejecting duplicate keys at any nesting level.
 * Returns the same shape `JSON.parse` would (numbers as `number`,
 * strings as `string`, etc.) so callers can swap this in transparently.
 */
export function strictParse(text: string): unknown {
  const ctx = { text, i: 0 };
  skipWs(ctx);
  const value = parseValue(ctx);
  skipWs(ctx);
  if (ctx.i !== text.length) {
    throw malformed(`trailing data after JSON value at position ${ctx.i}`);
  }
  return value;
}

interface Ctx {
  readonly text: string;
  i: number;
}

function parseValue(ctx: Ctx): unknown {
  skipWs(ctx);
  if (ctx.i >= ctx.text.length) {
    throw malformed('unexpected end of input');
  }
  const c = ctx.text.charCodeAt(ctx.i);
  // '{' = 0x7B, '[' = 0x5B, '"' = 0x22, '-' = 0x2D, '0'-'9' = 0x30-0x39
  // 't' = 0x74, 'f' = 0x66, 'n' = 0x6E
  if (c === 0x7b) return parseObject(ctx);
  if (c === 0x5b) return parseArray(ctx);
  if (c === 0x22) return parseString(ctx);
  if (c === 0x74) return parseLiteral(ctx, 'true', true);
  if (c === 0x66) return parseLiteral(ctx, 'false', false);
  if (c === 0x6e) return parseLiteral(ctx, 'null', null);
  if (c === 0x2d || (c >= 0x30 && c <= 0x39)) return parseNumber(ctx);
  throw malformed(`unexpected character '${ctx.text[ctx.i]}' at position ${ctx.i}`);
}

function parseObject(ctx: Ctx): Record<string, unknown> {
  expectChar(ctx, '{');
  const out: Record<string, unknown> = {};
  skipWs(ctx);
  if (peekChar(ctx) === '}') {
    ctx.i++;
    return out;
  }
  for (;;) {
    skipWs(ctx);
    if (peekChar(ctx) !== '"') {
      throw malformed(`expected object key at position ${ctx.i}`);
    }
    const key = parseString(ctx);
    if (Object.hasOwn(out, key)) {
      throw new StrictJsonError('CanonicalJSONDuplicateKey', `contains duplicate key: ${key}`, {
        key,
      });
    }
    skipWs(ctx);
    expectChar(ctx, ':');
    const value = parseValue(ctx);
    out[key] = value;
    skipWs(ctx);
    const next = peekChar(ctx);
    if (next === ',') {
      ctx.i++;
      continue;
    }
    if (next === '}') {
      ctx.i++;
      return out;
    }
    throw malformed(`expected ',' or '}' in object at position ${ctx.i}`);
  }
}

function parseArray(ctx: Ctx): unknown[] {
  expectChar(ctx, '[');
  const out: unknown[] = [];
  skipWs(ctx);
  if (peekChar(ctx) === ']') {
    ctx.i++;
    return out;
  }
  for (;;) {
    out.push(parseValue(ctx));
    skipWs(ctx);
    const next = peekChar(ctx);
    if (next === ',') {
      ctx.i++;
      continue;
    }
    if (next === ']') {
      ctx.i++;
      return out;
    }
    throw malformed(`expected ',' or ']' in array at position ${ctx.i}`);
  }
}

function parseString(ctx: Ctx): string {
  expectChar(ctx, '"');
  // Find the matching close-quote, handling escape sequences. The fast
  // path scans for an unescaped '"' and slices; the slow path appears
  // only when the string contains escape sequences and rebuilds the
  // value codepoint-by-codepoint.
  let start = ctx.i;
  while (ctx.i < ctx.text.length) {
    const c = ctx.text.charCodeAt(ctx.i);
    if (c === 0x22) {
      const value = ctx.text.slice(start, ctx.i);
      ctx.i++;
      return value;
    }
    if (c === 0x5c) {
      // Escape sequence — fall through to slow path with the bytes we've
      // accumulated so far.
      let acc = ctx.text.slice(start, ctx.i);
      while (ctx.i < ctx.text.length) {
        const ch = ctx.text.charCodeAt(ctx.i);
        if (ch === 0x22) {
          ctx.i++;
          return acc;
        }
        if (ch === 0x5c) {
          ctx.i++;
          if (ctx.i >= ctx.text.length) throw malformed('unterminated escape');
          const e = ctx.text[ctx.i] as string;
          ctx.i++;
          switch (e) {
            case '"':
              acc += '"';
              break;
            case '\\':
              acc += '\\';
              break;
            case '/':
              acc += '/';
              break;
            case 'b':
              acc += '\b';
              break;
            case 'f':
              acc += '\f';
              break;
            case 'n':
              acc += '\n';
              break;
            case 'r':
              acc += '\r';
              break;
            case 't':
              acc += '\t';
              break;
            case 'u': {
              if (ctx.i + 4 > ctx.text.length) throw malformed('truncated \\u escape');
              const hex = ctx.text.slice(ctx.i, ctx.i + 4);
              if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
                throw malformed(`invalid \\u escape: ${hex}`);
              }
              ctx.i += 4;
              acc += String.fromCharCode(parseInt(hex, 16));
              break;
            }
            default:
              throw malformed(`invalid escape sequence: \\${e}`);
          }
          start = ctx.i; // not really needed, we're in slow path
          continue;
        }
        if (ch < 0x20) {
          throw malformed(`unescaped control character at position ${ctx.i}`);
        }
        acc += String.fromCharCode(ch);
        ctx.i++;
        // Handle surrogate pair if present.
        if (ch >= 0xd800 && ch <= 0xdbff && ctx.i < ctx.text.length) {
          const lo = ctx.text.charCodeAt(ctx.i);
          if (lo >= 0xdc00 && lo <= 0xdfff) {
            acc += String.fromCharCode(lo);
            ctx.i++;
          }
        }
      }
      throw malformed('unterminated string');
    }
    if (c < 0x20) {
      throw malformed(`unescaped control character at position ${ctx.i}`);
    }
    ctx.i++;
  }
  throw malformed('unterminated string');
}

function parseNumber(ctx: Ctx): number {
  const start = ctx.i;
  if (ctx.text[ctx.i] === '-') ctx.i++;
  // Integer part.
  if (ctx.text[ctx.i] === '0') {
    ctx.i++;
  } else if (isDigit(ctx.text.charCodeAt(ctx.i))) {
    while (isDigit(ctx.text.charCodeAt(ctx.i))) ctx.i++;
  } else {
    throw malformed(`invalid number at position ${start}`);
  }
  // Fraction.
  if (ctx.text[ctx.i] === '.') {
    ctx.i++;
    if (!isDigit(ctx.text.charCodeAt(ctx.i))) {
      throw malformed(`invalid number fraction at position ${start}`);
    }
    while (isDigit(ctx.text.charCodeAt(ctx.i))) ctx.i++;
  }
  // Exponent.
  const expCh = ctx.text[ctx.i];
  if (expCh === 'e' || expCh === 'E') {
    ctx.i++;
    if (ctx.text[ctx.i] === '+' || ctx.text[ctx.i] === '-') ctx.i++;
    if (!isDigit(ctx.text.charCodeAt(ctx.i))) {
      throw malformed(`invalid exponent at position ${start}`);
    }
    while (isDigit(ctx.text.charCodeAt(ctx.i))) ctx.i++;
  }
  const literal = ctx.text.slice(start, ctx.i);
  const num = Number(literal);
  if (!Number.isFinite(num)) {
    throw malformed(`number out of range: ${literal}`);
  }
  return num;
}

function parseLiteral<T>(ctx: Ctx, expected: string, value: T): T {
  if (ctx.text.slice(ctx.i, ctx.i + expected.length) !== expected) {
    throw malformed(`expected '${expected}' at position ${ctx.i}`);
  }
  ctx.i += expected.length;
  return value;
}

function skipWs(ctx: Ctx): void {
  while (ctx.i < ctx.text.length) {
    const c = ctx.text.charCodeAt(ctx.i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
      ctx.i++;
    } else {
      break;
    }
  }
}

function peekChar(ctx: Ctx): string | undefined {
  return ctx.i < ctx.text.length ? ctx.text[ctx.i] : undefined;
}

function expectChar(ctx: Ctx, ch: string): void {
  if (ctx.text[ctx.i] !== ch) {
    throw malformed(`expected '${ch}' at position ${ctx.i}`);
  }
  ctx.i++;
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function malformed(msg: string): StrictJsonError {
  return new StrictJsonError('TokenMalformed', msg);
}
