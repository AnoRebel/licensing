import type { ColumnDef } from '@tanstack/vue-table';
import { h } from 'vue';
import type { components } from '#open-fetch-schemas/licensing';
import DataTableColumnHeader from '~/components/DataTable/DataTableColumnHeader.vue';
import UsageRowActions from '~/components/UsageRowActions.vue';
import UsageStatusBadge from '~/components/UsageStatusBadge.vue';
import { formatAbsolute, formatRelative } from '~/lib/datetime';

type Usage = components['schemas']['Usage'];

/**
 * Column defs for the embedded usages table on the license detail page.
 * The per-row action column holds the "revoke" button gated by
 * ConfirmDestructive. The onRevoke callback is injected via `meta` on the
 * table instance so the columns stay declarative and decoupled from the
 * page's API-call plumbing.
 */
export const usageColumns: ColumnDef<Usage>[] = [
  {
    accessorKey: 'fingerprint',
    id: 'fingerprint',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'fingerprint' }),
    cell: ({ row }) =>
      h(
        'span',
        { class: 'font-mono text-xs', title: row.original.fingerprint },
        `${row.original.fingerprint.slice(0, 16)}…`,
      ),
    enableHiding: false,
  },
  {
    accessorKey: 'status',
    id: 'status',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'status' }),
    cell: ({ row }) => h(UsageStatusBadge, { status: row.original.status }),
    filterFn: (row, columnId, filterValue: unknown) => {
      if (!Array.isArray(filterValue) || filterValue.length === 0) return true;
      return filterValue.includes(row.getValue(columnId));
    },
  },
  {
    accessorKey: 'registered_at',
    id: 'registered_at',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'registered' }),
    cell: ({ row }) =>
      h(
        'time',
        {
          datetime: row.original.registered_at,
          title: formatAbsolute(row.original.registered_at),
          class: 'font-mono text-xs text-muted-foreground',
        },
        formatRelative(row.original.registered_at),
      ),
  },
  // Last-seen approximates "the most recent thing happened to this
  // usage row" — the storage layer stamps `updated_at` on every
  // mutation (token refresh, status change). Not the same as a
  // dedicated heartbeat column, but the closest signal we have until
  // the issuer surfaces a true `last_seen_at`.
  {
    accessorKey: 'updated_at',
    id: 'last_seen',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'last seen' }),
    cell: ({ row }) =>
      h(
        'time',
        {
          datetime: row.original.updated_at,
          title: formatAbsolute(row.original.updated_at),
          class: 'font-mono text-xs text-muted-foreground',
        },
        formatRelative(row.original.updated_at),
      ),
  },
  // client_meta is consumer-controlled — surface IP + user agent when
  // they're present, otherwise render "—" so the columns stay aligned.
  {
    id: 'ip',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'ip' }),
    accessorFn: (row) => {
      const m = row.client_meta as { ip?: string; ip_address?: string } | undefined;
      return m?.ip ?? m?.ip_address ?? null;
    },
    cell: ({ getValue }) => {
      const v = getValue<string | null>();
      if (!v) return h('span', { class: 'font-mono text-xs text-muted-foreground' }, '—');
      return h('span', { class: 'font-mono text-xs', title: v }, v);
    },
    enableSorting: false,
  },
  {
    id: 'user_agent',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'agent' }),
    accessorFn: (row) => {
      const m = row.client_meta as { user_agent?: string; userAgent?: string } | undefined;
      return m?.user_agent ?? m?.userAgent ?? null;
    },
    cell: ({ getValue }) => {
      const v = getValue<string | null>();
      if (!v) return h('span', { class: 'font-mono text-xs text-muted-foreground' }, '—');
      // Truncate aggressively — full UA strings explode column widths.
      // The `title` attribute gives the operator the full string on hover.
      const display = v.length > 32 ? `${v.slice(0, 32)}…` : v;
      return h('span', { class: 'font-mono text-xs', title: v }, display);
    },
    enableSorting: false,
  },
  {
    accessorKey: 'revoked_at',
    id: 'revoked_at',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'revoked' }),
    cell: ({ row }) => {
      const v = row.original.revoked_at;
      if (!v) return h('span', { class: 'font-mono text-xs text-muted-foreground' }, '—');
      return h(
        'time',
        {
          datetime: v,
          title: formatAbsolute(v),
          class: 'font-mono text-xs text-muted-foreground',
        },
        formatRelative(v),
      );
    },
  },
  {
    id: 'actions',
    header: '',
    enableHiding: false,
    enableSorting: false,
    cell: ({ row, table }) =>
      h(UsageRowActions, {
        usage: row.original,
        // `meta.onRevoke` is injected by the page so the column def has no
        // knowledge of how the revoke call is made.
        onRevoke: () =>
          (table.options.meta as UsageTableMeta | undefined)?.onRevoke?.(row.original),
      }),
  },
];

export interface UsageTableMeta {
  onRevoke?: (usage: Usage) => void;
}
