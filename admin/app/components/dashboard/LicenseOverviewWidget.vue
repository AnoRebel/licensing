<script setup lang="ts">
import { computed } from 'vue';
import { Donut } from '@unovis/ts';
import { VisDonut, VisSingleContainer } from '@unovis/vue';
import StatTile from '~/components/StatTile.vue';
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  componentToString,
} from '~/components/ui/chart';

/**
 * License overview — counts (total / active / pending / expiring) +
 * trailing-30d signed delta on the active set, plus a status-mix donut.
 *
 * All numbers come from /admin/stats/licenses, which the backend
 * aggregates server-side. No more page-cap approximations: counts are
 * accurate, the delta is computed from the audit log without a
 * client-side window walk.
 *
 * Each widget owns its own useLicensing call so a 500 here doesn't
 * blank the rest of the dashboard.
 */

interface Props {
  /** Optional scope filter — UUID, the literal "null" for global-only,
   *  or undefined for every scope. Mirrors the API query param. */
  scopeId?: string | undefined;
}
const props = defineProps<Props>();

const query = computed(() =>
  props.scopeId !== undefined ? { scope_id: props.scopeId } : {},
);

const { data, pending, error } = await useLicensing('/admin/stats/licenses', {
  query,
  key: () => `dash-overview-${props.scopeId ?? 'all'}`,
  watch: [query],
});

const stats = computed(() => data.value?.data);
const counts = computed(() => stats.value?.counts);

function fmt(n: number | undefined): string {
  return typeof n === 'number' ? n.toLocaleString() : '—';
}

const totalNum = computed(() => {
  const c = counts.value;
  if (!c) return 0;
  return c.pending + c.active + c.grace + c.expired + c.suspended + c.revoked;
});
const totalCount = computed(() => (counts.value ? fmt(totalNum.value) : '—'));
const activeCount = computed(() => fmt(counts.value?.active));
const pendingCount = computed(() => fmt(counts.value?.pending));
const expiringCount = computed(() => fmt(stats.value?.expiring_within_30d));

// Signed delta = added - removed. Caveat string carries the raw bucket
// counts so operators can audit the number — "Δ +12 (added 18, removed 6)".
const activeDelta = computed<{ value: number; caveat: string } | null>(() => {
  const d = stats.value?.active_delta_30d;
  if (!d) return null;
  const value = d.added - d.removed;
  const sign = value > 0 ? '+' : value < 0 ? '' : '±';
  return {
    value,
    caveat: `Δ ${sign}${value} in 30d (+${d.added} / −${d.removed})`,
  };
});

const activeCaveat = computed(() => activeDelta.value?.caveat ?? 'Δ unavailable');

const tileError = computed(() =>
  error.value ? 'Could not load license stats.' : null,
);

// --- Status-mix donut ---------------------------------------------------
//
// Six fixed status keys + one "label-only" key for the central total.
// Colors map to the design system's --chart-1..5 tokens — the chart
// component installs them as scoped CSS vars (--color-active etc.) via
// ChartStyle, and unovis's :color accessor reads those.

type StatusKey = 'active' | 'pending' | 'grace' | 'expired' | 'suspended' | 'revoked';

// Status palette — maps statuses to the design system's chart tokens
// (--chart-1..5) plus --destructive for revoked. The tokens themselves
// retint between light + dark mode, so the donut stays legible without
// per-mode chart configs.
//
// We don't try to encode semantics in colour (e.g. "grace = warning
// yellow") because the dark-mode token palette is its own scheme — the
// per-status legend below carries the meaning.
const chartConfig = {
  total: { label: 'Total' },
  active: { label: 'Active', color: 'var(--chart-2)' },
  pending: { label: 'Pending', color: 'var(--chart-1)' },
  grace: { label: 'Grace', color: 'var(--chart-4)' },
  expired: { label: 'Expired', color: 'var(--chart-3)' },
  suspended: { label: 'Suspended', color: 'var(--chart-5)' },
  revoked: { label: 'Revoked', color: 'var(--destructive)' },
} satisfies ChartConfig;

interface DonutDatum {
  status: StatusKey;
  count: number;
}

