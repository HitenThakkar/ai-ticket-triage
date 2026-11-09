import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from './pool.js';
import { logger } from '../lib/logger.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

const ADVISORY_LOCK_KEY = 827_361_544; // arbitrary but fixed: one migrator at a time

/**
 * A tiny forward-only migration runner.
 *
 * Why not a library: the requirement is "a clear and repeatable way to set the schema
 * up". Plain .sql files applied in filename order, each in its own transaction, tracked
 * in schema_migrations, is the most readable version of that - and it means the schema
 * is reviewable as SQL rather than as someone's DSL.
 *
 * A session-level advisory lock makes it safe for several app instances to boot at once:
 * the first one migrates, the rest wait and then find nothing to do.
 */
export async function runMigrations({ log = logger } = {}) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await client.query('SELECT name, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));

    const results = [];

    for (const name of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
      const checksum = await sha256Hex(sql);

      if (applied.has(name)) {
        if (applied.get(name) !== checksum) {
          throw new Error(
            `Migration ${name} has changed since it was applied. ` +
              'Applied migrations are immutable - add a new migration instead.',
          );
        }
        results.push({ name, status: 'already-applied' });
        continue;
      }

      log.info('Applying migration', { migration: name });

      // Each migration is atomic: it either applies completely or not at all.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          name,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${name} failed: ${err.message}`, { cause: err });
      }

      results.push({ name, status: 'applied' });
    }

    return results;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

export async function migrationStatus() {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await getPool()
    .query('SELECT name, applied_at FROM schema_migrations ORDER BY name')
    .catch(() => ({ rows: [] }));
  const applied = new Map(rows.map((r) => [r.name, r.applied_at]));
  return files.map((name) => ({
    name,
    applied: applied.has(name),
    appliedAt: applied.get(name) ?? null,
  }));
}

async function sha256Hex(value) {
  const { createHash } = await import('node:crypto');
  // Normalise line endings so a git checkout on Windows does not look like a changed
  // migration to a container that checked out on Linux.
  return createHash('sha256').update(value.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}
