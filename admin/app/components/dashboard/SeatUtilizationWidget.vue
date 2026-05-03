<script setup lang="ts">
import { computed } from 'vue';
import { shortId } from '~/lib/datetime';

/**
 * Seat utilisation — top 10 active licenses by seat-fill ratio (DESC).
 *
 * Source: /admin/stats/licenses → seat_utilization.{ active_usages_total,
 * max_usages_total, top_n }. The backend does the sort; we just render.
 *
 * Row layout: [licence link] [horizontal bar] [used/max + pct].
 * The bar is a flex pair (filled + remainder) so it scales fluidly
 * with the column width without the "auto-shrink looks misaligned"
 * problem you get with absolute-positioned fills on dense tables.
 *
 * Colour bands at 80% / 95% draw the operator's eye to seats nearing
 * exhaustion. The colours are CSS tokens (chart-2/4 plus destructive)
 * so they retint cleanly under dark mode without per-row prop fiddling.
 */

interface Props {
  scopeId?: string | undefined;
}
const props = defineProps<Props>();

const query = computed(() =>
  props.scopeId !== undefined ? { scope_id: props.scopeId } : {},
);

const { data, pending, error } = await useLicensing('/admin/stats/licenses', {
  query,
  key: () => `dash-seats-${props.scopeId ?? 'all'}`,
  watch: [query],
});

const stats = computed(() => data.value?.data?.seat_utilization);
const rows = computed(() => stats.value?.top_n ?? []);
const totalActive = computed(() => stats.value?.active_usages_total ?? 0);
const totalMax = computed(() => stats.value?.max_usages_total ?? 0);
const totalPct = computed(() =>
  totalMax.value === 0 ? 0 : (totalActive.value / totalMax.value) * 100,
);

interface SeatRow {
  license_id: string;
  license_key: string;
  max_usages: number;
  active_usages: number;
  pct: number;
  band: 'ok' | 'warn' | 'alert';
  color: string;
}

const decoratedRows = computed<readonly SeatRow[]>(() =>
  rows.value.map((r) => {
    const pct = r.max_usages > 0 ? (r.active_usages / r.max_usages) * 100 : 0;
    let band: SeatRow['band'] = 'ok';
    // Tokens retint between light + dark mode automatically — chart-2
    // is teal (light) / green (dark), chart-4 is yellow (light) /
    // purple (dark), destructive is red in both. We use them as
    // semantic intensity bands; the percentage label carries the
    // exact value alongside.
    let color = 'var(--chart-2)';
    if (pct >= 95) {
      band = 'alert';
      color = 'var(--destructive)';
    } else if (pct >= 80) {
      band = 'warn';
      color = 'var(--chart-4)';
    }
    return {
      license_id: r.license_id,
      license_key: r.license_key,
      max_usages: r.max_usages,
      active_usages: r.active_usages,
      pct,
      band,
      color,
    };
  }),
);

const tileError = computed(() =>
  error.value ? 'Could not load seat utilisation.' : null,
);

const isEmpty = computed(() => !pending.value && decoratedRows.value.length === 0);
</script>

<template>
  <section
    aria-labelledby="seats-heading"
    class="min-w-0 rounded-md border border-border bg-card"
  >
    <header class="flex items-baseline justify-between border-b border-border px-4 py-3">
      <div>
        <h2
          id="seats-heading"
          class="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground"
        >
          seat utilisation
        </h2>
        <p class="mt-0.5 font-mono text-[10px] text-muted-foreground tabular-nums">
          top 10 by fill ratio · {{ totalActive }} / {{ totalMax }} active seats
          ({{ totalPct.toFixed(1) }}%)
        </p>
      </div>
      <NuxtLink
        to="/licenses?status=active"
        class="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline focus-visible:outline-none"
      >
        view all →
      </NuxtLink>
    </header>

    <div v-if="pending && rows.length === 0" class="space-y-2 p-4" aria-busy="true">
      <div v-for="n in 5" :key="n" class="h-4 w-full animate-pulse rounded bg-muted" />
    </div>
    <p v-else-if="tileError" role="alert" class="p-4 text-sm text-destructive">
      {{ tileError }}
    </p>
    <p v-else-if="isEmpty" class="p-4 text-sm text-muted-foreground">
      No active licenses to display.
    </p>
    <ul v-else class="divide-y divide-border">
      <li
        v-for="row in decoratedRows"
        :key="row.license_id"
        class="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-2.5"
      >
        <NuxtLink
          :to="`/licenses/${row.license_id}`"
          class="font-mono text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline focus-visible:outline-none"
          :title="row.license_key"
        >
          {{ shortId(row.license_id) }}
        </NuxtLink>
        <div
          class="relative h-2.5 overflow-hidden rounded-sm bg-muted"
          role="img"
          :aria-label="`${row.active_usages} of ${row.max_usages} seats used (${row.pct.toFixed(0)} percent), ${row.band}`"
        >
          <!--
            Bar fill — width pinned to the percentage. We render at the
            band's colour token so it picks up dark-mode adjustments
            from the design system without per-mode toggles here.
          -->
          <div
            class="h-full rounded-sm transition-[width] duration-300 ease-out"
            :style="{ width: `${Math.min(100, row.pct)}%`, backgroundColor: row.color }"
          />
        </div>
        <span class="flex items-baseline gap-2 font-mono text-xs tabular-nums">
          <span class="text-muted-foreground">
            {{ row.active_usages }}/{{ row.max_usages }}
          </span>
          <span
            class="w-10 text-right"
            :class="{
              'text-destructive': row.band === 'alert',
              'text-foreground': row.band !== 'alert',
            }"
          >
            {{ row.pct.toFixed(0) }}%
          </span>
        </span>
      </li>
    </ul>
  </section>
</template>
