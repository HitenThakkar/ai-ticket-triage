import { Router } from 'express';
import config from '../../config.js';
import * as repo from '../../db/tickets.repo.js';
import { checkDatabase } from '../../db/pool.js';
import { PROMPT_FINGERPRINT, PROMPT_VERSION } from '../../llm/prompt.js';
import { asyncHandler } from '../asyncHandler.js';
import { parseOrThrow, usageQuerySchema } from '../validation.js';

/** Liveness and readiness. Unauthenticated: orchestrators should not need a secret. */
export function healthRouter() {
  const router = Router();

  // Liveness: is the process up? Deliberately does not touch the database - a database
  // blip should not get the container killed and restarted.
  router.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', role: config.role, uptime_s: Math.round(process.uptime()) });
  });

  // Readiness: should this instance receive traffic?
  router.get(
    '/readyz',
    asyncHandler(async (_req, res) => {
      try {
        const db = await checkDatabase();
        res.json({ status: 'ready', database: { ok: true, latency_ms: db.latencyMs } });
      } catch (err) {
        res.status(503).json({
          status: 'not_ready',
          database: { ok: false, error: err.message },
        });
      }
    }),
  );

  return router;
}

/** Operational views: queue depth, cache effectiveness, model spend. */
export function usageRouter() {
  const router = Router();

  router.get(
    '/usage/daily',
    asyncHandler(async (req, res) => {
      const { days } = parseOrThrow(usageQuerySchema, req.query, 'query parameters');
      const rows = await repo.getDailyUsage({ days });
      res.json({
        days,
        data: rows.map((row) => ({
          day: row.day,
          provider: row.provider,
          model: row.model,
          kind: row.kind,
          calls: Number(row.calls),
          successful_calls: Number(row.successful_calls),
          invalid_output_calls: Number(row.invalid_output_calls),
          failed_calls: Number(row.failed_calls),
          cache_hits: Number(row.cache_hits),
          input_tokens: Number(row.input_tokens),
          output_tokens: Number(row.output_tokens),
          total_tokens: Number(row.total_tokens),
        })),
      });
    }),
  );

  router.get(
    '/stats',
    asyncHandler(async (_req, res) => {
      const [statuses, cache] = await Promise.all([repo.countByStatus(), repo.cacheStats()]);
      res.json({
        tickets_by_status: statuses,
        cache,
        triage: {
          provider: config.llm.provider,
          model: config.llm.provider === 'fake' ? 'fake-triage-v1' : config.llm.model,
          prompt_version: PROMPT_VERSION,
          prompt_fingerprint: PROMPT_FINGERPRINT,
          validation_attempts: config.triage.validationAttempts,
          cache_enabled: config.triage.cacheEnabled,
        },
        // Echo the settings this instance is actually running with. Configuration is
        // snapshotted at boot (so it cannot change under a ticket mid-flight), which
        // means an edited .env and a running process can silently disagree - this is
        // how you tell. Only tuning values: no secrets, no connection strings.
        worker: {
          role: config.role,
          enabled: config.worker.enabled,
          concurrency: config.worker.concurrency,
          batch_size: config.worker.batchSize,
          max_attempts: config.worker.maxAttempts,
          backoff_base_ms: config.worker.backoffBaseMs,
          backoff_max_ms: config.worker.backoffMaxMs,
          stale_lock_ms: config.worker.staleLockMs,
        },
      });
    }),
  );

  return router;
}
