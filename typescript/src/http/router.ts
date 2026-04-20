/**
 * Minimal path router. We don't want a framework dep for routing, but we
 * do need path params (`/admin/licenses/:id`). This is ~60 lines of
 * regex-free matching that's plenty fast for the endpoint counts we deal
 * with (~35 total routes).
 *
 * Design:
 *   - Routes are declared as `{method, pattern, handler}`.
 *   - `pattern` is a plain string; `:name` segments capture.
 *   - Match is O(routes) — trivial at our scale.
 *   - Wildcards are intentionally absent. We know the full surface.
 */

import { err } from './envelope.ts';
import type { Handler, HandlerRequest, HandlerResponse, HttpMethod, Middleware } from './types.ts';

export interface Route {
  readonly method: HttpMethod;
  readonly pattern: string;
  readonly handler: (
    req: HandlerRequest,
    params: Readonly<Record<string, string>>,
  ) => Promise<HandlerResponse>;
  /** If true, the auth middleware skips this route. Default false. */
  readonly public?: boolean;
}

interface CompiledRoute {
  readonly method: HttpMethod;
  readonly segments: readonly RouteSegment[];
  readonly handler: Route['handler'];
  readonly public: boolean;
}

type RouteSegment =
  | { readonly kind: 'static'; readonly value: string }
  | { readonly kind: 'param'; readonly name: string };

function compileRoute(route: Route): CompiledRoute {
  const parts = route.pattern.split('/').filter((p) => p.length > 0);
  const segments: RouteSegment[] = parts.map((part) =>
    part.startsWith(':') ? { kind: 'param', name: part.slice(1) } : { kind: 'static', value: part },
  );
  return { method: route.method, segments, handler: route.handler, public: route.public ?? false };
}

function matchSegments(
  segments: readonly RouteSegment[],
  pathParts: readonly string[],
): Readonly<Record<string, string>> | null {
  if (segments.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const part = pathParts[i];
    if (seg === undefined || part === undefined) return null;
    if (seg.kind === 'static') {
      if (seg.value !== part) return null;
    } else {
      params[seg.name] = decodeURIComponent(part);
    }
  }
  return params;
}

export interface RouterOptions {
  /** Middleware applied in order, outermost first. Auth goes first, then
   *  rate-limit, then the handler. The middleware receives the matched
   *  route's `public` flag via the adapter-attached `__route_is_public`
   *  header (see `buildHandler` below). */
  readonly middleware?: readonly Middleware[];
}

/** Compile a route table into a single `Handler`. Unknown routes → 404;
 *  known path + wrong method → 405. */
export function createRouter(routes: readonly Route[], opts: RouterOptions = {}): Handler {
  const compiled = routes.map(compileRoute);
  const middleware = opts.middleware ?? [];

  async function dispatch(req: HandlerRequest): Promise<HandlerResponse> {
    const pathParts = req.path.split('/').filter((p) => p.length > 0);

    // First pass: collect every compiled route whose path matches, remember
    // their method + public flag. Second pass: choose the method match or
    // surface 405 if a path-only match exists.
    let methodMismatch = false;
    let matchedPublic = false;
    let handlerFn: CompiledRoute['handler'] | null = null;
    let matchedParams: Readonly<Record<string, string>> | null = null;

    for (const route of compiled) {
      const params = matchSegments(route.segments, pathParts);
      if (params === null) continue;
      if (route.method !== req.method) {
        methodMismatch = true;
        continue;
      }
      handlerFn = route.handler;
      matchedParams = params;
      matchedPublic = route.public;
      break;
    }

    if (handlerFn === null) {
      if (methodMismatch)
        return err(405, 'MethodNotAllowed', `method ${req.method} not allowed for ${req.path}`);
      return err(404, 'NotFound', `no handler for ${req.method} ${req.path}`);
    }

    // Route's `public` flag tells middleware to short-circuit (auth, rate
    // limit still run if they want). We encode it as a synthetic header
    // that middleware can read without changing their signature.
    const enrichedReq: HandlerRequest = matchedPublic
      ? { ...req, headers: { ...req.headers, 'x-licensing-route-public': '1' } }
      : req;

    const final: Handler = async (r) => {
      if (matchedParams === null || handlerFn === null) {
        // Unreachable — we only reach `final` after a successful match.
        return err(500, 'InternalError', 'router invariant violation');
      }
      return handlerFn(r, matchedParams);
    };

    // Compose middleware right-to-left so the first entry is outermost.
    const chain = middleware.reduceRight<Handler>((next, mw) => (r) => mw(r, next), final);
    return chain(enrichedReq);
  }

  return dispatch;
}
