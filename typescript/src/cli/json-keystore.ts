/**
 * Newline-delimited JSON file-backed {@link KeyStore} for the `licensing-keys` CLI.
 *
 * Why NDJSON and not a single JSON array? Atomic append of one line is
 * cheap with `fs.appendFileSync` + fsync; a whole-file rewrite loses work if
 * the process dies mid-write. On `put`/`update` we atomically rewrite via
 * write-to-tmp + rename, so a crash either preserves the old file or lands
 * the new one whole — never a half-written prefix.
 *
 * Schema: one LicenseKey JSON object per line, plus a sentinel first line
 * `{"__kind":"licensing-keys/v1"}` so we can evolve the format.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { errors } from '../errors.ts';
import type { KeyStore, KeyStoreFilter } from '../key-hierarchy.ts';
import type { LicenseKey, UUIDv7 } from '../types.ts';

const HEADER = '{"__kind":"licensing-keys/v1"}';

export class JsonFileKeyStore implements KeyStore {
  readonly #path: string;
  #byId = new Map<UUIDv7, LicenseKey>();
  #byKid = new Map<string, UUIDv7>();
  #loaded = false;

  constructor(path: string) {
    this.#path = resolve(path);
  }

  /** Force a read from disk. Called automatically by every mutating op. */
  #loadIfNeeded(): void {
    if (this.#loaded) return;
    if (!existsSync(this.#path)) {
      this.#loaded = true;
      return;
    }
    const text = readFileSync(this.#path, 'utf8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) {
      this.#loaded = true;
      return;
    }
    const [first, ...rest] = lines;
    if (first !== HEADER) {
      throw errors.tokenMalformed(
        `keystore at ${this.#path}: missing or unknown header (expected ${HEADER})`,
      );
    }
    for (const line of rest) {
      const rec = JSON.parse(line) as LicenseKey;
      this.#byId.set(rec.id, rec);
      this.#byKid.set(rec.kid, rec.id);
    }
    this.#loaded = true;
  }

  /** Rewrite the file atomically: write-to-tmp then rename. */
  #flush(): void {
    const lines: string[] = [HEADER];
    for (const rec of this.#byId.values()) lines.push(JSON.stringify(rec));
    const tmp = `${this.#path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, `${lines.join('\n')}\n`, { mode: 0o600 });
    // fsync the file before rename so the data is durable.
    const fd = openSync(tmp, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.#path);
    // fsync the directory so the rename itself is durable on crash.
    try {
      const dir = openSync(dirname(this.#path), 'r');
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    } catch {
      // Directory fsync is best-effort; some filesystems don't support it.
    }
  }

  async put(record: LicenseKey): Promise<void> {
    this.#loadIfNeeded();
    const existingId = this.#byKid.get(record.kid);
    if (existingId !== undefined && existingId !== record.id) {
      throw errors.uniqueConstraintViolation('kid', record.kid);
    }
    this.#byId.set(record.id, record);
    this.#byKid.set(record.kid, record.id);
    this.#flush();
  }

  async get(id: UUIDv7): Promise<LicenseKey | null> {
    this.#loadIfNeeded();
    return this.#byId.get(id) ?? null;
  }

  async findByKid(kid: string): Promise<LicenseKey | null> {
    this.#loadIfNeeded();
    const id = this.#byKid.get(kid);
    return id ? (this.#byId.get(id) ?? null) : null;
  }

  async list(filter: KeyStoreFilter): Promise<readonly LicenseKey[]> {
    this.#loadIfNeeded();
    const out: LicenseKey[] = [];
    for (const rec of this.#byId.values()) {
      if (filter.scope_id !== undefined && rec.scope_id !== filter.scope_id) continue;
      if (filter.role !== undefined && rec.role !== filter.role) continue;
      if (filter.state !== undefined && rec.state !== filter.state) continue;
      if (filter.alg !== undefined && rec.alg !== filter.alg) continue;
      out.push(rec);
    }
    out.sort((a, b) => {
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return out;
  }

  async update(id: UUIDv7, next: LicenseKey): Promise<void> {
    this.#loadIfNeeded();
    if (!this.#byId.has(id)) throw errors.tokenMalformed(`key not found: ${id}`);
    if (id !== next.id) throw errors.tokenMalformed('update cannot change id');
    this.#byId.set(id, next);
    this.#byKid.set(next.kid, id);
    this.#flush();
  }
}
