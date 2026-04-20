/**
 * Cursor encoding for the SQLite adapter.
 *
 * Identical encoding to the memory and Postgres adapters — all three expose
 * the SAME opaque cursor format, so a cursor minted by one can be decoded by
 * the others. This invariant lets a migration across backends reuse cursors
 * held by clients mid-pagination.
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
