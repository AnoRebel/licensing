/**
 * Cursor encoding for the Postgres adapter.
 *
 * Identical encoding to `@anorebel/licensing/storage/memory/cursor.ts` — both adapters
 * expose the SAME opaque cursor format, so a cursor minted by one adapter
 * can be decoded by the other. (In practice nobody shuffles cursors between
 * adapters, but the invariant lets a migration from memory → postgres reuse
 * any cursors held by clients mid-pagination.)
 *
 * Postgres-side pagination uses tuple comparison in SQL:
 *   WHERE (created_at, id) < ($cursor_created_at, $cursor_id)
 *   ORDER BY created_at DESC, id DESC
 *   LIMIT $n
 * Row comparison in Postgres follows lexicographic ordering, which is exactly
 * the semantics the cursor encodes.
 */

import { Buffer } from 'node:buffer';

export interface CursorTuple {
  readonly createdAt: string;
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
