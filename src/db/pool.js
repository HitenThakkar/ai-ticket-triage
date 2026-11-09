import pg from 'pg';
import config from '../config.js';
import { logger } from '../lib/logger.js';

const { Pool, types } = pg;

// Return BIGINT/NUMERIC counts as JS numbers. Safe here: these are row counts and
// token totals, nowhere near 2^53.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

// Keep DATE as 'YYYY-MM-DD'. The default parser builds a JS Date at local midnight,
// which turns a UTC usage day into the previous day for anyone east of Greenwich.
types.setTypeParser(1082, (v) => v);

let pool;

export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: config.db.url,
      max: config.db.poolMax,
      application_name: `ticket-triage-${config.role}`,
      // Keeps a wedged query from pinning a pool connection forever.
      statement_timeout: config.db.statementTimeoutMs,
      idle_in_transaction_session_timeout: config.db.statementTimeoutMs,
    });

    pool.on('error', (err) => {
      // Idle client blew up (e.g. the database restarted). pg will reconnect; we log
      // rather than let an unhandled 'error' event take the process down.
      logger.error('Idle database client error', { err });
    });
  }
  return pool;
}

export async function query(text, params) {
  return getPool().query(text, params);
}

/** Run a function inside a transaction, with rollback on any throw. */
export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error('Rollback failed', { err: rollbackErr });
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function checkDatabase() {
  const started = Date.now();
  await query('SELECT 1');
  return { ok: true, latencyMs: Date.now() - started };
}

export async function closePool() {
  if (pool) {
    const current = pool;
    pool = undefined;
    await current.end();
  }
}
