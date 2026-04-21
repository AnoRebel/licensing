# @licensing/sdk

Offline-capable software licensing for TypeScript runtimes. Issue signed
license tokens, bind them to a device fingerprint, and verify them with no
network round-trip — using Ed25519, RSA-PSS, or HMAC under a single envelope
format (LIC1).

Ships as one package with subpath exports for every layer: low-level crypto
primitives, the issuer lifecycle (keys, scopes, templates, licenses, usages,
tokens), framework-agnostic HTTP handlers with Hono/Express/Fastify adapters,
an offline-first client, and pluggable storage (memory, Postgres, SQLite). A
companion Go module at `github.com/AnoRebel/licensing` ships the same surface;
tokens are byte-compatible across both ports at the same version.

## Install

```bash
bun add @licensing/sdk
# or
npm install @licensing/sdk
# or
deno add jsr:@licensing/sdk
```

Optional peers, installed only when you use the matching storage adapter:

```bash
bun add pg                  # for @licensing/sdk/storage/postgres
# (Bun's built-in bun:sqlite is used by the SQLite adapter — no install needed)
```

## Subpath exports

| Import                                            | What you get                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| `@licensing/sdk`                            | Issuer primitives: lifecycle, license/scope/template/token services.   |
| `@licensing/sdk/canonical-json`             | Deterministic stringify used by LIC1 and the interop fixtures.         |
| `@licensing/sdk/base64url`                  | RFC 4648 §5 encoder/decoder (unpadded).                                |
| `@licensing/sdk/lic1`                       | Low-level encode/decode of the `LIC1.<h>.<p>.<s>` envelope.            |
| `@licensing/sdk/crypto`                     | `AlgorithmRegistry`, `KeyAlgBindings`, `SignatureBackend` types.       |
| `@licensing/sdk/crypto/ed25519`             | Ed25519 backend.                                                       |
| `@licensing/sdk/crypto/rsa`                 | RSA-PSS (RS256/RS384/RS512) backend.                                   |
| `@licensing/sdk/crypto/hmac`                | HMAC-SHA-256 backend (symmetric — use carefully).                      |
| `@licensing/sdk/encrypted-pkcs8`            | PBES2 (PBKDF2-HMAC-SHA-256 + AES-256-GCM) wrap/unwrap.                 |
| `@licensing/sdk/errors`                     | Stable error codes shared with the HTTP surface.                       |
| `@licensing/sdk/client`                     | Offline-first consumer: activate / validate / heartbeat / refresh.     |
| `@licensing/sdk/http`                       | Framework-agnostic HTTP handlers; Hono / Express / Fastify adapters.   |
| `@licensing/sdk/http/adapters/hono`         | `toHonoHandler` factory.                                               |
| `@licensing/sdk/http/adapters/express`      | `toExpressHandler` factory.                                            |
| `@licensing/sdk/http/adapters/fastify`      | `toFastifyHandler` factory.                                            |
| `@licensing/sdk/storage`                    | `Storage` interface + schema descriptions.                             |
| `@licensing/sdk/storage/memory`             | In-memory adapter (tests + ephemeral runtimes).                        |
| `@licensing/sdk/storage/postgres`           | Postgres adapter using `pg`.                                           |
| `@licensing/sdk/storage/postgres/migrations`| `applyMigrations(pool)` — ships the Postgres schema migration runner.  |
| `@licensing/sdk/storage/sqlite`             | SQLite adapter using `bun:sqlite` (WAL + foreign keys enabled).        |
| `@licensing/sdk/storage/sqlite/migrations`  | `applyMigrations(db)` for SQLite.                                      |

## Quickstart: issuer

```ts
import {
  createLicense, issueToken, registerUsage,
  generateRootKey, issueInitialSigningKey,
  NewAlgorithmRegistry, NewKeyAlgBindings,
  systemClock,
} from '@licensing/sdk';
import { ed25519 } from '@licensing/sdk/crypto/ed25519';
import { MemoryStorage } from '@licensing/sdk/storage/memory';

const store = new MemoryStorage();
const clock = systemClock();
const registry = new NewAlgorithmRegistry();
registry.register(ed25519());

const root = await generateRootKey(store, clock, registry, {
  alg: 'ed25519', passphrase: 'root-pw',
});
const signing = await issueInitialSigningKey(store, clock, registry, {
  alg: 'ed25519', rootKid: root.kid,
  rootPassphrase: 'root-pw', signingPassphrase: 'sign-pw',
});

const license = await createLicense(store, clock, {
  licensableType: 'User', licensableId: 'user-42',
  status: 'active', maxUsages: 3,
});
const usage = await registerUsage(store, clock, {
  licenseId: license.id, fingerprint: 'a'.repeat(64),
});
const { token } = await issueToken(store, clock, registry, {
  license, usage: usage.usage, ttlSeconds: 3600,
  alg: 'ed25519', signingPassphrase: 'sign-pw',
});
```

See [`examples/ts/issue-and-verify.ts`](../../examples/ts/issue-and-verify.ts) for
the full end-to-end flow including public-key verification.

## Quickstart: client

```ts
import { activate, sendOneHeartbeat, deactivate, MemoryTokenStore }
  from '@licensing/sdk/client';

const store = new MemoryTokenStore();
const { license_id, usage_id } = await activate('LK-DEMO-0000-0000', {
  baseUrl: 'https://issuer.example.com',
  fingerprint: 'b'.repeat(64),
  store,
});
```

See [`examples/ts/client-flow.ts`](../../examples/ts/client-flow.ts).

## CLI

```bash
bunx licensing-keys generate --alg ed25519 --out keys/k1
bunx licensing-keys encrypt --in keys/k1/private.pem --passphrase-env KEY_PASS
bunx licensing-keys rotate --scope scp_01HX... --alg ed25519
```

Refuses empty passphrases. See [`docs/security.md`](../../docs/security.md) for
the full key hierarchy and rotation procedure.

## Versioning

Every release of this package matches the Go module
(`github.com/AnoRebel/licensing/licensing`) at the same tag. A LIC1 token
issued by one language verifies in the other; the interop fixtures in
`tools/interop/` are pinned per-version.

## License

Apache-2.0. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
