<script setup lang="ts">
import type { components } from '#open-fetch-schemas/licensing';

type UsageStatus = components['schemas']['UsageStatus'];

/**
 * Two-state chip for usage rows. Uses the same visual vocabulary as
 * LicenseStatusBadge (color + text, never color alone) so the detail
 * page stays legible with a red/green color-blindness simulator.
 */
defineProps<{ status: UsageStatus }>();

const variants: Record<UsageStatus, { dot: string; label: string }> = {
  active: { dot: 'bg-emerald-500', label: 'active' },
  revoked: { dot: 'bg-rose-500', label: 'revoked' },
};
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 rounded-sm border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wide"
  >
    <span :class="['size-1.5 rounded-full', variants[status].dot]" aria-hidden="true" />
    {{ variants[status].label }}
  </span>
</template>
