/**
 * Shared types for the DataTable family. Lives outside `.vue` files so
 * other modules (e.g. page-level `columns.ts`) can import these without
 * triggering Vue SFC type extraction.
 */

export interface FilterFacet {
  /** TanStack column id to bind the facet selection to. */
  columnId: string;
  /** Button label (e.g. "Status"). */
  title: string;
  options: { label: string; value: string }[];
}
