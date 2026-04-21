# Releasing

How to cut a release of the three-artefact bundle:
`@licensing/sdk` on npm, `@licensing/sdk` on jsr.io, and
`github.com/AnoRebel/licensing` on pkg.go.dev — all at the same version.

For the *why* behind the single-version model, read
[`docs/versioning.md`](docs/versioning.md). This document is the
*how* — a step-by-step playbook.

---

## Prerequisites (one-time setup)

### Repository secrets (GitHub → Settings → Secrets → Actions)

| Secret | Used by | Notes |
|---|---|---|
| `NPM_TOKEN` | `release.yml → publish-npm` | npm **Automation** token scoped to `@licensing/sdk`. [Create one.](https://docs.npmjs.com/creating-and-viewing-access-tokens) |

No JSR token is required — JSR publishes via GitHub OIDC (`id-token: write`).
No PyPI / crates.io / pkg.go.dev tokens — Go module proxy ingests tags from
the public GitHub mirror automatically.

### Repository environments (GitHub → Settings → Environments)

Create two environments with required reviewers if you want a human gate
before each publish step:

- `npm` — URL `https://www.npmjs.com/package/@licensing/sdk`
- `jsr` — URL `https://jsr.io/@licensing/sdk`

Both are referenced in `release.yml` with `environment.name`.

---

## Cutting a release

### 1. Open a release PR

On a fresh branch from `main`:

```bash
# Pick the next version per docs/versioning.md semver rules.
# Pre-release candidate: v0.1.0-rc.1
# Final:                 v0.1.0
echo 0.1.0-rc.1 > VERSION

# Rewrite every manifest (package.json, jsr.json, licensing/version.go)
bun run version:sync

# CI gate — must pass before PR merges
bun run version:check

# Update CHANGELOG.md — move [Unreleased] items under a new dated section
$EDITOR CHANGELOG.md

git add VERSION typescript/package.json typescript/jsr.json \
        admin/package.json examples/ts/package.json tools/*/package.json \
        licensing/version.go CHANGELOG.md
git commit -m "release: v0.1.0-rc.1"
git push -u origin release/v0.1.0-rc.1
gh pr create --title "release: v0.1.0-rc.1" --body "See CHANGELOG.md"
```

Wait for CI to go green, then merge. **Squash or rebase**, not merge commits —
the tag needs a single, clean commit to point at.

### 2. Tag the merge commit on `main`

```bash
git fetch origin main
git checkout main
git pull --ff-only

# Verify you're on the release commit
git log -1 --oneline  # → "release: v0.1.0-rc.1"

# Signed tag if you have a signing key set up; -a otherwise
git tag -s v0.1.0-rc.1 -m "v0.1.0-rc.1"
git push origin v0.1.0-rc.1
```

### 3. Watch `release.yml` run

The `release.yml` workflow triggers on any `v*.*.*` or `v*.*.*-*` tag push.
It runs four jobs in this order:

1. **`verify`** — fails fast if:
   - Tag doesn't match `v${VERSION}` (caught by the `Tag matches VERSION file` step)
   - Any manifest drifted from `VERSION` (caught by `version:check`)
   - Any test fails (full matrix with Postgres enabled under `-race`)
2. **`publish-npm`** — requires `NPM_TOKEN`; publishes with `--provenance` so
   npmjs.com shows a Provenance badge attesting to the source commit.
3. **`publish-jsr`** — uses GitHub OIDC; no secret required.
4. **`notify-go-proxy`** — primes `proxy.golang.org` so
   `go get github.com/AnoRebel/licensing@vX.Y.Z` resolves immediately.

If any step fails, **do not push the same tag again** — registries reject
republishing a version. Instead:

- Delete the tag (`git tag -d v0.1.0-rc.1 && git push --delete origin v0.1.0-rc.1`).
- Fix the underlying issue via a follow-up commit on `main`.
- Bump to the next pre-release (`v0.1.0-rc.2`) and retag.

### 4. Verify the release landed

```bash
# npm
npm view @licensing/sdk@0.1.0-rc.1

# jsr
bunx jsr info @licensing/sdk

# Go
go list -m -versions github.com/AnoRebel/licensing
# → github.com/AnoRebel/licensing v0.1.0-rc.1
```

Smoke-test a fresh consumer install:

```bash
# TS
mkdir /tmp/smoke && cd /tmp/smoke
bun init -y
bun add @licensing/sdk@0.1.0-rc.1
bun -e "import {canonicalize} from '@licensing/sdk/canonical-json'; console.log(canonicalize({b:1,a:2}))"

# Go
cd /tmp && mkdir smoke-go && cd smoke-go
go mod init smoke
go get github.com/AnoRebel/licensing@v0.1.0-rc.1
cat > main.go <<'EOF'
package main
import (
    "fmt"
    lic "github.com/AnoRebel/licensing"
)
func main() { fmt.Println(lic.Version) }
EOF
go run .
# → 0.1.0-rc.1
```

### 5. Promoting an RC to final

```bash
# Bump VERSION: v0.1.0-rc.1 → v0.1.0 (drop the -rc suffix)
echo 0.1.0 > VERSION
bun run version:sync
bun run version:check
# CHANGELOG: move Unreleased → [0.1.0] with today's date
# PR → merge → tag v0.1.0 → push → release.yml runs
```

---

## Rollback

Once a version is published to **any** of the three registries, those bytes
are immutable. The only remediation is a new version with a fix; the bad
version must be **deprecated**, not deleted.

```bash
# npm
npm deprecate '@licensing/sdk@0.1.0' 'Critical bug XYZ; upgrade to 0.1.1'

# jsr
bunx jsr deprecate @licensing/sdk@0.1.0 --reason "Critical bug XYZ"

# Go: add a `retract` directive to go.mod, commit, tag the next version
# Example block:
#   retract v0.1.0  // Critical bug XYZ; see CHANGELOG
```

---

## Checklist (copy into the release PR description)

```markdown
- [ ] VERSION bumped
- [ ] `bun run version:sync` run locally
- [ ] `bun run version:check` passes locally
- [ ] CHANGELOG entry added with date
- [ ] CI green on the PR (ts, go, admin-ui, interop, openapi-contract)
- [ ] Merged to main (squash/rebase, not merge commit)
- [ ] Tag pushed matches `v${VERSION}`
- [ ] release.yml completed all four jobs
- [ ] Verified on npm, jsr.io, pkg.go.dev
- [ ] Smoke-tested a fresh consumer install
```
