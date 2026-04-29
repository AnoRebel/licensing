# Audit-log event vocabulary

Every row in `audit_logs` carries an `event` string drawn from a stable,
documented vocabulary. Both ports emit identical event names for the same
underlying state transitions — interop tests assert that.

This document is the single source of truth. **Adding a new event is
backwards-compatible; renaming or repurposing an existing one is a breaking
change** and must go through a change proposal.

The audit log itself is append-only — adapters reject UPDATE and DELETE on
`audit_logs` rows with `ImmutableAuditLog`. See `fixtures/schema/entities.md`
§6 for the column shape.

---

## Common columns

Every event row carries:

| Column         | Notes                                                                 |
| -------------- | --------------------------------------------------------------------- |
| `id`           | uuid v7                                                                |
| `license_id`   | nullable; null for events that don't belong to a single license        |
| `scope_id`     | nullable                                                               |
| `actor`        | free-form string. `"system"` for automatic transitions; otherwise an admin user id, service principal, or other consumer-supplied principal |
| `event`        | one of the strings below                                               |
| `prior_state`  | nullable JSON snapshot of the entity *before* the transition           |
| `new_state`    | nullable JSON snapshot of the entity *after* the transition            |
| `occurred_at`  | timestamptz                                                            |

`prior_state`/`new_state` carry whole-entity snapshots. Create events have
`prior_state = null`; delete events have `new_state = null`. Other events
have both populated.

---

## License events

| Event                     | Trigger                                                                                                  | `prior_state` / `new_state` |
| ------------------------- | -------------------------------------------------------------------------------------------------------- | -- |
| `license.created`         | A license row is inserted (admin issuance or template-backed creation).                                  | null / License |
| `license.activated`       | First successful `/activate` for a pending license — usage row created, status moves to `active`.         | License (pending) / License (active) |
| `license.refreshed`       | `/refresh` minted a new token for an existing license. No license-row state change beyond `updated_at`. | License / License |
| `license.renewed`         | Admin extended `expires_at` (separate from `refreshed`, which only mints a new token).                    | License / License |
| `license.grace_entered`   | A license whose `expires_at` has elapsed but `grace_until` is still in the future moves to `grace`.       | License (active) / License (grace) |
| `license.suspended`       | Admin suspended a license (status → `suspended`).                                                         | License / License (suspended) |
| `license.resumed`         | Admin resumed a suspended license back to `active`.                                                       | License (suspended) / License (active) |
| `license.revoked`         | Admin revoked a license (terminal state, `status` → `revoked`).                                          | License / License (revoked) |
| `license.expired`         | A license passed `expires_at` and `grace_until` (or had no grace) and was moved to `expired`.            | License / License (expired) |

## Usage events

| Event              | Trigger                                                                                       | `prior_state` / `new_state` |
| ------------------ | --------------------------------------------------------------------------------------------- | -- |
| `usage.registered` | New `LicenseUsage` row — typically the result of `/activate` for an unseen device fingerprint. | null / LicenseUsage (active) |
| `usage.revoked`    | Usage status moved to `revoked` (admin revoke, or `/deactivate`).                              | LicenseUsage (active) / LicenseUsage (revoked) |

## Scope events

| Event           | Trigger                                                  | `prior_state` / `new_state` |
| --------------- | -------------------------------------------------------- | -- |
| `scope.created` | New `LicenseScope` row inserted (admin create-scope flow). | null / LicenseScope |

## Template events (added in v0002)

| Event                | Trigger                                                                                  | `prior_state` / `new_state` |
| -------------------- | ---------------------------------------------------------------------------------------- | -- |
| `template.created`   | New `LicenseTemplate` row inserted.                                                      | null / LicenseTemplate |
| `template.updated`   | Existing template patched (admin edit, including re-parenting).                          | LicenseTemplate / LicenseTemplate |
| `template.deleted`   | `LicenseTemplate` row hard-deleted by an admin.                                          | LicenseTemplate / null |

## Trial events (added in v0002)

| Event           | Trigger                                                                                       | `prior_state` / `new_state` |
| --------------- | --------------------------------------------------------------------------------------------- | -- |
| `trial.issued`  | A trial license was issued and a `trial_issuances` row recorded for the dedupe pair.          | null / TrialIssuance |
| `trial.reset`   | Admin "Reset trial" cleared a `trial_issuances` row, allowing the fingerprint to trial again. | TrialIssuance / null |

## Key events

| Event         | Trigger                                                       | `prior_state` / `new_state` |
| ------------- | ------------------------------------------------------------- | -- |
| `key.rotated` | Active signing key rotated. The previous key moves to `retiring`. | LicenseKey (state=active) / LicenseKey (state=retiring) |

---

## Filtering events with `events.list({...})`

Both ports expose the audit-log query under their `Storage.listAudit` /
`Storage.ListAudit` method (TS / Go). The v0002 filter accepts:

- `license_id` (nullable; null = events without a license attached).
- `scope_id` (nullable).
- `event` — single string, or an array of strings (TS) / `Events []string` (Go).
- `licensable_type` + `licensable_id` — joins via `licenses`, uses the
  `licenses_licensable_type_id_idx` introduced in v0002.
- `actor` — free-form match.
- `since` / `until` — half-open window on `occurred_at`. `since` is inclusive,
  `until` is exclusive.

Pagination uses an opaque cursor sorted by `(occurred_at DESC, id DESC)`. Pass
the previous page's cursor verbatim to fetch the next page.

```ts
// TS
const page = await issuer.listAudit(
  { licensable_type: 'User', licensable_id: 'u_123', events: ['license.refreshed'] },
  { limit: 20 },
);
```

```go
// Go
ev := "license.refreshed"
lt := "User"
lid := "u_123"
page, err := storage.ListAudit(
    licensing.AuditLogFilter{
        LicensableType: &lt,
        LicensableID:   &lid,
        Events:         []string{ev},
    },
    licensing.PageRequest{Limit: 20},
)
```

---

## Adding a new event

1. Add the string to this document under the appropriate section.
2. Pick a stable name following the `<entity>.<verb>` convention.
3. Emit it from the matching state-machine transition (Go + TS in lockstep).
4. The interop test that round-trips the audit log across ports will pick up
   the new event automatically once both sides emit it.

**Never repurpose an existing event string.** Add a new one and migrate the
emitter; existing rows in production audit logs reference the old name.
