import type { ColumnDef } from '@tanstack/vue-table';
import { h } from 'vue';
import type { components } from '#open-fetch-schemas/licensing';
import AuditRowActions from '~/components/AuditRowActions.vue';
import DataTableColumnHeader from '~/components/DataTable/DataTableColumnHeader.vue';
import { formatAbsolute, formatRelative, shortId } from '~/lib/datetime';

type AuditEntry = components['schemas']['AuditEntry'];

/**
 * Columns for the audit log viewer.
 *
 * Time-first: operators reading the audit during an incident want the
 * "when" to anchor their eye, not the id. Events are rendered mono so
 * the lowercase dotted names (`license.activated`, `key.rotated`) line
 * up visually across rows and make prefix-scanning trivial.
 *
 * prior_state / new_state are not surfaced as columns (the JSON is too
 * variable to render in a grid without sacrificing scan-ability). The
 * row action opens a dialog that pretty-prints both so the operator can
 * diff them side-by-side.
 */
export const auditColumns: ColumnDef<AuditEntry>[] = [
  {
    accessorKey: 'occurred_at',
    id: 'occurred_at',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'when' }),
    cell: ({ row }) =>
      h(
        'time',
        {
          datetime: row.original.occurred_at,
          title: formatAbsolute(row.original.occurred_at),
          class: 'font-mono text-xs text-muted-foreground',
        },
        formatRelative(row.original.occurred_at),
      ),
    enableHiding: false,
  },
  {
    accessorKey: 'event',
    id: 'event',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'event' }),
    cell: ({ row }) => h('span', { class: 'font-mono text-xs' }, row.original.event),
    filterFn: 'includesString',
  },
  {
    accessorKey: 'actor',
    id: 'actor',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'actor' }),
    cell: ({ row }) =>
      h(
        'span',
        { class: 'font-mono text-xs text-muted-foreground', title: row.original.actor },
        row.original.actor,
      ),
  },
  {
    accessorKey: 'license_id',
    id: 'license_id',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'license' }),
    cell: ({ row }) => {
      const id = row.original.license_id;
      if (!id) return h('span', { class: 'font-mono text-xs text-muted-foreground' }, '—');
      return h(
        'span',
        { class: 'font-mono text-xs text-muted-foreground', title: id },
        shortId(id),
      );
    },
  },
  {
    accessorKey: 'scope_id',
    id: 'scope_id',
    header: ({ column }) => h(DataTableColumnHeader, { column, title: 'scope' }),
    cell: ({ row, table }) => {
      const id = row.original.scope_id;
      if (!id) return h('span', { class: 'font-mono text-xs text-muted-foreground' }, '—');
      const resolver = (table.options.meta as AuditTableMeta | undefined)?.scopeSlugFor;
      const label = resolver?.(id) ?? shortId(id);
      return h('span', { class: 'font-mono text-xs text-muted-foreground', title: id }, label);
    },
  },
  {
    id: 'bucket',
    // Synthetic column fed by the row-level `event` for faceted filtering
    // by prefix (`license`, `scope`, `key`, `usage`, …). Hidden from the
    // rendered grid — the facet UI uses it without ever showing a cell.
    accessorFn: (row) => {
      const idx = row.event.indexOf('.');
      return idx > 0 ? row.event.slice(0, idx) : row.event;
    },
    header: () => null,
    cell: () => null,
    enableHiding: true,
    enableSorting: false,
    filterFn: (row, columnId, filterValue: unknown) => {
      if (!Array.isArray(filterValue) || filterValue.length === 0) return true;
      return filterValue.includes(row.getValue(columnId));
    },
  },
  {
    id: 'actions',
    header: '',
    enableHiding: false,
    enableSorting: false,
    cell: ({ row, table }) =>
      h(AuditRowActions, {
        entry: row.original,
        onView: () => (table.options.meta as AuditTableMeta | undefined)?.onView?.(row.original),
      }),
  },
];

export interface AuditTableMeta {
  onView?: (entry: AuditEntry) => void;
  /** Maps a scope id to its slug for the scope column; falls back to shortId. */
  scopeSlugFor?: (id: string) => string | undefined;
}
