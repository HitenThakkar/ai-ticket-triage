-- The daily usage view counted cache hits inside `calls`, which overstates how many
-- times we actually paid the provider: a cache hit is recorded in the same ledger
-- (deliberately - that is how the saving becomes visible) but it is not a model call.
--
-- `calls` now means "requests that reached the provider". Cache hits keep their own
-- column, so the two numbers together still account for every triage.

CREATE OR REPLACE VIEW llm_usage_daily AS
SELECT
  (created_at AT TIME ZONE 'UTC')::date AS day,
  provider,
  model,
  kind,
  count(*) FILTER (WHERE outcome <> 'cache_hit')        AS calls,
  count(*) FILTER (WHERE outcome = 'success')           AS successful_calls,
  count(*) FILTER (WHERE outcome = 'invalid_output')    AS invalid_output_calls,
  count(*) FILTER (WHERE outcome LIKE '%\_error')       AS failed_calls,
  count(*) FILTER (WHERE outcome = 'cache_hit')         AS cache_hits,
  coalesce(sum(input_tokens), 0)                        AS input_tokens,
  coalesce(sum(output_tokens), 0)                       AS output_tokens,
  coalesce(sum(input_tokens + output_tokens), 0)        AS total_tokens
FROM llm_calls
GROUP BY 1, 2, 3, 4;
