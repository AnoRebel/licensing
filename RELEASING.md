# Releasing

How to cut a release of the three-artefact bundle:
`@anorebel/licensing` on npm, `@anorebel/licensing` on jsr.io, and
`github.com/AnoRebel/licensing` on pkg.go.dev — all at the same version.

For the *why* behind the single-version model, read
[`docs/versioning.md`](docs/versioning.md). This document is the
*how* — a step-by-step playbook.

---

## Prerequisites (one-time setup)

### Repository secrets (GitHub → Settings → Secrets → Actions)

**None.** The workflow uses OIDC trusted publishing for both npm and
JSR — no long-lived tokens are stored on GitHub. The one-time bootstrap
below creates the packages; after that every release is tokenless.

### Repository environments (GitHub → Settings → Environments)

Create two environments — both are referenced by `release.yml` and both
names are part of the trusted-publisher OIDC claim check. **The names
must match exactly**; renaming them breaks publishing.

- `npm` — URL `https://www.npmjs.com/package/@anorebel/licensing`
- `jsr` — URL `https://jsr.io/@anorebel/licensing`

Optionally add required reviewers to each environment if you want a
human gate before publish fires.

### One-time bootstrap (before the first tag is ever pushed)

npm and JSR both require the package to exist on the registry before
they'll accept an OIDC publish. This was a chicken-and-egg for v0.1.0-rc.0 <!-- doc-version: historical -->
only; it is done, and every subsequent release skips these steps entirely.

**1. npm (one-shot token publish):**

```bash
cd typescript
# Copy license into the package dir the same way release.yml does
cp ../LICENSE ../NOTICE .
bun run build
# Generate a classic automation token at npmjs.com → Tokens → Generate
# (granular, type=automation, scope @anorebel/licensing, 7-day expiry).
# This token is used ONCE and revoked immediately after.
npm publish --access public --provenance
# Clean up
rm LICENSE NOTICE
```

Then on npmjs.com:

1. Go to `@anorebel/licensing` → Settings → Trusted Publisher
2. Fill in: organization = `AnoRebel`, repo = `licensing`,
   workflow filename = `release.yml`, environment = `npm`
3. Save — npm does **not** validate these at save time, so double-check
   capitalisation and the filename (must be `release.yml`, not the path).
4. Revoke the automation token you just used.

**2. JSR (create scope + package, link to repo):**

1. Go to [jsr.io/new](https://jsr.io/new) → create the `@anorebel` scope
2. In the scope, create the `licensing` package
3. In package settings → GitHub → link `AnoRebel/licensing`

JSR's OIDC publish works from the very first tag once the package is
created and linked — no one-shot token dance needed.

**3. Go module:** nothing to bootstrap. `proxy.golang.org` ingests
public GitHub tags automatically.

After these three one-time steps, the full release flow below is
tokenless and fully automated from every subsequent `git push origin v*`.

---

## Cutting a release

### 1. Merge the release PR

**release-please opens the PR for you.** It watches `main`, reads
conventional-commit history, and keeps an open "chore: release main" PR
proposing the next version. There is no manual VERSION edit and no manual
CHANGELOG authoring in the normal path.

What the PR contains:

- `VERSION` bumped to the computed version.
- `CHANGELOG.md` with a generated section for that version.
- `.release-please-manifest.json` updated to the new baseline.
- A follow-up commit syncing the seven derived manifests, pushed
  automatically by the workflow. release-please does not own those files —
  see the ownership table in [`docs/versioning.md`](docs/versioning.md) —
  so without this step the PR would fail its own `version:check` gate.

Before merging, check that the proposed version is the one you expect. The
bump follows conventional-commit types: `feat` → minor, `fix` → patch, a
`!` or `BREAKING CHANGE` footer → major (or minor while `MAJOR == 0`).

Wait for CI to go green, then merge. **Squash or rebase**, not merge
commits — the tag needs a single, clean commit to point at.

<details>
<summary>Manual path (recovery only)</summary>

If release-please is unavailable and a release cannot wait, the version can
be bumped by hand:

```bash
echo 1.2.3 > VERSION
bun run version:sync     # rewrites the derived manifests
bun run version:check    # CI gate; must pass
$EDITOR CHANGELOG.md     # add a "## [1.2.3] — <date>" section by hand
git commit -am "chore(release): 1.2.3"
```

**Consequence, and the step that must follow.** release-please derives its
baseline from published GitHub Releases, so a manual tag is invisible to it
until `release.yml` publishes the Release for that tag. Confirm the Release
appears before expecting the next automated proposal to be correct — a
missing Release is what previously caused it to recompute from an empty
history and propose a wrong version.

Also update `.release-please-manifest.json` to the released version, since
`version:sync` deliberately no longer writes it.

</details>

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

First confirm the GitHub Release exists — it is both what consumers
download and the baseline release-please reads for the next proposal:

```bash
gh release view "$TAG" --json tagName,isPrerelease,assets \
  --jq '{tag: .tagName, prerelease: .isPrerelease, assets: [.assets[].name]}'

# Verify the attached artefacts the way a consumer would
mkdir /tmp/rel && cd /tmp/rel
gh release download "$TAG" --repo AnoRebel/licensing
sha256sum -c SHA256SUMS.txt
```

A stable tag should report `prerelease: false` and carry the npm tarball,
the Go module zip, and `SHA256SUMS.txt`. A tag with a `-rc.N` suffix
should report `prerelease: true` and must not be the repository's latest
release.

Then the registries:

```bash
# npm
npm view @anorebel/licensing@0.1.0-rc.1

# jsr
bunx jsr info @anorebel/licensing

# Go
go list -m -versions github.com/AnoRebel/licensing
# → github.com/AnoRebel/licensing v0.1.0-rc.1
```

Smoke-test a fresh consumer install:

```bash
# TS
mkdir /tmp/smoke && cd /tmp/smoke
bun init -y
bun add @anorebel/licensing@0.1.0-rc.1
bun -e "import {canonicalize} from '@anorebel/licensing/canonical-json'; console.log(canonicalize({b:1,a:2}))"

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

## Major versions

Work constituting a new major version is developed on a branch named for
that major — `v1`, `v2` — and merged back into `main` when complete.
`main` remains the canonical branch; the tag is cut from `main` after the
merge, never from the version branch.

```
main ──●─────────────────●──●─  (patches keep shipping)
        \               /
  v1     ●──●──●──●──●──●        merged, then tagged v1.0.0 from main
         refactor  feature
```

The version branch is **retained** after the merge, as a checkpoint
identifying the work that made up that major. It is not deleted and not
developed on further; the next major gets its own branch.

Why a branch rather than landing directly on `main`: a major typically
carries a multi-step refactor, and `main` needs to stay releasable for
patches to the current version throughout. Without the branch there is no
clean commit to cut a patch from while the refactor is mid-flight.

---

## Rollback

Once a version is published to **any** of the three registries, those bytes
are immutable. The only remediation is a new version with a fix; the bad
version must be **deprecated**, not deleted.

```bash
# npm
npm deprecate '@anorebel/licensing@0.1.0' 'Critical bug XYZ; upgrade to 0.1.1'

# jsr
bunx jsr deprecate @anorebel/licensing@0.1.0 --reason "Critical bug XYZ"

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
