/**
 * Express adapter. Turns a `Handler` into an Express `RequestHandler`.
 *
 * Express 5+ `req.body` arrives pre-parsed iff `express.json()` was mounted.
 * We DON'T want to force that decision on the caller, so we read the raw
 * stream ourselves when `req.body` is undefined — that way the adapter
 * works with or without the JSON body-parser middleware.
 *
 * Usage:
 *
 *   import express from 'express';
 *   import { toExpressHandler } from '@licensing/sdk/http/adapters/express';
 *
 *   const app = express();
 *   app.all('/api/licensing/v1/*', toExpressHandler(router));
 */

import type { IncomingMessage } from 'node:http';
import type { Handler, HandlerRequest, HttpMethod, JsonValue } from '../types.ts';

function isKnownMethod(m: string): m is HttpMethod {
  return m === 'GET' || m === 'POST' || m === 'PATCH' || m === 'DELETE';
}

// Structural Express types so we don't force the peer dep to resolve at
// type-check time for consumers who only use Hono/Fastify.
interface ExpressRequestLike extends IncomingMessage {
  readonly originalUrl?: string;
  readonly ip?: string;
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, unknown>>;
}

interface ExpressResponseLike {
  status: (code: number) => ExpressResponseLike;
  setHeader: (name: string, value: string) => void;
  send: (body: string) => void;
  end: () => void;
  headersSent: boolean;
}

type NextFn = (err?: unknown) => void;

function normalizeHeaders(
  raw: NodeJS.Dict<string | string[]>,
): Readonly<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

function normalizeQuery(
  q: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, string | readonly string[] | undefined>> {
  if (q === undefined) return {};
  const out: Record<string, string | readonly string[] | undefined> = {};
  for (const [k, v] of Object.entries(q)) {
    if (typeof v === 'string') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === 'string');
  }
  return out;
}

function splitPathAndQuery(urlStr: string): { readonly path: string } {
  const idx = urlStr.indexOf('?');
  const pathOnly = idx === -1 ? urlStr : urlStr.slice(0, idx);
  return { path: pathOnly.length > 1 && pathOnly.endsWith('/') ? pathOnly.slice(0, -1) : pathOnly };
}

async function readJsonBody(req: ExpressRequestLike): Promise<JsonValue | undefined> {
  // If express.json() pre-parsed, use it.
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object') {
    return req.body as JsonValue;
  }
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'DELETE') return undefined;
  const ct = (req.headers['content-type'] ?? '').toLowerCase();
  if (!ct.includes('application/json')) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonValue;
  } catch {
    return undefined;
  }
}

/** Convert a `Handler` into an Express `(req, res, next) => void`. */
export function toExpressHandler(
  handler: Handler,
): (req: ExpressRequestLike, res: ExpressResponseLike, next: NextFn) => void {
  return (req, res, next) => {
    void (async () => {
      try {
        const rawMethod = (req.method ?? 'GET').toUpperCase();
        if (!isKnownMethod(rawMethod)) {
          res.status(405);
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.send(
            JSON.stringify({
              success: false,
              error: { code: 'MethodNotAllowed', message: `method ${rawMethod} not allowed` },
            }),
          );
          return;
        }
        const { path } = splitPathAndQuery(req.originalUrl ?? req.url ?? '/');
        const hreq: HandlerRequest = {
          method: rawMethod,
          path,
          query: normalizeQuery(req.query),
          headers: normalizeHeaders(req.headers),
          body: await readJsonBody(req),
          remoteAddr: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        };
        const hres = await handler(hreq);
        res.status(hres.status);
        if (hres.headers !== undefined) {
          for (const [k, v] of Object.entries(hres.headers)) {
            res.setHeader(k, v);
          }
        }
        if (hres.body === undefined) {
          res.end();
          return;
        }
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.send(JSON.stringify(hres.body));
      } catch (e) {
        // Forward to Express's error handler so the app's own logger sees it.
        // Last-resort safety: if nothing is listening, Express will 500.
        if (!res.headersSent) next(e);
      }
    })();
  };
}
