# Fixtures

Canonical, byte-stable test vectors shared by the TypeScript and Go ports.

These files are the ground truth. A correct implementation in either language
MUST produce byte-identical output against every `canonical_*.bin` and
`expected_token.txt` file in this directory.

```
fixtures/
├─ README.md                          # this document (NORMATIVE)
├─ keys/
│  ├─ ed25519/{private,public}.pem    # sample Ed25519 keypair (PKCS#8 / SPKI)
│  ├─ rsa/{private,public}.pem        # sample RSA-3072 keypair (PKCS#8 / SPKI)
│  └─ hmac/secret.hex                 # sample 32-byte HMAC secret, lowercase hex
├─ tokens/
│  └─ <nnn>/
│     ├─ inputs.json                  # {alg, kid, header, payload, key_ref, now?}
│     ├─ canonical_header.bin         # canonicalized header JSON bytes
│     ├─ canonical_payload.bin        # canonicalized payload JSON bytes
│     └─ expected_token.txt           # full LIC1.<h>.<p>.<s> token string
├─ tokens-invalid/
│  └─ <nnn>-<variant>/                # tamper siblings of valid vectors
│     └─ ...
└─ schema/
   └─ entities.md                     # shared entity-schema normative doc
```

Keys under `keys/` are sample-only. They are committed intentionally (and
explicitly whitelisted in `.gitignore`) so that both languages can validate
against the same material. Do not reuse them for anything real.

---

## 1. Canonical JSON (NORMATIVE)

The LIC1 envelope signs **canonical JSON bytes**, not arbitrary JSON. Two
implementations that disagree on canonicalization will produce different
signatures for the same logical object, breaking cross-language interop. This
section defines canonicalization exhaustively.

### 1.1 Scope

Canonicalization applies to:
- the JSON header (the first path-segment of a LIC1 token, pre-base64url), and
- the JSON payload (the second path-segment of a LIC1 token, pre-base64url).

It does NOT apply to arbitrary user-supplied JSON elsewhere in the system;
only to the two documents that feed the signature.

### 1.2 Allowed value types

Canonical JSON permits only:

| JSON type | Allowed? | Notes                                                             |
| --------- | -------- | ----------------------------------------------------------------- |
| `null`    | yes      | encoded literally as `null`.                                      |
| `boolean` | yes      | encoded literally as `true` or `false`.                           |
| `string`  | yes      | UTF-8; escaping rules below.                                      |
| `number`  | yes      | integers only; see §1.5. Floats are rejected.                     |
| `array`   | yes      | preserves insertion order.                                        |
| `object`  | yes      | keys sorted per §1.4.                                             |

Any other input type (e.g., JS `undefined`, Go `time.Time`, bigints beyond the
range specified in §1.5) MUST be rejected by the canonicalizer with
`CanonicalJSONInvalidType`.

### 1.3 Whitespace

The canonical serialization contains **zero insignificant whitespace**:

- No space after `:` in object members.
- No space after `,` in arrays or objects.
- No leading or trailing whitespace anywhere.
- No line terminators.

`{"a":1,"b":[2,3]}` is canonical. `{ "a": 1 }` is not.

### 1.4 Object key ordering

Object keys MUST be sorted by their **UTF-16 code-unit sequence**, ascending
(i.e., lexicographic order on the UTF-16 representation). This matches the
ordering produced by ECMA-262 `Array.prototype.sort` on JS strings and is
straightforward to replicate in Go by comparing UTF-16 transcodes.

Rationale: sorting by Unicode code points (32-bit) would diverge from the
UTF-16 order used by JS string comparison for astral-plane characters. We
pick UTF-16 ordering because the TypeScript port is the reference implementation
and astral keys are vanishingly rare in practice; consistency matters more
than code-point purity.

Keys MUST be unique within a single object. Duplicate keys in the input MUST
be rejected with `CanonicalJSONDuplicateKey`.

### 1.5 Numbers

Only integers in the closed range **[-2^53 + 1, 2^53 - 1]** are permitted.
This is the inclusive JS `Number.MIN_SAFE_INTEGER` … `Number.MAX_SAFE_INTEGER`
range, so every legal value round-trips losslessly through an IEEE-754 double.

Encoding rules:

- Positive zero is encoded as `0`. Negative zero is rejected.
- No leading zeros: `7` not `07`.
- No leading `+` sign.
- No decimal point, no fractional digits, no exponent.
- Negative integers have a single leading `-`: `-7`.

Floats, `NaN`, `Infinity`, and `-Infinity` are rejected with
`CanonicalJSONInvalidNumber`.

Rationale for integer-only: JSON numbers have historically been a source of
cross-language disagreement (TS defaults to 64-bit float, Go defaults to
int/float64 based on context). Restricting to safe integers eliminates that
class of bug. If a future requirement needs sub-second time, use a dedicated
integer field (e.g., `exp_ms`) rather than a float.

### 1.6 Strings

Strings are UTF-8 internally; the JSON encoding escapes the following
codepoints:

