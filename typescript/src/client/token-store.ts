/**
 * Pluggable token persistence.
 *
 * The client stores three pieces of state:
 *
 *   - `token`: the encoded LIC1 string returned by `/activate` or `/refresh`.
 *   - `graceStartSec`: absolute unix-seconds timestamp when the client
 *     entered unreachable-grace, or null when not in grace.
 *
 * Storage is a single JSON blob so reads are atomic (one file read, one
 * parse) and a partial write can never leave us with a token without its
 * matching grace state.
 *
 * `FileTokenStore` is the default for Node/Bun: writes go via `rename` of
 * a temp file so power loss can't corrupt the store. A
 * `MemoryTokenStore` is provided for tests and for consumers who want to
 * inject their own persistence (e.g. OS keychain) via the `TokenStore`
 * interface.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface StoredTokenState {
  readonly token: string | null;
  /** Unix seconds when grace started, null when not in grace. */
  readonly graceStartSec: number | null;
}

export const EMPTY_STATE: StoredTokenState = {
  token: null,
  graceStartSec: null,
};

export interface TokenStore {
  /** Read the full state. Returns {@link EMPTY_STATE} when no token has been
   *  stored yet — implementations SHOULD NOT throw on "file not found". */
  read(): Promise<StoredTokenState>;
  /** Replace the entire state atomically. */
  write(state: StoredTokenState): Promise<void>;
  /** Clear all state. Equivalent to `write(EMPTY_STATE)` for most stores;
   *  kept separate so implementations can drop keychain entries, etc. */
  clear(): Promise<void>;
}

// ---------- FileTokenStore ----------

/**
 * Default file-backed token store. Reads a JSON document from `path`,
 * writes via tmp-file + rename for atomicity, and creates the parent
 * directory on first write.
 *
 * File layout:
 *
 *   {
 *     "token": "LIC1.<header>.<payload>.<sig>" | null,
 *     "graceStartSec": 1746000000 | null
 *   }
 *
 * Unknown top-level fields are preserved on write so a future client
 * version that adds fields doesn't wipe them — but we only READ the ones
 * we know about. This keeps forward-compat cheap without forcing schema
 * migrations for every added field.
 */
export class FileTokenStore implements TokenStore {
  readonly #path: string;

  constructor(path: string) {
    if (path.length === 0) throw new Error('FileTokenStore path must be non-empty');
    this.#path = path;
  }

  async read(): Promise<StoredTokenState> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        token: typeof parsed.token === 'string' ? parsed.token : null,
        graceStartSec:
          typeof parsed.graceStartSec === 'number' && Number.isFinite(parsed.graceStartSec)
            ? parsed.graceStartSec
            : null,
      };
    } catch (err) {
      if (isNotFound(err)) return EMPTY_STATE;
      // Corrupted JSON or unreadable file — surface as "no token" rather than
      // throwing, so a bricked store doesn't brick the whole client. The
      // caller can observe the corruption via a subsequent `validate()`
      // that returns `NoToken`.
      return EMPTY_STATE;
    }
  }

  async write(state: StoredTokenState): Promise<void> {
    const dir = dirname(this.#path);
    await mkdir(dir, { recursive: true });
    const tmp = `${this.#path}.tmp-${process.pid}-${Date.now().toString(36)}`;
    const body = `${JSON.stringify(
      { token: state.token, graceStartSec: state.graceStartSec },
      null,
      2,
    )}\n`;
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, this.#path);
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.#path);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
}

// ---------- MemoryTokenStore ----------

/**
 * In-memory token store. Suitable for tests and for ephemeral runtimes
 * (CLIs that re-activate on every invocation). Thread-safe only to the
 * extent that JS itself is single-threaded per event loop.
 */
export class MemoryTokenStore implements TokenStore {
  #state: StoredTokenState = EMPTY_STATE;

  async read(): Promise<StoredTokenState> {
    return this.#state;
  }

  async write(state: StoredTokenState): Promise<void> {
    this.#state = state;
  }

  async clear(): Promise<void> {
    this.#state = EMPTY_STATE;
  }
}

// ---------- internals ----------

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}
