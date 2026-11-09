/**
 * Integration-test harness.
 *
 * Imported before anything that reads configuration, because src/config.js snapshots
 * the environment at import time. Everything else is imported dynamically afterwards.
 *
 * Point it at a throwaway database:
 *   TEST_DATABASE_URL=postgres://triage:triage@localhost:5432/triage_test
 * It migrates that database itself and truncates between tests.
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://triage:triage@localhost:5432/triage_test';

// Deterministic, offline, instant.
process.env.LLM_PROVIDER = 'fake';
process.env.FAKE_LATENCY_MS = '0';
process.env.FAKE_FAILURE_RATE = '0';

// Auth on, so the tests exercise the real middleware path.
process.env.API_KEYS = 'test-key-1,test-key-2';
process.env.RATE_LIMIT_MAX = '1000';

// The worker is driven manually (runOnce) so tests are not timing-dependent.
process.env.WORKER_ENABLED = 'false';
process.env.WORKER_MAX_ATTEMPTS = '3';
process.env.WORKER_BACKOFF_BASE_MS = '1000';

export const API_KEY = 'test-key-1';

const { default: config } = await import('../../src/config.js');
const { createApp } = await import('../../src/api/app.js');
const { runMigrations } = await import('../../src/db/migrate.js');
const pool = await import('../../src/db/pool.js');
const repo = await import('../../src/db/tickets.repo.js');
const { Worker } = await import('../../src/worker/worker.js');
const { createFakeProvider } = await import('../../src/llm/fake.js');
const { createEmbeddingProvider } = await import('../../src/llm/embeddings.js');
const { processTicket } = await import('../../src/triage/service.js');

export { config, createApp, repo, pool, Worker, processTicket, createFakeProvider };

export async function databaseAvailable() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    await pool.closePool().catch(() => {});
    return false;
  }
}

export async function setupDatabase() {
  await runMigrations({ log: { info() {}, warn() {}, error() {} } });
}

export async function resetDatabase() {
  await pool.query(
    'TRUNCATE tickets, triage_cache, llm_calls, ticket_embeddings, ticket_duplicates RESTART IDENTITY CASCADE',
  );
}

export async function teardown() {
  await pool.closePool();
}

export function newWorker(overrides = {}) {
  return new Worker({
    provider: createFakeProvider({ latencyMs: 0 }),
    embedder: createEmbeddingProvider({ provider: 'hash' }),
    settings: { batchSize: 20, concurrency: 4, ...overrides },
  });
}

export async function insertTicket({ subject, body, customerEmail = 'customer@example.com' }) {
  const { normalizeTicketText, sha256 } = await import('../../src/lib/text.js');
  return repo.insertTicket({
    subject,
    body,
    customerEmail,
    contentHash: sha256(normalizeTicketText(subject, body)),
  });
}

export async function getTicketRow(id) {
  const { rows } = await pool.query(
    `SELECT t.*, r.category, r.priority, r.summary, r.from_cache, r.model_attempts
     FROM tickets t LEFT JOIN triage_results r ON r.ticket_id = t.id
     WHERE t.id = $1`,
    [id],
  );
  return rows[0];
}
