/**
 * Opaque cursor encoding for list pagination.
 *
 * The memory adapter orders results by `(created_at DESC, id DESC)`. A
 * cursor captures the tuple of the LAST row on the previous page; the next
 * call returns rows strictly after that tuple under the same ordering.
 *
 * Encoding is base64url of a tiny JSON blob — opaque to the caller, stable
 * across process restarts (the adapter's state doesn't survive restart, so
 * cursor longevity matches the data's longevity). A malformed cursor is
 * treated as "first page" rather than an error; this mirrors Postgres/SQLite
 * adapter behavior where a stale cursor pointing at a deleted row gracefully
 * resumes from the start of the set.
 */

import { Buffer } from 'node:buffer';

export interface CursorTuple {
  /** ISO-8601 string of the last row's `created_at`. */
  readonly createdAt: string;
  /** UUIDv7 of the last row. */
  readonly id: string;
}

export function encodeCursor(t: CursorTuple): string {
  const json = JSON.stringify({ c: t.createdAt, i: t.id });
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeCursor(s: string | null | undefined): CursorTuple | null {
  if (!s) return null;
  try {
    const json = Buffer.from(s, 'base64url').toString('utf8');
    const obj = JSON.parse(json) as { c?: unknown; i?: unknown };
    if (typeof obj.c !== 'string' || typeof obj.i !== 'string') return null;
    return { createdAt: obj.c, id: obj.i };
  } catch {
    return null;
  }
}

/** Sort comparator implementing `(created_at DESC, id DESC)`. Ties on
 *  `created_at` are broken by `id`, which is UUIDv7 — so id-DESC is
 *  equivalent to "most-recently-inserted first" within the same ms. */
export function compareDesc(
  a: { readonly created_at: string; readonly id: string },
  b: { readonly created_at: string; readonly id: string },
): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

/** Returns true if `row` comes strictly after `cursor` under the DESC order. */
export function isAfter(
  row: { readonly created_at: string; readonly id: string },
  cursor: CursorTuple,
): boolean {
  // "After" under DESC means "lexicographically smaller tuple".
  if (row.created_at !== cursor.createdAt) return row.created_at < cursor.createdAt;
  return row.id < cursor.id;
}
