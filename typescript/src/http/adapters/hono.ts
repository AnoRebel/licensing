/**
 * Hono adapter. Produces either a `Hono` app or a `MiddlewareHandler` you
 * can `.use('/api/licensing/v1/*', fn)` onto an existing app.
 *
 * Hono peer dep is optional — we import types only and use the runtime
 * objects the caller injects. This keeps `@licensing/sdk/http` from
 * pulling Hono into consumers who only wanted Express.
 *
 * Usage:
 *
 *   import { Hono } from 'hono';
 *   import { toHonoHandler } from '@licensing/sdk/http/adapters/hono';
 *
 *   const app = new Hono();
 *   app.all('/api/licensing/v1/*', toHonoHandler(router));
 */

import type { Handler, HandlerRequest, HttpMethod, JsonValue } from '../types.ts';

// Hono's concrete types are peer-dep-guarded. We use `any`-free structural
// types here to stay compile-clean without `hono` installed.
//
// `BodyInit` is a DOM lib symbol; our tsconfig doesn't pull in `dom`, so we
// re-express the subset we actually pass (string | null). Hono accepts far
// more (Blob, ReadableStream, ArrayBuffer, etc.) but the licensing adapter
// only ever serializes JSON text or sends empty responses.
interface HonoContextLike {
  readonly req: {
    readonly method: string;
    readonly url: string;
    readonly raw: { readonly headers: Headers };
    json: () => Promise<unknown>;
    header: (name: string) => string | undefined;
  };
  // Hono's `c.body` / `c.json` / `c.newResponse` all accept these shapes.
  newResponse: (body: string | null, init?: ResponseInit) => Response;
}

function isKnownMethod(m: string): m is HttpMethod {
  return m === 'GET' || m === 'POST' || m === 'PATCH' || m === 'DELETE';
}

function parseQueryFromUrl(urlStr: string): {
  readonly path: string;
  readonly query: Readonly<Record<string, string | readonly string[] | undefined>>;
} {
  // Hono gives us a full URL (e.g. `http://localhost/path?x=1`), so URL
  // parsing is straightforward.
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return { path: urlStr, query: {} };
  }
  const q: Record<string, string | readonly string[] | undefined> = {};
  for (const key of url.searchParams.keys()) {
    const all = url.searchParams.getAll(key);
    q[key] = all.length === 1 ? all[0] : all;
  }
  const rawPath = url.pathname;
  const path = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  return { path, query: q };
}

function normalizeHonoHeaders(h: Headers): Readonly<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

function clientIpFromHeaders(h: Headers): string {
  const fwd = h.get('x-forwarded-for');
  if (fwd !== null && fwd.length > 0) {
    const leftmost = fwd.split(',')[0];
    if (leftmost !== undefined) return leftmost.trim();
  }
  const real = h.get('x-real-ip');
  if (real !== null) return real;
  return 'unknown';
}

async function readHonoBody(c: HonoContextLike): Promise<JsonValue | undefined> {
  const method = c.req.method.toUpperCase();
  if (method === 'GET' || method === 'DELETE') return undefined;
  const ct = c.req.header('content-type') ?? '';
  if (!ct.toLowerCase().includes('application/json')) return undefined;
  try {
    return (await c.req.json()) as JsonValue;
  } catch {
    return undefined;
  }
}

/** Convert a `Handler` into a Hono context handler
 *  `(c) => Response | Promise<Response>`. */
export function toHonoHandler(handler: Handler): (c: HonoContextLike) => Promise<Response> {
  return async (c) => {
    const rawMethod = c.req.method.toUpperCase();
    if (!isKnownMethod(rawMethod)) {
      return c.newResponse(
        JSON.stringify({
          success: false,
          error: { code: 'MethodNotAllowed', message: `method ${rawMethod} not allowed` },
        }),
        { status: 405, headers: { 'content-type': 'application/json; charset=utf-8' } },
      );
    }
    const { path, query } = parseQueryFromUrl(c.req.url);
    const headers = c.req.raw.headers;
    const hreq: HandlerRequest = {
      method: rawMethod,
      path,
      query,
      headers: normalizeHonoHeaders(headers),
      body: await readHonoBody(c),
      remoteAddr: clientIpFromHeaders(headers),
    };
    const hres = await handler(hreq);
    const respHeaders: Record<string, string> = {};
    if (hres.headers !== undefined) Object.assign(respHeaders, hres.headers);
    if (hres.body !== undefined) {
      respHeaders['content-type'] = 'application/json; charset=utf-8';
      return c.newResponse(JSON.stringify(hres.body), {
        status: hres.status,
        headers: respHeaders,
      });
    }
    return c.newResponse(null, { status: hres.status, headers: respHeaders });
  };
}
