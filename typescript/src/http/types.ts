/**
 * Framework-agnostic HTTP types. Adapters (Hono, Express, Fastify, Node)
 * translate between their native Request/Response shapes and these types.
 *
 * Design principle: handler logic NEVER touches a framework. It receives a
 * `HandlerRequest` (plain data), returns a `HandlerResponse` (plain data),
 * and the adapter handles all the plumbing.
 */

/** Plain JSON value type. Matches `@anorebel/licensing`'s `JSONValue` but kept
 *  local to avoid coupling consumers of the http-handlers surface to that
 *  type when all they do is pass a JSON body through. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { readonly [k: string]: JsonValue }
  | readonly JsonValue[];

/** The subset of HTTP methods the licensing API uses. Add-on verbs like
 *  HEAD/OPTIONS aren't exposed by the OpenAPI spec and deliberately aren't
 *  declared here — adapters that receive one should treat it as 405. */
export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** Incoming request as seen by the handler core. Opaque to the adapter
 *  layer's framework conventions. */
export interface HandlerRequest {
  readonly method: HttpMethod;
  /** Path without query string; no trailing slash (except root). */
  readonly path: string;
  /** Already-parsed query params. Array values for repeated keys. */
  readonly query: Readonly<Record<string, string | readonly string[] | undefined>>;
  /** Already-normalized header map. Keys SHALL be lowercase. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** Already-parsed JSON body, or `undefined` if absent / non-JSON.
   *  Adapters that can't parse return `undefined`; the handler decides
   *  whether that's an error. */
  readonly body: JsonValue | undefined;
  /** Opaque client address the rate limiter keys off of. Adapters choose
   *  the source: direct peer address, `x-forwarded-for` leftmost, etc. */
  readonly remoteAddr: string;
}

/** Outgoing response. Adapters serialize `body` as JSON unless `status`
 *  is 204 (no content) — in which case `body` MUST be `undefined`. */
export interface HandlerResponse {
  readonly status: number;
  /** Extra headers set by the handler. Rate-limit `Retry-After` lives here. */
  readonly headers?: Readonly<Record<string, string>>;
  /** JSON body; `undefined` for 204 responses. */
  readonly body?: JsonValue;
}

/** A handler is a pure function from request to response. Impure only in
 *  that it calls into the storage layer (which is an injected dependency). */
export type Handler = (req: HandlerRequest) => Promise<HandlerResponse>;

/** Middleware wraps a handler and may short-circuit with a response (e.g.,
 *  auth rejection, rate-limit 429) or pass through to `next` after possibly
 *  mutating nothing (middleware is pure — attach state via headers if you
 *  must, otherwise keep concerns separated). */
export type Middleware = (req: HandlerRequest, next: Handler) => Promise<HandlerResponse>;

/** Canonical success envelope. */
export interface SuccessEnvelope<T extends JsonValue> {
  readonly success: true;
  readonly data: T;
}

/** Canonical error envelope. `code` is a stable identifier matching the
 *  core `LicensingErrorCode` union plus HTTP-specific codes the core
 *  doesn't raise (e.g., `BadRequest`, `MethodNotAllowed`). */
export interface ErrorEnvelope {
  readonly success: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}
