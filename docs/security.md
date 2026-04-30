# Security model

This document covers the threat model and the mitigations baked into the
licensing issuer. Read this before operating a production deployment.

Scope: key hierarchy, key storage, rotation, alg-confusion resistance, and
operational handling of passphrases and bearer tokens. The wire format itself
is covered by [`token-format.md`](./token-format.md).

## Threats in scope

1. **Token forgery** — an attacker who does not hold a signing key crafts a
   LIC1 token the client accepts.
2. **Key compromise** — a signing key leaks and the attacker mints valid
   tokens until rotation.
3. **Alg-confusion** — an attacker swaps the header `alg` to trick a verifier
   into using the wrong algorithm (classic JWT-style footgun).
4. **Passphrase leakage** — the encryption passphrase for private keys leaks
   via logs, environment dumps, or crash reports.
5. **Admin-API token theft** — the bearer token an operator pastes into the
   admin UI is exfiltrated via XSS or a malicious extension.

Out of scope: physical key theft, rubber-hose cryptanalysis, and
browser-vendor supply-chain attacks on the admin UI bundle itself.

## Key hierarchy

Two levels per scope (and one global pair for cross-scope operations):

```
root (long-lived, offline)
  └─ signing keys (short-lived, online)
        ├─ active   (exactly one)
        └─ retiring (≥ 0; still verify unexpired tokens)
```

- **Root keys** certify signing keys. They sign no license tokens directly
  and are expected to live offline (air-gapped workstation, HSM, hardware
  token). Rotation is a manual ceremony.
- **Signing keys** sign license tokens (`LIC1.h.p.s`). Exactly one is
  `active` per scope at any time; zero or more are `retiring`. Retiring keys
  continue to verify tokens they signed until `exp`. Once no unexpired tokens
  reference a retiring key it can be deleted.

At most one `active` per scope is enforced at the storage layer by a partial
unique index. Rotation is atomic — the issuer demotes the old key to
`retiring` and promotes the new key to `active` in a single transaction.

## Key storage at rest

Private keys MUST NEVER be persisted in plaintext. On disk they live as
PKCS#8 PEM encrypted with PBES2:

- KDF: **PBKDF2-HMAC-SHA-256**, 600,000 iterations, 16-byte random salt.
- Cipher: **AES-256-GCM**, 12-byte random nonce.

Public keys are stored as SubjectPublicKeyInfo PEM, unencrypted.

### Unwrap-time profile allowlist

Encrypted PKCS#8 identifies its KDF and cipher by ASN.1 Object Identifier.
A permissive unwrapper that dispatches on "any OID the library recognises"
opens a parameter-confusion attack: an attacker who can place a file on
disk (backup restore, shared volume, compromised CI secret store) can
hand the issuer a blob encrypted with PBKDF2-HMAC-SHA-1 + 3DES-CBC, and
the default library path will happily decrypt it. The issuer would then
sign tokens with a key whose parameters were chosen by the attacker.

Both ports defeat this by **byte-equality OID checks** on unwrap,
before any crypto primitive runs:

- `1.2.840.113549.1.5.13` — PBES2 (outer scheme)
- `1.2.840.113549.1.5.12` — PBKDF2 (KDF)
- `1.2.840.113549.2.9`   — HMAC-SHA-256 (PRF)
- `2.16.840.1.101.3.4.1.46` — AES-256-GCM (cipher)

Any other triple (including PBKDF2-HMAC-SHA-1, PBKDF2-HMAC-SHA-512,
AES-256-CBC, 3DES) collapses into the opaque `KeyDecryptionFailed` error
— deliberately the same error as an invalid passphrase, so an attacker
probing the OID allowlist cannot distinguish "wrong cipher" from "wrong
passphrase".

Raw bytes (32-byte Ed25519 seed, RSA modulus/exponent, HMAC secret) are
accessible alongside PEM via the key-storage adapter — consumers never have
to parse PEM to get canonical key material.

### Passphrase handling

- Passphrases come from `LICENSING_KEY_PASSPHRASE` (or a per-scope override
  env var). They are never written to disk, never logged, never returned in
  API responses.
- Empty passphrases are refused at key generation time
  (`MissingKeyPassphrase`) — the CLI will not produce a plaintext key "just
  for testing".
- In the admin UI and the HTTP surface, error envelopes never echo the
  passphrase back, even on decryption failure (`PassphraseInvalid` with no
  value).

## Algorithm confusion

The classic JWT attack — craft `{"alg":"none"}` or swap an RSA public key in
as an HMAC secret — is prevented by **pre-registration**: every `kid` is
registered with its expected `alg` at validator construction. On token
verification:

1. Parse the header. Reject any field outside the whitelist
   (`v`, `typ`, `alg`, `kid`).
2. Look up the registered `alg` for `header.kid`.
   - Not registered → `UnknownKid`.
3. Compare to `header.alg`.
   - Mismatch → `AlgorithmMismatch`. **No backend is invoked.**
