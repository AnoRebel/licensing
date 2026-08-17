import {
  type Column,
  type ColumnDef,
  type ColumnVisibilityState,
  columnFacetingFeature,
  columnFilteringFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  coreFeatures,
  createFacetedRowModel,
  createFacetedUniqueValues,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFn_includesString,
  type Row,
  type RowData,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  type Table,
  tableFeatures,
} from '@tanstack/vue-table';

/**
 * The single, app-wide TanStack Table feature set.
 *
 * TanStack Table v9 dropped v8's "everything is bundled" model: features and
 * their row models must be registered explicitly, and every table type is
 * parameterised by the feature set (`Table<TFeatures, TData>`,
 * `ColumnDef<TFeatures, TData, TValue>`, ...).
 *
 * We deliberately declare ONE set for the whole app rather than a minimal set
 * per page. If each page registered its own features, each page's `ColumnDef`
 * would be a structurally different type, and the shared `DataTable` component
 * could no longer accept them without becoming generic over features too.
 * Collapsing `TFeatures` to a single concrete type keeps `DataTable` generic
 * over `TData` alone and keeps the column files free of feature plumbing.
 *
 * The registered set mirrors exactly what the list views used under v8 —
 * sorting, column filtering, faceting, pagination, column visibility and row
 * selection — so the migration preserves behaviour rather than trimming it.
 * Bundle size is not the goal here; behavioural parity is.
 *
 * Note on slot prerequisites: v9 validates that every row-model slot is
 * accompanied by its feature (`filteredRowModel` needs `columnFilteringFeature`,
 * `facetedRowModel`/`facetedUniqueValues` need `columnFacetingFeature`, and so
 * on) and fails the build with a named error if one is missing.
 */
export const tableFeatureSet = tableFeatures({
  ...coreFeatures,
  columnFacetingFeature,
  columnFilteringFeature,
  // Required for `size`/`minSize`/`maxSize` on a column def — used by the
  // synthesised selection column to keep a fixed narrow width.
  columnSizingFeature,
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  facetedRowModel: createFacetedRowModel(),
  facetedUniqueValues: createFacetedUniqueValues(),
  filteredRowModel: createFilteredRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortedRowModel: createSortedRowModel(),
  // Named filter functions must be registered before a column can refer to
  // one by string (`filterFn: 'includesString'`). v8 shipped these
  // implicitly; v9 makes the registry explicit, and its keys become the
  // valid string values with full inference. Columns passing an inline
  // function instead are unaffected.
  filterFns: {
    includesString: filterFn_includesString,
  },
});

/** The concrete feature-set type every table type below is bound to. */
export type AppTableFeatures = typeof tableFeatureSet;

/**
 * App-local aliases for the library generics, pre-bound to
 * {@link AppTableFeatures}.
 *
 * Components and column files import these instead of the raw library types so
 * the `TFeatures` argument appears in exactly one place. If the feature set
 * ever changes, only this module is touched.
 */
export type AppColumnDef<TData extends RowData, TValue = unknown> = ColumnDef<
  AppTableFeatures,
  TData,
  TValue
>;
export type AppTable<TData extends RowData> = Table<AppTableFeatures, TData>;
export type AppRow<TData extends RowData> = Row<AppTableFeatures, TData>;
export type AppColumn<TData extends RowData, TValue = unknown> = Column<
  AppTableFeatures,
  TData,
  TValue
>;

/**
 * v9 removed the `VisibilityState` export; `ColumnVisibilityState` is its
 * replacement. Re-exported (rather than hand-rolled as
 * `Record<string, boolean>`) so this app's declaration cannot drift from the
 * library's actual shape.
 */
export type AppColumnVisibilityState = ColumnVisibilityState;
