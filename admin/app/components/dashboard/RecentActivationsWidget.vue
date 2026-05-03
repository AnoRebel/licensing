<script setup lang="ts">
import type { components } from '#open-fetch-schemas/licensing';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { CurveType } from '@unovis/ts';
import { VisAxis, VisLine, VisXYContainer } from '@unovis/vue';
import { usePreferredReducedMotion } from '@vueuse/core';
import { formatAbsolute, formatRelative, shortId } from '~/lib/datetime';
import {
  type ChartConfig,
  ChartContainer,
  ChartCrosshair,
  ChartTooltip,
  ChartTooltipContent,
  componentToString,
} from '~/components/ui/chart';

type AuditEntry = components['schemas']['AuditEntry'];

/**
 * Recent activations — `license.created` + `license.activated` events
 * from the audit log, polled every 60 seconds.
 *
 * The list endpoint accepts an `event` filter, but only one event per
 * request. We pull the recent unfiltered tail and classify client-side
 * — same approach the Overview widget uses for the 30d delta. This is
 * a small convenience hit (we drop ~50% of rows) in exchange for one
 * round-trip instead of two.
 *
 * Polling: a 60s `setInterval` triggers refresh(). Refreshes happen
 * silently in the background; new entries fade into the list with a
 * CSS transition that's disabled under prefers-reduced-motion.
 *
 * Failure isolation: a failed refresh leaves the previous list intact
 * (Nuxt useAsyncData semantics). The error tile only shows on the
 * initial load.
 */

interface Props {
  scopeId?: string | undefined;
}
const props = defineProps<Props>();

const POLL_INTERVAL_MS = 60_000;

const query = computed(() => ({
  limit: 50,
  ...(props.scopeId !== undefined ? { scope_id: props.scopeId } : {}),
}));

const { data, pending, error, refresh } = await useLicensing('/admin/audit', {
  query,
  key: () => `dash-activations-${props.scopeId ?? 'all'}`,
  watch: [query],
});

const auditItems = computed<AuditEntry[]>(() => data.value?.data?.items ?? []);

// Activations = license.created + license.activated. The first row is
// the canonical "license appeared" event; the second fires when a
// pending license transitions to active. Either signals "new seat in
// circulation" to the operator.
const ACTIVATION_EVENTS = new Set(['license.created', 'license.activated']);

const activations = computed<AuditEntry[]>(() =>
  auditItems.value.filter((e) => ACTIVATION_EVENTS.has(e.event)).slice(0, 8),
);

// Sparkline — bucket the trailing 24h of activations into 24 hourly
// slots. Empty hours render as zero so the line shape is honest about
// quiet periods (no implicit gap-skipping).
interface SparkDatum {
  hour: number;
  count: number;
}
const sparkData = computed<readonly SparkDatum[]>(() => {
  const now = Date.now();
  const buckets = new Array<number>(24).fill(0);
  for (const ev of auditItems.value) {
    if (!ACTIVATION_EVENTS.has(ev.event)) continue;
    const ts = Date.parse(ev.occurred_at);
    if (Number.isNaN(ts)) continue;
    const hoursAgo = Math.floor((now - ts) / (60 * 60 * 1000));
    if (hoursAgo < 0 || hoursAgo >= 24) continue;
    // Bucket 0 = current hour; bucket 23 = 23h ago. We render
    // chronologically (left = oldest) so the line reads naturally.
    const idx = 23 - hoursAgo;
    if (idx >= 0 && idx < buckets.length) buckets[idx] = (buckets[idx] ?? 0) + 1;
  }
  return buckets.map((count, hour) => ({ hour, count }));
});

const sparkPeak = computed(() => Math.max(0, ...sparkData.value.map((d) => d.count)));
const totalActivations24h = computed(() =>
  sparkData.value.reduce((sum, d) => sum + d.count, 0),
);

const chartConfig = {
  count: { label: 'Activations', color: 'var(--chart-2)' },
} satisfies ChartConfig;

const sparkX = (d: SparkDatum) => d.hour;
const sparkY = (d: SparkDatum) => d.count;

const sparkCrosshairTemplate = computed(() =>
  componentToString(chartConfig, ChartTooltipContent, {
    labelFormatter: (d: number | Date) => {
      const n = typeof d === 'number' ? d : Number(d);
      const hoursAgo = 23 - n;
      return hoursAgo === 0 ? 'this hour' : `${hoursAgo}h ago`;
    },
  }),
);

function tickFormat(value: number | string | Date): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (n === 23) return 'now';
  if (n === 0) return '−24h';
  return '';
}

const tileError = computed(() =>
  error.value && auditItems.value.length === 0 ? 'Could not load activity feed.' : null,
);

const isEmpty = computed(() => !pending.value && activations.value.length === 0);

// --- Polling --------------------------------------------------------------
//
// A simple setInterval. We deliberately don't use VueUse's useIntervalFn
// because we want the timer to start AFTER the initial fetch settles,
// and we want a deterministic cleanup on unmount. The catch swallows
// network-layer errors so a transient failure doesn't bubble up to
// the page-level error boundary; the next tick retries.
let pollHandle: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  pollHandle = setInterval(() => {
    refresh().catch(() => undefined);
  }, POLL_INTERVAL_MS);
});
onBeforeUnmount(() => {
  if (pollHandle !== null) clearInterval(pollHandle);
});

