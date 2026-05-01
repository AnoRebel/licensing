# LIC1 threat model

This document describes what the LIC1 token format defends against, what
it deliberately does NOT defend against, and how the offline-first
deployment model shapes those choices.

System-level concerns (key hierarchy, key storage at rest, admin-API
authentication, audit-log immutability) are covered separately in
[`docs/security.md`](./security.md). This file focuses on the **token
envelope** — the `LIC1.<header>.<payload>.<sig>` wire format and the
verification pipeline that consumes it.

The wire format itself is in [`docs/token-format.md`](./token-format.md);
read that first if you are implementing a verifier.

## 1. In scope (the token MUST defend)

### 1.1 Forgery without a signing key

An attacker who does not hold a signing key MUST NOT be able to produce
a token that any conforming verifier accepts.

**Mitigation:** every LIC1 token's signature is over the canonical
`<header_b64>.<payload_b64>` byte string. Verification uses the
caller-pinned `(kid → public_key)` map; absent the matching private
key, no signature satisfies the primitive.

**Caveat:** HS256 violates this — see §3.2.

### 1.2 Algorithm confusion

The classic JWT footgun: an attacker swaps `header.alg` to `"none"`,
or to `"HS256"` while presenting an RSA public key as the HMAC secret,
hoping the verifier dispatches to a primitive that trivially accepts
the forged signature.

**Mitigation:** every `kid` is registered with its expected `alg` at
verifier construction. On every token, the verifier:

1. Reads `header.kid` and `header.alg`.
2. Looks up the **registered** `alg` for that `kid`.
3. Compares to `header.alg`. Mismatch → `AlgorithmMismatch`,
   **before any backend is invoked.**

A token whose header `alg` disagrees with the pre-bound pair never
reaches a verification primitive at all. See `licensing/verify.go`
and `typescript/src/verify.ts` for the implementation, and
[`docs/security.md`](./security.md) §"Algorithm confusion" for the
key-management context.

### 1.3 Signature stripping via re-serialization

A naive verifier that re-serializes a parsed JSON object before
signature verification opens up an attack: the attacker submits
`{"a":1,"b":2}`, the verifier parses it to a map, re-serializes
(possibly with different key order or whitespace), and verifies the
signature over **the re-serialized bytes** — which the attacker can
predict and forge.

**Mitigation:** LIC1 uses **canonical JSON** (deterministic key sort,
zero whitespace, locked escape table, integer-only numbers) and the
verifier signs/verifies over the **wire** base64url segments, not
over re-serialized output. There is exactly one byte string for any
given header/payload, and it's the one that travels.

See [`docs/token-format.md`](./token-format.md) §4 for the
canonical-JSON rules and §1.1 for the signing-input definition.

### 1.4 Clock-fuzz attacks on `exp` / `nbf`

An attacker manipulates the verifier's clock to extend an expired
token's window or to consume a not-yet-valid one early.

**Mitigation:** `nbf` and `exp` are validated with a **strict, configurable
skew** (default 60 seconds). The boundary is inclusive of the stated
deadline — `exp + skew < now` (strictly less) fires `TokenExpired`,
not `≤`. Verifiers SHOULD source `now` from a monotonic system clock,
not from any value derivable from the token itself.

### 1.5 Token reuse across products / tenants (when pinned)

In a deployment where one root key signs licenses for multiple products
or tenants, an attacker captures a token issued for product A and
presents it to product B's verifier (which trusts the same root).

**Mitigation:** the optional `aud` (audience) claim in §3.2 of the spec.
When the verifier pins an expected audience, mismatches MUST fail with
`AudienceMismatch`. When unpinned, the claim is advisory and ignored —
single-tenant deployments don't pay for the check they don't need.

The optional `iss` claim is the symmetric defense for BYO-key
deployments where the verifier wants to pin "this token came from
issuer X" to defeat rogue-issuer attacks.

### 1.6 Status-based revocation

An issuer needs to revoke a token before its `exp` without waiting for
the client to refresh.

**Mitigation:** the required `status` claim. A signed `status="revoked"`
token MUST fail verification with `LicenseRevoked` even if the
signature is valid and `exp > now`. Practically, the client only
encounters this status if it re-fetches; for tokens already cached
locally and offline, see §2.1 below.

## 2. Partially defended (mitigations are best-effort)

### 2.1 Offline-first revocation latency

A revoked-but-cached token continues to verify locally until the
client next refreshes. The protocol is offline-first by design; this
is a feature, not a bug, but it has a security consequence.

**Best-effort mitigation:** the optional `force_online_after` claim.
When set, the client MUST attempt an online refresh once `now ≥
force_online_after` and MUST surface `RequiresOnlineRefresh` if the
issuer is reachable but rejects the refresh. After
`force_online_after` lapses with the issuer unreachable, the client
enters a configurable **grace window** (default 7 days); past the
grace window, verification fails with `GraceExpired`.

**Limit:** a malicious offline client can simply not call `/refresh`.
`force_online_after` is a feature gate (push hard refresh deadlines
from the issuer to the client) and a soft revocation hint, **not** a
forge defense. Anyone designing a deployment where revocation latency
must be tight should pair LIC1 with an online check at every
high-stakes operation, not rely on the token alone.

### 2.2 Verifier compromise

If an attacker compromises a machine running the verifier, they can:

- Bypass step 8 (signature verification) entirely.
- Or hold a valid token indefinitely past `exp` by lying about `now`.

