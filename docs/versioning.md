# Versioning & release strategy

This monorepo ships **three artefacts** from one commit:

1. `@anorebel/licensing` on **npm** (dual ESM/CJS + `.d.ts` via `tsdown`)
2. `@anorebel/licensing` on **jsr.io** (raw TypeScript; JSR transpiles on publish)
3. `github.com/AnoRebel/licensing` on **pkg.go.dev** (Go module tagged `v<semver>`)

All three share one version. A license issued by any port at version `X.Y.Z` is guaranteed verifiable by any other port at the same `X.Y.Z`. The interop CI job (`.github/workflows/interop.yml`) is the binding contract that enforces this.

---

## Single source of truth: `VERSION`

The repo-root `VERSION` file holds the canonical semver string (no `v` prefix, no trailing newline required but tolerated). Release-candidate suffixes (`-rc.N`, `-beta.N`) are permitted and flow through to every manifest unchanged:

```
0.2.0
```

### Who writes what

Two systems touch release files, and **no file is written by both** — that
overlap is what previously let them fight.

| File | Writer | What it holds |
|---|---|---|
| `VERSION` | release-please | the canonical semver string |
| `CHANGELOG.md` | release-please | generated from conventional commits |
| `.release-please-manifest.json` | release-please | its own last-released baseline |
| `typescript/package.json` | `version:sync` | `"version"` |
| `typescript/jsr.json` | `version:sync` | `"version"` |
| `admin/package.json` | `version:sync` | `"version"` (cosmetic) |
| `examples/ts/package.json` | `version:sync` | `"version"` |
| `tools/*/package.json` | `version:sync` | `"version"` |
| `licensing/version.go` | `version:sync` | `const Version`, surfaced on pkg.go.dev |

release-please decides the version and writes the changelog;
`scripts/sync-versions.mjs` propagates that version into the derived
manifests. The release workflow runs the sync into the release PR, so a
maintainer merges one coherent commit.

### Commands

```bash
# Rewrite every manifest to match VERSION
bun run version:sync

# CI gate: exit 1 if any manifest drifts from VERSION
bun run version:check
```

`version:check` runs in the `ts` and `go` CI jobs, so a PR that bumps `VERSION` without running `version:sync` (or vice versa) fails before merge.

---

