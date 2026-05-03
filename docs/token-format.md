# LIC1 token format

LIC1 is the on-wire license token issued by `github.com/AnoRebel/licensing`
and `@anorebel/licensing`. This document is the **normative spec**: the Go
and TypeScript ports MUST agree on every byte described here, and any
third-party verifier MUST follow these rules to accept tokens issued by a
conforming issuer.

This file is paired with:

- [`fixtures/README.md`](../fixtures/README.md) — operational fixture layout.
- [`fixtures/tokens/`](../fixtures/tokens/) — known-answer test vectors
  per algorithm (Ed25519, RSA-PSS, HS256), each containing locked key
  material refs, payload, expected canonical bytes, and expected wire
  token. Both ports verify against these in CI as a byte-determinism
  floor; the deterministic algs (Ed25519, HS256) check exact wire-byte
  equality, the probabilistic alg (RSA-PSS) checks header+payload byte
  equality plus cross-verification.
- [`docs/threat-model.md`](./threat-model.md) — what LIC1 defends against
  and what it deliberately does NOT.
- [`docs/security.md`](./security.md) — system-level concerns (key hierarchy,
  rotation, admin-API auth) outside the token envelope itself.

The fixtures are ground truth; this document describes how to reproduce them.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be
interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## 1. Wire shape

```
LIC1.<header_b64>.<payload_b64>.<sig_b64>
```

- `LIC1` — literal ASCII format prefix. Verifiers MUST reject any other
  prefix (including `LIC2`, `v4.public.`, JWT-style `eyJ...`) with
  `UnsupportedTokenFormat` **before** parsing the rest.
- `<header_b64>` — base64url of the canonical header JSON bytes, no padding.
- `<payload_b64>` — base64url of the canonical payload JSON bytes, no padding.
- `<sig_b64>` — base64url of the raw signature bytes, no padding.

A token is exactly four `.`-separated segments. Three segments, five
segments, or any segment containing `=` MUST fail with `TokenMalformed`.

### 1.1 Signing input

```
signing_input = <header_b64> || "." || <payload_b64>
```

The first two wire segments, ASCII, including the literal `.` separator.
Signatures are computed over **this exact byte string** — not over the
canonical JSON alone, and not with any trailing newline or whitespace.

### 1.2 Format prefix dispatch

The literal `LIC1` prefix is dispatched through a prefix allowlist (see
`licensing/lic1.go::dispatchFormat` and `typescript/src/token.ts::dispatch`).
Verifiers SHOULD treat unknown prefixes as opaque and surface
`UnsupportedTokenFormat` so a future format extension does not silently
re-route to the LIC1 parser.

This allowlist is **prefix-only**: it does not parse alternate formats,
only declares which prefixes are eligible to reach the LIC1 parser.

## 2. Header

Canonical JSON object with **exactly four fields** in the strict whitelist
below. Unknown fields fail with `TokenMalformed`. Missing fields fail with
`TokenMalformed`.

| Field | Type    | Required | Value                                              |
|-------|---------|----------|----------------------------------------------------|
| `v`   | integer | yes      | MUST be `1`. Any other value → `TokenMalformed`.   |
| `typ` | string  | yes      | MUST be `"lic"`. Any other value → `TokenMalformed`. |
| `alg` | string  | yes      | One of `"ed25519"`, `"rs256-pss"`, `"hs256"`. Any other value → `UnsupportedAlgorithm`. |
| `kid` | string  | yes      | Non-empty key id. MUST be pre-registered with a matching `alg`. |

The `kid` field is the join key for the verifier's pre-registered
`(kid → alg)` binding; see §7 step 6.

## 3. Payload

Canonical JSON object. The codec treats the payload as opaque; the domain
layer enforces the schema below at validate time.

### 3.1 Required claims

Every required claim MUST be present and have the listed type. A missing
or wrong-typed claim MUST fail with `InvalidTokenFormat`.

