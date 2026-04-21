# Licensing Admin — Accessibility Walkthrough

This document records the keyboard-only walkthrough performed for task
`13.12` (`port-laravel-licensing-to-ts-and-go`). It's intended as a
living checklist: when a primary flow is refactored, re-run the
walkthrough and update the findings block.

## Scope (WCAG 2.2 AA)

Five primary flows, keyboard only, dark and light mode, Chromium + real
screen-reader spot-check. The flows are the ones an on-call SRE will
actually touch at 3 a.m.:

1. **Create license** — `/licenses` → create dialog → submit
2. **Activate license** — `/licenses/:id` → activate action
3. **Revoke usage** — `/usages` → per-row revoke (ConfirmDestructive)
4. **Rotate key** — `/scopes/:id` → per-key rotate (AlertDialog)
5. **Sign out** — header button, any page

The automated axe suite at `tests/a11y/` covers (1)–(5) under Chromium
in both `colorScheme: 'light'` and `colorScheme: 'dark'`, seeded with
canned fixtures so it runs offline.

## How to run

```bash
# one-time per machine
cd admin
bun run test:a11y:install

# full axe sweep (boots nuxt dev on :3100)
bun run test:a11y

# single flow with the Playwright UI
bunx playwright test tests/a11y/usages-revoke.spec.ts --ui
```

CI runs the same sweep on every PR touching `admin/**`, fails the build
on any axe violation at `wcag2aa` / `wcag22aa` impact, and uploads the
HTML report as an artifact on failure.

## Manual walkthrough — 2026-04-19

Driver: keyboard only, `prefers-reduced-motion: reduce`, OS set to
JetBrains Mono default stack. Both light and dark modes verified.

### 1. Create license

| Check | Result |
| --- | --- |
| Tab lands on the "New license" button without traversing the whole nav | ok — nav is in its own `<nav aria-label="Primary">` landmark, skip-nav unnecessary at this density |
| Dialog opens with focus moved to the first field | ok (reka-ui `Dialog` default) |
| `Escape` closes the dialog and returns focus to the trigger | ok |
| Submit disabled until form is valid (`form.Subscribe` → `canSubmit`) | ok |
| Error messages tied via `aria-describedby` | ok (`{field}-error` id) |

### 2. Activate license

| Check | Result |
| --- | --- |
| Per-row "Activate" reachable with `ArrowDown` in the DataTable | ok — `@tanstack/vue-table` keyboard nav preserved |
| AlertDialog exposes role + `aria-describedby` | ok |
| Cancel is the default focus (destructive action does not auto-focus the destructive button) | ok |

### 3. Revoke usage

| Check | Result |
| --- | --- |
| `ConfirmDestructive` typed-to-confirm input has a visible label | ok |
| Destructive button remains disabled until the exact phrase matches | ok |
| `aria-invalid` flips on mismatch | ok |

### 4. Rotate key

| Check | Result |
| --- | --- |
| Rotate dialog describes impact in `aria-describedby` text, not in a `title` tooltip only | ok — plain-text paragraph above buttons |
| New key material is copy-to-clipboard with a discoverable button, not just a click-to-select affordance | ok |
| Focus returns to the row's rotate button after dismissal | ok |

### 5. Sign out

| Check | Result |
| --- | --- |
| Header button has a visible text label | ok — "Sign out", not icon-only |
| Focus ring visible in both modes | ok |
| `ColorModeToggle` is a named button (`aria-label` describes current + next) | ok |

## Known accepted limitations

- `<pre>` blocks in the audit state-diff dialog may trigger
  `scrollable-region-focusable` on large payloads. The blocks have
  `tabindex="0"` to make them focusable without disrupting the dialog's
  primary focus — that's the correct fix per axe docs, verify no
  regressions land.
- Color-mode toggle relies on `ClientOnly` because the resolved class
  isn't known until the client reads localStorage; this creates a brief
  no-icon state before hydration. Because the button is small and the
  fallback reserves the same footprint (`<span class="h-8 w-8" />`),
  there's no CLS and axe does not flag it. If a future redesign makes
  the button bigger, reconsider — and add a skeleton state.

## When this doc is wrong

If the axe suite passes but this document disagrees with observed
behavior, the automated suite wins. Update the table above in the same
PR that refactors the flow.
