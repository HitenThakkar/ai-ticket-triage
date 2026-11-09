import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '@google/genai';
import { createGeminiProvider, mapGeminiError } from '../../src/llm/gemini.js';
import { PermanentLLMError, TransientLLMError } from '../../src/llm/errors.js';
import { parseTriageOutput } from '../../src/triage/schema.js';

const TICKET = {
  id: '00000000-0000-4000-8000-000000000001',
  subject: 'Charged twice',
  body: 'We were billed twice for invoice INV-1.',
};

/** Minimal stand-in for `ai.interactions` so these stay offline unit tests. */
function fakeClient(responder) {
  const calls = [];
  return {
    calls,
    interactions: {
      async create(params, options) {
        calls.push({ params, options });
        return responder(params, options);
      },
    },
  };
}

const COMPLETED = {
  status: 'completed',
  model: 'gemini-3.5-flash-lite',
  output_text: JSON.stringify({
    category: 'billing',
    priority: 'high',
    summary: 'Customer was billed twice and wants one charge reversed.',
    injection_suspected: false,
  }),
  usage: { total_input_tokens: 412, total_output_tokens: 38, total_tokens: 450 },
};

describe('gemini provider - request shape', () => {
  test('sends the system prompt, the user prompt and the JSON schema', async () => {
    const client = fakeClient(() => COMPLETED);
    const provider = createGeminiProvider({ client, model: 'gemini-3.5-flash-lite' });

    await provider.triage({ system: 'SYSTEM', user: 'USER', ticket: TICKET });

    const { params } = client.calls[0];
    assert.equal(params.model, 'gemini-3.5-flash-lite');
    assert.equal(params.system_instruction, 'SYSTEM');
    assert.equal(params.input, 'USER');
    assert.equal(params.response_format.mime_type, 'application/json');
    assert.deepEqual(params.response_format.schema.required, [
      'category',
      'priority',
      'summary',
      'injection_suspected',
    ]);
  });

  test('does not let Google retain ticket text', async () => {
    const client = fakeClient(() => COMPLETED);
    await createGeminiProvider({ client, model: 'm' }).triage({ system: 's', user: 'u' });
    assert.equal(client.calls[0].params.store, false);
  });

  test('owns its own retries and timeout rather than delegating to the SDK', async () => {
    const client = fakeClient(() => COMPLETED);
    await createGeminiProvider({ client, model: 'm', timeoutMs: 1234 }).triage({
      system: 's',
      user: 'u',
    });
    const { options } = client.calls[0];
    assert.deepEqual(options.retries, { strategy: 'none' });
    assert.equal(options.timeout_ms, 1234);
  });

  test('omits thinking_level unless it is configured', async () => {
    const off = fakeClient(() => COMPLETED);
    await createGeminiProvider({ client: off, model: 'm' }).triage({ system: 's', user: 'u' });
    assert.equal(off.calls[0].params.generation_config.thinking_level, undefined);

    const on = fakeClient(() => COMPLETED);
    await createGeminiProvider({ client: on, model: 'm', thinkingLevel: 'low' }).triage({
      system: 's',
      user: 'u',
    });
    assert.equal(on.calls[0].params.generation_config.thinking_level, 'low');
  });

  test('can be switched to free-text mode', async () => {
    const client = fakeClient(() => COMPLETED);
    await createGeminiProvider({ client, model: 'm', structuredOutput: false }).triage({
      system: 's',
      user: 'u',
    });
    assert.equal(client.calls[0].params.response_format, undefined);
  });

  test('refuses to construct without an API key', () => {
    assert.throws(() => createGeminiProvider({ model: 'm' }), /GEMINI_API_KEY is required/);
  });
});

