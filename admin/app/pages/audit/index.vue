<script setup lang="ts">
import type { components } from '#open-fetch-schemas/licensing';
import { computed, ref } from 'vue';
import { toast } from 'vue-sonner';
import type { FilterFacet } from '~/components/DataTable/types';
import { formatAbsolute, formatRelative, shortId } from '~/lib/datetime';
import { auditColumns, type AuditTableMeta } from './columns';

type AuditEntry = components['schemas']['AuditEntry'];

/**
 * Audit log viewer — the tail of every state-changing operation.
 *
 * Filters:
 *   - Server-side: `license_id` (UUID), `scope_id` (UUID), `event` (exact
 *     or prefix match — upstream accepts the raw string). All three are
 *     URL-query-backed so incident links paste and land on the same view.
 *   - Client-side: free-text on the event column, faceted filter on the
 *     synthetic `bucket` column (first segment of the event name) so an
 *     operator can carve the current page into `license.*` / `scope.*` /
 *     `key.*` / `usage.*` without a re-fetch.
 *
 * Row click → opens the "View state" dialog with prior_state / new_state
 * pretty-printed. Copy buttons on each column surface the raw JSON for
 * pasting into incident tools.
 *
 * The API is append-only by construction — no row-level mutations here,
 * just inspection.
 */

useHead({ title: 'Audit — Licensing Admin' });

const route = useRoute();
const router = useRouter();

const licenseIdQuery = computed(() =>
  typeof route.query.license_id === 'string' ? route.query.license_id : undefined,
);
const scopeIdQuery = computed(() =>
  typeof route.query.scope_id === 'string' ? route.query.scope_id : undefined,
);
const eventQuery = computed(() =>
  typeof route.query.event === 'string' && route.query.event.length > 0
    ? route.query.event
    : undefined,
);
const cursorQuery = computed(() =>
  typeof route.query.cursor === 'string' && route.query.cursor.length > 0
    ? route.query.cursor
    : undefined,
);

const listQuery = computed(() => ({
  limit: 50,
  cursor: cursorQuery.value,
  license_id: licenseIdQuery.value,
  scope_id: scopeIdQuery.value,
  event: eventQuery.value,
}));

const { data, pending, error, refresh } = await useLicensing('/admin/audit', {
  query: listQuery,
  key: 'admin-audit-list',
  watch: [listQuery],
});

const items = computed<AuditEntry[]>(() => data.value?.data?.items ?? []);
const nextCursor = computed(() => data.value?.data?.next_cursor ?? null);

// Scopes fuel the scope-slug resolver for the `scope` column. Keyed
// independently from the list so a refresh of one doesn't re-fetch both.
const { data: scopesData } = await useLicensing('/admin/scopes', {
  query: { limit: 100 },
  key: 'admin-audit-scope-index',
});
const scopes = computed(() => scopesData.value?.data?.items ?? []);
const scopeSlugById = computed(() => {
  const map = new Map<string, string>();
  for (const s of scopes.value) map.set(s.id, s.slug);
  return map;
});

const cursorStack = ref<string[]>([]);

function applyServerFilter(patch: Record<string, string | undefined>) {
  cursorStack.value = [];
  const merged = { ...route.query, ...patch };
  const next = Object.fromEntries(
    Object.entries(merged).filter(([, v]) => v !== undefined && v !== ''),
  );
  router.push({ query: next });
}

function goNext() {
  if (!nextCursor.value) return;
  cursorStack.value = [...cursorStack.value, cursorQuery.value ?? ''];
  router.push({ query: { ...route.query, cursor: nextCursor.value } });
}

function goPrev() {
  const prev = cursorStack.value[cursorStack.value.length - 1];
  cursorStack.value = cursorStack.value.slice(0, -1);
  const query = { ...route.query };
  if (prev) query.cursor = prev;
  else delete query.cursor;
  router.push({ query });
}

function clearAllFilters() {
  cursorStack.value = [];
  router.push({ query: {} });
}

const hasActiveServerFilters = computed(() =>
  Boolean(licenseIdQuery.value || scopeIdQuery.value || eventQuery.value),
);

