# Templates

Templates are reusable defaults for new licenses. The licensing
service ships them as a flat resource — `id`, name, scope, and the
five numeric defaults — with optional **inheritance** layered on top
via `parent_id`. Both ports implement the resolver identically; the
admin UI surfaces the chain with a breadcrumb + child list.

## Why templates

Without templates every `createLicense` call has to spell out
`max_usages`, `trial_duration_sec`, `grace_duration_sec`,
`force_online_after_sec`, and any custom entitlements. With templates
the policy lives in one row and licenses just reference its `id`.
When the policy changes, only that row moves — already-issued
licenses keep the snapshot they were created with, but new licenses
pick up the change automatically.

## Flat templates

A template is a row in `license_templates`:

| Field                    | Type            | Notes                              |
| ------------------------ | --------------- | ---------------------------------- |
| `id`                     | uuid            | Server-generated, ULID-ordered.    |
| `scope_id`               | uuid \| null    | Multi-tenant boundary.             |
| `parent_id`              | uuid \| null    | Self-FK, ON DELETE RESTRICT.       |
| `name`                   | string ≤ 128    | Operator-facing label.             |
| `max_usages`             | int ≥ 1         | Seat count.                        |
| `trial_duration_sec`     | int ≥ 0         | 0 = no trial.                      |
| `trial_cooldown_sec`     | int \| null     | Per-template re-trial gap.         |
| `grace_duration_sec`     | int ≥ 0         | Window after `expires_at`.         |
| `force_online_after_sec` | int \| null     | Heartbeat hard-stop.               |
| `entitlements`           | jsonb           | Free-form feature flags.           |
| `meta`                   | jsonb           | Free-form metadata.                |

The bare flat case — no parent — works exactly like a defaulting
record: the issuer copies the template's defaults onto the new
license and you go from there. The four numeric fields and the two
JSON blobs all live on the template row directly; nothing is
inherited, nothing is resolved. The
[`/admin/templates`](../openapi/licensing-admin.yaml) endpoints CRUD
this shape directly.

## Hierarchy

`parent_id` makes a template a child of another template. The
storage layer enforces the relationship with `ON DELETE RESTRICT`
(deleting a parent that still has children fails with
`UniqueConstraintViolation`) and with cycle detection at write time
(see below). At read time the issuer walks the chain from leaf to
root and merges fields with child-wins precedence.

```
Base SKU                        max_usages: 5
└── Pro Yearly                  max_usages: 50    (overrides Base)
    └── Pro Yearly — Trial      trial_duration_sec: 86400
                                trial_cooldown_sec: 604800
```

Issuing a license against `Pro Yearly — Trial` resolves the chain
twice: once at `createLicense` time to copy the numeric defaults
onto the license row, and once at `Issuer.issue({ isTrial: true })`
time to pick up the trial cooldown.

## Inheritance precedence

The resolver lives in `typescript/src/templates/resolve.ts` and the
Go mirror at `licensing/templates/resolve.go`. Both ports implement
the same rules:

1. **Numeric defaults** (`max_usages`, `trial_duration_sec`,
   `trial_cooldown_sec`, `grace_duration_sec`,
   `force_online_after_sec`) are taken from the **leaf row only**.
   They are NOT NULL by schema (the two `_*_sec` fields tagged
   "nullable" stay null when the leaf has them null), so each leaf
   is self-sufficient. Inheritance is an admin convenience, not a
   policy fallback.
2. **`entitlements` and `meta`** are deep-merged with **child-wins
   precedence**. The walker collects ancestors from leaf-parent to
   root, then merges in reverse (root first, leaf last). A nested
   key the leaf sets always wins; a nested key the leaf doesn't set
   inherits from the closest ancestor that does.
3. **Walk depth caps at five ancestors**. Beyond that the resolver
   emits a warning naming the leaf and the chain length, then stops
   walking with whatever it assembled so far. The `truncated` flag
   on the resolved object lets callers detect this. The cap exists
   because deeper hierarchies are almost always a configuration bug
   on the consumer side, and the issuer should never block a token
   issuance on an unbounded walk.

The merge is symmetric across ports — we have a deterministic
fixture under `fixtures/` that both runtimes walk identically.

## Cycle detection

The storage layer rejects writes that would form a cycle. On a
`PATCH /admin/templates/{id}` whose `parent_id` change would loop
back through the same template, the adapter throws
`TemplateCycle`, which the HTTP layer maps to **409 Conflict**.

The cycle check walks the proposed new chain and bails the moment
it revisits the template being updated. It runs inside the same
transaction as the update, so a concurrent write that would create
a cycle by composition is also rejected.

```
PATCH /admin/templates/A   { parent_id: B }     # B is a descendant of A
→ 409 { "error": "TemplateCycle", "message": "..." }
```

The resolver itself has a defence-in-depth pass: even if the storage
layer ever fails to reject a cycle (operator-edited DB, schema bug),
the read path tracks visited ids and breaks the loop with a warning
rather than spinning. That's a safety net, not the contract — writes
are the line of defence.

## Admin UI

The hierarchy preview on `/templates/{id}` reads:

- **Ancestors** — breadcrumb from the leaf rootward, each crumb
  links to the parent's detail page.
- **Direct children** — list of templates whose `parent_id` is the
  current template, each linking to its own detail page.

The parent-picker on the create + edit forms hides the current
template **and its descendants** so the obvious cycle paths never
appear as options. The 409 from the server is the source of truth;
client-side filtering is purely UX.

## Listing children

`GET /admin/templates?parent_id=<uuid>` returns the immediate
children of the named template. Pass the literal string `null` to
list root templates only.

```
GET /admin/templates?parent_id=018df9f1-0000-7000-8000-000000000041
→ [Pro Yearly, Pro Monthly]   # children of Base SKU

GET /admin/templates?parent_id=null
→ [Base SKU, Free, Internal]  # roots
```

## See also

- [`docs/trials.md`](trials.md) — how `trial_cooldown_sec` interacts
  with `trial_issuances` and the issuer's per-fingerprint dedupe.
- [`docs/token-format.md`](token-format.md) — what fields land on
  the issued token vs stay on the license row.
- `openapi/licensing-admin.yaml` — the canonical API contract;
  `/admin/templates` and `/admin/templates/{id}` are the only
  endpoints that touch this resource.
