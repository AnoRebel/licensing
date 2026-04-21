<script setup lang="ts">
import type { components } from '#open-fetch-schemas/licensing';

type KeyState = components['schemas']['KeyState'];

/**
 * Signing-key state chip: `active` vs `retiring`. Same color+text pattern
 * as the license/usage badges so the whole dashboard reads consistently.
 *
 * `retiring` is amber because a retiring key still verifies existing
 * tokens — it's a soft-decommission state, not an outage. Operators
 * should notice, but it isn't "danger red".
 */
defineProps<{ state: KeyState }>();

const variants: Record<KeyState, { dot: string; label: string }> = {
  active: { dot: 'bg-emerald-500', label: 'active' },
  retiring: { dot: 'bg-amber-500', label: 'retiring' },
};
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 rounded-sm border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wide"
  >
    <span :class="['size-1.5 rounded-full', variants[state].dot]" aria-hidden="true" />
    {{ variants[state].label }}
  </span>
</template>
