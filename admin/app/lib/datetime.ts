import { TZDate } from '@date-fns/tz';
import { format, formatDistanceToNowStrict } from 'date-fns';

/**
 * Date helpers scoped to the admin UI. Built on `date-fns` + `@date-fns/tz`
 * (the canonical stack for this repo — see feedback_datetime memory).
 *
 * Inputs are always ISO-8601 strings straight from the admin API, which
 * emits UTC timestamps with a `Z`. We render them in the operator's local
 * zone for scan-ability; the raw ISO stays available via `title=` on the
 * rendered element so hover reveals the exact instant + zone.
 */

/**
 * Short relative form for feeds — "5m", "2h", "3d ago". We use the strict
 * variant so "just now" doesn't round to 0 minutes (operators find that
 * ambiguous during active incidents).
 */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  return formatDistanceToNowStrict(then, { addSuffix: true });
}

/**
 * Absolute form for tooltips and dense tables — "2026-04-19 14:37 UTC".
 * Accepts an optional IANA zone override for operators who configure
 * their console to display UTC regardless of browser locale.
 */
export function formatAbsolute(iso: string | null | undefined, zone?: string): string {
  if (!iso) return '—';
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  const d = zone ? new TZDate(parsed, zone) : new Date(parsed);
  return format(d, "yyyy-MM-dd HH:mm 'UTC'xxx");
}

/**
 * Shorten a UUID to its first 8 chars — the full id is always surfaced
 * via a copy affordance on the row. Feed/table columns stay scannable.
 */
export function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  return id.length <= 8 ? id : id.slice(0, 8);
}
