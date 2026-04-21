import type { ColumnDef } from '@tanstack/vue-table';
import { h } from 'vue';
import type { components } from '#open-fetch-schemas/licensing';
import DataTableColumnHeader from '~/components/DataTable/DataTableColumnHeader.vue';
import { formatAbsolute, formatRelative } from '~/lib/datetime';

type Scope = components['schemas']['Scope'];

/**
 * Columns for the scopes list. `slug` is the human identifier operators
 * reason about — surfaced as the first column. `name` is free-form; we
 * let it flex. Row click navigates to the scope detail where operators
 * can edit metadata or rotate its signing key.
 */
export const scopeColumns: ColumnDef<Scope>[] = [
  {
    accessorKey: 'slug',
    id: 'slug',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'slug' }),
    cell: ({ row }) =>
      h(
        'span',
        { class: 'font-mono text-xs text-foreground', title: row.original.slug },
        row.original.slug,
      ),
    enableHiding: false,
    filterFn: 'includesString',
  },
  {
    accessorKey: 'name',
    id: 'name',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'name' }),
    cell: ({ row }) => h('span', { class: 'text-sm' }, row.original.name),
    filterFn: 'includesString',
  },
  {
    accessorKey: 'created_at',
    id: 'created_at',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'created' }),
    cell: ({ row }) =>
      h(
        'time',
        {
          datetime: row.original.created_at,
          title: formatAbsolute(row.original.created_at),
          class: 'font-mono text-xs text-muted-foreground',
        },
        formatRelative(row.original.created_at),
      ),
  },
  {
    accessorKey: 'updated_at',
    id: 'updated_at',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'updated' }),
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
];
