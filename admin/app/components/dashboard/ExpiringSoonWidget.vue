<script setup lang="ts">
import type { components } from '#open-fetch-schemas/licensing';
import { computed } from 'vue';
import { addDays, isAfter, isBefore, parseISO } from 'date-fns';
import { VisAxis, VisStackedBar, VisXYContainer } from '@unovis/vue';
import { formatAbsolute, formatRelative, shortId } from '~/lib/datetime';
import {
  type ChartConfig,
  ChartContainer,
  ChartCrosshair,
  ChartTooltip,
  ChartTooltipContent,
  componentToString,
} from '~/components/ui/chart';

type License = components['schemas']['License'];

/**
 * Expiring within 30 days — next 10 active licenses by expires_at ASC,
 * plus a 30-bucket histogram (one per day).
 *
 * The list endpoint has no expires_at sort or expires_before filter
 * (yet), so we fetch the active page and filter+sort client-side. The
 * cap is 100 — past that we'd need a stats endpoint that returns the
 * actual list (not just the count). 100 active licenses is well past
 * the operator's working set in v0.1.0; if a tenant outgrows it we'll
 * extend the API.
 *
 * The widget owns its own useLicensing call so a 500 here doesn't
 * blank the rest of the dashboard.
 */

interface Props {
  scopeId?: string | undefined;
}
const props = defineProps<Props>();

const query = computed(() => ({
  status: 'active' as const,
  limit: 100,
  ...(props.scopeId !== undefined ? { scope_id: props.scopeId } : {}),
}));

const { data, pending, error } = await useLicensing('/admin/licenses', {
  query,
  key: () => `dash-expiring-${props.scopeId ?? 'all'}`,
  watch: [query],
});

const items = computed<License[]>(() => data.value?.data?.items ?? []);

const expiringSoon = computed<License[]>(() => {
  const now = new Date();
  const horizon = addDays(now, 30);
  const matches = items.value.filter((lic) => {
    if (!lic.expires_at) return false;
    const ex = parseISO(lic.expires_at);
    // Strictly future, within 30d. Already-expired rows wouldn't show as
    // active anyway, but the strict check guards against clock skew.
    return isAfter(ex, now) && isBefore(ex, horizon);
  });
  matches.sort((a, b) => {
    const ax = a.expires_at ?? '';
    const bx = b.expires_at ?? '';
    return ax < bx ? -1 : ax > bx ? 1 : 0;
  });
  return matches.slice(0, 10);
});

const tileError = computed(() => (error.value ? 'Could not load licenses.' : null));

const isEmpty = computed(() => !pending.value && expiringSoon.value.length === 0);

// 30-day histogram — bucket every active+expiring-within-30d license
// into one of 30 buckets keyed by days-until-expiry.
interface HistDatum {
  day: number;
  expiring: number;
}
const histogramData = computed<readonly HistDatum[]>(() => {
  const buckets = new Array<number>(30).fill(0);
  const now = new Date();
  const horizon = addDays(now, 30);
  for (const lic of items.value) {
    if (!lic.expires_at) continue;
    const ex = parseISO(lic.expires_at);
    if (!isAfter(ex, now) || !isBefore(ex, horizon)) continue;
    const dayIdx = Math.min(
      29,
      Math.max(0, Math.floor((ex.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))),
    );
    buckets[dayIdx] = (buckets[dayIdx] ?? 0) + 1;
  }
  return buckets.map((expiring, day) => ({ day, expiring }));
});

const histogramPeak = computed(() =>
  Math.max(0, ...histogramData.value.map((d) => d.expiring)),
);

const chartConfig = {
  expiring: { label: 'Expiring', color: 'var(--chart-4)' },
} satisfies ChartConfig;

const histX = (d: HistDatum) => d.day;
const histY = (d: HistDatum) => d.expiring;