## Release flow

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Open a release PR                                        │
│    - edit VERSION                                           │
│    - bun run version:sync                                   │
│    - bun run version:check   (must be clean)                │
│    - commit: "release: vX.Y.Z"                              │
│    - merge to main                                          │
├─────────────────────────────────────────────────────────────┤
│ 2. Tag the merge commit                                     │
│    - git tag vX.Y.Z -m "..."                                │
│    - git push origin vX.Y.Z                                 │
├─────────────────────────────────────────────────────────────┤
│ 3. release.yml kicks off on the tag (see §"Publish")        │
│    - npm publish --access public --provenance              │
│    - npx jsr publish                                        │
│    - (no extra step for pkg.go.dev: the proxy sees the tag) │
└─────────────────────────────────────────────────────────────┘
```

**Why a single tag?** `pkg.go.dev` resolves `github.com/AnoRebel/licensing@vX.Y.Z` by looking for a Git tag `vX.Y.Z` in the default branch. Because `golang/licensing/version.go` already carries `X.Y.Z` (written by the pre-tag `version:sync`), publishing to npm and jsr from the same tag guarantees all three consumers see matching versions.

---

## Semver policy

| Change | Bump | Example |
|---|---|---|
| Breaking API, token-format change, storage schema change, error-code rename | **major** | `1.0.0 → 2.0.0` |
| New subpath export, new error code, new optional config field, new endpoint | **minor** | `0.1.0 → 0.2.0` |
| Bug fix, dependency bump (no API change), docs-only | **patch** | `0.1.0 → 0.1.1` |
| Pre-release under active development | `-rc.N` | `0.1.0-rc.1` |

Both ports move in lockstep. If only one port needs a bug fix, the other gets the same version bump with a no-op changelog entry — this keeps `X.Y.Z ↔ vX.Y.Z` a reliable contract for cross-language consumers.

### Pre-1.0 caveat (historical) <!-- doc-version: historical -->

Retired. While `MAJOR == 0` the API was unstable and breaking changes could ship on a minor bump — `0.2.0` did exactly that, dropping four fields from the client heartbeat input on both ports. That no longer applies; the policy below governs.

### Stability policy

In effect as of `1.0.0`, and holding until the next major.

**Covered — a breaking change to any of these requires a major bump:**

- The exported API surface of both ports: function signatures, exported types, error codes, and the `kid`/`alg` binding semantics.
- Token wire formats. A token issued by `1.x` verifies under any later `1.y`. LIC1 and LIC2 bytes are both frozen; a change to either is a major.
- The HTTP contract in `openapi/licensing-admin.yaml`: paths, request and response shapes, and status codes.
- The storage schema as described in `fixtures/schema/entities.md`. Additive migrations are minor; a column removal or type change is major.
- Which token format is issued by default. LIC1 is the default, and changing that default is a breaking change.

**Not covered — these may change in a minor or patch:**

- Internal module layout, unexported identifiers, and anything under a path documented as internal.
- The admin UI. It is an operator console, not an API; its routes and components carry no compatibility promise.
- Log output, error *messages* (as opposed to error codes), and audit-row prose.
- Development tooling: fixture-generator internals, the interop harness, lint configuration, and CI workflow shape.
- Adding a new token format, a new optional config field, a new endpoint, or a new error code. These are minor by the table above.

**Deprecation.** A covered surface slated for removal is documented as deprecated in the changelog for at least one minor release before the major that removes it. Pre-1.0 there is no such guarantee — deprecated shims are removed in the same commit that replaces them.

---

## Token-format versioning is separate

Token envelope versions are **not** tied to the package version. A token issued by `@anorebel/licensing@0.1.0` and one issued by `@anorebel/licensing@2.4.7` are both valid LIC1 tokens and remain cross-compatible.

Two envelopes ship:

- **LIC1** — the default. Carried by the `v` header claim; wire prefix `LIC1.`.
- **LIC2** — PASETO `v4.public`, opt-in via `tokenFormat`. Wire prefix `v4.public.`.

The codec registry lets a single verifier accept both simultaneously, so adopting LIC2 for new issuance does not invalidate LIC1 tokens already on devices.

See [`docs/token-format.md`](token-format.md) for both specs.

---

## Go consumers: checking available versions

```bash
# List every tag pkg.go.dev knows about for this module
go list -m -versions github.com/AnoRebel/licensing

# Pin a specific version
go get github.com/AnoRebel/licensing@v0.2.0

# View on the registry
open https://pkg.go.dev/github.com/AnoRebel/licensing@v0.2.0
```

## TypeScript consumers: checking available versions

```bash
# npm
npm view @anorebel/licensing versions

# jsr
npx jsr info @anorebel/licensing
```

---

## Publish workflow

The tag-triggered pipeline lives at `.github/workflows/release.yml` (see §"Publish" in [`docs/security.md`](security.md) for the npm-provenance setup).

The workflow:

1. Checks out the tag.
2. Runs `bun run version:check` — fails the release if any manifest drifted since the release PR merged.
3. Runs the full TS + Go test matrix (memory + sqlite + postgres).
4. Builds the npm tarball via `tsdown`.
5. Publishes to npm (`--provenance`) under `NPM_TOKEN`.
6. Publishes to jsr via OIDC (`npx jsr publish`) — no long-lived token.
7. Waits for the Go proxy to pick up the tag (no action needed; Go module proxy ingests tags from GitHub automatically).

Rollback: deprecate the bad version (`npm deprecate`, `jsr deprecate`, `go mod tidy` won't pick retracted Go tags if `retract` is added to `golang/go.mod`). **Never republish the same version with different bytes** — all three registries forbid it.

---

## Changesets? No.

We considered `changesets/changesets` but rejected it: the monorepo ships *one* TS package plus *one* Go module, so the primary value of changesets (independent per-package versioning in a multi-package repo) does not apply. The single-`VERSION` approach is simpler, statically verifiable in CI, and aligns naturally with the one-tag-per-release model the Go module proxy requires.

If the repo ever grows a second independently-versioned package (e.g., an `@anorebel/licensing-auth-apikey` post-v1), reconsider this decision.
