import { InvalidModelOutputError } from '../llm/errors.js';
import { SYSTEM_PROMPT, buildUserPrompt, looksLikeInjection } from '../llm/prompt.js';
import { parseTriageOutput } from './schema.js';

/**
 * One triage attempt against the model, including the validate-and-retry loop.
 *
 * This function is deliberately free of database access, so the retry/validation rules
 * can be unit-tested against a stub provider with no Postgres anywhere in sight. It has
 * exactly three outcomes:
 *
 *   - returns a validated result                -> the worker may store it
 *   - throws InvalidModelOutputError            -> the model would not produce valid
 *                                                  output; the ticket needs a human
 *   - throws Transient/PermanentLLMError        -> an infrastructure problem; the
 *                                                  worker decides whether to requeue
 *
 * Invalid output is never returned, so the caller cannot accidentally persist it.
 */
export async function runTriage({
  provider,
  ticket,
  validationAttempts = 3,
  timeoutMs = 20_000,
  onCall = () => {},
  logger,
}) {
  const issuesByAttempt = [];
  let lastRaw;

  for (let attempt = 1; attempt <= validationAttempts; attempt += 1) {
    const user = buildUserPrompt(ticket, {
      // Echo back only our own validator's complaints - never the model's previous
      // output, which could carry injected text back into the instruction channel.
      repairHints: issuesByAttempt.at(-1),
    });

    const startedAt = Date.now();
    const signal = AbortSignal.timeout(timeoutMs);

    let response;
    try {
      response = await provider.triage({ system: SYSTEM_PROMPT, user, ticket, signal });
    } catch (err) {
      // Infrastructure failure: does not consume the validation budget. The worker
      // will requeue the whole ticket with backoff.
      await onCall({
        outcome: classifyErrorOutcome(err),
        errorKind: err?.kind ?? err?.name,
        latencyMs: Date.now() - startedAt,
        usage: null,
        attempt,
      });
      throw err;
    }

    const latencyMs = Date.now() - startedAt;
    lastRaw = response.raw;
    const parsed = parseTriageOutput(response.raw);

    if (parsed.ok) {
      await onCall({ outcome: 'success', latencyMs, usage: response.usage, attempt });
      return {
        result: {
          ...parsed.value,
          // Union of the model's own judgement and a cheap local heuristic. Either
          // one firing is enough to flag the ticket for a human to glance at.
          injection_suspected:
            parsed.value.injection_suspected ||
            looksLikeInjection(`${ticket.subject}\n${ticket.body}`),
        },
        model: response.model ?? provider.model,
        provider: provider.name,
        usage: response.usage ?? null,
        latencyMs,
        attempts: attempt,
      };
    }

    issuesByAttempt.push(parsed.issues);
    await onCall({
      outcome: 'invalid_output',
      errorKind: 'schema_violation',
      latencyMs,
      usage: response.usage,
      attempt,
    });
    logger?.warn('Model returned invalid triage output', {
      ticketId: ticket.id,
      attempt,
      issues: parsed.issues,
    });
  }

  throw new InvalidModelOutputError(
    `Model produced invalid triage output ${validationAttempts} time(s)`,
    { issues: issuesByAttempt.flat(), raw: lastRaw },
  );
}

function classifyErrorOutcome(err) {
  if (err?.name === 'TransientLLMError') return 'transient_error';
  if (err?.name === 'PermanentLLMError') return 'permanent_error';
  return 'error';
}
