/**
 * Fastify adapter. Fastify pre-parses JSON bodies by default (via its
 * built-in content-type parser), so `request.body` is the parsed value.
 * Query is pre-parsed too.
 *
 * Usage:
 *
 *   import Fastify from 'fastify';
 *   import { toFastifyHandler } from '@anorebel/licensing/http/adapters/fastify';
 *
 *   const app = Fastify();
 *   app.all('/api/licensing/v1/*', toFastifyHandler(router));
 */

import type { Handler, HandlerRequest, HttpMethod, JsonValue } from '../types.ts';

function isKnownMethod(m: string): m is HttpMethod {
  return m === 'GET' || m === 'POST' || m === 'PATCH' || m === 'DELETE';
}

// Structural types — Fastify's real types require the peer dep.
interface FastifyRequestLike {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly query: unknown;
  readonly body: unknown;
  readonly ip: string;
}

interface FastifyReplyLike {
  code: (status: number) => FastifyReplyLike;
  header: (name: string, value: string) => FastifyReplyLike;
  send: (body?: string | Buffer) => FastifyReplyLike;
}

function normalizeHeaders(
  raw: Readonly<Record<string, string | string[] | undefined>>,
): Readonly<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

function normalizeQuery(
  q: unknown,
): Readonly<Record<string, string | readonly string[] | undefined>> {
  if (q === null || typeof q !== 'object') return {};
  const out: Record<string, string | readonly string[] | undefined> = {};
  for (const [k, v] of Object.entries(q as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === 'string');
  }
  return out;
}

function splitPath(urlStr: string): string {
  const idx = urlStr.indexOf('?');
  const pathOnly = idx === -1 ? urlStr : urlStr.slice(0, idx);
  return pathOnly.length > 1 && pathOnly.endsWith('/') ? pathOnly.slice(0, -1) : pathOnly;
}

function bodyOrUndefined(b: unknown): JsonValue | undefined {
  if (b === undefined || b === null) return undefined;
  // Fastify pre-parses JSON into an object/array/scalar. Anything else
  // (Buffer from multipart, string from text/plain) we pass through as
  // `undefined` — the licensing endpoints all expect JSON objects.
  if (
    typeof b === 'object' ||
    typeof b === 'string' ||
    typeof b === 'number' ||
    typeof b === 'boolean'
  ) {
    return b as JsonValue;
  }
  return undefined;
}

/** Convert a `Handler` into a Fastify route handler. */
export function toFastifyHandler(
  handler: Handler,
): (req: FastifyRequestLike, reply: FastifyReplyLike) => Promise<void> {
  return async (req, reply) => {
    const rawMethod = req.method.toUpperCase();
    if (!isKnownMethod(rawMethod)) {
      reply
        .code(405)
        .header('content-type', 'application/json; charset=utf-8')
        .send(
          JSON.stringify({
            success: false,
            error: { code: 'MethodNotAllowed', message: `method ${rawMethod} not allowed` },
          }),
        );
      return;
    }
    const hreq: HandlerRequest = {
      method: rawMethod,
      path: splitPath(req.url),
      query: normalizeQuery(req.query),
      headers: normalizeHeaders(req.headers),
      body: bodyOrUndefined(req.body),
      remoteAddr: req.ip,
    };
    const hres = await handler(hreq);
    reply.code(hres.status);
    if (hres.headers !== undefined) {
      for (const [k, v] of Object.entries(hres.headers)) {
        reply.header(k, v);
      }
    }
    if (hres.body === undefined) {
      reply.send();
      return;
    }
    reply.header('content-type', 'application/json; charset=utf-8');
    reply.send(JSON.stringify(hres.body));
  };
}