describe('gemini provider - response handling', () => {
  test('returns the raw text and token usage', async () => {
    const provider = createGeminiProvider({ client: fakeClient(() => COMPLETED), model: 'm' });
    const out = await provider.triage({ system: 's', user: 'u' });

    assert.equal(out.usage.inputTokens, 412);
    assert.equal(out.usage.outputTokens, 38);
    assert.equal(parseTriageOutput(out.raw).ok, true);
  });

  test('tolerates a response with no usage block', async () => {
    const provider = createGeminiProvider({
      client: fakeClient(() => ({ ...COMPLETED, usage: undefined })),
      model: 'm',
    });
    const out = await provider.triage({ system: 's', user: 'u' });
    assert.equal(out.usage.inputTokens, 0);
  });

  test('a truncated (incomplete) response is passed to the validator, not thrown', async () => {
    // Hitting max_output_tokens produces truncated JSON. That is a bad-output retry,
    // not an infrastructure failure, so the provider must not raise.
    const provider = createGeminiProvider({
      client: fakeClient(() => ({ ...COMPLETED, status: 'incomplete', output_text: '{"category":"bil' })),
      model: 'm',
    });
    const out = await provider.triage({ system: 's', user: 'u' });
    assert.equal(parseTriageOutput(out.raw).ok, false);
  });

  test('a failed interaction is transient', async () => {
    const provider = createGeminiProvider({
      client: fakeClient(() => ({ status: 'failed', errors: [{ code: 'INTERNAL', message: 'boom' }] })),
      model: 'm',
    });
    await assert.rejects(() => provider.triage({ system: 's', user: 'u' }), TransientLLMError);
  });

  test('a safety block is permanent, so the ticket goes to a human', async () => {
    const provider = createGeminiProvider({
      client: fakeClient(() => ({
        status: 'failed',
        errors: [{ code: 'BLOCKED_SAFETY', message: 'prompt was blocked for safety reasons' }],
      })),
      model: 'm',
    });
    await assert.rejects(
      () => provider.triage({ system: 's', user: 'u' }),
      (err) => {
        assert.ok(err instanceof PermanentLLMError);
        assert.equal(err.kind, 'refusal');
        return true;
      },
    );
  });

  test('a budget-exceeded interaction is permanent', async () => {
    const provider = createGeminiProvider({
      client: fakeClient(() => ({ status: 'budget_exceeded', errors: [] })),
      model: 'm',
    });
    await assert.rejects(() => provider.triage({ system: 's', user: 'u' }), PermanentLLMError);
  });

  test('an unexpected non-terminal status is transient', async () => {
    const provider = createGeminiProvider({
      client: fakeClient(() => ({ status: 'requires_action' })),
      model: 'm',
    });
    await assert.rejects(() => provider.triage({ system: 's', user: 'u' }), TransientLLMError);
  });
});

describe('gemini error mapping', () => {
  const api = (status, message = 'err') => new ApiError({ status, message });

  const expectTransient = (err, kind) => {
    const mapped = mapGeminiError(err);
    assert.ok(mapped instanceof TransientLLMError, `expected transient, got ${mapped.name}`);
    if (kind) assert.equal(mapped.kind, kind);
  };

  const expectPermanent = (err, kind) => {
    const mapped = mapGeminiError(err);
    assert.ok(mapped instanceof PermanentLLMError, `expected permanent, got ${mapped.name}`);
    if (kind) assert.equal(mapped.kind, kind);
  };

  test('429 is a retryable rate limit', () => expectTransient(api(429), 'rate_limit'));
  test('500 is a retryable outage', () => expectTransient(api(500), 'outage'));
  test('503 is a retryable outage', () => expectTransient(api(503), 'outage'));
  test('408 is a retryable timeout', () => expectTransient(api(408), 'timeout'));

  test('401 is permanent - retrying a bad key only burns the budget', () =>
    expectPermanent(api(401), 'auth'));
  test('403 is permanent', () => expectPermanent(api(403), 'auth'));
  test('400 is permanent and names the likely cause', () => {
    // Gemini answers a bad API key with 400, not 401 - verified against the live API.
    const mapped = mapGeminiError(api(400, 'bad request'), { model: 'gemini-3.5-flash-lite' });
    assert.ok(mapped instanceof PermanentLLMError);
    assert.equal(mapped.kind, 'invalid_request');
    assert.match(mapped.message, /GEMINI_API_KEY/);
    assert.match(mapped.message, /gemini-3\.5-flash-lite/);
  });

  test('404 is permanent and explains the retired-model trap', () => {
    const mapped = mapGeminiError(api(404, 'model not found'), { model: 'gemini-2.5-flash' });
    assert.ok(mapped instanceof PermanentLLMError);
    assert.match(mapped.message, /TRIAGE_MODEL="gemini-2\.5-flash"/);
    assert.match(mapped.message, /npm run models/);
  });

  test('an aborted request is a transient timeout', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expectTransient(abort, 'timeout');
  });

  test('an interrupted continuation is transient', () => {
    const interrupted = new Error('interrupted');
    interrupted.name = 'ContinuationInterruptedError';
    expectTransient(interrupted, 'outage');
  });

  test('an unrecognised failure is treated as transient, never as a lost ticket', () =>
    expectTransient(new Error('socket hang up'), 'network'));
});
