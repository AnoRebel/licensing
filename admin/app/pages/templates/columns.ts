import type { ColumnDef } from '@tanstack/vue-table';
import { h } from 'vue';
import type { components } from '#open-fetch-schemas/licensing';
import DataTableColumnHeader from '~/components/DataTable/DataTableColumnHeader.vue';
import { formatAbsolute, formatRelative } from '~/lib/datetime';

type Template = components['schemas']['Template'];

/**
 * Column defs for the templates list. Templates drive the defaults that
 * copy onto new licenses at creation time — so operators primarily scan
 * by `name` and `max_usages`. Durations render in seconds; a future
 * iteration can add a humanize helper, but exact seconds are what the
 * API stores and what's used in ops tickets.
 */
export const templateColumns: ColumnDef<Template>[] = [
  {
    accessorKey: 'name',
    id: 'name',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'name' }),
    cell: ({ row }) => h('span', { class: 'text-sm' }, row.original.name),
    enableHiding: false,
    filterFn: 'includesString',
  },
  {
    accessorKey: 'max_usages',
    id: 'max_usages',
    header: ({ column }) =>
      h(DataTableColumnHeader, { column, title: 'seats', class: 'justify-end' }),
    cell: ({ row }) =>
      h('span', { class: 'block text-right font-mono text-xs' }, String(row.original.max_usages)),
  },
  {
    accessorKey: 'trial_duration_sec',
    id: 'trial_duration_sec',
    header: ({ column }) =>
      h(DataTableColumnHeader, { column, title: 'trial (s)', class: 'justify-end' }),
    cell: ({ row }) =>
      h(
        'span',
        { class: 'block text-right font-mono text-xs text-muted-foreground' },
        row.original.trial_duration_sec ? String(row.original.trial_duration_sec) : '—',
      ),
  },
  {
    accessorKey: 'grace_duration_sec',
    id: 'grace_duration_sec',
    header: ({ column }) =>
      h(DataTableColumnHeader, { column, title: 'grace (s)', class: 'justify-end' }),
    cell: ({ row }) =>
      h(
        'span',
        { class: 'block text-right font-mono text-xs text-muted-foreground' },
        String(row.original.grace_duration_sec),
      ),
  },
  {
    accessorKey: 'force_online_after_sec',
    id: 'force_online_after_sec',
    header: ({ column }) =>
      h(DataTableColumnHeader, { column, title: 'force-online (s)', class: 'justify-end' }),
    cell: ({ row }) => {
      const v = row.original.force_online_after_sec;
      return h(
        'span',
        { class: 'block text-right font-mono text-xs text-muted-foreground' },
        v == null ? '—' : String(v),
      );
    },
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
