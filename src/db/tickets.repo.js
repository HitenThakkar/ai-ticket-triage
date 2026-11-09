import { getPool, query, withTransaction } from './pool.js';

/**
 * Every statement the application runs lives in this file.
 *
 * Keeping SQL in one module (rather than scattered through route handlers) makes the
 * data access auditable: you can read the whole storage contract in one sitting, and
 * there is exactly one place to look when an index needs to change.
 */

export const TICKET_COLUMNS = `
  t.id, t.subject, t.body, t.customer_email, t.status, t.attempts,
  t.next_attempt_at, t.locked_at, t.locked_by, t.last_error,
  t.content_hash, t.created_at, t.updated_at
`;

const RESULT_COLUMNS = `
  r.category, r.priority, r.summary, r.suggested_reply, r.injection_suspected,
  r.provider, r.model, r.prompt_version, r.from_cache, r.model_attempts,
  r.latency_ms AS result_latency_ms, r.created_at AS triaged_at
`;

export const NEW_TICKET_CHANNEL = 'tickets_new';

/* ------------------------------------------------------------------ writes */

export async function insertTicket({ subject, body, customerEmail, contentHash }) {
  const { rows } = await query(
    `INSERT INTO tickets (subject, body, customer_email, content_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING id, status, created_at`,
    [subject, body, customerEmail, contentHash],
  );

  // Wake an idle worker immediately instead of waiting for its next poll. Best effort:
  // if it fails, the poll loop still picks the ticket up.
  await query('SELECT pg_notify($1, $2)', [NEW_TICKET_CHANNEL, rows[0].id]).catch(() => {});

  return rows[0];
}

/**
 * Atomically claim up to `limit` tickets for this worker.
 *
 * This single statement is what stops two workers triaging the same ticket:
 *
 *   FOR UPDATE SKIP LOCKED - concurrent claimers never select the same rows; a row
 *                            locked by another transaction is skipped, not waited on.
 *   status -> 'processing' - once committed, the ticket is no longer `pending`, so it
 *                            will not be selected again even after the lock is gone.
 *   attempts + 1 at claim  - a worker that crashes mid-call still burns an attempt, so
 *                            a poison ticket cannot loop forever.
 *
 * Tickets stuck in `processing` past the stale-lock window are reclaimed here too,
 * which is how work survives a worker being killed.
 */
export async function claimTickets({ workerId, limit, staleLockMs }) {
  const { rows } = await query(
    `WITH due AS (
       SELECT id
       FROM tickets
       WHERE (status = 'pending' AND next_attempt_at <= now())
          OR (status = 'processing' AND locked_at < now() - make_interval(secs => $3::double precision))
       ORDER BY next_attempt_at ASC, id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $2
     )
     UPDATE tickets t
     SET status = 'processing',
         locked_at = now(),
         locked_by = $1,
         attempts = t.attempts + 1,
         updated_at = now()
     FROM due
     WHERE t.id = due.id
     RETURNING ${TICKET_COLUMNS}`,
    [workerId, limit, staleLockMs / 1000],
  );
  return rows;
}

/**
 * Store a validated result and mark the ticket triaged - in one transaction, so a
 * ticket is never `triaged` without a result row, and never has a result row while
 * still queued.
 */
