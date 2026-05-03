<script setup lang="ts">
import type { components } from '#open-fetch-schemas/licensing';
import { computed, h, ref } from 'vue';
import type { ColumnDef } from '@tanstack/vue-table';
import DataTableColumnHeader from '~/components/DataTable/DataTableColumnHeader.vue';
import { formatAbsolute, formatRelative, shortId } from '~/lib/datetime';

type AuditEntry = components['schemas']['AuditEntry'];

/**
 * Activity stream — operator-facing, friendlier sibling of the deeper
 * /audit page. Uses the shared DataTable so the toolbar's free-text
 * search + responsive layout come for free.
 *
 * Two filter layers:
 *   - Server-side: `event` filter via the chip row at the top. Active
 *     chip is reflected in the URL so links share state.
 *   - Client-side: free-text search through DataTable's toolbar (the
 *     `assignee` synthetic column matches against actor / event /
 *     payload's licensable fields).
 *
 * Cursor pagination via the same next_cursor contract as every other
 * admin list. The /audit page stays as the deeper view (full
 * prior_state / new_state diff dialog, bucket facets, scope-slug
 * resolution); this page is the on-call incident landing.
 */

useHead({ title: 'Activity — Licensing Admin' });

const route = useRoute();
const router = useRouter();

interface EventFilter {
  id: 'all' | 'license.created' | 'license.activated' | 'license.suspended' | 'license.revoked' | 'license.expired';
  label: string;
}

const FILTERS: readonly EventFilter[] = [
  { id: 'all', label: 'all' },
  { id: 'license.created', label: 'created' },
  { id: 'license.activated', label: 'activated' },
  { id: 'license.suspended', label: 'suspended' },
  { id: 'license.revoked', label: 'revoked' },
  { id: 'license.expired', label: 'expired' },
];

const eventQuery = computed<EventFilter['id']>(() => {
  const e = route.query.event;
  if (typeof e !== 'string') return 'all';
  return (FILTERS.find((f) => f.id === e)?.id ?? 'all') as EventFilter['id'];
});

const cursorQuery = computed(() =>
  typeof route.query.cursor === 'string' && route.query.cursor.length > 0
    ? route.query.cursor
    : undefined,
);

const cursorStack = ref<string[]>([]);

const listQuery = computed(() => ({
  limit: 50,
  cursor: cursorQuery.value,
  ...(eventQuery.value !== 'all' ? { event: eventQuery.value } : {}),
}));

const { data, pending, error, refresh } = await useLicensing('/admin/audit', {
  query: listQuery,
  key: 'admin-activity-list',
  watch: [listQuery],
});

const items = computed<AuditEntry[]>(() => data.value?.data?.items ?? []);
const nextCursor = computed(() => data.value?.data?.next_cursor ?? null);

function setEventFilter(id: EventFilter['id']) {
  cursorStack.value = [];
  const next: Record<string, string | undefined> = {
    ...(route.query as Record<string, string>),
    event: id === 'all' ? undefined : id,
    cursor: undefined,
  };
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(next)) {
    if (typeof v === 'string' && v.length > 0) cleaned[k] = v;
  }
  router.push({ query: cleaned });
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

const errorMessage = computed(() =>
  error.value ? 'Could not load activity. Check the upstream API.' : null,
);

// --- Column defs ------------------------------------------------------
//
// `assignee` is a synthetic accessor — DataTable's toolbar search
// targets it via the `searchColumn` prop, so the operator can type
// "user:42" / "license.suspended" / actor name and narrow the page.
const columns: ColumnDef<AuditEntry>[] = [
  {
    id: 'license_id',
    accessorKey: 'license_id',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'license' }),
    cell: ({ row }) => {
      const id = row.original.license_id;
      if (!id) return h('span', { class: 'font-mono text-xs text-muted-foreground' }, '—');
      return h(
        // resolveComponent at runtime keeps the Nuxt auto-import wiring
        // intact — no need to import NuxtLink explicitly.
        resolveComponent('NuxtLink'),
        {
          to: `/licenses/${id}`,
          class:
            'font-mono text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline',
          title: id,
        },
        () => shortId(id),
      );
    },
  },
  {
    id: 'event',
    accessorKey: 'event',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'event' }),
    cell: ({ row }) =>
      h('span', { class: 'font-mono text-xs text-foreground' }, row.original.event),
  },
  {
    id: 'actor',
    accessorKey: 'actor',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'actor' }),
    cell: ({ row }) =>
      h('span', { class: 'font-mono text-xs text-muted-foreground' }, row.original.actor),
  },
  {
    id: 'assignee',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'owner' }),
    accessorFn: (row) => {
      // Pull licensable_type/_id out of new_state when present; fall
      // back to actor + event so toolbar search still has something
      // useful to match against.
      const ns = row.new_state as Record<string, unknown> | null;
      const lt = ns && typeof ns.licensable_type === 'string' ? ns.licensable_type : '';
      const li = ns && typeof ns.licensable_id === 'string' ? ns.licensable_id : '';
      const owner = lt && li ? `${lt}:${li}` : '';
      return [owner, row.actor, row.event].filter(Boolean).join(' ');
    },
    cell: ({ row }) => {
      const ns = row.original.new_state as Record<string, unknown> | null;
      const lt = ns && typeof ns.licensable_type === 'string' ? ns.licensable_type : '';
      const li = ns && typeof ns.licensable_id === 'string' ? ns.licensable_id : '';
      if (!lt || !li) return h('span', { class: 'font-mono text-xs text-muted-foreground' }, '—');
      return h(
        'span',
        { class: 'font-mono text-xs', title: `${lt}:${li}` },
        `${lt}:${li}`,
      );
    },
    enableSorting: false,
  },
  {
    id: 'occurred_at',
    accessorKey: 'occurred_at',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'when' }),
    cell: ({ row }) =>
      h(
        'time',
        {
          datetime: row.original.occurred_at,
          title: formatAbsolute(row.original.occurred_at),
          class: 'font-mono text-xs text-muted-foreground tabular-nums',
        },
        formatRelative(row.original.occurred_at),
      ),
  },
];
</script>

<template>
  <div class="space-y-6">
    <header class="flex items-baseline justify-between gap-4">
      <div class="space-y-1">
        <p class="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
          page
        </p>
        <h1 class="text-2xl font-semibold tracking-tight">Activity</h1>
      </div>
      <Button variant="outline" size="sm" @click="refresh()">Refresh</Button>
    </header>

    <!--
      Filter chips. role="group" + aria-pressed give screen readers the
      toggle semantics without relying on colour alone for the active
      state. Active chip swaps to `bg-primary` for high-contrast pop.
    -->
    <section
      role="group"
      aria-label="Event filter"
      class="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-3"
    >
      <button
        v-for="f in FILTERS"
        :key="f.id"
        type="button"
        :aria-pressed="eventQuery === f.id"
        :class="[
          'rounded-full border px-3 py-1 font-mono text-xs transition-colors',
          eventQuery === f.id
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
        ]"
        @click="setEventFilter(f.id)"
      >
        {{ f.label }}
      </button>
    </section>

    <p v-if="errorMessage" role="alert" class="text-sm text-destructive">
      {{ errorMessage }}
    </p>

    <DataTable
      v-else
      :columns="columns"
      :data="items"
      :loading="pending"
      search-column="assignee"
      search-placeholder="Search owner / actor / event…"
      pagination-mode="cursor"
      :next-cursor="nextCursor"
      :can-go-prev="cursorStack.length > 0"
      empty-message="No activity matches these filters."
      @prev="goPrev"
      @next="goNext"
    />
  </div>
</template>
