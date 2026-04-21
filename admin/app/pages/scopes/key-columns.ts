import type { ColumnDef } from '@tanstack/vue-table';
import { h } from 'vue';
import type { components } from '#open-fetch-schemas/licensing';
import DataTableColumnHeader from '~/components/DataTable/DataTableColumnHeader.vue';
import KeyRowActions from '~/components/KeyRowActions.vue';
import KeyStateBadge from '~/components/KeyStateBadge.vue';
import { formatAbsolute, formatRelative } from '~/lib/datetime';

type Key = components['schemas']['Key'];

/**
 * Key columns for the embedded "signing keys" table on a scope's detail
 * page. Like the license usages table, per-row actions are wired via
 * `table.options.meta` so the column def remains declarative.
 *
 * `kid` (key id string, not UUID) is the identifier operators see in
 * token headers — it's the first column so it scans vertically.
 */
export const keyColumns: ColumnDef<Key>[] = [
  {
    accessorKey: 'kid',
    id: 'kid',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'kid' }),
    cell: ({ row }) =>
      h('span', { class: 'font-mono text-xs', title: row.original.kid }, row.original.kid),
    enableHiding: false,
  },
  {
    accessorKey: 'alg',
    id: 'alg',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'alg' }),
    cell: ({ row }) => h('span', { class: 'font-mono text-xs uppercase' }, row.original.alg),
  },
  {
    accessorKey: 'role',
    id: 'role',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'role' }),
    cell: ({ row }) => h('span', { class: 'font-mono text-xs' }, row.original.role),
  },
  {
    accessorKey: 'state',
    id: 'state',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'state' }),
    cell: ({ row }) => h(KeyStateBadge, { state: row.original.state }),
  },
  {
    accessorKey: 'not_before',
    id: 'not_before',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'not before' }),
    cell: ({ row }) =>
      h(
        'time',
        {
          datetime: row.original.not_before,
          title: formatAbsolute(row.original.not_before),
          class: 'font-mono text-xs text-muted-foreground',
        },
        formatRelative(row.original.not_before),
      ),
  },
  {
    accessorKey: 'not_after',
    id: 'not_after',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'not after' }),
    cell: ({ row }) => {
      const v = row.original.not_after;
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
      h(KeyRowActions, {
        keyRow: row.original,
        onRotate: () => (table.options.meta as KeyTableMeta | undefined)?.onRotate?.(row.original),
      }),
  },
];

export interface KeyTableMeta {
  onRotate?: (key: Key) => void;
}
