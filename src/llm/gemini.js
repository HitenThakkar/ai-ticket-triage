import { ApiError, GoogleGenAI } from '@google/genai';
import { OUTPUT_JSON_SCHEMA } from './prompt.js';
import { PermanentLLMError, TransientLLMError } from './errors.js';

/**
 * Real provider: Google Gemini, via the official `@google/genai` SDK.
 *
 * Uses the Interactions API (`ai.interactions.create`), which Google documents as
 * generally available and the recommended interface for new projects;
 * `models.generateContent` is still supported but is now the legacy path.
 *
 * Three deliberate choices:
 *
 * 1. `retries: { strategy: 'none' }` - the SDK can retry for us, but durable retry
 *    policy lives in the worker, which can persist state and back off across process
 *    restarts. Exactly one layer owns the slow path.
 * 2. `store: false` - tickets contain customer data, so the interaction is not
 *    retained server-side for later retrieval. We do not use `previous_interaction_id`
 *    (each triage is a single independent call), so there is nothing to give up.
 * 3. Structured output (`response_format`) is on by default, which makes malformed
 *    JSON rare. We still validate every response ourselves - and here that is not
 *    belt-and-braces: Gemini's schema support explicitly *ignores* `minLength` and
 *    `maxLength` (its own docs say to enforce those in your application), so the
 *    provider cannot guarantee the 200-character summary limit that our column does.
 */
export function createGeminiProvider({
  apiKey,
  model,
  maxOutputTokens = 1024,
  thinkingLevel,
  timeoutMs = 20_000,
  structuredOutput = true,
  client,
} = {}) {
  if (!client && !apiKey) {
    throw new Error('GEMINI_API_KEY is required when LLM_PROVIDER=gemini');
  }

  const ai = client ?? new GoogleGenAI({ apiKey });

  return {
    name: 'gemini',
    model,

    async triage({ system, user, signal }) {
      const params = {
        model,
        input: user,
        system_instruction: system,
        store: false,
        generation_config: {
          max_output_tokens: maxOutputTokens,
          // Only sent when explicitly configured: not every model accepts it, and an
          // unsupported field is a 400 rather than a graceful ignore.
          ...(thinkingLevel ? { thinking_level: thinkingLevel } : {}),
        },
        ...(structuredOutput
          ? {
              response_format: {
                type: 'text',
                mime_type: 'application/json',
                schema: OUTPUT_JSON_SCHEMA,
              },
            }
          : {}),
      };

      let interaction;
      try {
        interaction = await ai.interactions.create(params, {
          timeout_ms: timeoutMs,
          signal,
          retries: { strategy: 'none' },
        });
      } catch (err) {
        throw mapGeminiError(err, { model });
      }

      assertUsableStatus(interaction);

      return {
        model: interaction.model ?? model,
        raw: interaction.output_text ?? '',
        usage: {
          inputTokens: interaction.usage?.total_input_tokens ?? 0,
          outputTokens: interaction.usage?.total_output_tokens ?? 0,
        },
        status: interaction.status,
      };
    },
  };
}

/**
 * An interaction can come back without having produced an answer. `incomplete` is
 * left alone deliberately: it usually means the output hit `max_output_tokens`, so the
 * text is truncated JSON, and the validator rejecting it is exactly the right
 * behaviour - that path is a bad-output retry, not an infrastructure failure.
 */
function assertUsableStatus(interaction) {
  const status = interaction.status;
  if (status === 'completed' || status === 'incomplete') return;

  const detail = (interaction.errors ?? [])
    .map((e) => [e.code, e.message].filter(Boolean).join(': '))
    .join('; ');

  // Safety blocking surfaces as a failed interaction carrying a blocked/safety code.
  // That is specific to this ticket's content, so a human should look at it rather
  // than the worker retrying the same text forever.
  if (/safety|blocked|prohibited|jailbreak/i.test(detail)) {
    throw new PermanentLLMError(`Model declined to answer: ${detail}`, { kind: 'refusal' });
  }

  if (status === 'budget_exceeded') {
    throw new PermanentLLMError(`Token or cost budget exceeded: ${detail}`, { kind: 'quota' });
  }

  if (status === 'cancelled') {
    throw new TransientLLMError('Interaction was cancelled', { kind: 'timeout' });
  }

  // 'failed', plus the states a single non-streaming call should never end in
  // ('queued', 'in_progress', 'requires_action', 'requires_continuation').
  throw new TransientLLMError(
    `Interaction ended with status "${status}"${detail ? `: ${detail}` : ''}`,
    { kind: 'outage' },
  );
}

/** Collapse the SDK's error surface onto our transient/permanent taxonomy. */
export function mapGeminiError(err, { model } = {}) {
  // Our own AbortSignal fired, or the SDK's timeout_ms elapsed.
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
    return new TransientLLMError('Request aborted (client timeout)', {
      kind: 'timeout',
      cause: err,
    });
  }
  if (err?.name === 'ContinuationInterruptedError') {
    return new TransientLLMError('Generation was interrupted mid-continuation', {
      kind: 'outage',
      cause: err,
    });
  }

  const status = err instanceof ApiError ? err.status : err?.status;

  if (status === 429) {
    return new TransientLLMError('Gemini rate limit or quota exhausted (429)', {
      kind: 'rate_limit',
      cause: err,
    });
  }
  if (status === 408 || status === 499) {
    return new TransientLLMError(`Gemini request timed out (${status})`, {
      kind: 'timeout',
      cause: err,
    });
  }
  if (typeof status === 'number' && status >= 500) {
    return new TransientLLMError(`Gemini service error (${status})`, {
      kind: 'outage',
      cause: err,
    });
  }
  if (status === 401 || status === 403) {
    return new PermanentLLMError(`Gemini rejected our credentials (${status}): ${err.message}`, {
      kind: 'auth',
      cause: err,
    });
  }
  if (status === 404) {
    // Easy to hit: Gemini model IDs are retired on a published schedule. Say so,
    // rather than leaving someone to decode a bare 404.
    return new PermanentLLMError(
      `Gemini model not found (404)${model ? ` for TRIAGE_MODEL="${model}"` : ''}. ` +
        `Run "npm run models" to list the models this key can use. Detail: ${err.message}`,
      { kind: 'invalid_request', cause: err },
    );
  }
  if (status === 400) {
    // Gemini answers an invalid API key with 400, not 401, and the SDK does not
    // surface the response body usefully - so name the two likely causes here
    // rather than leave someone staring at a bare 400.
    return new PermanentLLMError(
      `Gemini rejected the request (400). Usual causes: an invalid or expired ` +
        `GEMINI_API_KEY, or a model/parameter combination that ` +
        `${model ? `"${model}"` : 'this model'} does not accept ` +
        `(try "npm run models"). Detail: ${err.message}`,
      { kind: 'invalid_request', cause: err },
    );
  }
  if (typeof status === 'number' && status >= 400) {
    return new PermanentLLMError(`Gemini rejected the request (${status}): ${err.message}`, {
      kind: 'invalid_request',
      cause: err,
    });
  }

  // Unknown shape: treat as transient. One extra call is cheaper than a lost ticket.
  return new TransientLLMError(`Unexpected provider failure: ${err?.message ?? err}`, {
    kind: 'network',
    cause: err,
  });
}