**Mitigation:** none, by definition — the threat model treats the
verifier as a trusted component. Operators concerned about
verifier-side compromise should layer attestation (TPM, Secure
Enclave) and runtime integrity checks **outside** the LIC1 envelope.
LIC1 makes no claim against this attack.

### 2.3 Trial-issuance fingerprint enumeration

The trial-issuance dedupe layer hashes `(template_id, fingerprint)`
with a per-installation pepper to dedupe abusive trial signups. If the pepper leaks, an attacker can rainbow
the trial table to enumerate which fingerprints have ever requested
trials.

**Mitigation:** the pepper is operator-managed (env var, never
persisted alongside the data it protects). Operators MUST ensure
`LICENSING_TRIAL_PEPPER` is at least 32 random bytes and stored in
the same secrets vault as their database credentials, not in the
codebase or a config file. See `licensing/trials/pepper.go` and
`typescript/src/trials/pepper.ts`.

**Limit:** if both the DB and the pepper leak, the privacy property
is gone. Operators concerned about trial enumeration leakage should
rotate the pepper periodically; rotation invalidates all dedupe state
(every fingerprint can issue a new trial), which is acceptable for
most operations but should be planned as a maintenance window.

## 3. Out of scope (the token does NOT defend)

### 3.1 Symmetric-key forgery (HS256)

When `alg = "hs256"`, the verification key is the signing key.
Anyone who can verify can forge.

LIC1 supports HS256 because it has narrow legitimate uses
(server-to-server single-tenant, edge caches with locally-provisioned
HMAC keys, test fixtures). The wire format is unchanged across
algorithms, but the **threat model differs sharply** — see
[`docs/token-format.md`](./token-format.md) §6.1 for when HS256 is
defensible and when it absolutely is not.

The default `Issuer` constructor in both ports generates Ed25519 keys.
Operators choosing HS256 are expected to have read §6.1.

### 3.2 Replay across one verifier

A captured token, replayed against the same verifier within its
`exp + skew` window, MUST verify successfully. LIC1 has no built-in
nonce or jti-tracking layer.

If your application needs replay protection (e.g. license tokens
double as one-time activation receipts), layer a server-side `jti`
ledger on top — record `jti` on first use, reject on second.
The codec gives you a strong unique `jti` per token; binding "first
use" semantics is application-domain.

### 3.3 Side-channel attacks on private key material

Timing attacks, cache attacks, EM-emission attacks, and other
side channels against the signing primitive (Ed25519, RSA-PSS,
HMAC-SHA-256) are out of scope for LIC1. Use a library you trust
(both ports use the language's standard cryptographic libraries)
and run signing in an environment where the threat model excludes
the relevant adversary.

### 3.4 Coercion / legal compulsion

LIC1 cannot defend against "show me your signing key or go to jail".
Operators concerned about compelled key disclosure should investigate
HSM-based key custody (deferred to a v0.2+ feature, see
`docs/security.md` §"What the admin UI still lacks").

## 4. Known gaps tracked for hardening

### 4.1 Duplicate-key parser permissiveness — CLOSED

**Status: closed.** Both ports' canonical-JSON encoders reject duplicate
keys, AND the parsers used during verification now do too. The Go path
walks `json.Decoder.Token()` to detect duplicates before they collapse
into a `map[string]any`; the TypeScript path uses a small recursive-
descent parser (`src/strict-json.ts`) that rejects duplicates at parse
time. Both surface `CanonicalJSONDuplicateKey` BEFORE signature
verification runs, so a tampered token with `{"status":"revoked",
"status":"active"}` fails fast — even if an attacker somehow forged
a valid signature over duplicate-key bytes, the parser stops the token
before the signature check.

Test coverage:

- Go: `licensing/duplicate_key_test.go` — top-level, header, nested,
  array-nested duplicates plus end-to-end "fails before sig check"
- TypeScript: `tests/core/duplicate-key.test.ts` — same matrix plus a
  round-trip parity block proving the strict parser produces the same
  shape `JSON.parse` did for every valid (non-duplicate) input.

### 4.2 No CT-style transparency log

LIC1 has no public, append-only log of issued tokens analogous to
Certificate Transparency. A compromised issuer with stolen keys can
mint tokens that no third party can detect after the fact (only the
operator's own audit log records issuance, and that log is
local-trust).

This is intentional for v0.1.0 — full CT semantics multiply the
deployment surface (witness servers, gossip protocols) and the
licensing market does not yet demand it. Operators who need it should
mirror their `audit_log` to an externally-verifiable append-only
store (S3 with object lock, AWS QLDB, immudb).

### 4.3 No formal proof of canonicalization byte-equality

Both ports' canonicalizers are tested against shared fixtures and a
property test, but neither has a formal proof of byte-equality. This
is the highest-impact unknown-unknown in the codec; both ports'
canonicalizer fuzz tests are the closest practical substitute.

## 5. Reporting

Suspected vulnerabilities in LIC1 itself, or in either port's
implementation, should be reported privately to the project
maintainer rather than via a public issue tracker. The current
contact is the GitHub-listed maintainer of
[`AnoRebel/licensing`](https://github.com/AnoRebel/licensing); a
formal `SECURITY.md` with a coordinated-disclosure policy is planned
for v0.2+. Public issue tickets are welcome for clarifications,
additional tests, and documentation gaps.
