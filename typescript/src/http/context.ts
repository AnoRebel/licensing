/**
 * Shared handler-group context. Consumers construct one of these and
 * hand it to `createClientHandlers(...)` / `createAdminHandlers(...)`.
 * Bundling the dependencies up front keeps individual handler signatures
 * small and makes wiring adapters (Hono/Express/Fastify) uniform.
 */

import type { Clock, KeyAlg, SignatureBackend, Storage } from '../index.ts';

export interface HandlerContext {
  /** Storage adapter — any `Storage` implementation works (memory,
   *  sqlite, postgres). */
  readonly storage: Storage;
  /** Injected clock for deterministic tests. */
  readonly clock: Clock;
  /** Registered signature backends (ed25519, rs256-pss, hs256). */
  readonly backends: ReadonlyMap<KeyAlg, SignatureBackend>;
  /** Semver string reported by `GET /health`. */
  readonly version: string;
}

/** Client-specific context augments the base with issuance policy. */
export interface ClientHandlerContext extends HandlerContext {
  /** Token lifetime in seconds (becomes `exp - iat`). Default 3600. */
  readonly tokenTtlSec?: number;
  /** Default signing algorithm. Default `'ed25519'`. */
  readonly defaultAlg?: KeyAlg;
  /** Signing key passphrase — sourced from KMS/env/vault in prod, never
   *  hardcoded. Required because the core `issueToken` demands it per-call. */
  readonly signingPassphrase: string;
  /** Force-online-after override for issued tokens (absolute unix seconds).
   *  When undefined, `issueToken` falls back to `license.meta.force_online_after_sec`. */
  readonly forceOnlineAfter?: number | null;
}

/** Admin-specific context. Key-rotation endpoints require the root + signing
 *  passphrases; the rest of the admin surface only needs the base context.
 *  Passphrases are *required for the rotate endpoint only* and are supplied
 *  here so the handler group wires them once rather than via the request
 *  body. (Putting passphrases on the wire is a non-starter.) */
export interface AdminHandlerContext extends HandlerContext {
  /** Passphrase for root keys — used by `POST /admin/keys/{id}/rotate` to
   *  re-sign the new signing key's attestation. Omit to disable rotation. */
  readonly rootPassphrase?: string;
  /** Passphrase for newly-minted signing keys. Omit to disable rotation
   *  and signing-key issuance. */
  readonly signingPassphrase?: string;
}
