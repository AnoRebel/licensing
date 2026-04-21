import type { ColumnDef } from '@tanstack/vue-table';
import { h } from 'vue';
import type { components } from '#open-fetch-schemas/licensing';
import DataTableColumnHeader from '~/components/DataTable/DataTableColumnHeader.vue';
import KeyRowActions from '~/components/KeyRowActions.vue';
import KeyStateBadge from '~/components/KeyStateBadge.vue';
import { formatAbsolute, formatRelative, shortId } from '~/lib/datetime';

type Key = components['schemas']['Key'];

/**
 * Columns for the global keys index. Superset of the scope-embedded
 * key-columns: adds a `scope_id` column so operators can scan which
 * scope each key belongs to without drilling in. The `scope_id` cell
 * surfaces the scope slug when the resolver map has it, else a short
 * UUID — fed through `table.options.meta.scopeSlugFor`.
 */
export const keyColumns: ColumnDef<Key>[] = [
  {
    accessorKey: 'kid',
    id: 'kid',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'kid' }),
    cell: ({ row }) =>
      h('span', { class: 'font-mono text-xs', title: row.original.kid }, row.original.kid),
    enableHiding: false,
    filterFn: 'includesString',
  },
  {
    accessorKey: 'scope_id',
    id: 'scope_id',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'scope' }),
    cell: ({ row, table }) => {
      const id = row.original.scope_id;
      if (!id) return h('span', { class: 'font-mono text-xs text-muted-foreground' }, '—');
      const resolver = (table.options.meta as KeyTableMeta | undefined)?.scopeSlugFor;
      const label = resolver?.(id) ?? shortId(id);
      return h('span', { class: 'font-mono text-xs text-muted-foreground', title: id }, label);
    },
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
    filterFn: (row, columnId, filterValue: unknown) => {
      if (!Array.isArray(filterValue) || filterValue.length === 0) return true;
      return filterValue.includes(row.getValue(columnId));
    },
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
  /** Maps a scope id to its slug for the scope column; falls back to shortId. */
  scopeSlugFor?: (id: string) => string | undefined;
}
