import config from '../config.js';
import * as repo from '../db/tickets.repo.js';
import { backoffMs } from '../lib/backoff.js';
import { truncate } from '../lib/text.js';
import { InvalidModelOutputError, PermanentLLMError } from '../llm/errors.js';
import { PROMPT_FINGERPRINT, looksLikeInjection } from '../llm/prompt.js';
import { buildCacheKey } from './cacheKey.js';
import { detectDuplicates } from './duplicates.js';
import { runTriage } from './triager.js';

const MAX_STORED_ERROR_CHARS = 500;

/**
 * Process exactly one claimed ticket and leave it in a terminal-for-now state.
 *
 * The ticket arrives already claimed (status `processing`, attempts incremented) and
 * leaves as one of:
 *
 *   triaged       - a validated result is stored
 *   pending       - transient failure, retry scheduled with backoff
 *   needs_review  - the model could not produce valid output (or refused)
 *   failed        - infrastructure failure, retry budget exhausted
 *
 * This function does not throw for expected failures; it records them. The worker
 * only has to deal with genuinely unexpected errors.
 */
export async function processTicket(ticket, { provider, embedder, logger, settings = {} } = {}) {
  const log = logger?.child?.({ ticketId: ticket.id }) ?? logger;
  const opts = {
    validationAttempts: config.triage.validationAttempts,
    cacheEnabled: config.triage.cacheEnabled,
    maxAttempts: config.worker.maxAttempts,
    backoffBaseMs: config.worker.backoffBaseMs,
    backoffMaxMs: config.worker.backoffMaxMs,
    timeoutMs: config.llm.timeoutMs,
    duplicates: config.duplicates,
    ...settings,
  };

  const cacheKey = buildCacheKey({
    subject: ticket.subject,
    body: ticket.body,
    provider: provider.name,
    model: provider.model,
    promptFingerprint: PROMPT_FINGERPRINT,
  });

  // Duplicate detection is independent of triage and must never break it.
  if (opts.duplicates?.enabled && embedder) {
    await detectDuplicates({
      ticket,
      embedder,
      threshold: opts.duplicates.threshold,
      candidateLimit: opts.duplicates.candidateLimit,
      logger: log,
    });
  }

  // ---------------------------------------------------------------- cache
  if (opts.cacheEnabled) {
    const cached = await repo.getCachedTriage(cacheKey);
    if (cached) {
      await repo.completeTriage({
        ticketId: ticket.id,
        // The cached entry holds the model's own judgement. The local heuristic is
        // free and may have been tightened since the entry was written, so it is
        // re-applied here rather than frozen into the cache.
        result: {
          ...cached,
          injection_suspected:
            cached.injection_suspected ||
            looksLikeInjection(`${ticket.subject}
${ticket.body}`),
        },
        provider: cached.provider,
        model: cached.model,
        promptVersion: cached.prompt_version,
        fromCache: true,
        modelAttempts: 0,
        latencyMs: 0,
        cacheKey,
        cacheEnabled: opts.cacheEnabled,
      });
      await repo.recordLlmCall({
        ticketId: ticket.id,
        provider: provider.name,
        model: provider.model,
        promptVersion: PROMPT_FINGERPRINT,
        outcome: 'cache_hit',
        latencyMs: 0,
      });
      log?.info('Triage served from cache', { cacheKey });
      return { outcome: 'cached', status: 'triaged' };
    }
  }

  // ---------------------------------------------------------------- model
  try {
    const triage = await runTriage({
      provider,
      ticket,
      validationAttempts: opts.validationAttempts,
      timeoutMs: opts.timeoutMs,
      logger: log,
      onCall: (call) =>
        repo
          .recordLlmCall({
            ticketId: ticket.id,
            provider: provider.name,
            model: provider.model,
            promptVersion: PROMPT_FINGERPRINT,
            outcome: call.outcome,
            errorKind: call.errorKind,
            inputTokens: call.usage?.inputTokens ?? 0,
            outputTokens: call.usage?.outputTokens ?? 0,
            latencyMs: call.latencyMs,
          })
          .catch((err) => log?.warn('Failed to record usage', { err })),
    });

    await repo.completeTriage({
      ticketId: ticket.id,
      result: triage.result,
      provider: triage.provider,
      model: triage.model,
      promptVersion: PROMPT_FINGERPRINT,
      fromCache: false,
      modelAttempts: triage.attempts,
      latencyMs: triage.latencyMs,
      cacheKey,
      cacheEnabled: opts.cacheEnabled,
    });

    log?.info('Ticket triaged', {
      category: triage.result.category,
      priority: triage.result.priority,
      modelAttempts: triage.attempts,
      latencyMs: triage.latencyMs,
    });

    return { outcome: 'triaged', status: 'triaged', result: triage.result };
  } catch (err) {
    return handleFailure({ ticket, err, opts, log });
  }
}

async function handleFailure({ ticket, err, opts, log }) {
  // The model answered, repeatedly, with something we refuse to store. Retrying the
  // same prompt against the same text is unlikely to help, so a human takes it.
  if (err instanceof InvalidModelOutputError) {
    await repo.markTerminal({
      ticketId: ticket.id,
      status: 'needs_review',
      error: truncate(`invalid_model_output: ${err.issues.join('; ')}`, MAX_STORED_ERROR_CHARS),
    });
    log?.warn('Ticket marked for manual review', { issues: err.issues });
    return { outcome: 'needs_review', status: 'needs_review' };
  }

  if (err instanceof PermanentLLMError) {
    // A refusal is specific to this ticket's content - a human should look at it.
    // Anything else (bad key, bad model id, malformed request) is an operator problem:
    // retrying will not fix it, so fail loudly and let /retry requeue after the fix.
    const status = err.kind === 'refusal' ? 'needs_review' : 'failed';
    await repo.markTerminal({
      ticketId: ticket.id,
      status,
      error: truncate(`${err.kind}: ${err.message}`, MAX_STORED_ERROR_CHARS),
    });
    log?.error('Permanent provider failure', { kind: err.kind, err });
    return { outcome: status, status };
  }

  // Everything else - timeouts, 429s, 5xx, dropped connections, and any unexpected
  // error - is treated as transient. Losing a ticket is the worst outcome available.
  const attempts = ticket.attempts;
  const kind = err?.kind ?? 'unknown';

  if (attempts >= opts.maxAttempts) {
    await repo.markTerminal({
      ticketId: ticket.id,
      status: 'failed',
      error: truncate(
        `${kind}: ${err?.message ?? err} (gave up after ${attempts} attempts)`,
        MAX_STORED_ERROR_CHARS,
      ),
    });
    log?.error('Retry budget exhausted', { attempts, kind, err });
    return { outcome: 'failed', status: 'failed' };
  }

  const delayMs = Math.max(
    err?.retryAfterMs ?? 0,
    backoffMs(attempts, { baseMs: opts.backoffBaseMs, maxMs: opts.backoffMaxMs }),
  );

  await repo.scheduleRetry({
    ticketId: ticket.id,
    delayMs,
    error: truncate(`${kind}: ${err?.message ?? err}`, MAX_STORED_ERROR_CHARS),
  });

  log?.warn('Transient failure, retry scheduled', { attempts, kind, delayMs, err });
  return { outcome: 'retry_scheduled', status: 'pending', delayMs };
}
