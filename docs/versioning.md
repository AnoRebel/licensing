# Versioning & release strategy

This monorepo ships **three artefacts** from one commit:

1. `@licensing/sdk` on **npm** (dual ESM/CJS + `.d.ts` via `tsdown`)
2. `@licensing/sdk` on **jsr.io** (raw TypeScript; JSR transpiles on publish)
3. `github.com/AnoRebel/licensing` on **pkg.go.dev** (Go module tagged `v<semver>`)

All three share one version. A license issued by any port at version `X.Y.Z` is guaranteed verifiable by any other port at the same `X.Y.Z`. The interop CI job (`.github/workflows/interop.yml`) is the binding contract that enforces this.

---

## Single source of truth: `VERSION`

The repo-root `VERSION` file holds the canonical semver string (no `v` prefix, no trailing newline required but tolerated). Release-candidate suffixes (`-rc.N`, `-beta.N`) are permitted and flow through to every manifest unchanged:

```
0.1.0-rc.0
```

Every other manifest is generated / rewritten from this file by `scripts/sync-versions.mjs`:

| File | What it holds | Who reads it |
|---|---|---|
| `VERSION` | `0.1.0` | sync script; humans |
| `typescript/package.json` | `"version": "0.1.0"` | npm publish, Bun workspace |
| `typescript/jsr.json` | `"version": "0.1.0"` | `npx jsr publish` |
| `admin/package.json` | `"version": "0.1.0"` | Nuxt build (cosmetic) |
| `examples/ts/package.json` | `"version": "0.1.0"` | workspace resolution |
| `tools/*/package.json` | `"version": "0.1.0"` | workspace resolution |
| `licensing/version.go` | `const Version = "0.1.0"` | Go module; surfaced on pkg.go.dev |

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

### Pre-1.0 caveat

While `MAJOR == 0`, the API is **unstable**. Breaking changes may ship on a minor bump (`0.1.0 → 0.2.0`). Downstream consumers should pin to exact versions (`"@licensing/sdk": "0.1.0"` and `github.com/AnoRebel/licensing v0.1.0`) until `1.0.0`.

---

## Token-format versioning is separate

`LIC1` is the **token envelope** version, carried in the `v` header claim of every token. It is **not** tied to the package version — a token issued by `@licensing/sdk@0.1.0` and one issued by `@licensing/sdk@2.4.7` are both `LIC1` tokens and remain cross-compatible.

A future `LIC2` envelope (if/when PASETO compatibility lands) will ship alongside `LIC1` — the prefix-based dispatch registry (`LIC1.` / `LIC2.`) lets a single library accept both simultaneously.

See [`docs/token-format.md`](token-format.md) for the LIC1 spec.

---

## Go consumers: checking available versions

```bash
# List every tag pkg.go.dev knows about for this module
go list -m -versions github.com/AnoRebel/licensing

# Pin a specific version
go get github.com/AnoRebel/licensing@v0.1.0

# View on the registry
open https://pkg.go.dev/github.com/AnoRebel/licensing@v0.1.0
```

## TypeScript consumers: checking available versions

```bash
# npm
npm view @licensing/sdk versions

# jsr
npx jsr info @licensing/sdk
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

If the repo ever grows a second independently-versioned package (e.g., an `@licensing/auth-apikey` post-v1), reconsider this decision.
