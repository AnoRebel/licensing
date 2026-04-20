/**
 * Request body / query parameter validation helpers. These are intentionally
 * lightweight — we don't want a heavy schema library as a dependency, but
 * we DO want every handler to reject malformed inputs before they hit the
 * core services (which would surface less-helpful errors).
 *
 * The OpenAPI document is the authoritative contract; these helpers match
 * the shapes declared there. If you change a schema, update both.
 */

import { err } from './envelope.ts';
import type { HandlerRequest, HandlerResponse, JsonValue } from './types.ts';

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly response: HandlerResponse };

/** Assert the request has a JSON object body. Arrays and scalars fail. */
export function requireJsonObject(
  req: HandlerRequest,
): ValidationResult<Readonly<Record<string, JsonValue>>> {
  if (req.body === undefined) {
    return { ok: false, response: err(400, 'BadRequest', 'request body is required') };
  }
  if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) {
    return { ok: false, response: err(400, 'BadRequest', 'request body must be a JSON object') };
  }
  return { ok: true, value: req.body as Readonly<Record<string, JsonValue>> };
}

/** Pull a required string field from an object body. */
export function requireString(
  obj: Readonly<Record<string, JsonValue>>,
  key: string,
): ValidationResult<string> {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    return { ok: false, response: err(400, 'BadRequest', `missing or empty string field: ${key}`) };
  }
  return { ok: true, value: v };
}

/** Pull an optional string; null / undefined / empty-string all produce
 *  `null`. Non-strings fail. */
export function optionalString(
  obj: Readonly<Record<string, JsonValue>>,
  key: string,
): ValidationResult<string | null> {
  const v = obj[key];
  if (v === undefined || v === null || v === '') return { ok: true, value: null };
  if (typeof v !== 'string') {
    return {
      ok: false,
      response: err(400, 'BadRequest', `field must be a string or null: ${key}`),
    };
  }
  return { ok: true, value: v };
}

/** Pull a required integer field (rejects non-integer / non-finite / NaN). */
export function requireInt(
  obj: Readonly<Record<string, JsonValue>>,
  key: string,
  opts: { min?: number; max?: number } = {},
): ValidationResult<number> {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    return { ok: false, response: err(400, 'BadRequest', `field must be an integer: ${key}`) };
  }
  if (opts.min !== undefined && v < opts.min) {
    return { ok: false, response: err(400, 'BadRequest', `field ${key} must be >= ${opts.min}`) };
  }
  if (opts.max !== undefined && v > opts.max) {
    return { ok: false, response: err(400, 'BadRequest', `field ${key} must be <= ${opts.max}`) };
  }
  return { ok: true, value: v };
}

/** Pull an optional object field. Treats `undefined`/`null` as "absent",
 *  returning `null`. Rejects arrays and scalars. */
export function optionalObject(
  obj: Readonly<Record<string, JsonValue>>,
  key: string,
): ValidationResult<Readonly<Record<string, JsonValue>> | null> {
  const v = obj[key];
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== 'object' || Array.isArray(v)) {
    return { ok: false, response: err(400, 'BadRequest', `field must be an object: ${key}`) };
  }
  return { ok: true, value: v as Readonly<Record<string, JsonValue>> };
}

/** Match a SHA-256 hex digest (exactly 64 lowercase hex chars). */
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

/** Pull + validate a fingerprint field. */
export function requireFingerprint(
  obj: Readonly<Record<string, JsonValue>>,
  key = 'fingerprint',
): ValidationResult<string> {
  const r = requireString(obj, key);
  if (!r.ok) return r;
  if (!FINGERPRINT_RE.test(r.value)) {
    return {
      ok: false,
      response: err(400, 'BadRequest', `field ${key} must be a 64-char lowercase hex SHA-256`),
    };
  }
  return r;
}

/** Parse the `limit` query parameter. Default 25, cap 100 per OpenAPI. */
export function parseLimit(req: HandlerRequest): ValidationResult<number> {
  const raw = req.query.limit;
  if (raw === undefined) return { ok: true, value: 25 };
  const str = Array.isArray(raw) ? raw[0] : raw;
  if (str === undefined) return { ok: true, value: 25 };
  const n = Number(str);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    return { ok: false, response: err(400, 'BadRequest', 'limit must be an integer in [1, 100]') };
  }
  return { ok: true, value: n };
}

/** Parse the `cursor` query parameter. Opaque strings pass through. */
export function parseCursor(req: HandlerRequest): string | null {
  const raw = req.query.cursor;
  if (raw === undefined) return null;
  const str = Array.isArray(raw) ? raw[0] : raw;
  return str === undefined || str.length === 0 ? null : str;
}
