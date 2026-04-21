import type { ColumnDef } from '@tanstack/vue-table';
import { h } from 'vue';
import type { components } from '#open-fetch-schemas/licensing';
import DataTableColumnHeader from '~/components/DataTable/DataTableColumnHeader.vue';
import LicenseStatusBadge from '~/components/LicenseStatusBadge.vue';
import { formatAbsolute, formatRelative } from '~/lib/datetime';

type License = components['schemas']['License'];

/**
 * Column defs for the licenses table. Kept in a .ts file (not inline in
 * the .vue) because TanStack column defs are JSX-ish — the `cell` and
 * `header` slots expect render functions, and authoring those in a
 * `<script setup>` block fights the type system.
 *
 * Column naming convention:
 *   - `id` is the internal column id (used for filters, visibility state)
 *   - `accessorKey` pulls from the row object
 *   - `header` either gets a sortable DataTableColumnHeader render or a
 *     plain string for non-sortable columns
 */
export const licenseColumns: ColumnDef<License>[] = [
  {
    accessorKey: 'license_key',
    id: 'license_key',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'key' }),
    cell: ({ row }) =>
      h(
        'span',
        { class: 'font-mono text-xs', title: row.original.license_key },
        `${row.original.license_key.slice(0, 12)}…`,
      ),
    enableHiding: false,
  },
  {
    id: 'assignee',
    accessorFn: (row) => `${row.licensable_type}:${row.licensable_id}`,
    header: 'assignee',
    cell: ({ row }) =>
      h(
        'span',
        { class: 'font-mono text-xs' },
        `${row.original.licensable_type}:${row.original.licensable_id}`,
      ),
    filterFn: 'includesString',
  },
  {
    accessorKey: 'status',
    id: 'status',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'status' }),
    cell: ({ row }) => h(LicenseStatusBadge, { status: row.original.status }),
    // Faceted filter stores selected values as an array; we want OR-membership.
    filterFn: (row, columnId, filterValue: unknown) => {
      if (!Array.isArray(filterValue) || filterValue.length === 0) return true;
      return filterValue.includes(row.getValue(columnId));
    },
  },
  {
    id: 'seats',
    accessorFn: (row) => (row.active_usages ?? 0) / Math.max(1, row.max_usages),
    header: ({ column }) =>
      h(DataTableColumnHeader, { column, title: 'seats', class: 'justify-end' }),
    cell: ({ row }) =>
      h(
        'span',
        { class: 'block text-right font-mono text-xs' },
        `${row.original.active_usages ?? 0} / ${row.original.max_usages}`,
      ),
  },
  {
    accessorKey: 'expires_at',
    id: 'expires_at',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'expires' }),
    cell: ({ row }) => {
      const v = row.original.expires_at;
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