export async function completeTriage({
  ticketId,
  result,
  provider,
  model,
  promptVersion,
  fromCache,
  modelAttempts,
  latencyMs,
  cacheKey,
  cacheEnabled,
}) {
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO triage_results (
         ticket_id, category, priority, summary, suggested_reply, injection_suspected,
         provider, model, prompt_version, from_cache, model_attempts, latency_ms
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (ticket_id) DO UPDATE SET
         category = EXCLUDED.category,
         priority = EXCLUDED.priority,
         summary = EXCLUDED.summary,
         suggested_reply = EXCLUDED.suggested_reply,
         injection_suspected = EXCLUDED.injection_suspected,
         provider = EXCLUDED.provider,
         model = EXCLUDED.model,
         prompt_version = EXCLUDED.prompt_version,
         from_cache = EXCLUDED.from_cache,
         model_attempts = EXCLUDED.model_attempts,
         latency_ms = EXCLUDED.latency_ms,
         updated_at = now()`,
      [
        ticketId,
        result.category,
        result.priority,
        result.summary,
        result.suggested_reply ?? null,
        result.injection_suspected ?? false,
        provider,
        model,
        promptVersion,
        fromCache,
        modelAttempts,
        latencyMs ?? null,
      ],
    );

    await client.query(
      `UPDATE tickets
       SET status = 'triaged', locked_at = NULL, locked_by = NULL,
           last_error = NULL, updated_at = now()
       WHERE id = $1`,
      [ticketId],
    );

    if (cacheEnabled && cacheKey && !fromCache) {
      await client.query(
        `INSERT INTO triage_cache (
           cache_key, category, priority, summary, suggested_reply,
           injection_suspected, provider, model, prompt_version
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (cache_key) DO NOTHING`,
        [
          cacheKey,
          result.category,
          result.priority,
          result.summary,
          result.suggested_reply ?? null,
          result.injection_suspected ?? false,
          provider,
          model,
          promptVersion,
        ],
      );
    }
  });
}

/** Put the ticket back on the queue after a transient failure. */
export async function scheduleRetry({ ticketId, delayMs, error }) {
  const { rows } = await query(
    `UPDATE tickets
     SET status = 'pending',
         next_attempt_at = now() + make_interval(secs => $2::double precision),
         locked_at = NULL,
         locked_by = NULL,
         last_error = $3,
         updated_at = now()
     WHERE id = $1
     RETURNING id, status, attempts, next_attempt_at`,
    [ticketId, delayMs / 1000, error ?? null],
  );
  return rows[0] ?? null;
}

/** Terminal states: `needs_review` (model output unusable) and `failed` (infra). */
export async function markTerminal({ ticketId, status, error }) {
  const { rows } = await query(
    `UPDATE tickets
     SET status = $2::ticket_status,
         locked_at = NULL,
         locked_by = NULL,
         last_error = $3,
         updated_at = now()
     WHERE id = $1
     RETURNING id, status, attempts`,
    [ticketId, status, error ?? null],
  );
  return rows[0] ?? null;
}

/** Hand a stuck/terminal ticket back to the queue (used by the retry endpoint and on shutdown). */
export async function requeueTicket({ ticketId, resetAttempts = false, fromStatuses }) {
  const conditions = fromStatuses?.length ? 'AND status = ANY($2::ticket_status[])' : '';
  const params = fromStatuses?.length ? [ticketId, fromStatuses] : [ticketId];

  const { rows } = await query(
    `UPDATE tickets
     SET status = 'pending',
         next_attempt_at = now(),
         locked_at = NULL,
         locked_by = NULL,
         attempts = ${resetAttempts ? '0' : 'attempts'},
         updated_at = now()
     WHERE id = $1 ${conditions}
     RETURNING id, status, attempts, next_attempt_at`,
    params,
  );
  return rows[0] ?? null;
}

/** Release anything this worker still holds, so a restart does not wait for the stale-lock timeout. */
export async function releaseWorkerLocks(workerId) {
  const { rowCount } = await query(
    `UPDATE tickets
     SET status = 'pending', locked_at = NULL, locked_by = NULL, updated_at = now()
     WHERE status = 'processing' AND locked_by = $1`,
    [workerId],
  );
  return rowCount;
}

/* ------------------------------------------------------------------- reads */

export async function getTicketById(id) {
  const { rows } = await query(
    `SELECT ${TICKET_COLUMNS}, ${RESULT_COLUMNS}
     FROM tickets t
     LEFT JOIN triage_results r ON r.ticket_id = t.id
     WHERE t.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function getDuplicatesForTicket(id) {
  // A link is stored once, on whichever ticket was processed second. Reading it from
  // both directions means the support team sees the relationship from either ticket.
  const { rows } = await query(
    `SELECT duplicate_of AS ticket_id, similarity, detection_method, created_at
     FROM ticket_duplicates WHERE ticket_id = $1
     UNION
     SELECT ticket_id AS ticket_id, similarity, detection_method, created_at
     FROM ticket_duplicates WHERE duplicate_of = $1
     ORDER BY similarity DESC`,
    [id],
  );
  return rows;
}

export async function listTickets({
  status,
  category,
  priority,
  customerEmail,
  limit,
  offset,
  order = 'desc',
}) {
  const where = [];
  const params = [];

  const add = (clause, value) => {
    params.push(value);
    where.push(clause.replace('$?', `$${params.length}`));
  };

  if (status) add('t.status = $?::ticket_status', status);
  if (category) add('r.category = $?::triage_category', category);
  if (priority) add('r.priority = $?::triage_priority', priority);
  if (customerEmail) add('lower(t.customer_email) = lower($?)', customerEmail);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const direction = order === 'asc' ? 'ASC' : 'DESC';

  const dataParams = [...params, limit, offset];
  const dataSql = `
    SELECT ${TICKET_COLUMNS}, ${RESULT_COLUMNS}
    FROM tickets t
    LEFT JOIN triage_results r ON r.ticket_id = t.id
    ${whereSql}
    ORDER BY t.created_at ${direction}, t.id ${direction}
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `;

  const countSql = `
    SELECT count(*)::bigint AS total
    FROM tickets t
    LEFT JOIN triage_results r ON r.ticket_id = t.id
    ${whereSql}
  `;

  const [data, count] = await Promise.all([
    query(dataSql, dataParams),
    query(countSql, params),
  ]);

  return { rows: data.rows, total: Number(count.rows[0].total) };
}

export async function countByStatus() {
  const { rows } = await query(
    'SELECT status, count(*)::bigint AS count FROM tickets GROUP BY status',
  );
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
}

/* ------------------------------------------------------------------- cache */

export async function getCachedTriage(cacheKey) {
  const { rows } = await query(
    `UPDATE triage_cache
     SET hits = hits + 1, last_hit_at = now()
     WHERE cache_key = $1
     RETURNING category, priority, summary, suggested_reply, injection_suspected,
               provider, model, prompt_version, hits`,
    [cacheKey],
  );
  return rows[0] ?? null;
}

export async function cacheStats() {
  const { rows } = await query(
    `SELECT count(*)::bigint AS entries, coalesce(sum(hits), 0)::bigint AS hits FROM triage_cache`,
  );
  return { entries: Number(rows[0].entries), hits: Number(rows[0].hits) };
}

/* ------------------------------------------------------------------- usage */

export async function recordLlmCall({
  ticketId,
  kind = 'triage',
  provider,
  model,
  promptVersion,
  outcome,
  errorKind,
  inputTokens = 0,
  outputTokens = 0,
  latencyMs,
}) {
  await query(
    `INSERT INTO llm_calls (
       ticket_id, kind, provider, model, prompt_version, outcome, error_kind,
       input_tokens, output_tokens, latency_ms
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      ticketId ?? null,
      kind,
      provider,
      model,
      promptVersion ?? null,
      outcome,
      errorKind ?? null,
      inputTokens,
      outputTokens,
      latencyMs ?? null,
    ],
  );
}

export async function getUsageByTicket(ticketId) {
  // `calls` counts requests that actually reached the provider. A cache hit is in the
  // same ledger - that is how the saving stays visible - but it is not a model call.
  const { rows } = await query(
    `SELECT count(*) FILTER (WHERE outcome <> 'cache_hit')::bigint AS calls,
            count(*) FILTER (WHERE outcome = 'cache_hit')::bigint  AS cache_hits,
            coalesce(sum(input_tokens), 0)::bigint AS input_tokens,
            coalesce(sum(output_tokens), 0)::bigint AS output_tokens
     FROM llm_calls WHERE ticket_id = $1`,
    [ticketId],
  );
  const row = rows[0];
  return {
    calls: Number(row.calls),
    cache_hits: Number(row.cache_hits),
    input_tokens: Number(row.input_tokens),
    output_tokens: Number(row.output_tokens),
    total_tokens: Number(row.input_tokens) + Number(row.output_tokens),
  };
}

export async function getDailyUsage({ days = 7 } = {}) {
  const { rows } = await query(
    `SELECT * FROM llm_usage_daily
     WHERE day >= (now() AT TIME ZONE 'UTC')::date - ($1::integer - 1)
     ORDER BY day DESC, provider, model, kind`,
    [days],
  );
  return rows;
}

/* -------------------------------------------------------------- duplicates */

export async function saveEmbedding({ ticketId, model, vector }) {
  await query(
    `INSERT INTO ticket_embeddings (ticket_id, model, dimensions, vector)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (ticket_id) DO UPDATE
       SET model = EXCLUDED.model, dimensions = EXCLUDED.dimensions, vector = EXCLUDED.vector`,
    [ticketId, model, vector.length, vector],
  );
}

/**
 * Candidate set for duplicate detection: recent, still-open tickets from the same
 * customer, embedded with the same model. Scoping to one customer keeps this an index
 * lookup over a handful of rows rather than a similarity search over the whole table.
 */
export async function findDuplicateCandidates({ ticketId, customerEmail, model, limit }) {
  const { rows } = await query(
    `SELECT t.id, t.subject, t.content_hash, e.vector
     FROM tickets t
     JOIN ticket_embeddings e ON e.ticket_id = t.id
     WHERE lower(t.customer_email) = lower($1)
       AND t.id <> $2
       AND t.status <> 'failed'
       AND e.model = $3
     ORDER BY t.created_at DESC
     LIMIT $4`,
    [customerEmail, ticketId, model, limit],
  );
  return rows;
}

export async function linkDuplicate({ ticketId, duplicateOf, similarity, method }) {
  await query(
    `INSERT INTO ticket_duplicates (ticket_id, duplicate_of, similarity, detection_method)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (ticket_id, duplicate_of) DO NOTHING`,
    [ticketId, duplicateOf, similarity, method],
  );
}

/* ------------------------------------------------------------------ listen */

/** Dedicated connection for LISTEN - it must not be returned to the pool. */
export async function createNotificationListener({ channel = NEW_TICKET_CHANNEL, onNotify, onError }) {
  // LISTEN cannot take a bind parameter, so the channel name is whitelisted instead
  // of interpolated blindly.
  if (!/^[a-z_][a-z0-9_]*$/.test(channel)) {
    throw new Error(`Invalid notification channel name: ${channel}`);
  }

  const client = await getPool().connect();
  client.on('notification', (msg) => onNotify?.(msg));
  client.on('error', (err) => onError?.(err));
  await client.query(`LISTEN ${channel}`);

  return {
    async close() {
      try {
        await client.query(`UNLISTEN ${channel}`);
      } catch {
        // connection already gone; releasing is enough
      }
      client.release();
    },
  };
}
