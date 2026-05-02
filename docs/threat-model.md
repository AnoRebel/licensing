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
client next contacts the issuer. The protocol is offline-first by
design; this is a feature, not a bug, but it has a security
consequence.

**Best-effort mitigations** (all configurable per-deployment):

1. **`force_online_after` claim.** When set, the client MUST attempt
   an online refresh once `now ≥ force_online_after` and MUST surface
   `RequiresOnlineRefresh` if the issuer is reachable but rejects the
   refresh. Past `force_online_after` with the issuer unreachable, the
   client enters a configurable **grace window** (default 7 days);
   past the grace window, verification fails with `GraceExpired`.

2. **Heartbeat-driven revocation push.** The client's heartbeat
   scheduler sends the bearer token to `/heartbeat`, where the
   issuer checks the license's authoritative status. A revoked or
   suspended license response (`LicenseRevoked` / `LicenseSuspended`)
   causes the client to clear its local token store with a CAS guard
   that prevents clobbering a parallel `Refresh()` write. This
   compresses the worst-case offline window from "until `exp`" to
   "until next heartbeat tick", typically within the configured
   interval (default 1 hour).

**Limit:** a malicious offline client can simply not call `/refresh`
or `/heartbeat`. The mitigations are honor-system; they tighten the
window for cooperating clients but do not defend against a determined
adversary who controls the device. Anyone designing a deployment
where revocation latency must be tight should pair LIC1 with an
online check at every high-stakes operation, not rely on the token
alone.

### 2.2 Verifier compromise — limits and escalation paths

If an attacker compromises a machine running the verifier, they can
bypass any check that runs INSIDE the verifier — signature
verification, expiry, fingerprint match, the JtiLedger lookup, the
TransparencyHook delivery. **By definition, no protocol-level
mechanism inside the verifier can defeat an attacker who already has
that level of access.** The verifier is the trust boundary; you
cannot build a defense inside the trust boundary against an attacker
who is also inside it.

LIC1 therefore makes no claim against this attack. But "by
definition" is doing a lot of work in that sentence — the cost of
bypass varies enormously across deployment patterns, and operators
concerned about verifier compromise have several layers available to
them outside the LIC1 envelope:

**Tighten the offline window (already supported by LIC1).** The
default `tokenTtlSec` of 3600 leaves a 1-hour window where a
bypassed verifier accepts a stolen token. Operators concerned about
verifier compromise should crank this to 300s or less and set
aggressive `force_online_after` so the verifier MUST re-check soon.
Combined with the heartbeat-driven revocation push (§2.1), this
shrinks the window from "until exp" to "until next heartbeat tick"
for cooperating clients — a compromised verifier still bypasses, but
only briefly.

**Hardware-rooted attestation.** TPM, TEE (Intel SGX, AMD SEV-SNP),
or Secure Enclave deployments raise the bypass cost from "edit the
binary" to "compromise the enclave." Code identity (only the signed
verifier binary runs), sealed storage (tokens decrypt only inside
the enclave), and remote attestation (a third party verifies the
verifier is unmodified) move the threat qualitatively. LIC1 doesn't
ship with attestation today; future work could add a
`verifier-attestation` claim that the issuer demands at activation
time so non-attested verifiers can't get tokens at all.

**Anti-tamper packaging.** For binary verifiers (CLI tools, native
apps), strip symbols, add anti-debugging traps, and have the
verifier integrity-check itself at startup. None of these defeat a
determined attacker, but they raise the floor — what was a 5-minute
patch becomes a multi-day reverse-engineering job. Whether that's
enough depends on the prize.

**Out-of-band revocation signals.** Push notifications (FCM, APNs)
or polled-DNS revocation lists let the issuer notify a verifier that
a license should be invalidated even when the verifier hasn't asked
recently. Combined with attestation, this approaches "online check
at every high-stakes operation" without paying the latency on the
hot path.

**Forensics over prevention.** The JtiLedger (§2.4) + TransparencyHook
(§4.2) stack lets operators DETECT compromise after the fact even
when prevention failed. Replayed tokens surface as `TokenReplayed`,
and an external transparency log diverging from the operator's audit
log is a clear signal. Forensic readiness doesn't stop the first
attack, but it caps the damage — the attacker can't stay undetected
indefinitely.

**Online-only authorization at high-stakes operations.** The strongest
mitigation: don't trust the verifier at all for actions that matter.
The verifier becomes a ticket-holder; the issuer (or a separate
authorization service) makes the actual decision. This defeats the
LIC1 offline-first pitch — but for deployments where the value
protected exceeds the cost of always-online authorization, it's the
right answer. Pair LIC1 with a second authorization layer rather
than relying on token validation alone.

