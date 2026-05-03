<script setup lang="ts">
import type { components } from '#open-fetch-schemas/licensing';
import { computed } from 'vue';
import { format, parseISO } from 'date-fns';
import { formatAbsolute, formatRelative } from '~/lib/datetime';

type AuditEntry = components['schemas']['AuditEntry'];

/**
 * Audit timeline scoped to one license. Fetches /admin/audit
 * filtered by `license_id`, groups by calendar day (in the operator's
 * local zone), and renders a vertical timeline newest-first.
 *
 * Each entry shows:
 *   - actor (admin user, system, etc.)
 *   - event ("license.created", "license.suspended", ...)
 *   - relative time within the day, with the absolute UTC instant on
 *     hover (date-fns formatAbsolute helper)
 *   - a <details> payload expander that pretty-prints prior_state →
 *     new_state if either is non-null
 *
 * Per-day grouping uses local-zone `yyyy-MM-dd` so an event at 23:30
 * UTC on the 19th lands in "19 April" for Europe but "20 April" for
 * Asia. Operators read the timeline as their day, not UTC's.
 */

interface Props {
  licenseId: string;
}
const props = defineProps<Props>();

const query = computed(() => ({ license_id: props.licenseId, limit: 50 }));

const { data, pending, error } = await useLicensing('/admin/audit', {
  query,
  key: () => `license-detail-audit-${props.licenseId}`,
  watch: [query],
});

const entries = computed<AuditEntry[]>(() => data.value?.data?.items ?? []);

const errorMessage = computed(() => (error.value ? 'Could not load audit log.' : null));
const isEmpty = computed(() => !pending.value && entries.value.length === 0);

interface DayGroup {
  dayKey: string;
  dayLabel: string;
  entries: AuditEntry[];
}

// Group by local-zone `yyyy-MM-dd`, preserving the API's newest-first
// order. The audit log is already DESC by `occurred_at`, so a single
// pass with a Map keyed by day keeps the order intact.
const groups = computed<readonly DayGroup[]>(() => {
  const out = new Map<string, DayGroup>();
  for (const e of entries.value) {
    const d = parseISO(e.occurred_at);
    if (Number.isNaN(d.getTime())) continue;
    const key = format(d, 'yyyy-MM-dd');
    let g = out.get(key);
    if (!g) {
      g = { dayKey: key, dayLabel: format(d, 'EEEE, d MMM yyyy'), entries: [] };
      out.set(key, g);
    }
    g.entries.push(e);
  }
  return [...out.values()];
});

function prettyJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function hasPayload(e: AuditEntry): boolean {
  return Boolean(
    (e.prior_state && Object.keys(e.prior_state as object).length > 0) ||
      (e.new_state && Object.keys(e.new_state as object).length > 0),
  );
}
</script>

<template>
  <section
    aria-labelledby="audit-timeline-heading"
    class="space-y-3"
  >
    <div class="flex items-baseline justify-between">
      <h2 id="audit-timeline-heading" class="text-sm font-semibold tracking-tight">
        Audit log
        <span class="ml-2 font-mono text-xs font-normal text-muted-foreground">
          {{ entries.length }}
        </span>
      </h2>
      <NuxtLink
        :to="`/audit?license_id=${licenseId}`"
        class="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline focus-visible:outline-none"
      >
        view all →
      </NuxtLink>
    </div>

    <div
      v-if="pending && entries.length === 0"
      class="space-y-2 rounded-md border border-border bg-card p-4"
      aria-busy="true"
    >
      <div v-for="n in 4" :key="n" class="h-4 w-full animate-pulse rounded bg-muted" />
    </div>
    <p
      v-else-if="errorMessage"
      role="alert"
      class="rounded-md border border-border bg-card p-4 text-sm text-destructive"
    >
      {{ errorMessage }}
    </p>
    <p
      v-else-if="isEmpty"
      class="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground"
    >
      No audit entries for this license yet.
    </p>
    <ol v-else class="space-y-4">
      <li v-for="group in groups" :key="group.dayKey" class="space-y-2">
        <p class="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          {{ group.dayLabel }}
        </p>
        <ol class="space-y-1.5 border-l border-border pl-4">
          <li
            v-for="entry in group.entries"
            :key="entry.id"
            class="relative space-y-1"
          >
            <span
              aria-hidden="true"
              class="absolute -left-[1.0625rem] top-1.5 h-2 w-2 rounded-full border border-border bg-card"
            />
            <div class="grid grid-cols-[1fr_auto] items-baseline gap-3">
              <p class="text-sm">
                <span class="font-mono text-foreground">{{ entry.event }}</span>
                <span class="text-muted-foreground"> · </span>
                <span class="text-muted-foreground">{{ entry.actor }}</span>
              </p>
              <time
                :datetime="entry.occurred_at"
                :title="formatAbsolute(entry.occurred_at)"
                class="font-mono text-[10px] text-muted-foreground tabular-nums"
              >
                {{ formatRelative(entry.occurred_at) }}
              </time>
            </div>
            <details
              v-if="hasPayload(entry)"
              class="rounded-sm border border-border bg-muted/30 p-2 [&[open]>summary]:mb-1.5"
            >
              <summary class="cursor-pointer font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                payload
              </summary>
              <div class="grid gap-2 font-mono text-[11px] sm:grid-cols-2">
                <div class="space-y-1">
                  <p class="text-[10px] uppercase tracking-wide text-muted-foreground">prior</p>
                  <pre class="overflow-x-auto rounded-sm bg-background/40 p-2 text-foreground">{{ prettyJson(entry.prior_state) }}</pre>
                </div>
                <div class="space-y-1">
                  <p class="text-[10px] uppercase tracking-wide text-muted-foreground">new</p>
                  <pre class="overflow-x-auto rounded-sm bg-background/40 p-2 text-foreground">{{ prettyJson(entry.new_state) }}</pre>
                </div>
              </div>
            </details>
          </li>
        </ol>
      </li>
    </ol>
  </section>
</template>
