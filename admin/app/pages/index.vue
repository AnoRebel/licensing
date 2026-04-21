<script setup lang="ts">
import { addDays, isBefore, parseISO } from 'date-fns';
import { formatAbsolute, formatRelative, shortId } from '~/lib/datetime';

/**
 * Dashboard — four at-a-glance tiles + a recent-audit feed.
 *
 * Data model caveat: the admin API paginates everything cursor-style and
 * does NOT expose totals or dedicated rollup endpoints yet. So rather
 * than faking a total by walking pages (expensive, flaky), we:
 *   - Fetch one page (`limit=100`) per tile's underlying query.
 *   - Render the count as "N" or "100+" when the page is full.
 *   - Add a muted caveat so operators know they're looking at a lower
 *     bound, not a true total.
 *
 * When the upstream adds `/admin/stats`, we swap these out — but until
 * then, honesty-in-UI beats misleading precision.
 *
 * Expiring-in-30d: the /admin/licenses endpoint has no `expires_before`
 * filter, so we pull `status=active` and filter client-side. Same cap.
 */

useHead({ title: 'Dashboard — Licensing Admin' });

const LIMIT = 100;

// Parallel fetches — Nuxt's useAsyncData dedupe plus the per-key refresh
// give us granular retry later without coupling the three tiles.
const {
  data: active,
  pending: activePending,
  error: activeError,
} = await useLicensing('/admin/licenses', { query: { limit: LIMIT, status: 'active' } });

const {
  data: audit,
  pending: auditPending,
  error: auditError,
} = await useLicensing('/admin/audit', { query: { limit: 20 } });

// Derived — keep as computeds so re-fetching a ref flows through.
const activeItems = computed(() => active.value?.data?.items ?? []);
const auditItems = computed(() => audit.value?.data?.items ?? []);
const hitPageCap = computed(() => activeItems.value.length >= LIMIT);

const activeCount = computed(() => {
  const n = activeItems.value.length;
  return hitPageCap.value ? `${LIMIT}+` : String(n);
});

const expiringCount = computed(() => {
  const threshold = addDays(new Date(), 30);
  const matches = activeItems.value.filter((lic) => {
    if (!lic.expires_at) return false;
    return isBefore(parseISO(lic.expires_at), threshold);
  });
  const n = matches.length;
  // If we hit the page cap on the underlying list, the "expiring" count
  // is a lower bound too — flag it the same way.
  return hitPageCap.value ? `${n}+` : String(n);
});

const seatUtilization = computed(() => {
  if (activeItems.value.length === 0) return '—';
  let used = 0;
  let total = 0;
  for (const lic of activeItems.value) {
    used += lic.active_usages ?? 0;
    total += lic.max_usages ?? 0;
  }
  if (total === 0) return '—';
  const pct = Math.round((used / total) * 1000) / 10; // 1 decimal
  return `${pct}%`;
});

const seatCaveat = computed(() => {
  if (activeItems.value.length === 0) return 'no active licenses on this page';
  let used = 0;
  let total = 0;
  for (const lic of activeItems.value) {
    used += lic.active_usages ?? 0;
    total += lic.max_usages ?? 0;
  }
  const base = `${used.toLocaleString()} / ${total.toLocaleString()} seats`;
  return hitPageCap.value ? `${base} · first ${LIMIT} licenses` : base;
});

const auditCount = computed(() => {
  const n = auditItems.value.length;
  return n === 0 ? '0' : String(n);
});

// Surface the first non-pending error per tile. Keep the string short —
// the reader is trying to work, not debug. Full stack goes to devtools.
const activeTileError = computed(() => (activeError.value ? 'Could not load licenses.' : null));
const auditTileError = computed(() => (auditError.value ? 'Could not load audit feed.' : null));
</script>

<template>
  <div class="space-y-8">
    <header class="space-y-1">
      <p class="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
        overview
      </p>
      <h1 class="text-2xl font-semibold tracking-tight">Dashboard</h1>
    </header>

    <section
      class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
      aria-label="License summary"
    >
      <StatTile
        title="active licenses"
        :value="activeCount"
        :caveat="hitPageCap ? `first ${LIMIT} on page` : 'all'"
        :pending="activePending"
        :error="activeTileError"
      />
      <StatTile
        title="expiring ≤30d"
        :value="expiringCount"
        caveat="based on active page"
        :pending="activePending"
        :error="activeTileError"
      />
      <StatTile
        title="seat utilization"
        :value="seatUtilization"
        :caveat="seatCaveat"
        :pending="activePending"
        :error="activeTileError"
      />
      <StatTile
        title="recent audit"
        :value="auditCount"
        caveat="last 20 events"
        :pending="auditPending"
        :error="auditTileError"
      />
    </section>

    <section aria-labelledby="audit-feed-heading" class="space-y-3">
      <div class="flex items-baseline justify-between">
        <h2
          id="audit-feed-heading"
          class="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground"
        >
          audit feed
        </h2>
        <NuxtLink
          to="/audit"
          class="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline focus-visible:outline-none"
        >
          view all →
        </NuxtLink>
      </div>

      <div class="rounded-md border border-border bg-card">
        <div v-if="auditPending" class="p-4">
          <div class="space-y-2">
            <div v-for="n in 5" :key="n" class="h-4 w-full animate-pulse rounded bg-muted" />
          </div>
        </div>
        <p
          v-else-if="auditTileError"
          role="alert"
          class="p-4 text-sm text-destructive"
        >
          {{ auditTileError }}
        </p>
        <p
          v-else-if="auditItems.length === 0"
          class="p-4 text-sm text-muted-foreground"
        >
          No audit events yet.
        </p>
        <ul v-else class="divide-y divide-border">
          <li
            v-for="entry in auditItems"
            :key="entry.id"
            class="grid grid-cols-[auto_1fr_auto] items-baseline gap-3 px-4 py-2.5"
          >
            <span
              class="font-mono text-xs text-muted-foreground"
              :title="entry.license_id ?? ''"
            >
              {{ shortId(entry.license_id) }}
            </span>
            <span class="text-sm">
              <span class="font-mono text-foreground">{{ entry.event }}</span>
              <span class="text-muted-foreground"> by </span>
              <span class="font-mono text-foreground">{{ entry.actor }}</span>
            </span>
            <time
              :datetime="entry.occurred_at"
              :title="formatAbsolute(entry.occurred_at)"
              class="font-mono text-xs text-muted-foreground"
            >
              {{ formatRelative(entry.occurred_at) }}
            </time>
          </li>
        </ul>
      </div>
    </section>
  </div>
</template>