// --- Reduced-motion-aware animation -----------------------------------
//
// New items get a brief fade+slide-down on append. Operators with the
// reduced-motion media query set get the same data instantly — no
// transform, no opacity ramp. The transition is keyed by the audit
// row's id so Vue's <transition-group> can detect appends correctly.
const prefersReducedMotion = usePreferredReducedMotion();
const motionEnabled = computed(() => prefersReducedMotion.value !== 'reduce');
</script>

<template>
  <!--
    `min-w-0` so the section can shrink inside its grid track. Without
    it the sparkline's intrinsic width keeps the column from collapsing
    on narrow parents.
  -->
  <section
    aria-labelledby="activations-heading"
    aria-live="polite"
    class="min-w-0 rounded-md border border-border bg-card"
  >
    <header class="flex items-baseline justify-between border-b border-border px-4 py-3">
      <div>
        <h2
          id="activations-heading"
          class="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground"
        >
          recent activations
        </h2>
        <p class="mt-0.5 font-mono text-[10px] text-muted-foreground tabular-nums">
          {{ totalActivations24h }} in last 24h · refreshes every 60s
        </p>
      </div>
      <NuxtLink
        to="/audit?event=license.created"
        class="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline focus-visible:outline-none"
      >
        view all →
      </NuxtLink>
    </header>

    <div v-if="pending && auditItems.length === 0" class="space-y-2 p-4" aria-busy="true">
      <div v-for="n in 4" :key="n" class="h-4 w-full animate-pulse rounded bg-muted" />
    </div>
    <p v-else-if="tileError" role="alert" class="p-4 text-sm text-destructive">
      {{ tileError }}
    </p>
    <template v-else>
      <!--
        24h sparkline — same role="img" pattern as the other widgets so
        screen readers get one summary, sighted operators see the shape.
      -->
      <div class="border-b border-border px-4 py-3">
        <div class="mb-1 flex items-baseline justify-between">
          <p class="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            last 24h
          </p>
          <p class="font-mono text-[10px] text-muted-foreground tabular-nums">
            peak {{ sparkPeak }} / hour
          </p>
        </div>
        <div
          role="img"
          :aria-label="`Activations over the last 24 hours; ${totalActivations24h} total, peak ${sparkPeak} per hour`"
          class="h-[60px] w-full"
        >
          <ChartContainer :config="chartConfig" class="h-full">
            <VisXYContainer
              :data="sparkData"
              :margin="{ top: 6, right: 4, bottom: 18, left: 4 }"
              :y-domain="[0, undefined]"
            >
              <VisLine
                :x="sparkX"
                :y="sparkY"
                :color="chartConfig.count.color"
                :curve-type="CurveType.MonotoneX"
                :line-width="2"
              />
              <VisAxis
                type="x"
                :tick-format="tickFormat"
                :num-ticks="2"
                :tick-line="false"
                :domain-line="false"
                :grid-line="false"
              />
              <ChartTooltip />
              <ChartCrosshair :template="sparkCrosshairTemplate" :color="chartConfig.count.color" />
            </VisXYContainer>
          </ChartContainer>
        </div>
      </div>

      <p v-if="isEmpty" class="p-4 text-sm text-muted-foreground">
        No license activations yet.
      </p>
      <transition-group
        v-else
        tag="ul"
        :name="motionEnabled ? 'activation-fade' : ''"
        class="divide-y divide-border"
      >
        <li
          v-for="entry in activations"
          :key="entry.id"
          class="grid grid-cols-[auto_1fr_auto] items-baseline gap-3 px-4 py-2.5"
        >
          <NuxtLink
            v-if="entry.license_id"
            :to="`/licenses/${entry.license_id}`"
            class="font-mono text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline focus-visible:outline-none"
            :title="entry.license_id"
          >
            {{ shortId(entry.license_id) }}
          </NuxtLink>
          <span v-else class="font-mono text-xs text-muted-foreground">—</span>
          <span class="truncate text-sm">
            <span class="font-mono text-foreground">{{ entry.event }}</span>
            <span class="text-muted-foreground"> · </span>
            <span class="text-muted-foreground">{{ entry.actor }}</span>
          </span>
          <time
            :datetime="entry.occurred_at"
            :title="formatAbsolute(entry.occurred_at)"
            class="font-mono text-xs text-muted-foreground tabular-nums"
          >
            {{ formatRelative(entry.occurred_at) }}
          </time>
        </li>
      </transition-group>
    </template>
  </section>
</template>

<style scoped>
/* Inline transition so the reduced-motion guard above can simply not
   apply the name. Tailwind's animation utilities don't expose
   enter/leave-from/to as classes. */
.activation-fade-enter-active {
  transition: opacity 220ms ease-out, transform 220ms ease-out;
}
.activation-fade-enter-from {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
