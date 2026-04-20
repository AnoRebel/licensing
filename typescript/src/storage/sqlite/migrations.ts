/**
 * Idempotent migration runner for SQLite.
 *
 * Design:
 *   - Migration files live in `../migrations/NNNN_description.sql`, ordered
 *     lexicographically by filename.
 *   - Every migration is wrapped in `BEGIN; … COMMIT;` so a partial apply
 *     never leaves the DB wedged.
 *   - A `_licensing_migrations` table records applied filenames; a migration
 *     already present there is skipped. Combined with `IF NOT EXISTS` inside
 *     every migration's DDL, this satisfies the idempotence requirement.
 *
 * Usage:
 *   import { Database } from 'bun:sqlite';
 *   import { applyMigrations } from '@licensing/sdk/storage/sqlite/migrations';
 *   const db = new Database('licensing.db');
 *   db.run('PRAGMA journal_mode = WAL');
 *   db.run('PRAGMA foreign_keys = ON');
 *   applyMigrations(db);
 *
 * Keeping the runner separate from the adapter lets operators run migrations
 * from deploy scripts, smoke tests, or local dev without instantiating a
 * full `SqliteStorage`.
 */

import type { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// `src/storage/sqlite/` or `dist/storage/sqlite/` → `../../../migrations/sqlite/`.
// The `migrations/` directory is shipped at the package root via the `files`
// field in package.json.
const MIGRATIONS_DIR = join(HERE, '..', '..', '..', 'migrations', 'sqlite');

interface Migration {
  readonly name: string;
  readonly sql: string;
}

function loadMigrations(): readonly Migration[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return files.map((name) => ({
    name,
    sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8'),
  }));
}

function ensureMigrationsTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS _licensing_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
}

function isApplied(db: Database, name: string): boolean {
  const row = db.query('SELECT name FROM _licensing_migrations WHERE name = ?').get(name);
  return row !== null;
}

/** Apply all pending migrations. Returns the names of migrations applied this
 *  call (empty = nothing to do). */
export function applyMigrations(db: Database): readonly string[] {
  const migrations = loadMigrations();
  const applied: string[] = [];
  ensureMigrationsTable(db);
  for (const mig of migrations) {
    if (isApplied(db, mig.name)) continue;
    db.run('BEGIN');
    try {
      db.run(mig.sql);
      db.query('INSERT INTO _licensing_migrations (name) VALUES (?)').run(mig.name);
      db.run('COMMIT');
      applied.push(mig.name);
    } catch (err) {
      db.run('ROLLBACK');
      throw err;
    }
  }
  return applied;
}

/** List every migration discovered on disk, in order. Useful for operators
 *  auditing what would run. */
export function listMigrations(): readonly string[] {
  return loadMigrations().map((m) => m.name);
}