// --- Client facets ------------------------------------------------------
//
// `buckets` is computed from the current page's events — facets adapt to
// what's actually visible rather than hardcoding an enum the backend may
// extend. Sorted so the UI stays stable across refreshes.
const buckets = computed(() => {
  const set = new Set<string>();
  for (const e of items.value) {
    const idx = e.event.indexOf('.');
    set.add(idx > 0 ? e.event.slice(0, idx) : e.event);
  }
  return Array.from(set).sort();
});

const facets = computed<FilterFacet[]>(() => [
  {
    columnId: 'bucket',
    title: 'Bucket (on page)',
    options: buckets.value.map((b) => ({ label: b, value: b })),
  },
]);

// --- State-diff dialog --------------------------------------------------
const viewOpen = ref(false);
const viewEntry = ref<AuditEntry | null>(null);

function openView(entry: AuditEntry) {
  viewEntry.value = entry;
  viewOpen.value = true;
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return String(value);
  }
}

async function copyJson(value: unknown) {
  try {
    await navigator.clipboard.writeText(prettyJson(value));
    toast.success('Copied');
  } catch {
    toast.error('Could not copy — try selecting manually');
  }
}

const tableMeta = computed<AuditTableMeta>(() => ({
  onView: (entry: AuditEntry) => openView(entry),
  scopeSlugFor: (id: string) => scopeSlugById.value.get(id),
}));

const errorText = computed(() =>
  error.value ? 'Could not load audit log. Check the upstream API.' : null,
);
</script>