// Tooltip via ChartCrosshair — picks up the crosshair line on hover
// over the 30-bar canvas, renders the dotted-indicator ChartTooltipContent
// with our chartConfig label so the chip says "Expiring  N".
const crosshairTemplate = computed(() =>
  componentToString(chartConfig, ChartTooltipContent, {
    labelFormatter: (d: number | Date) => {
      const n = typeof d === 'number' ? d : Number(d);
      return n === 0 ? 'today' : `+${n}d`;
    },
  }),
);

function tickFormat(value: number | string | Date): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (n === 0) return 'now';
  return `+${n}d`;
}
</script>

<template>
  <!--
    `min-w-0` so the section can shrink inside its grid track on narrow
    parents — without it, the inner SVG forces the column to stretch.
  -->
  <section
    aria-labelledby="expiring-heading"
    class="min-w-0 rounded-md border border-border bg-card"
  >
    <header class="flex items-baseline justify-between border-b border-border px-4 py-3">
      <h2
        id="expiring-heading"
        class="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground"
      >
        expiring within 30d
      </h2>
      <NuxtLink
        to="/licenses?expires_within=30d"
        class="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline focus-visible:outline-none"
      >
        view all →
      </NuxtLink>
    </header>

    <div v-if="pending && items.length === 0" class="space-y-2 p-4" aria-busy="true">
      <div v-for="n in 5" :key="n" class="h-4 w-full animate-pulse rounded bg-muted" />
    </div>
    <p v-else-if="tileError" role="alert" class="p-4 text-sm text-destructive">
      {{ tileError }}
    </p>
    <p v-else-if="isEmpty" class="p-4 text-sm text-muted-foreground">
      No active licenses expire in the next 30 days.
    </p>
    <template v-else>
      <!--
        30-day expiry histogram. Marked role="img" + aria-label so screen
        readers get the gist; the list below is the canonical reading.
      -->
      <div class="border-b border-border px-4 py-3">
        <div class="mb-1 flex items-baseline justify-between">
          <p class="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            distribution
          </p>
          <p class="font-mono text-[10px] text-muted-foreground tabular-nums">
            peak {{ histogramPeak }} / day
          </p>
        </div>
        <div
          role="img"
          :aria-label="`30-day expiry distribution; peak ${histogramPeak} per day`"
          class="h-[80px] w-full"
        >
          <ChartContainer :config="chartConfig" class="h-full">
            <VisXYContainer
              :data="histogramData"
              :margin="{ top: 6, right: 4, bottom: 22, left: 4 }"
              :y-domain="[0, undefined]"
            >
              <VisStackedBar
                :x="histX"
                :y="histY"
                :color="chartConfig.expiring.color"
                :rounded-corners="2"
                :bar-padding="0.15"
              />
              <VisAxis
                type="x"
                :tick-format="tickFormat"
                :num-ticks="4"
                :tick-line="false"
                :domain-line="false"
                :grid-line="false"
              />
              <ChartTooltip />
              <ChartCrosshair :template="crosshairTemplate" color="#0000" />
            </VisXYContainer>
          </ChartContainer>
        </div>
      </div>
      <ul class="divide-y divide-border">
        <li
          v-for="lic in expiringSoon"
          :key="lic.id"
          class="grid grid-cols-[auto_1fr_auto] items-baseline gap-3 px-4 py-2.5"
        >
          <NuxtLink
            :to="`/licenses/${lic.id}`"
            class="font-mono text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline focus-visible:outline-none"
            :title="lic.id"
          >
            {{ shortId(lic.id) }}
          </NuxtLink>
          <span class="truncate text-sm">
            <span class="font-mono text-foreground">{{ lic.license_key }}</span>
          </span>
          <time
            :datetime="lic.expires_at ?? ''"
            :title="formatAbsolute(lic.expires_at)"
            class="font-mono text-xs text-muted-foreground tabular-nums"
          >
            {{ formatRelative(lic.expires_at) }}
          </time>
        </li>
      </ul>
    </template>
  </section>
</template>