| Field               | Type    | Notes                                                  |
|---------------------|---------|--------------------------------------------------------|
| `jti`               | string  | Token id. UUIDv7 RECOMMENDED.                          |
| `iat`               | integer | Issued-at, Unix seconds.                               |
| `nbf`               | integer | Not-before, Unix seconds. Strict, with optional skew.  |
| `exp`               | integer | Expiry, Unix seconds. Strict, with optional skew. (Not nullable.) |
| `scope`             | string  | License scope identifier.                              |
| `license_id`        | string  | License ULID/UUIDv7.                                   |
| `usage_id`          | string  | Per-device usage record id.                            |
| `usage_fingerprint` | string  | Device fingerprint the token is bound to.              |
| `status`            | string  | One of `"active"`, `"grace"`, `"revoked"`, `"suspended"`, `"expired"`. Verifiers MUST accept only `"active"` and `"grace"`. |
| `max_usages`        | integer | Seat cap at issue time.                                |

### 3.2 Optional claims

| Field                | Type            | Notes                                       |
|----------------------|-----------------|---------------------------------------------|
| `force_online_after` | integer         | Hard refresh deadline, Unix seconds. When `now ≥ force_online_after`, the client MUST attempt an online refresh. See §3.4. |
| `entitlements`       | object          | Flat key→primitive map. Keys and value types are application-defined; the codec does not enforce a whitelist. |
| `aud`                | string \| array | Audience. When the verifier pins an expected audience, mismatches MUST fail with `AudienceMismatch`. When unpinned, advisory and ignored. |
| `iss`                | string          | Issuer. When the verifier pins an expected issuer, mismatches MUST fail with `IssuerMismatch`. When unpinned, advisory and ignored. |

Any other claim names are RESERVED. Verifiers MUST ignore unrecognised
claims rather than reject them — forward-compatibility for future
optional claims depends on this.

### 3.3 Status semantics

A token's `status` claim is the **issuer's view at the moment of signing**.
A `"revoked"`, `"suspended"`, or `"expired"` status MUST cause verification
to fail with the matching error code; the verifier MUST NOT treat such a
token as a usable license even if its signature is valid and `exp > now`.

This is the issuer's express revocation channel: instead of waiting for
clients to refresh, the issuer can sign a final `status="revoked"` token
that locks future verifications even if the original `exp` is far in the
future. (Practically, the client's stored token only flips this way if it
re-fetches; see §3.4.)

### 3.4 Grace and `force_online_after`

`exp` is strict on both sides:

- `exp + skew < now` → `TokenExpired`.
- `nbf > now + skew` → `TokenNotYetValid`.

`skew` defaults to 60 seconds and is configurable per-validator. Both
checks use a strict inequality boundary inclusive of the stated deadline
(see `licensing/client/validate.go` and `typescript/src/client/validate.ts`).

`force_online_after` is the issuer's **online-refresh hint**. When set
and `now ≥ force_online_after`, the client MUST treat the cached token
as requiring an online refresh:

- A successful `/refresh` returns a fresh token, resetting `force_online_after`.
- A network failure on `/refresh` enters the **grace window** (default
  604800s / 7 days). While in grace, the token is still locally valid
  but the client SHOULD warn the application that connectivity has
  degraded.
- Once `now ≥ grace_started_at + grace_window`, verification fails with
  `GraceExpired`.

`force_online_after` is a hint, not a security boundary: a malicious
offline client can simply not call `/refresh`. The threat model treats
this as a feature gate, not a forge defense (see
[`docs/threat-model.md`](./threat-model.md) §"Offline-first").

## 4. Canonical JSON (NORMATIVE)

Canonicalization applies to header and payload bytes that feed the
signature. It does NOT apply to arbitrary JSON elsewhere in the system
(e.g. envelope bodies, audit-log payloads).

### 4.1 Allowed types

`null`, `boolean`, `string`, `number` (integer only, see §4.4), `array`,
`object`. Any other type → `CanonicalJSONInvalidType`.

### 4.2 Whitespace