4. Look up the backend for `alg`.
   - Not registered → `UnsupportedAlgorithm`.
5. Verify.

Because step 3 precedes step 4, an attacker cannot swap `alg` to one that
resolves to a different verification primitive — the mismatch fires first.

## Minimum key strength

- **Ed25519** — exact 32-byte seeds. No minimum parameter beyond the curve.
- **RSA-PSS** — minimum 2048-bit modulus; generation defaults to 3072 bits.
  Sub-2048 keys fail verification with `InsufficientKeyStrength` before the
  signature is ever checked.
- **HMAC-SHA-256** — secrets < 32 bytes fail with `InsufficientKeyStrength`.

## Rotation procedure

Recommended cadence: rotate signing keys at most every 90 days, or
immediately on suspected compromise. Root keys rotate on a 1–2 year cadence
or on compromise.

### Signing-key rotation (online)

```bash
bunx licensing-keys rotate --scope scp_01HX... --alg ed25519
# or
go run github.com/AnoRebel/licensing/cmd/licensing-keys rotate --scope scp_01HX... --alg ed25519
```

The admin UI's Keys page wraps the same operation. Under the hood:

1. Generate a fresh Ed25519/RSA/HMAC key.
2. Inside one transaction:
   - Demote the current `active` key to `retiring`.
   - Insert the new key as `active`.
   - Append an `audit_log` entry.
3. Return the new `kid`. Outstanding tokens signed by the previous key
   continue to verify until `exp`.

Revocation before `exp` is not expressed by rotation; use the per-license
`/admin/licenses/:id/revoke` endpoint.

### Root-key rotation (offline ceremony)

1. Generate the new root key on an air-gapped workstation.
2. Re-certify every active signing key under the new root.
3. Transport the new public root to every verifying client (admin UI,
   embedded `client.PublicKey` maps, etc.) via a signed release.
4. Retire the old root only once every signing key has been re-certified.

This is deliberately manual — an automated root-rotation pipeline would
itself become the highest-value target in the system.

## Admin-API bearer token

The admin UI accepts a bearer token at sign-in and stores it server-only
in a sealed httpOnly cookie (`nuxt-auth-utils` + iron-webcrypto, AES-256-GCM
with a 32-byte session password). The browser never sees the token:

- No `localStorage` / `sessionStorage` — XSS cannot read it.
- Session cookie is `HttpOnly; Secure; SameSite=Strict`.
- Every API call goes through `server/api/proxy/[...]` which:
  - Reads `secure.apiToken` from the sealed session.
  - Forwards **only** an allow-listed set of headers
    (`accept`, `content-type`, `authorization`).
  - Never echoes client-supplied `Authorization`, `Cookie`, or
    `X-Forwarded-*` headers.
- 401 from upstream → session cleared → redirect to `/sign-in`.

### CSRF defence-in-depth

`SameSite=Strict` alone defeats every CSRF vector modern browsers can
launch. We additionally enforce same-origin provenance at the proxy
edge for state-changing verbs (`POST` / `PUT` / `PATCH` / `DELETE`):

- `Sec-Fetch-Site` MUST be `same-origin` or `none` (browser-enforced,
  unforgeable via `fetch` — the browser sets this header itself), **OR**
- `Origin` MUST exactly match this server's scheme+host.

Missing both → `403 cross-origin request refused` before the session
cookie is even read. This layer exists because:

1. If a buggy browser or a mis-tuned CDN strips `SameSite`, the cookie
   reverts to the old attacker-favouring default.
2. The proxy may one day front programmatic callers (CLI, CI). Explicit
   origin policy is cheaper to reason about than implicit cookie policy.

The session cookie password MUST be set in production via
`NUXT_SESSION_PASSWORD` (≥ 32 bytes). The dev fallback in
`nuxt.config.ts` is refused by `nuxt-auth-utils` at production startup.

## Audit immutability

`audit_log` is append-only. Both the Postgres and SQLite adapters enforce
this at the DB layer with `BEFORE UPDATE/DELETE` triggers — not just in
application code. `DELETE FROM audit_log` issued as a superuser fails.

## What the admin UI still lacks (tracked)

These are intentionally deferred to post-v0.1.0:

- **Content-Security-Policy headers.** The admin UI has no CSP. Acceptable
  for an internal ops tool deployed behind SSO; revisit before any
  internet-exposed deployment. The proxy's `Origin` / `Sec-Fetch-Site`
  check (above) is the current CSRF backstop; CSP would add XSS-in-depth.
- **Rate limiting on sign-in probe.** The upstream `/v1/auth/me` endpoint
  already rate-limits, so a brute-force attacker hits that ceiling first.
  An additional layer at the admin edge is a belt-and-braces improvement.
- **Hardware-backed key custody.** Today's encrypted-PKCS#8-at-rest is the
  floor. HSM/YubiHSM adapters are a planned adapter, not a v0.1 requirement.
