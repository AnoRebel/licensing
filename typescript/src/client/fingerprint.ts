/**
 * Device fingerprint derivation.
 *
 *   hex(SHA-256( sorted(sources).join('\n') ))
 *
 * Sorting is lexicographic on the raw source strings so that source
 * collection order doesn't change the hash. Sources are newline-joined (no
 * delimiter escaping needed — newlines can't appear in machine-id / MAC /
 * OS-id strings, and we assert it). The application-provided salt is just
 * another source — no special treatment, no concatenation tricks.
 *
 * This module is I/O-free at the core: `fingerprintFromSources` takes an
 * explicit string array and hashes. The `defaultFingerprintSources` helper
 * collects the canonical defaults (OS id, machine-id, MAC/host UUID, salt)
 * and lives separately because it's the I/O layer of the pluggable-sources
 * design.
 */

import { createHash } from 'node:crypto';

/**
 * A fingerprint source contributor. `collect()` returns either a non-empty
 * string that participates in the hash, or `null` if the source is
 * unavailable on this platform (e.g. no machine-id file) — nulls are
 * filtered out before sorting. Throwing is reserved for configuration
 * errors (salt missing, etc.); "couldn't read that file" should be null.
 */
export interface FingerprintSource {
  readonly name: string;
  collect(): Promise<string | null> | string | null;
}

/**
 * Compute a fingerprint from an already-collected list of source strings.
 * Inputs are validated (no empty, no embedded newlines), sorted
 * lexicographically, joined with `\n`, and hashed.
 *
 * This is the pure core. Callers who want to test with synthetic sources
 * or replace the collection layer entirely can bypass {@link collectFingerprint}.
 */
export function fingerprintFromSources(sources: readonly string[]): string {
  if (sources.length === 0) {
    throw new Error('fingerprint requires at least one source string');
  }
  for (const s of sources) {
    if (s.length === 0) {
      throw new Error('fingerprint source strings must be non-empty');
    }
    if (s.includes('\n')) {
      throw new Error('fingerprint source strings must not contain newlines');
    }
  }
  const sorted = [...sources].sort();
  const hash = createHash('sha256');
  hash.update(sorted.join('\n'));
  return hash.digest('hex');
}

/**
 * Collect fingerprint source strings by invoking each {@link FingerprintSource}
 * in parallel. Nulls (source unavailable) are filtered out. If every source
 * returns null, the call throws — a zero-input fingerprint is useless and
 * would trivially collide across machines.
 */
export async function collectFingerprint(sources: readonly FingerprintSource[]): Promise<string> {
  if (sources.length === 0) {
    throw new Error('at least one fingerprint source must be configured');
  }
  const collected = await Promise.all(
    sources.map(async (src) => {
      const raw = await src.collect();
      return raw === null || raw.length === 0 ? null : raw;
    }),
  );
  const strings = collected.filter((v): v is string => v !== null);
  if (strings.length === 0) {
    throw new Error(
      `all configured fingerprint sources returned null — cannot derive a fingerprint`,
    );
  }
  return fingerprintFromSources(strings);
}

// ---------- default sources ----------

/**
 * Build the default source list: OS id, machine-id, primary MAC/host
 * UUID, and the caller-supplied app salt. Each source is a thin wrapper
 * around a platform read; I/O is deferred to `collect()` time so the
 * source list itself is cheap to construct and test.
 *
 * Callers who want a different source mix MUST pass their own array —
 * this helper is the canonical default and is NEVER silently merged
 * with a caller's custom list.
 */
export function defaultFingerprintSources(appSalt: string): readonly FingerprintSource[] {
  if (appSalt.length === 0) {
    throw new Error('appSalt must be a non-empty string — it anchors the fingerprint to your app');
  }
  return [
    { name: 'os.id', collect: () => readOsId() },
    { name: 'machine.id', collect: () => readMachineId() },
    { name: 'net.primaryMac', collect: () => readPrimaryMac() },
    { name: 'app.salt', collect: () => `salt:${appSalt}` },
  ];
}

/** Best-effort OS identifier. Node exposes `process.platform` (e.g. `linux`,
 *  `darwin`, `win32`). Combine with `process.arch` to disambiguate x64 vs
 *  arm64 darwin machines whose IDs would otherwise collide on virtualized
 *  platforms where the MAC is stable but the architecture differs. */
function readOsId(): string {
  return `os:${process.platform}:${process.arch}`;
}

/** Linux: `/etc/machine-id` or `/var/lib/dbus/machine-id`.
 *  macOS: IOPlatformUUID via `ioreg` — requires a shell-out, which we skip
 *    for now; the MAC source is usually sufficient on macOS.
 *  Windows: `MachineGuid` from the registry — likewise skipped for now.
 *
 *  Returns null when unreadable. Spec allows null-degradation as long as
 *  at least one source produces a value. */
async function readMachineId(): Promise<string | null> {
  try {
    const fs = await import('node:fs/promises');
    const candidates = ['/etc/machine-id', '/var/lib/dbus/machine-id'];
    for (const path of candidates) {
      try {
        const raw = await fs.readFile(path, 'utf8');
        const trimmed = raw.trim();
        if (trimmed.length > 0) return `machine:${trimmed}`;
      } catch {
        // Try next candidate.
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Primary non-internal MAC address from `os.networkInterfaces()`. Picks
 *  the lexicographically-first interface to keep ordering deterministic
 *  across boots (Node's insertion order is not guaranteed stable on all
 *  platforms). Returns null when no external interface has a MAC — e.g.
 *  inside a sandboxed environment. */
async function readPrimaryMac(): Promise<string | null> {
  try {
    const os = await import('node:os');
    const ifaces = os.networkInterfaces();
    const macs: string[] = [];
    for (const [ifaceName, entries] of Object.entries(ifaces)) {
      if (entries === undefined) continue;
      for (const entry of entries) {
        if (entry.internal) continue;
        // Node fills `mac` with '00:00:00:00:00:00' on some virtual ifaces.
        if (entry.mac.length === 0 || entry.mac === '00:00:00:00:00:00') continue;
        macs.push(`${ifaceName}|${entry.mac}`);
      }
    }
    if (macs.length === 0) return null;
    macs.sort();
    return `mac:${macs[0]}`;
  } catch {
    return null;
  }
}