<template>
  <div class="space-y-6">
    <header class="flex items-baseline justify-between gap-4">
      <div class="space-y-1">
        <p class="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
          observability
        </p>
        <h1 class="text-2xl font-semibold tracking-tight">Audit log</h1>
      </div>
      <Button variant="outline" size="sm" @click="refresh()">Refresh</Button>
    </header>

    <section
      aria-label="Server filters"
      class="grid grid-cols-1 gap-3 rounded-md border border-border bg-card p-4 sm:grid-cols-3"
    >
      <div class="space-y-1.5">
        <Label for="server-license" class="text-xs font-normal text-muted-foreground">
          License <span class="text-muted-foreground">(id)</span>
        </Label>
        <Input
          id="server-license"
          :model-value="licenseIdQuery ?? ''"
          placeholder="uuid"
          class="font-mono text-xs"
          @change="(e: Event) => applyServerFilter({ license_id: (e.target as HTMLInputElement).value || undefined, cursor: undefined })"
        />
      </div>

      <div class="space-y-1.5">
        <Label for="server-scope" class="text-xs font-normal text-muted-foreground">
          Scope
        </Label>
        <select
          id="server-scope"
          :value="scopeIdQuery ?? ''"
          class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          @change="(e) => applyServerFilter({ scope_id: (e.target as HTMLSelectElement).value || undefined, cursor: undefined })"
        >
          <option value="">any scope</option>
          <option v-for="s in scopes" :key="s.id" :value="s.id">{{ s.slug }}</option>
        </select>
      </div>

      <div class="space-y-1.5">
        <Label for="server-event" class="text-xs font-normal text-muted-foreground">
          Event
        </Label>
        <Input
          id="server-event"
          :model-value="eventQuery ?? ''"
          placeholder="license.activated"
          class="font-mono text-xs"
          @change="(e: Event) => applyServerFilter({ event: (e.target as HTMLInputElement).value || undefined, cursor: undefined })"
        />
      </div>

      <div
        v-if="hasActiveServerFilters"
        class="sm:col-span-3 flex items-center justify-end"
      >
        <Button variant="ghost" size="sm" @click="clearAllFilters">
          Clear server filters
        </Button>
      </div>
    </section>

    <p v-if="errorText" role="alert" class="text-sm text-destructive">
      {{ errorText }}
    </p>

    <DataTable
      v-else
      :columns="auditColumns"
      :data="items"
      :loading="pending"
      search-column="event"
      search-placeholder="Filter event on page…"
      :filter-facets="facets"
      :meta="tableMeta"
      pagination-mode="cursor"
      :next-cursor="nextCursor"
      :can-go-prev="cursorStack.length > 0"
      empty-message="No audit events match these filters."
      @row-click="(row) => openView(row as AuditEntry)"
      @prev="goPrev"
      @next="goNext"
    />

    <Dialog v-model:open="viewOpen">
      <DialogContent class="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Audit entry</DialogTitle>
          <DialogDescription>
            Immutable record of a state change. <code>prior_state</code> and
            <code>new_state</code> capture the shape just before and just after the
            event fired — diff them to understand exactly what moved.
          </DialogDescription>
        </DialogHeader>

        <div v-if="viewEntry" class="space-y-4">
          <dl class="grid grid-cols-1 gap-x-8 gap-y-2 font-mono text-xs sm:grid-cols-2">
            <div class="space-y-0.5">
              <dt class="uppercase tracking-wide text-muted-foreground">event</dt>
              <dd>{{ viewEntry.event }}</dd>
            </div>
            <div class="space-y-0.5">
              <dt class="uppercase tracking-wide text-muted-foreground">actor</dt>
              <dd>{{ viewEntry.actor }}</dd>
            </div>
            <div class="space-y-0.5">
              <dt class="uppercase tracking-wide text-muted-foreground">when</dt>
              <dd>
                <time
                  :datetime="viewEntry.occurred_at"
                  :title="formatAbsolute(viewEntry.occurred_at)"
                >
                  {{ formatRelative(viewEntry.occurred_at) }}
                  <span class="ml-2 text-muted-foreground">
                    ({{ formatAbsolute(viewEntry.occurred_at) }})
                  </span>
                </time>
              </dd>
            </div>
            <div class="space-y-0.5">
              <dt class="uppercase tracking-wide text-muted-foreground">id</dt>
              <dd class="break-all">{{ viewEntry.id }}</dd>
            </div>
            <div class="space-y-0.5">
              <dt class="uppercase tracking-wide text-muted-foreground">license</dt>
              <dd>
                <NuxtLink
                  v-if="viewEntry.license_id"
                  :to="`/licenses/${viewEntry.license_id}`"
                  class="underline-offset-2 hover:underline"
                  :title="viewEntry.license_id"
                >
                  {{ shortId(viewEntry.license_id) }}
                </NuxtLink>
                <span v-else class="text-muted-foreground">—</span>
              </dd>
            </div>
            <div class="space-y-0.5">
              <dt class="uppercase tracking-wide text-muted-foreground">scope</dt>
              <dd>
                <NuxtLink
                  v-if="viewEntry.scope_id"
                  :to="`/scopes/${viewEntry.scope_id}`"
                  class="underline-offset-2 hover:underline"
                  :title="viewEntry.scope_id"
                >
                  {{ scopeSlugById.get(viewEntry.scope_id) ?? shortId(viewEntry.scope_id) }}
                </NuxtLink>
                <span v-else class="text-muted-foreground">—</span>
              </dd>
            </div>
          </dl>

          <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <section class="space-y-1.5" aria-labelledby="prior-state-heading">
              <div class="flex items-center justify-between">
                <h3
                  id="prior-state-heading"
                  class="font-mono text-xs uppercase tracking-wide text-muted-foreground"
                >
                  prior_state
                </h3>
                <Button
                  v-if="viewEntry.prior_state"
                  variant="ghost"
                  size="sm"
                  class="h-6 px-2 text-xs"
                  @click="copyJson(viewEntry.prior_state)"
                >
                  Copy
                </Button>
              </div>
              <pre
                v-if="viewEntry.prior_state"
                class="max-h-80 overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs"
              >{{ prettyJson(viewEntry.prior_state) }}</pre>
              <p
                v-else
                class="rounded-md border border-dashed border-border bg-card p-3 font-mono text-xs text-muted-foreground"
              >
                (none — creation event or no prior state)
              </p>
            </section>

            <section class="space-y-1.5" aria-labelledby="new-state-heading">
              <div class="flex items-center justify-between">
                <h3
                  id="new-state-heading"
                  class="font-mono text-xs uppercase tracking-wide text-muted-foreground"
                >
                  new_state
                </h3>
                <Button
                  v-if="viewEntry.new_state"
                  variant="ghost"
                  size="sm"
                  class="h-6 px-2 text-xs"
                  @click="copyJson(viewEntry.new_state)"
                >
                  Copy
                </Button>
              </div>
              <pre
                v-if="viewEntry.new_state"
                class="max-h-80 overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs"
              >{{ prettyJson(viewEntry.new_state) }}</pre>
              <p
                v-else
                class="rounded-md border border-dashed border-border bg-card p-3 font-mono text-xs text-muted-foreground"
              >
                (none — deletion event or no new state)
              </p>
            </section>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" @click="viewOpen = false">Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
