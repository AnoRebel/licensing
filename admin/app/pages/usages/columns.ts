import type { ColumnDef } from '@tanstack/vue-table';
import { h } from 'vue';
import type { components } from '#open-fetch-schemas/licensing';
import DataTableColumnHeader from '~/components/DataTable/DataTableColumnHeader.vue';
import UsageRowActions from '~/components/UsageRowActions.vue';
import UsageStatusBadge from '~/components/UsageStatusBadge.vue';
import { formatAbsolute, formatRelative, shortId } from '~/lib/datetime';

type Usage = components['schemas']['Usage'];

/**
 * Columns for the global usages index. Unlike the per-license usages on
 * the license detail page, this view surfaces `license_id` as its own
 * column and keeps rows clickable into the parent license for drill-down.
 *
 * The row-click happens at the TableRow level (DataTable's `rowClick`
 * emit). The per-row Revoke button `@click.stop`s so it doesn't also
 * navigate — we want the operator to see the confirm dialog, not leave
 * the page.
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
    filterFn: 'includesString',
  },
  {
    accessorKey: 'license_id',
    id: 'license_id',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'license' }),
    cell: ({ row }) =>
      h(
        'span',
        { class: 'font-mono text-xs text-muted-foreground', title: row.original.license_id },
        shortId(row.original.license_id),
      ),
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
        onRevoke: () =>
          (table.options.meta as UsageTableMeta | undefined)?.onRevoke?.(row.original),
      }),
  },
];

export interface UsageTableMeta {
  onRevoke?: (usage: Usage) => void;
}
