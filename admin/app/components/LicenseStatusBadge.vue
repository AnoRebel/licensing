<script setup lang="ts">
import type { components } from '#open-fetch-schemas/licensing';

type LicenseStatus = components['schemas']['LicenseStatus'];

/**
 * Six-state badge for LicenseStatus. Color semantics follow the ops
 * dashboard convention operators are used to:
 *   - active  → green / muted success
 *   - pending → blue (pre-activation)
 *   - grace   → amber (expiring but still honored)
 *   - expired → muted red (out of window)
 *   - suspended → amber outline (reversible pause)
 *   - revoked → red solid (terminal)
 *
 * Lifecycle is represented by color alone AND a short label — never by
 * color alone, so colorblind operators still parse it at a glance.
 */
defineProps<{ status: LicenseStatus }>();

const CLASSES: Record<LicenseStatus, string> = {
  active: 'border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  pending: 'border-sky-600/30 bg-sky-500/10 text-sky-700 dark:text-sky-400',
  grace: 'border-amber-600/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  expired: 'border-rose-600/30 bg-rose-500/10 text-rose-700 dark:text-rose-400',
  suspended: 'border-amber-600/40 bg-transparent text-amber-700 dark:text-amber-400',
  revoked: 'border-transparent bg-destructive/90 text-destructive-foreground',
};
</script>

<template>
  <span
    class="inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider"
    :class="CLASSES[status]"
  >
    {{ status }}
  </span>
</template>
