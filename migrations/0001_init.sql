-- Core schema: tickets, their validated triage results, the result cache and usage log.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Enums rather than text + CHECK: the allowed values are fixed by the spec, and the
-- database should reject an out-of-range category even if a bug slips past validation.
CREATE TYPE ticket_status AS ENUM (
  'pending',       -- waiting to be picked up (now, or after a backoff delay)
  'processing',    -- claimed by a worker
  'triaged',       -- validated result stored
  'needs_review',  -- model could not produce valid output; a human must triage
  'failed'         -- infrastructure failure, retries exhausted
);

CREATE TYPE triage_category AS ENUM ('billing', 'technical', 'account', 'feedback', 'other');
CREATE TYPE triage_priority AS ENUM ('low', 'medium', 'high', 'urgent');

CREATE TABLE tickets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject          text NOT NULL,
  body             text NOT NULL,
  customer_email   text NOT NULL,
  status           ticket_status NOT NULL DEFAULT 'pending',

  -- Queue bookkeeping. Postgres is the queue; these columns are the queue state.
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  locked_at        timestamptz,
  locked_by        text,
  last_error       text,

  content_hash     text NOT NULL, -- sha256 of normalised subject+body
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- The worker's claim query: "oldest due work first". Partial index keeps it small -
-- it only ever contains the backlog, not the millions of tickets already triaged.
CREATE INDEX tickets_due_idx
  ON tickets (next_attempt_at, id)
  WHERE status = 'pending';

-- Lets the worker find tickets abandoned by a crashed peer.
CREATE INDEX tickets_stale_lock_idx
  ON tickets (locked_at)
  WHERE status = 'processing';

-- Listing endpoint: filter by status, newest first.
CREATE INDEX tickets_status_created_idx ON tickets (status, created_at DESC, id DESC);
CREATE INDEX tickets_created_idx ON tickets (created_at DESC, id DESC);
CREATE INDEX tickets_customer_idx ON tickets (lower(customer_email), created_at DESC);
CREATE INDEX tickets_content_hash_idx ON tickets (content_hash);

-- One validated result per ticket. A row here exists only if it passed validation.
CREATE TABLE triage_results (
  ticket_id            uuid PRIMARY KEY REFERENCES tickets (id) ON DELETE CASCADE,
  category             triage_category NOT NULL,
  priority             triage_priority NOT NULL,
  summary              text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 200),
  suggested_reply      text CHECK (suggested_reply IS NULL OR char_length(suggested_reply) <= 600),
  injection_suspected  boolean NOT NULL DEFAULT false,
  provider             text NOT NULL,
  model                text NOT NULL,
  prompt_version       text NOT NULL,
  from_cache           boolean NOT NULL DEFAULT false,
  model_attempts       integer NOT NULL DEFAULT 1,
  latency_ms           integer,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX triage_results_category_priority_idx ON triage_results (category, priority);
CREATE INDEX triage_results_priority_idx ON triage_results (priority);

-- Result cache. The key already encodes provider + model + prompt fingerprint, so a
-- prompt or model change produces a different key instead of a stale hit.
CREATE TABLE triage_cache (
  cache_key            text PRIMARY KEY,
  category             triage_category NOT NULL,
  priority             triage_priority NOT NULL,
  summary              text NOT NULL,
  suggested_reply      text,
  injection_suspected  boolean NOT NULL DEFAULT false,
  provider             text NOT NULL,
  model                text NOT NULL,
  prompt_version       text NOT NULL,
  hits                 integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_hit_at          timestamptz
);

CREATE INDEX triage_cache_created_idx ON triage_cache (created_at);

-- One row per model call, including the ones that failed. This is the usage ledger.
CREATE TABLE llm_calls (
  id             bigserial PRIMARY KEY,
  ticket_id      uuid REFERENCES tickets (id) ON DELETE SET NULL,
  kind           text NOT NULL DEFAULT 'triage',
  provider       text NOT NULL,
  model          text NOT NULL,
  prompt_version text,
  outcome        text NOT NULL, -- success | invalid_output | transient_error | permanent_error | cache_hit
  error_kind     text,
  input_tokens   integer NOT NULL DEFAULT 0,
  output_tokens  integer NOT NULL DEFAULT 0,
  latency_ms     integer,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX llm_calls_created_idx ON llm_calls (created_at DESC);
CREATE INDEX llm_calls_ticket_idx ON llm_calls (ticket_id);

-- Daily rollup for the usage endpoint. A view is fine at this size; at scale this
-- becomes a materialised view or a nightly aggregate table (see README).
CREATE VIEW llm_usage_daily AS
SELECT
  (created_at AT TIME ZONE 'UTC')::date AS day,
  provider,
  model,
  kind,
  count(*)                                              AS calls,
  count(*) FILTER (WHERE outcome = 'success')           AS successful_calls,
  count(*) FILTER (WHERE outcome = 'invalid_output')    AS invalid_output_calls,
  count(*) FILTER (WHERE outcome LIKE '%_error')        AS failed_calls,
  count(*) FILTER (WHERE outcome = 'cache_hit')         AS cache_hits,
  coalesce(sum(input_tokens), 0)                        AS input_tokens,
  coalesce(sum(output_tokens), 0)                       AS output_tokens,
  coalesce(sum(input_tokens + output_tokens), 0)        AS total_tokens
FROM llm_calls
GROUP BY 1, 2, 3, 4;