Zero insignificant whitespace. No space after `:` or `,`. No leading or
trailing whitespace. No line terminators inside or around the structure.

✓ `{"a":1,"b":[2,3]}`
✗ `{ "a": 1 }`

### 4.3 Object key ordering

Keys MUST be sorted ascending by their **UTF-16 code-unit sequence**.
This matches ECMA-262 default `Array.prototype.sort` on JS strings; Go
implementations transcode keys to UTF-16 to compare. ASCII-only keys
have a fast path because byte order equals UTF-16 order in that range.

The encoder MUST raise `CanonicalJSONDuplicateKey` if asked to serialize
an object with duplicate keys. *(In Go, `map[string]any` cannot hold
duplicates; this case arises only via deliberately-constructed paths.
In TypeScript, `Object.keys` cannot return duplicates either, but a
`Proxy` or hand-constructed property bag can produce them — both ports
guard explicitly.)*

#### 4.3.1 Parser duplicate-key rejection

Both the encoder and the **parser** reject duplicate keys. A token
containing `{"status":"revoked","status":"active"}` fails verification
with `CanonicalJSONDuplicateKey` BEFORE signature verification runs:

- **Go**: `parseJSONObject` walks `json.Decoder.Token()` and detects
  duplicates before they collapse into a `map[string]any`.
- **TypeScript**: `src/strict-json.ts` is a small recursive-descent
  parser that rejects duplicates at parse time; the rest of its
  behaviour is byte-identical to `JSON.parse` for all valid (non-
  duplicate) inputs, so existing fixtures and round-trip tests remain
  unchanged.

This closes the threat-model gap previously documented under
[`docs/threat-model.md`](./threat-model.md) §4.1; the parse-time
rejection is defence-in-depth even though the encoder-side guarantee
already prevented exploitable forgery.

### 4.4 Numbers

Integers only, in `[-2^53 + 1, 2^53 - 1]` (the JavaScript safe-integer
range). Both ports MUST agree on this bound to keep cross-language
serialization byte-stable.

- No leading zeros: `7` not `07`.
- No leading `+`.
- No decimal point, fractional digits, or exponent.
- Negative: single leading `-`, e.g. `-7`.
- `0` is the only zero. Negative zero is rejected.
- `NaN`, `Infinity`, `-Infinity`, and all non-integer floats →
  `CanonicalJSONInvalidNumber`.
- Floats that happen to be exact safe integers (e.g. `1.0`) MUST
  serialize as their integer form (`1`).

### 4.5 Strings

UTF-8. Escape table:

