/**
 * Node stdlib `http` adapter. Turns a `Handler` into a
 * `(req, res) => void` function suitable for `http.createServer(fn)`.
 *
 * This adapter has zero framework dependencies — just the Node `http`
 * types. Every other adapter (Hono/Express/Fastify) ultimately funnels
 * into the same `Handler` shape.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Handler, HandlerRequest, HttpMethod, JsonValue } from '../types.ts';

function isKnownMethod(m: string): m is HttpMethod {
  return m === 'GET' || m === 'POST' || m === 'PATCH' || m === 'DELETE';
}

function remoteAddrFrom(req: IncomingMessage): string {
  // Prefer an explicit forwarded-for header the caller's reverse proxy
  // set; fall back to the raw socket peer.
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    const leftmost = fwd.split(',')[0];
    if (leftmost !== undefined) return leftmost.trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function normalizeHeaders(
  raw: NodeJS.Dict<string | string[]>,
): Readonly<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    // For repeated headers Node concatenates per RFC 9110 §5.2; we collapse
    // arrays with a comma-joined string which matches that convention.
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

function parseQuery(urlStr: string): {
  readonly path: string;
  readonly query: Readonly<Record<string, string | readonly string[] | undefined>>;
} {
  const idx = urlStr.indexOf('?');
  const pathOnly = idx === -1 ? urlStr : urlStr.slice(0, idx);
  const queryStr = idx === -1 ? '' : urlStr.slice(idx + 1);
  const params = new URLSearchParams(queryStr);
  const q: Record<string, string | readonly string[] | undefined> = {};
  for (const key of params.keys()) {
    const all = params.getAll(key);
    q[key] = all.length === 1 ? all[0] : all;
  }
  // Normalize trailing slashes (preserve root `/`).
  const path = pathOnly.length > 1 && pathOnly.endsWith('/') ? pathOnly.slice(0, -1) : pathOnly;
  return { path, query: q };
}

async function readBody(req: IncomingMessage): Promise<JsonValue | undefined> {
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'DELETE') return undefined;
  const contentType = (req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.includes('application/json')) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    // Let downstream handlers surface a 400 via `requireJsonObject` which
    // sees `undefined`.
    return undefined;
  }
}

/** Convert a `Handler` into a Node request listener. Non-JSON and
 *  unknown-method requests are handled defensively. */
export function toNodeListener(
  handler: Handler,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      try {
        const method = (req.method ?? 'GET').toUpperCase();
        if (!isKnownMethod(method)) {
          res.statusCode = 405;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(
            JSON.stringify({
              success: false,
              error: { code: 'MethodNotAllowed', message: `method ${method} not allowed` },
            }),
          );
          return;
        }
        const { path, query } = parseQuery(req.url ?? '/');
        const hreq: HandlerRequest = {
          method,
          path,
          query,
          headers: normalizeHeaders(req.headers),
          body: await readBody(req),
          remoteAddr: remoteAddrFrom(req),
        };
        const hres = await handler(hreq);
        res.statusCode = hres.status;
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
        res.end(JSON.stringify(hres.body));
      } catch {
        // Last-resort handler — something threw outside our normal paths.
        // Never leak internals.
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(
            JSON.stringify({
              success: false,
              error: { code: 'InternalError', message: 'an unexpected error occurred' },
            }),
          );
        }
      }
    })();
  };
}
