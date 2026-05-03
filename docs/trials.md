# Trials

Trials are licenses with a finite `trial_duration_sec` window and a
**per-fingerprint dedupe** that survives across deletes. Issuing one
records a `(template_id, fingerprint_hash)` row in
`trial_issuances`; re-issuing the same pair within the cooldown
window fails with `TrialAlreadyIssued`. Both ports implement the
same flow; the admin UI exposes a "Reset trial" action that
hard-deletes the dedupe row when an operator decides the customer
deserves a second go.

## The shape of a trial

A trial license is a regular `License` row with three things going
on:

1. `template_id` is set, and the referenced template has
   `trial_duration_sec > 0`.
2. The license's `is_trial` claim is `true` (also stamped on the
   token).
3. The issuer has recorded a row in `trial_issuances` keyed by
   `(template_id, fingerprint_hash)`.

Nothing else differs at the storage layer — the row participates in
the same lifecycle (suspend / resume / revoke / renew) as a paid
license. The "trial" framing is entirely about issue-time policy:
who's allowed to claim one, and how often.

## Issuance flow

The high-level API is one call:

### TypeScript

```ts
import { Issuer } from '@anorebel/licensing';
import { MemoryStorage } from '@anorebel/licensing/storage/memory';

const issuer = new Issuer({
  db: new MemoryStorage(),
  signing: { passphrase: process.env.LICENSING_SIGNING_PW! },
  trialPepper: process.env.LICENSING_TRIAL_PEPPER!,
});

const license = await issuer.issue({
  templateId: TRIAL_TEMPLATE_ID,
  licensableType: 'User',
  licensableId: 'user-42',
  isTrial: true,
  fingerprint: 'a'.repeat(64),
});
```

### Go

```go
issuer, _ := easy.NewIssuer(easy.IssuerConfig{
    DB:          memory.New(memory.Options{}),
    Signing:     &easy.SigningConfig{Passphrase: os.Getenv("LICENSING_SIGNING_PW")},
    TrialPepper: os.Getenv("LICENSING_TRIAL_PEPPER"),
})

license, _ := issuer.Issue(ctx, easy.IssueInput{
    TemplateID:     &trialTemplateID,
    LicensableType: "User",
    LicensableID:   "user-42",
    IsTrial:        true,
    Fingerprint:    strings.Repeat("a", 64),
})
```

The issuer:

1. Resolves the template (walks the parent chain — see
   [`docs/templates.md`](templates.md)).
2. Hashes the caller-supplied `fingerprint` using
   `trials.hashFingerprint(pepper, fingerprint)`.
3. Looks up `(template_id, fingerprint_hash)` in `trial_issuances`.
   If a row exists and its `issued_at` is within the cooldown
   window, throws `TrialAlreadyIssued` (mapped to **409
   TrialAlreadyIssued** in the HTTP layer).
4. Persists the license + writes a `trial_issuances` row + writes a
   `license.created` audit entry, all in one transaction.

## The cooldown

The cooldown is the minimum gap between successive trials of the
same template against the same fingerprint. It comes from one of
two places:

1. **Per-template** — `template.trial_cooldown_sec` overrides the
   global default when set. Operators tune this on the admin UI's
   template detail page.
2. **Global default** — `IssuerConfig.trialCooldownSec` /
   `IssuerConfig.TrialCooldownSec` (90 days when omitted) covers
   templates without an explicit override.

The cooldown only matters when re-issuing a trial against a
fingerprint that already has a `trial_issuances` row for the same
template. A first-ever trial always succeeds. A trial against a
*different* template against the same fingerprint also succeeds —
each `(template_id, fingerprint_hash)` pair is independent.

## The pepper

`trial_issuances.fingerprint_hash` is a SHA-256 of
`pepper + ':' + fingerprint`. The pepper:

- Lives in `IssuerConfig.trialPepper` and is sourced from
  `LICENSING_TRIAL_PEPPER` (or your secret manager).
- Is **never persisted in the licensing DB**. A DB dump alone
  cannot be used to enumerate fingerprints — the attacker needs
  both the dump *and* the pepper.
- Is shared across the whole installation. Rotating it invalidates
  every existing trial-dedupe row (a fresh trial against any old
  fingerprint will succeed). Treat rotations like "trial reset
  day" and announce them.

The threat model is documented in `typescript/src/trials/pepper.ts`
and `licensing/trials/pepper.go`. In short: the pepper buys
**resistance to offline dictionary attacks against fingerprint
hashes**, not anonymity from a determined first-party operator.

## Admin reset

The admin UI exposes a "Reset trial" action on the trial-issuances
table. Confirming it hard-deletes the `(template_id,
fingerprint_hash)` row, which clears the dedupe ledger for that
pair. The next `Issuer.issue({ isTrial: true })` against the same
fingerprint succeeds and writes a new dedupe row.

The admin handler delegates to `Storage.deleteTrialIssuance(id)`
and writes a `trial.reset` audit entry. The deletion is final — the
audit row is the only persistent record that the trial was ever
issued.

## What the token carries

A trial token's payload claim set is the same as any other LIC1
token, plus `trial: true`. Verifiers don't need to look up the
license to know they're holding a trial — the claim is signed.
Consumers wanting to surface "trial expires in N days" copy in the
device's local clock and the token's `exp` claim and render
accordingly.

The `trial: true` claim does **not** turn off any verification step.
A revoked trial is rejected with `LicenseRevoked` exactly like a
revoked paid license; an expired trial is rejected with
`LicenseExpired`.

## See also

- [`docs/templates.md`](templates.md) — how `trial_cooldown_sec`
  inherits up the parent chain.
- [`docs/security.md`](security.md) — full pepper threat model.
- `typescript/src/trials/pepper.ts` / `licensing/trials/pepper.go` —
  the canonical hash function (cross-port byte-identical).
