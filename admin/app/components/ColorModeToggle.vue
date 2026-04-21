<script setup lang="ts">
import { Monitor, Moon, Sun } from 'lucide-vue-next';

/**
 * Three-state color-mode toggle: system → light → dark → system.
 *
 * Backed by @nuxtjs/color-mode (already wired in nuxt.config, with
 * storageKey 'licensing-admin-color-mode' so the choice survives reloads
 * and colorMode.preference stays authoritative on the `.dark` / `.light`
 * classes on <html>). We drive `colorMode.preference`, not `.value` —
 * setting preference to 'system' re-enables OS-follow, which
 * `.value` won't do.
 *
 * The button is a compact mono square matching the sign-out button's
 * dimensions; icon swaps based on the *resolved* value so the user sees
 * the theme they're actually in, while the `title` + sr-only label
 * describe the *preference* and what a click will do next.
 */

const colorMode = useColorMode();

const order = ['system', 'light', 'dark'] as const;
type Pref = (typeof order)[number];

function isPref(v: string): v is Pref {
  return (order as readonly string[]).includes(v);
}

function nextPref(current: Pref): Pref {
  // `order[...]` is `Pref | undefined` under noUncheckedIndexedAccess; the
  // modulo makes it provably in-bounds, so the non-null assertion is safe.
  return order[(order.indexOf(current) + 1) % order.length]!;
}

function cycle() {
  const current = isPref(colorMode.preference) ? colorMode.preference : 'system';
  colorMode.preference = nextPref(current);
}

// `colorMode.value` is the *resolved* theme ('light' | 'dark'), used to
// pick the glyph. `preference` is what the user chose ('system' can
// resolve either way).
const resolvedIcon = computed(() => (colorMode.value === 'dark' ? Moon : Sun));
const usingSystem = computed(() => colorMode.preference === 'system');

const label = computed(() => {
  const p = colorMode.preference;
  if (p === 'system') return 'Theme: system';
  if (p === 'dark') return 'Theme: dark';
  return 'Theme: light';
});

const nextLabel = computed(() => {
  const current = isPref(colorMode.preference) ? colorMode.preference : 'system';
  return `Switch to ${nextPref(current)}`;
});
</script>

<template>
  <ClientOnly>
    <button
      type="button"
      :title="`${label}. ${nextLabel}.`"
      :aria-label="`${label}. ${nextLabel}.`"
      class="inline-flex h-8 w-8 items-center justify-center rounded-md border border-input bg-background text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      @click="cycle"
    >
      <Monitor v-if="usingSystem" class="size-4" aria-hidden="true" />
      <component :is="resolvedIcon" v-else class="size-4" aria-hidden="true" />
    </button>
    <template #fallback>
      <span class="inline-flex h-8 w-8" aria-hidden="true" />
    </template>
  </ClientOnly>
</template>