No combination of these turns LIC1 into a system that defends against
verifier compromise. The right combination shifts the threat from
"indefinite undetected access" to "limited window of bypass that
leaves forensic evidence" — which may or may not be enough.
Deployments where it isn't should treat LIC1 as licensing infrastructure
(who paid, what tier, when does it expire) and layer separate
authorization infrastructure for the actions that matter.

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

### 2.4 Replay within `exp` (online verifiers only)

A captured token replayed against the same verifier within
`exp + skew` MUST verify successfully under the offline-first default
configuration. LIC1's signature verification has no built-in nonce
or jti-tracking layer; the codec gives you a strong unique `jti` per
token, but binding "first use" semantics is the verifier's job.

**Mitigation (online verifiers):** the optional
`ValidateOptions.JtiLedger` (Go) / `ValidateOptions.jtiLedger` (TS).
When supplied, validate records each token's `jti` after every other
check passes; a second validate of the same token surfaces
`TokenReplayed`. Three implementations ship out of the box:

- `MemoryJtiLedger` — single-instance, in-process.
- `SqliteJtiLedger` — single-instance with persistence, or shared via
  a network filesystem.
- `PostgresJtiLedger` — multi-instance with shared backing.

The persistent adapters use the `jti_uses` table created by
migration `0003_jti_uses.sql`; `INSERT ... ON CONFLICT DO NOTHING`
distinguishes first-use from replay in a single round trip.
Operators MAY call `PruneExpired(now)` from their own scheduler so
the ledger doesn't grow without bound — entries past `exp + skew`
are safe to delete.

**Limit:** the ledger is meaningful only for **online verifiers**.
Offline clients cannot consult a shared store, so the protocol's
default offline-first use case ignores this layer. Online deployments
that share a single trust domain (one verifier, or many sharing one
ledger backing store) gain per-trust-domain replay protection;
operators who run multiple independent verifiers without shared
storage need a different design (e.g. one-time tokens minted per
session, with the issuer enforcing single-use server-side).

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

### 3.2 Side-channel attacks on private key material

Timing attacks, cache attacks, EM-emission attacks, and other
side channels against the signing primitive (Ed25519, RSA-PSS,
HMAC-SHA-256) are out of scope for LIC1. Use a library you trust
(both ports use the language's standard cryptographic libraries)
and run signing in an environment where the threat model excludes
the relevant adversary.

### 3.3 Coercion / legal compulsion

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

### 4.2 CT-style transparency — opt-in hook

LIC1 has no built-in public, append-only log of issued tokens
analogous to Certificate Transparency. Full CT semantics (witness
servers, gossip protocols, third-party log monitors) are out of scope
for v0.1.0 — the deployment surface is too heavy for the licensing
market today.

A **lightweight opt-in mitigation** ships in both ports: a transparency
hook on the token-issue path. When the operator wires
`IssueTokenInput.TransparencyHook` (Go) /
`IssueTokenInput.transparencyHook` (TS) — or surfaces it on
`ClientHandlerContext.TransparencyHook` / `.transparencyHook` so the
HTTP layer fires it on every `/activate` and `/refresh` issuance — the
hook receives:

- `Jti` / `jti` — the token's unique identifier
- `LicenseID`, `UsageID`, `Kid` — context for indexing
- `Iat`, `Exp` — when it was issued and when it expires
- `TokenSHA256` / `tokenSha256` — lowercase-hex SHA-256 of the
  full wire-token bytes (64 chars)

Operators can mirror these events to an externally-verifiable
append-only store (S3 with object lock, AWS QLDB, immudb, a managed
CT-style log). A third party with read access to that store can
compare against the operator's local audit log to detect a stolen-
key attacker who minted tokens that didn't appear in the external
log.

The hook is fire-and-forget: any retry / async / error-surfacing
concern lives in the operator's wrapper, and a hook failure does NOT
fail the token issuance. The token is already signed and returned to
the caller by the time the hook fires; throwing from the hook in
TypeScript or panicking from it in Go propagates to the caller, but
that's an operator choice — wrap with `try` / `recover` if you want
issuance to succeed even when the transparency vendor is degraded.

This is **80% of CT's detection property at 5% of the cost.** It does
not provide gossip-based public verifiability without operator
buy-in, and operators concerned about supply-chain attacks on the
transparency vendor itself need additional layers.

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
