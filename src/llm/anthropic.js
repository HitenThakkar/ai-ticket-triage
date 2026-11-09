import Anthropic from '@anthropic-ai/sdk';
import { OUTPUT_JSON_SCHEMA } from './prompt.js';
import { PermanentLLMError, TransientLLMError } from './errors.js';

/**
 * Real provider: Anthropic Messages API via the official SDK.
 *
 * Two deliberate choices:
 *
 * 1. `maxRetries: 1` - the SDK retries a connection blip in-process (cheap, sub-second),
 *    but durable retry policy lives in the worker, which can persist state and back off
 *    across restarts. Only one layer owns the slow path.
 * 2. Structured outputs are on by default (`output_config.format`), which makes schema
 *    violations rare. We still validate every response ourselves - constrained decoding
 *    is a cost optimisation, not a trust boundary, and other providers have no such
 *    guarantee. Set LLM_STRUCTURED_OUTPUT=false to exercise the free-text path.
 */
export function createAnthropicProvider({
  apiKey,
  model,
  maxTokens = 1024,
  effort = 'low',
  timeoutMs = 20_000,
  structuredOutput = true,
  client,
} = {}) {
  if (!client && !apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic');
  }

  const anthropic = client ?? new Anthropic({ apiKey, maxRetries: 1, timeout: timeoutMs });

  return {
    name: 'anthropic',
    model,

    async triage({ system, user, signal }) {
      const request = {
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
        output_config: {
          effort,
          ...(structuredOutput
            ? { format: { type: 'json_schema', schema: OUTPUT_JSON_SCHEMA } }
            : {}),
        },
      };

      let response;
      try {
        response = await anthropic.messages.create(request, { signal, timeout: timeoutMs });
      } catch (err) {
        throw mapProviderError(err);
      }

      if (response.stop_reason === 'refusal') {
        throw new PermanentLLMError(
          `Model refused to triage this ticket (${response.stop_details?.category ?? 'unspecified'})`,
          { kind: 'refusal' },
        );
      }

      const text = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim();

      return {
        model: response.model ?? model,
        raw: text,
        usage: {
          inputTokens: response.usage?.input_tokens ?? 0,
          outputTokens: response.usage?.output_tokens ?? 0,
        },
        stopReason: response.stop_reason,
      };
    },
  };
}

/** Collapse the provider's error surface onto our transient/permanent taxonomy. */
export function mapProviderError(err) {
  if (err instanceof Anthropic.APIUserAbortError) {
    return new TransientLLMError('Request aborted (client timeout)', {
      kind: 'timeout',
      cause: err,
    });
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new TransientLLMError('Provider request timed out', { kind: 'timeout', cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new TransientLLMError('Could not reach provider', { kind: 'network', cause: err });
  }

  const status = err?.status;

  if (status === 429) {
    const retryAfter = Number(err?.headers?.['retry-after']);
    return new TransientLLMError('Provider rate limit', {
      kind: 'rate_limit',
      retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
      cause: err,
    });
  }
  if (status === 408 || status === 409 || (typeof status === 'number' && status >= 500)) {
    return new TransientLLMError(`Provider error ${status}`, { kind: 'outage', cause: err });
  }
  if (status === 401 || status === 403) {
    return new PermanentLLMError(`Provider rejected our credentials (${status})`, {
      kind: 'auth',
      cause: err,
    });
  }
  if (typeof status === 'number' && status >= 400) {
    return new PermanentLLMError(`Provider rejected the request (${status}): ${err.message}`, {
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