| Codepoint       | Escape       |
| --------------- | ------------ |
| `U+0022 "`      | `\"`         |
| `U+005C \`      | `\\`         |
| `U+0008` (BS)   | `\b`         |
| `U+0009` (HT)   | `\t`         |
| `U+000A` (LF)   | `\n`         |
| `U+000C` (FF)   | `\f`         |
| `U+000D` (CR)   | `\r`         |
| `U+0000`–`U+001F` (other) | `\u00XX` (lowercase hex) |

All other Unicode codepoints — including `/`, non-ASCII BMP characters, and
astral-plane characters — MUST be emitted as their raw UTF-8 bytes. The
forward slash `/` is NOT escaped. Astral codepoints MUST be emitted as UTF-8
directly, not as `\uXXXX\uXXXX` surrogate pairs.

Hex escapes use **lowercase** `a`–`f`: `\u001f`, not `\u001F`.

Invalid UTF-8 (including unpaired surrogates in UTF-16 inputs) MUST be
rejected with `CanonicalJSONInvalidUTF8`.

### 1.7 Arrays

Arrays preserve input order. No trailing comma. Empty arrays are `[]`.

### 1.8 Objects

Keys are sorted per §1.4, then each member is emitted as
`"<key>":<canonical-value>`, joined by `,`. No trailing comma. Empty objects
are `{}`.

### 1.9 Top-level form

The canonical form of a header or payload is always a JSON object (`{...}`),
never an array, string, or primitive. Canonicalizing a non-object top-level
input MUST be rejected with `CanonicalJSONInvalidTopLevel`.

### 1.10 Worked examples

Input:

```json
{
  "b": 2,
  "a": [3, 1, 2],
  "c": { "z": 1, "y": null, "x": "héllo/" }
}
```

Canonical bytes (displayed with visible quotes; no whitespace):

```
{"a":[3,1,2],"b":2,"c":{"x":"héllo/","y":null,"z":1}}
```

Note:
- `a` sorts before `b` sorts before `c`.
- `x`, `y`, `z` sorted.
- `/` emitted raw.
- `é` (U+00E9) emitted as raw UTF-8 bytes `C3 A9`, not `\u00e9`.
- `null` emitted literally.

---

## 2. LIC1 envelope

A LIC1 token is the concatenation of four parts joined by `.`:

```
LIC1.<header_b64>.<payload_b64>.<sig_b64>
```

- `LIC1` is the literal ASCII format prefix. Implementations MUST dispatch on
  this prefix and reject any other prefix (e.g., `v4.public.`,
  `eyJ` JWT-ish, `LIC2`) with `UnsupportedTokenFormat` **before** attempting
  to parse the remainder.
- `<header_b64>` is base64url of `canonical_header.bin` (no `=` padding).
- `<payload_b64>` is base64url of `canonical_payload.bin` (no `=` padding).
- `<sig_b64>` is base64url of the raw signature bytes returned by the
  registered backend for the header's `alg` (no `=` padding).

The signed byte string is:

```
signing_input = <header_b64> || "." || <payload_b64>
```

i.e., the first two segments, ASCII, including the dot separator. Signatures
MUST be computed over this exact string — not over the canonical bytes alone,
and not with any trailing newline.

### 2.1 Header fields

| Field | Type     | Required | Meaning                                    |
| ----- | -------- | -------- | ------------------------------------------ |
| `v`   | integer  | yes      | Format version. MUST be `1` for LIC1.      |
| `typ` | string   | yes      | Token type discriminator. MUST be `"lic"`. |
| `alg` | string   | yes      | Signature algorithm. Registered values: `"ed25519"`, `"rs256-pss"`, `"hs256"`. |
| `kid` | string   | yes      | Key id; MUST be pre-registered with an `alg` per the crypto spec. |

Unknown header fields MUST cause validation to fail with
`CanonicalJSONUnknownField` (strict field whitelist).

### 2.2 Payload fields

Defined by `specs/licensing-token-format/spec.md`. Unknown payload fields MUST
similarly be rejected.

---

## 3. Fixture directory format

Each directory under `fixtures/tokens/<nnn>/` contains:

- `inputs.json` — `{alg, kid, header, payload, key_ref, now?}` where
  `key_ref` points to a key under `fixtures/keys/`.
- `canonical_header.bin` — SHA-256-verifiable canonicalization of `header`.
- `canonical_payload.bin` — SHA-256-verifiable canonicalization of `payload`.
- `expected_token.txt` — the full LIC1 token. Newline-terminated (single `\n`).

`fixtures/tokens-invalid/<nnn>-<variant>/` mirrors this structure but contains
tampered data; each directory's name encodes the variant (e.g.,
`042-sig-bitflip`, `042-missing-exp`, `042-wrong-kid`).

---

## 4. When fixtures are generated

Initial population of `tokens/` and `tokens-invalid/` is deferred until the
canonicalizer + crypto backends land in tasks 3.3 / 3.6–3.8 (mirror: Go tasks
8.2 / 8.5–8.7). Until then, this document defines the contract; no binary
vectors are committed.

Once generation is live:
1. Both ports' canonicalizer tests MUST pass against every `canonical_*.bin`.
2. Both ports' token-issuance tests MUST produce the exact bytes in
   `expected_token.txt` when given `inputs.json`.
3. Both ports' validators MUST reject every sibling under `tokens-invalid/`
   with the error identifier implied by the variant suffix.

Any fixture change is a change-proposal-worthy event: the fixture is the
cross-language contract.
