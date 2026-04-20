import { describe, expect, it } from 'bun:test';
import {
  createAdvancingClock,
  createFixedClock,
  extractUuidV7Ms,
  isoFromMs,
  newUuidV7,
  systemClock,
} from '../../src/id.ts';

describe('isoFromMs', () => {
  it('pads to microsecond precision (always 6 fractional digits)', () => {
    expect(isoFromMs(0)).toBe('1970-01-01T00:00:00.000000Z');
    expect(isoFromMs(1_700_000_000_123)).toMatch(/\.\d{6}Z$/);
  });

  it('is monotonic in its argument', () => {
    const a = isoFromMs(1_700_000_000_000);
    const b = isoFromMs(1_700_000_000_001);
    expect(a < b).toBe(true); // lex == time at ms granularity
  });
});

describe('systemClock', () => {
  it('returns a non-zero ms near now()', () => {
    const before = Date.now();
    const ms = systemClock.nowMs();
    const after = Date.now();
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
  });

  it('nowIso parses back to nowMs', () => {
    const ms = systemClock.nowMs();
    const iso = isoFromMs(ms);
    expect(Date.parse(iso)).toBe(ms);
  });
});

describe('createFixedClock', () => {
  it('always returns the same ISO/ms', () => {
    const c = createFixedClock('2026-04-12T10:00:00.000000Z');
    expect(c.nowIso()).toBe('2026-04-12T10:00:00.000000Z');
    const first = c.nowMs();
    const second = c.nowMs();
    expect(first).toBe(second);
  });

  it('rejects a malformed instant', () => {
    expect(() => createFixedClock('not-a-date')).toThrow();
  });
});

describe('createAdvancingClock', () => {
  it('increments by stepMs per nowMs call', () => {
    const c = createAdvancingClock('2026-04-12T10:00:00.000Z', 1000);
    const a = c.nowMs();
    const b = c.nowMs();
    const d = c.nowMs();
    expect(b - a).toBe(1000);
    expect(d - b).toBe(1000);
  });

  it('default step is 1ms', () => {
    const c = createAdvancingClock('2026-04-12T10:00:00.000Z');
    const a = c.nowMs();
    const b = c.nowMs();
    expect(b - a).toBe(1);
  });
});

describe('newUuidV7', () => {
  it('embeds the clock millisecond timestamp in the leading bytes', () => {
    const clock = createFixedClock('2026-04-12T10:00:00.000Z');
    const id = newUuidV7(clock);
    expect(extractUuidV7Ms(id)).toBe(clock.nowMs());
  });

  it('sets the UUID version nibble to 7', () => {
    const id = newUuidV7(createFixedClock('2026-04-12T10:00:00.000Z'));
    // Version nibble is the first char of the 3rd UUID group.
    const thirdGroup = id.split('-')[2] as string;
    expect(thirdGroup.charAt(0)).toBe('7');
  });

  it('sets the variant bits to RFC 4122 (first 2 bits of the 4th group == 10)', () => {
    const id = newUuidV7(createFixedClock('2026-04-12T10:00:00.000Z'));
    const fourthGroup = id.split('-')[3] as string;
    const variantNibble = Number.parseInt(fourthGroup.charAt(0), 16);
    // variantNibble must be 0b10xx → 0x8, 0x9, 0xa, or 0xb.
    expect([0x8, 0x9, 0xa, 0xb]).toContain(variantNibble);
  });

  it('is unique across a batch (rand_b entropy suffices)', () => {
    const clock = createFixedClock('2026-04-12T10:00:00.000Z');
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(newUuidV7(clock));
    expect(ids.size).toBe(100);
  });

  it('produces time-sortable IDs under an advancing clock', () => {
    const clock = createAdvancingClock('2026-04-12T10:00:00.000Z', 1);
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(newUuidV7(clock));
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });

  it('matches the standard UUID format regex', () => {
    const id = newUuidV7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('extractUuidV7Ms', () => {
  it('round-trips through newUuidV7 across a range of instants', () => {
    const cases = [
      Date.parse('1970-01-01T00:00:00.001Z'),
      Date.parse('2000-01-01T00:00:00.000Z'),
      Date.parse('2026-04-12T10:00:00.000Z'),
      Date.parse('2099-12-31T23:59:59.999Z'),
    ];
    for (const ms of cases) {
      const c = createFixedClock(isoFromMs(ms));
      expect(extractUuidV7Ms(newUuidV7(c))).toBe(ms);
    }
  });

  it('rejects a non-v7 UUID', () => {
    const v4 = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    expect(() => extractUuidV7Ms(v4)).toThrow();
  });

  it('rejects a UUID with the wrong length', () => {
    expect(() => extractUuidV7Ms('not-a-uuid')).toThrow();
  });
});
