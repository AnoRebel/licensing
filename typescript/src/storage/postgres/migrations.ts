/**
 * Idempotent migration runner.
 *
 * Design:
 *   - Migration files live in `../migrations/NNNN_description.sql`, ordered
 *     lexicographically by filename.
 *   - Every migration is wrapped in a single Postgres transaction so a
 *     partial apply never leaves the DB wedged.
 *   - A `_licensing_migrations` table records applied filenames; a migration
 *     already present there is skipped. This — combined with `IF NOT EXISTS`
 *     inside every migration's DDL — gives us idempotence: running the full
 *     migration set twice is a no-op on the second pass.
 *
 * Usage:
 *   import { Pool } from 'pg';
 *   import { applyMigrations } from '@licensing/sdk/storage/postgres/migrations';
 *   const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 *   await applyMigrations(pool);
 *
 * Keeping the runner separate from the adapter lets operators run migrations
 * from deploy scripts, smoke tests, or local dev without instantiating a
 * full `PostgresStorage`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Pool, PoolClient } from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
// `src/storage/postgres/` or `dist/storage/postgres/` → `../../../migrations/postgres/`.
// The `migrations/` directory is shipped at the package root via the `files`
// field in package.json.
const MIGRATIONS_DIR = join(HERE, '..', '..', '..', 'migrations', 'postgres');

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

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _licensing_migrations (
      name       text         PRIMARY KEY,
      applied_at timestamptz  NOT NULL DEFAULT now()
    );
  `);
}

async function isApplied(client: PoolClient, name: string): Promise<boolean> {
  const res = await client.query<{ name: string }>(
    'SELECT name FROM _licensing_migrations WHERE name = $1',
    [name],
  );
  return res.rows.length > 0;
}

/** Apply all pending migrations. Returns the names of migrations that were
 *  applied this call (empty array = nothing to do). */
export async function applyMigrations(pool: Pool): Promise<readonly string[]> {
  const migrations = loadMigrations();
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    for (const mig of migrations) {
      if (await isApplied(client, mig.name)) continue;
      await client.query('BEGIN');
      try {
        await client.query(mig.sql);
        await client.query('INSERT INTO _licensing_migrations (name) VALUES ($1)', [mig.name]);
        await client.query('COMMIT');
        applied.push(mig.name);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    return applied;
  } finally {
    client.release();
  }
}

/** List every migration discovered on disk, in order. Useful for operators
 *  auditing what would run. */
export function listMigrations(): readonly string[] {
  return loadMigrations().map((m) => m.name);
}
