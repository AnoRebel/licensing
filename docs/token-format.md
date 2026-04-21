# LIC1 token format

LIC1 is the licensing issuer's on-wire token. This document reproduces the
normative spec in [`fixtures/README.md`](../fixtures/README.md) with a
copy-pastable focus: if you are writing a third-party verifier, everything
you need to be byte-compatible is here.

The fixtures under `fixtures/tokens/` are the ground truth; this document
describes how to reproduce them.

## 1. Wire shape

```
LIC1.<header_b64>.<payload_b64>.<sig_b64>
```

- `LIC1` — literal ASCII format prefix. Dispatchers MUST reject any other
  prefix (including `LIC2`, `v4.public.`, JWT-style `eyJ...`) with
  `UnsupportedTokenFormat` **before parsing the rest**.
- `<header_b64>` — base64url of the canonical header JSON bytes, no padding.
- `<payload_b64>` — base64url of the canonical payload JSON bytes, no padding.
- `<sig_b64>` — base64url of the raw signature bytes, no padding.

### Signing input

```
signing_input = <header_b64> || "." || <payload_b64>
```

First two segments, ASCII, including the `.` separator. Signatures are
computed over this exact byte string — not the canonical JSON alone, not
with a trailing newline.

### Version door

The literal `LIC1` prefix exists so a future `LIC2` (e.g. PASETO-compatible
envelope using [`paseto-ts`](https://github.com/auth70/paseto-ts) /
[`o1egl/paseto`](https://github.com/o1egl/paseto)) can be dispatched
alongside without breaking v1 consumers. Dispatch on the prefix first, parse
second.

## 2. Header

Canonical JSON object with exactly these fields:

| Field | Type    | Required | Value                                              |
|-------|---------|----------|----------------------------------------------------|
| `v`   | integer | yes      | Must be `1`.                                       |
| `typ` | string  | yes      | Must be `"lic"`.                                   |
| `alg` | string  | yes      | `"ed25519"`, `"rs256-pss"`, or `"hs256"`.          |
| `kid` | string  | yes      | Key id. Must be pre-registered with matching alg.  |

Unknown fields fail validation with `CanonicalJSONUnknownField`.

## 3. Payload

Canonical JSON object. Required fields:

| Field            | Type    | Notes                                               |
|------------------|---------|-----------------------------------------------------|
| `jti`            | string  | Token id (UUIDv7 recommended).                      |
| `iat`            | integer | Issued-at, seconds since Unix epoch.                |
| `exp`            | integer \| null | Expiry seconds; `null` means no expiry.     |
| `scope_id`       | string  | Scope ULID/UUIDv7.                                  |
| `license_id`     | string  | License ULID/UUIDv7.                                |
| `seats`          | integer | Seat count at issue time.                           |
| `fingerprint`    | string \| null | Device fingerprint; `null` for unbound tokens. |
| `entitlements`   | object  | Flat key→primitive map. Strict field whitelist enforced by the verifier. |

Grace semantics (client-side): `exp < now` fails strict. When the server is
unreachable, the client accepts `exp ≤ now + grace`. A `null` `exp` is
treated as "no expiry" and disables grace entirely — there is nothing to
extend.

## 4. Canonical JSON (NORMATIVE)

Canonicalization applies to header and payload bytes that feed the
signature. It does NOT apply to arbitrary JSON elsewhere in the system.

### 4.1 Allowed types

`null`, `boolean`, `string`, `number` (integer only, see §4.5), `array`,
`object`. Any other type → `CanonicalJSONInvalidType`.

### 4.2 Whitespace

Zero insignificant whitespace. No space after `:` or `,`. No leading or
trailing whitespace. No line terminators.

✓ `{"a":1,"b":[2,3]}`
✗ `{ "a": 1 }`

### 4.3 Object key ordering

Keys sorted ascending by their **UTF-16 code-unit sequence**. This matches
ECMA-262 `Array.prototype.sort` on JS strings; Go implementations transcode
keys to UTF-16 to compare.

Duplicate keys in the input → `CanonicalJSONDuplicateKey`.

### 4.4 Numbers

Integers only, in `[-2^53 + 1, 2^53 - 1]` (the JS safe-integer range).

- No leading zeros: `7` not `07`.
- No leading `+`.
- No decimal point, fractional digits, or exponent.
- Negative: single leading `-`, e.g. `-7`.
- `0` only. Negative zero is rejected.
- `NaN`, `Infinity`, `-Infinity`, and all floats → `CanonicalJSONInvalidNumber`.

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
Astral codepoints emit as UTF-8 directly, not as `\uXXXX\uXXXX` surrogate
pairs.

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

RFC 4648 §5, unpadded. Alphabet `A–Z a–z 0–9 - _`. No `=` padding on either
encode or decode; decoders MUST reject `=` in LIC1 segments.

## 6. Signatures

| `alg`        | Primitive                 | Signature length     |
|--------------|---------------------------|----------------------|
| `ed25519`    | RFC 8032 Ed25519          | 64 bytes             |
| `rs256-pss`  | RSASSA-PSS, SHA-256, MGF1-SHA-256, salt=32 | `modulus_len` bytes |
| `hs256`      | HMAC-SHA-256              | 32 bytes             |

RSA keys below 2048 bits fail with `InsufficientKeyStrength`. HMAC secrets
below 32 bytes likewise.

## 7. Validation order (NORMATIVE)

To be interoperable, validators MUST execute these checks in this order:

1. Prefix check: string starts with `LIC1.` → else `UnsupportedTokenFormat`.
2. Segment count: exactly 4 parts split on `.` → else `MalformedToken`.
3. base64url-decode each of segments 1–3 → else `MalformedToken`.
4. Canonical-parse segment 1 (header) into `{v, typ, alg, kid}`.
   - Unknown field → `CanonicalJSONUnknownField`.
   - Wrong field type → `CanonicalJSONInvalidType`.
5. `v == 1`, `typ == "lic"` → else `UnsupportedTokenFormat`.
6. kid-to-alg pre-registration lookup:
   - `kid` not registered → `UnknownKid`.
   - registered alg ≠ `header.alg` → `AlgorithmMismatch`.
     **No backend invoked.**
7. Backend lookup for `alg`:
   - not registered → `UnsupportedAlgorithm`.
8. Verify signature over `<seg1_b64>.<seg2_b64>`.
9. Canonical-parse segment 2 (payload); apply expiry and scope/license
   checks per the client.

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
sign(inputs.key_ref, "<b64(header)>.<b64(payload)>") == sig_b64 of expected_token
```

And for every sibling under `fixtures/tokens-invalid/<nnn>-<variant>/`:
verification MUST fail with the error identifier implied by the variant
suffix (e.g., `042-sig-bitflip` → `SignatureMismatch`).

Any fixture change is a change-proposal-worthy event: fixtures are the
cross-language contract.
