<script setup lang="ts">
/**
 * A dashboard stat card. Typography-driven per .impeccable.md:
 *   - Title: small-caps, muted, tracking-wide (label, not hero text).
 *   - Value: large, monospaced — numerics stay column-alignable.
 *   - Caveat: optional one-liner under the value for honesty-in-UI when
 *     a number is actually a lower bound (e.g. "100+ on this page").
 *
 * Kept as a single component so every tile looks the same and every
 * future tile is a one-liner to add.
 */
interface Props {
  /** Short all-lowercase label rendered in mono small-caps. */
  title: string;
  /** The number (or short string) we want the eye to land on. */
  value: string;
  /** Optional clarifier — rendered muted beneath the value. */
  caveat?: string;
  /** Show the skeleton bar instead of the value. */
  pending?: boolean;
  /** When set, render the card as an error state with this message. */
  error?: string | null;
}

defineProps<Props>();
</script>

<template>
  <section
    class="rounded-md border border-border bg-card p-4 shadow-sm"
    :aria-busy="pending ? 'true' : undefined"
  >
    <p class="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
      {{ title }}
    </p>
    <p v-if="error" class="mt-2 text-xs text-destructive" role="alert">
      {{ error }}
    </p>
    <div v-else-if="pending" class="mt-2 h-8 w-24 animate-pulse rounded bg-muted" />
    <p v-else class="mt-1 font-mono text-3xl font-medium tracking-tight tabular-nums">
      {{ value }}
    </p>
    <p v-if="!error && !pending && caveat" class="mt-1 text-xs text-muted-foreground">
      {{ caveat }}
    </p>
  </section>
</template>