// Drop zero-count statuses from the render so they don't show as
// invisible 0-deg slices that still consume legend ink.
const donutData = computed<readonly DonutDatum[]>(() => {
  const c = counts.value;
  if (!c) return [];
  const order: readonly StatusKey[] = [
    'active',
    'pending',
    'grace',
    'expired',
    'suspended',
    'revoked',
  ];
  return order.flatMap((status): DonutDatum[] => {
    const count = c[status];
    return count > 0 ? [{ status, count }] : [];
  });
});

const donutValue = (d: DonutDatum) => d.count;
const donutColor = (d: DonutDatum) => `var(--color-${d.status})`;
const donutTooltipTriggers = computed(() => ({
  [Donut.selectors.segment]: componentToString(chartConfig, ChartTooltipContent, {
    hideLabel: true,
  })!,
}));

// Build the legend ourselves — ChartLegendContent emits every config
// key including the meta-only `total`, but we only want statuses that
// actually have data, plus an exact count alongside each chip.
const legendEntries = computed(() =>
  donutData.value.map((d) => ({
    status: d.status,
    count: d.count,
    label: chartConfig[d.status].label,
  })),
);
</script>

<template>
  <section aria-label="License overview" class="space-y-4">
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatTile
        title="total licenses"
        :value="totalCount"
        caveat="all statuses"
        :pending="pending"
        :error="tileError"
      />
      <StatTile
        title="active"
        :value="activeCount"
        :caveat="activeCaveat"
        :pending="pending"
        :error="tileError"
      />
      <StatTile
        title="pending"
        :value="pendingCount"
        caveat="awaiting first activation"
        :pending="pending"
        :error="tileError"
      />
      <StatTile
        title="expiring ≤30d"
        :value="expiringCount"
        caveat="active licenses"
        :pending="pending"
        :error="tileError"
      />
    </div>

    <!--
      Status-mix donut + legend. The donut is decorative-supplementary
      (role="img" with a generated aria-label); operators can read the
      same data from the per-status legend below it, which is fully
      readable by screen readers.
    -->
    <!--
      Donut + legend block. Grid stacks vertically on narrow screens
      (mobile, narrow split-view) and lays donut+legend side-by-side
      from sm: up. The donut slot is a fixed 180×180 inside its own
      flex centre so the legend column gets all the remaining width
      without the donut shrinking unevenly.
    -->
    <div
      v-if="donutData.length > 0"
      class="grid grid-cols-1 items-center gap-4 rounded-md border border-border bg-card p-4 sm:grid-cols-[180px_minmax(0,1fr)]"
    >
      <div
        role="img"
        :aria-label="`License status mix: ${legendEntries.map((e) => `${e.count} ${e.label}`).join(', ')}`"
        class="mx-auto aspect-square w-full max-w-[180px]"
      >
        <ChartContainer
          :config="chartConfig"
          class="h-full w-full"
          :style="{
            '--vis-donut-central-label-font-size': '1.25rem',
            '--vis-donut-central-label-font-weight': '600',
            '--vis-donut-central-label-text-color': 'var(--foreground)',
            '--vis-donut-central-sub-label-text-color': 'var(--muted-foreground)',
          }"
        >
          <VisSingleContainer :data="donutData" :margin="{ top: 8, bottom: 8 }">
            <VisDonut
              :value="donutValue"
              :color="donutColor"
              :arc-width="14"
              :pad-angle="0.005"
              :central-label="totalNum.toLocaleString()"
              central-sub-label="total"
              :central-label-offset-y="6"
            />
            <ChartTooltip :triggers="donutTooltipTriggers" />
          </VisSingleContainer>
        </ChartContainer>
      </div>

      <div class="min-w-0">
        <p
          class="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground"
        >
          status mix
        </p>
        <ul class="grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs xs:grid-cols-2 sm:grid-cols-2">
          <li
            v-for="entry in legendEntries"
            :key="entry.status"
            class="flex items-baseline justify-between gap-2"
          >
            <span class="flex min-w-0 items-baseline gap-1.5">
              <span
                aria-hidden="true"
                class="inline-block h-2 w-2 shrink-0 rounded-sm"
                :style="{ backgroundColor: chartConfig[entry.status].color }"
              />
              <span class="truncate font-mono text-muted-foreground">{{ entry.label }}</span>
            </span>
            <span class="font-mono tabular-nums">{{ entry.count }}</span>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>
