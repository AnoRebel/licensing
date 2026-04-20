/**
 * UUIDv7 and Instant helpers.
 *
 * UUIDv7 (RFC 9562 §5.7) encodes a 48-bit Unix-milliseconds timestamp in the
 * leading bytes, making IDs time-sortable without a separate `created_at`
 * column becoming load-bearing. We pick v7 over v4 for this reason —
 * paginated listings and cursor-based queries stay stable even when the
 * clock is the only available sort key.
 *
 * The `Clock` abstraction lets tests inject a deterministic `now()` so that
 * issuer flows, lifecycle transitions, and grace calculations are
 * reproducible. Production wires the real system clock.
 */

import { randomFillSync } from 'node:crypto';
import type { Instant, UUIDv7 } from './types.ts';

/** Pluggable clock. Production uses {@link systemClock}; tests use
 *  {@link createFixedClock} or {@link createAdvancingClock}. */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  nowMs(): number;
  /** ISO-8601 string with microsecond precision. Wall-clock formatter. */
  nowIso(): Instant;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  nowIso: () => isoFromMs(Date.now()),
};

/** Fixed clock: always returns the same instant. Useful for "what does the
 *  system look like at exactly T?" tests. */
export function createFixedClock(iso: Instant): Clock {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`invalid instant: ${iso}`);
  return {
    nowMs: () => ms,
    nowIso: () => iso,
  };
}

/** Auto-advancing clock: `nowMs()` increments by `stepMs` per call starting
 *  at the given ISO. Useful for rotation / grace tests that care only about
 *  monotonic ordering, not wall time. */
export function createAdvancingClock(startIso: Instant, stepMs = 1): Clock {
  let ms = Date.parse(startIso);
  if (!Number.isFinite(ms)) throw new Error(`invalid instant: ${startIso}`);
  return {
    nowMs: () => {
      const cur = ms;
      ms += stepMs;
      return cur;
    },
    nowIso: () => isoFromMs(ms),
  };
}

/** Format an ISO-8601 instant with microsecond precision (always 6 digits
 *  after the decimal point). */
export function isoFromMs(ms: number): Instant {
  // JS only has ms resolution natively — trail the ISO with `000` to
  // reach microseconds. This keeps the format width stable across the
  // whole codebase so lex sort == time sort.
  const base = new Date(ms).toISOString(); // e.g. 2026-04-13T10:00:00.123Z
  return base.replace(/\.(\d{3})Z$/, '.$1000Z');
}

// -------- UUIDv7 --------

const V7_BUF = new Uint8Array(16);

/** Generate a fresh UUIDv7 against the given clock. */
export function newUuidV7(clock: Clock = systemClock): UUIDv7 {
  const ms = clock.nowMs();
  if (ms < 0 || ms > 0xffff_ffff_ffff) throw new Error(`ms out of range: ${ms}`);

  // 48-bit ms timestamp (big-endian).
  V7_BUF[0] = (ms / 0x1_0000_0000_00) & 0xff;
  V7_BUF[1] = (ms / 0x1_0000_0000) & 0xff;
  V7_BUF[2] = (ms >>> 24) & 0xff;
  V7_BUF[3] = (ms >>> 16) & 0xff;
  V7_BUF[4] = (ms >>> 8) & 0xff;
  V7_BUF[5] = ms & 0xff;

  // 12-bit rand_a + 4-bit version (0b0111) in bytes 6–7.
  // 62-bit rand_b + 2-bit variant (0b10) in bytes 8–15.
  randomFillSync(V7_BUF, 6, 10);
  V7_BUF[6] = ((V7_BUF[6] as number) & 0x0f) | 0x70; // version 7
  V7_BUF[8] = ((V7_BUF[8] as number) & 0x3f) | 0x80; // variant RFC 4122

  return formatUuid(V7_BUF);
}

function formatUuid(b: Uint8Array): UUIDv7 {
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push((b[i] as number).toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

/** Extract the embedded millisecond timestamp from a UUIDv7. */
export function extractUuidV7Ms(id: UUIDv7): number {
  const cleaned = id.replace(/-/g, '');
  if (cleaned.length !== 32) throw new Error(`invalid uuid: ${id}`);
  const version = Number.parseInt(cleaned.slice(12, 13), 16);
  if (version !== 7) throw new Error(`not a v7 uuid (version=${version}): ${id}`);
  const msHex = cleaned.slice(0, 12);
  return Number.parseInt(msHex, 16);
}
