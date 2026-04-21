/**
 * Shared input types for the fixture generator.
 *
 * The `inputs.json` format is the single authoritative input for a vector:
 * everything else in the directory is *derived* from it. A valid vector's
 * directory is:
 *   inputs.json            (committed, hand-authored)
 *   canonical_header.bin   (generated; byte-identical across ports)
 *   canonical_payload.bin  (generated; byte-identical across ports)
 *   expected_token.txt     (generated; the full LIC1 token + trailing \n)
 */

export type KeyAlg = 'ed25519' | 'rs256-pss' | 'hs256';

/** Filesystem name under `fixtures/keys/`. `ed25519` | `rsa` | `hmac`. */
export type KeyRef = 'ed25519' | 'rsa' | 'hmac';

export interface ValidInputs {
  /** Algorithm. MUST equal header.alg. */
  readonly alg: KeyAlg;
  /** Key id. MUST equal header.kid. */
  readonly kid: string;
  /** Key material source under fixtures/keys/<key_ref>/. */
  readonly key_ref: KeyRef;
  /** Header object to canonicalize verbatim. */
  readonly header: Record<string, unknown>;
  /** Payload object to canonicalize verbatim. */
  readonly payload: Record<string, unknown>;
  /** Optional fixed "now" (unix seconds) for deterministic iat-based vectors. */
  readonly now?: number;
  /** Human-readable summary, rendered into the README when browsing vectors. */
  readonly description?: string;
}

export interface TamperSpec {
  /** Suffix appended to the source vector id (e.g., 042-sig-bitflip). */
  readonly variant: string;
  /** What kind of tamper — also drives which byte/field to mutate. */
  readonly kind:
    | 'header-bitflip'
    | 'payload-bitflip'
    | 'sig-bitflip'
    | 'wrong-kid'
    | 'missing-required-claim'
    | 'expired'
    | 'nbf-in-future';
  /** For `missing-required-claim` — which payload claim to delete. */
  readonly claim?: string;
  /** For `wrong-kid` — the substitute kid to use. Defaults to `not-a-real-kid`. */
  readonly substituteKid?: string;
}

export interface TamperManifest {
  readonly source: string; // source vector id, e.g. "001"
  readonly variants: readonly TamperSpec[];
}