| Codepoint                 | Escape              |
|---------------------------|---------------------|
| `U+0022 "`                | `\"`                |
| `U+005C \`                | `\\`                |
| `U+0008` (BS)             | `\b`                |
| `U+0009` (HT)             | `\t`                |
| `U+000A` (LF)             | `\n`                |
| `U+000C` (FF)             | `\f`                |
| `U+000D` (CR)             | `\r`                |
| Other `U+0000`–`U+001F`   | `\u00XX` (lower hex)|

Everything else — including `/`, BMP non-ASCII, and astral codepoints —
emitted as raw UTF-8 bytes. The forward slash `/` is **not** escaped.
Astral codepoints emit as UTF-8 directly, not as `\uXXXX\uXXXX`
surrogate pairs.

Hex escapes use **lowercase** `a`–`f`.

Invalid UTF-8 → `CanonicalJSONInvalidUTF8`.

### 4.6 Arrays & objects

Arrays preserve input order, no trailing comma, `[]` for empty.

Objects: keys sorted per §4.3, each member emitted as `"<key>":<value>`,
joined by `,`, no trailing comma, `{}` for empty.

### 4.7 Top level

Header and payload MUST serialize to top-level JSON objects — not arrays,
strings, or primitives. Violations → `CanonicalJSONInvalidTopLevel`.

### 4.8 Worked example

Input:

```json
{
  "b": 2,
  "a": [3, 1, 2],
  "c": { "z": 1, "y": null, "x": "héllo/" }
}
```

Canonical bytes (no whitespace):

```
{"a":[3,1,2],"b":2,"c":{"x":"héllo/","y":null,"z":1}}
```

Note: `a < b < c`, `x < y < z`, `/` raw, `é` as UTF-8 `C3 A9`, `null`
literal.

## 5. base64url

RFC 4648 §5, unpadded. Alphabet `A–Z a–z 0–9 - _`. No `=` padding on
either encode or decode; decoders MUST reject `=` in LIC1 segments.

A LIC1 token is pure ASCII; verifiers SHOULD reject any byte outside
the printable ASCII range with `TokenMalformed` before attempting to
split on `.`.

## 6. Signatures

| `alg`        | Primitive                                  | Signature length     |
|--------------|--------------------------------------------|----------------------|
| `ed25519`    | RFC 8032 Ed25519                           | 64 bytes             |
| `rs256-pss`  | RSASSA-PSS, SHA-256, MGF1-SHA-256, salt=32 | `modulus_len` bytes  |
| `hs256`      | HMAC-SHA-256                               | 32 bytes             |

RSA keys below 2048 bits fail with `InsufficientKeyStrength` at key load
time. HMAC secrets below 32 bytes likewise. Both checks run **before**
any signature verification primitive runs.

### 6.1 HS256 — symmetric-key caveat

HS256 (HMAC-SHA-256) is supported but its threat model is fundamentally
different from the asymmetric algorithms. **The verification key is the
signing key.** Anyone who can verify an HS256 LIC1 token can also forge
one.

This rules out the protocol's typical deployment model — distributing
public keys to many client devices — because every client would then
hold a key capable of minting unlimited tokens. HS256 SHOULD therefore
NOT be used when:

- License tokens are verified on end-user devices, embedded systems,
  CI runners, or any environment outside the issuer's direct trust
  boundary.
- The `kid` is shared across multiple verifiers that don't all trust
  one another to the same degree.

HS256 is defensible in narrow scenarios:

- **Server-to-server, single-tenant.** The same operator runs the issuer
  and the verifier, and the HMAC secret is provisioned only into the
  verifier's own keystore.
- **Test fixtures and dev environments.** Faster than Ed25519 keygen
  and produces deterministic signatures, which is convenient for
  property-based testing of the codec.
- **Edge caches with rotating signing keys.** When a CDN or sidecar
  needs to verify tokens at the edge but has no path to a public-key
  bundle, an HS256 key per cache instance can be acceptable.

For any deployment that doesn't fit one of these, **use Ed25519**. The
default `Issuer` constructor in both the Go and TypeScript ports
generates Ed25519 keys; HS256 is opt-in and requires the consumer to
explicitly register an HMAC backend.

The issuer MAY require explicit operator confirmation before
issuing HS256 tokens (e.g. an `--allow-symmetric` CLI flag); this is
a defence-in-depth recommendation, not a wire-format rule.

## 7. Validation order (NORMATIVE)

To be interoperable, validators MUST execute these checks in this order.
The order is load-bearing for security: each step's failure terminates
verification before the next step's primitive is invoked.

1. **Format prefix.** Token starts with `LIC1.` → else `UnsupportedTokenFormat`.
2. **Segment count.** Exactly 4 segments split on `.` → else `TokenMalformed`.
3. **base64url decode** each of segments 1–3 → else `TokenMalformed`.
4. **Header parse.** Canonical-parse segment 1 into `{v, typ, alg, kid}`:
   - Unknown field → `TokenMalformed`.
   - Missing required field → `TokenMalformed`.
   - `v ≠ 1` or `typ ≠ "lic"` → `TokenMalformed`.
   - `alg` not in registry-allowed set → `UnsupportedAlgorithm`.
   - `kid` empty or not a string → `TokenMalformed`.
5. **kid → alg pre-registration lookup:**
   - `kid` not registered → `UnknownKid`.
   - registered alg ≠ `header.alg` → `AlgorithmMismatch`.
     **No backend invoked.** This step is the alg-confusion guard;
     see [`docs/security.md`](./security.md) §"Algorithm confusion".
6. **Backend lookup** for `alg`: not registered → `UnsupportedAlgorithm`.
7. **Public key load** for `kid` → typed key error on failure.
8. **Signature verification** over `<seg1_b64>.<seg2_b64>` → on failure,
   `TokenSignatureInvalid`.
9. **Payload parse.** Canonical-parse segment 2; assert required claims
   per §3.1.
10. **Lifetime checks** with skew (default 60s):
    - `nbf > now + skew` → `TokenNotYetValid`.
    - `exp + skew < now` → `TokenExpired`.
11. **Status check.** Only `"active"` and `"grace"` accepted. Others
    map to `LicenseRevoked`, `LicenseSuspended`, `TokenExpired`, or
    `InvalidTokenFormat` (unknown status value).
12. **`force_online_after` deadline** (no skew, hard boundary): if set
    and `now ≥ force_online_after` → `RequiresOnlineRefresh`.
13. **Fingerprint match.** `usage_fingerprint` MUST equal the verifier's
    bound device fingerprint → else `FingerprintMismatch`.
14. **Optional `aud`/`iss` checks** when the verifier pins them — see §3.2.
    Mismatches fire `AudienceMismatch` or `IssuerMismatch`. When the
    verifier does not pin them, the claims are ignored.

Steps 1–8 are codec-level. Steps 9–13 are application-layer and live in
`licensing/client/validate.go::Validate` and
`typescript/src/client/validate.ts::validate`. A verifier that only needs
signature validity (e.g. an admin-side log inspector) MAY stop at step 8
but MUST surface the bypass clearly; production token consumption MUST
run all 13.

## 8. Reproducing a fixture

Each fixture under `fixtures/tokens/<nnn>/`:

- `inputs.json` — `{alg, kid, header, payload, key_ref}`.
- `canonical_header.bin` — canonical bytes of `header`.
- `canonical_payload.bin` — canonical bytes of `payload`.
- `expected_token.txt` — full LIC1 token, `\n`-terminated.

To verify your implementation:

```
canonicalize(inputs.header) == canonical_header.bin   (byte-for-byte)
canonicalize(inputs.payload) == canonical_payload.bin (byte-for-byte)
sign(inputs.key_ref, "<b64(header)>.<b64(payload)>") == sig of expected_token
```

For every sibling under `fixtures/tokens-invalid/<nnn>-<variant>/`:
verification MUST fail with the error identifier implied by the
variant suffix (e.g. `042-sig-bitflip` → `TokenSignatureInvalid`).

Any fixture change is a change-proposal-worthy event: fixtures are the
cross-language contract.

### 8.1 Known-answer test vectors

The `fixtures/tokens/<nnn>-<alg>-<status>/` directories serve as known-
answer test vectors. Each has locked key material refs, locked payload,
expected canonical bytes, and an expected wire token. Both ports verify
against these in CI as a byte-determinism floor; once committed they are
immutable.

Determinism guarantees by algorithm:

- **Ed25519**: byte-for-byte wire equality across both ports.
- **HS256**: byte-for-byte wire equality across both ports.
- **RSA-PSS**: header+payload byte equality across both ports; the
  signature segment is fresh per-run by design (RSASSA-PSS mixes random
  salt). Cross-port `verify(GoSig)` and `verify(TsSig)` against the
  shared public key is the authoritative parity check.

The `licensing/interop/` and `tools/interop/` packages drive the
cross-port harness: TS signs → Go verifies, Go signs → TS verifies, plus
canonical-JSON byte-equality on every fixture. CI fails on any drift.

## 9. LIC2 (planned)

LIC1 is the only token format that ships in v0.1.0. Future major
versions MAY introduce LIC2 as a sibling format; the prefix-based
dispatch in §1.2 is the extension point.

The leading candidate for LIC2 is a [PASETO](https://paseto.io/)-
compatible layer (`v4.public` for Ed25519, `v4.local` for symmetric
deployments). PASETO offers two properties LIC1 doesn't:

1. **Versioned algorithm bundles** — a single PASETO `v4` token
   commits to Ed25519, BLAKE2b, and a fixed encoding. Algorithm-
   confusion attacks reduce to "is this the right version", which
   tooling can enforce structurally.
2. **External ecosystem** — multiple language SDKs already exist
   ([`o1egl/paseto`](https://github.com/o1egl/paseto) for Go,
   [`auth70/paseto-ts`](https://github.com/auth70/paseto-ts) for
   TypeScript), so consumers wanting a third-party verifier could
   bring their own.

LIC2 is **not on the v0.1.0 roadmap**. Adding it requires:

- A `v4.` prefix entry in the dispatch allowlist (§1.2).
- Cross-port fixtures under `fixtures/tokens/lic2-<alg>-<status>/`.
- A migration story for callers who hard-code `LIC1.` parsing —
  realistically, a major-version bump on both ports.
- A decision on whether LIC1 remains the default issuance format
  (most likely yes) or whether `Issuer.format` becomes a config
  knob.

Until that work lands, the safe assumption is **LIC1 only**. The
prefix-allowlist in §1.2 already rejects `v4.public.` /
`v4.local.` payloads with `UnsupportedTokenFormat`, which is the
correct behaviour pre-LIC2.

### 9.1 Decision matrix — LIC1 today, LIC2 someday

| Concern                                  | LIC1 (today)                                                                 | LIC2 (planned)                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Cross-port byte determinism**          | ✅ Required & enforced by fixtures + interop tests.                          | Same requirement. PASETO is structurally deterministic for `v4.public`; salt-bearing modes (XChaCha20) need protocol-level salt fixing the same way RSA-PSS does today. |
| **Algorithm-confusion resistance**       | ✅ `kid → alg` pre-registration table in `AlgorithmRegistry`.                | ✅ Built into PASETO's versioned suite.                                                         |
| **Custom payload claims**                | ✅ Free-form JSON object after the canonical-JSON contract in §4.            | ⚠️ PASETO has its own canonical claim set; trial / scope / fingerprint claims would need a footer convention or a wrapped sub-payload. |
| **Third-party verifier ecosystem**       | ❌ One verifier per port, both first-party.                                  | ✅ Multiple PASETO libraries; consumers can roll their own.                                     |
| **Ed25519 default**                      | ✅ `header.alg == "ed25519"`.                                                | ✅ `v4.public` is Ed25519 by definition.                                                        |
| **HMAC support**                         | ✅ `hs256` for symmetric / kiosk deployments.                                | ✅ `v4.local` (XChaCha20-SIV).                                                                  |
| **RSA-PSS support**                      | ✅ `rs256-pss` for legacy interop.                                           | ❌ PASETO `v4` drops RSA. A LIC1-RSA fallback would have to coexist for legacy verifiers.       |
| **Adoption cost**                        | None — already shipping.                                                     | A major bump on both ports + new fixture set + dispatch entry + consumer migration.             |
| **Right call when…**                     | Operating any v0.x.y release; running a small number of first-party SDKs.    | Onboarding third-party verifier ecosystems; standardising on a published format.                |

**Pick LIC1 if**: you're shipping in 2026, you already control the
verifier code, and you don't have a hard requirement to interoperate
with PASETO tooling. That's the common case and the only thing that
ships today.

**Pick LIC2 (when available) if**: you need third-party PASETO
verifiers, you're starting a new project that doesn't already
depend on `header.kid` / `header.alg` claim semantics, and you can
take the major-version bump cost.

There is no migration path from LIC1 to LIC2 without re-issuing
tokens. Existing licenses survive — the storage rows and lifecycle
state machines are format-agnostic — but the offline tokens cached
on every device need fresh re-issuance against the new format.
