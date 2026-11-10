import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '@google/genai';
import { runTriage } from '../../src/triage/triager.js';
import { mapGeminiError } from '../../src/llm/gemini.js';
import { backoffMs } from '../../src/lib/backoff.js';
import {
  InvalidModelOutputError,
  PermanentLLMError,
  TransientLLMError,
} from '../../src/llm/errors.js';

const TICKET = { id: 't1', subject: 'Charged twice', body: 'We were billed twice for INV-1.' };

const VALID = JSON.stringify({
  category: 'billing',
  priority: 'high',
  summary: 'Customer was billed twice and wants one charge reversed.',
  injection_suspected: false,
});

/** Replays a scripted list of responses or errors, and counts the calls. */
function scriptedProvider(script) {
  let call = 0;
  return {
    name: 'scripted',
    model: 'scripted-v1',
    calls: () => call,
    async triage() {
      const step = script[Math.min(call, script.length - 1)];
      call += 1;
      if (step instanceof Error) throw step;
      return { model: 'scripted-v1', raw: step, usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
}

describe('retry on invalid output', () => {
  test('returns the result on the first valid response', async () => {
    const provider = scriptedProvider([VALID]);
    const out = await runTriage({ provider, ticket: TICKET, validationAttempts: 3 });
    assert.equal(out.result.category, 'billing');
    assert.equal(provider.calls(), 1);
  });

  test('retries invalid output and succeeds within the budget', async () => {
    const provider = scriptedProvider(['not json at all', '{"category":"billing"}', VALID]);
    const out = await runTriage({ provider, ticket: TICKET, validationAttempts: 3 });
    assert.equal(out.attempts, 3);
    assert.equal(out.result.priority, 'high');
  });

  test('gives up after the configured number of attempts, and uses no more', async () => {
    const provider = scriptedProvider(['nonsense']);
    await assert.rejects(
      () => runTriage({ provider, ticket: TICKET, validationAttempts: 3 }),
      InvalidModelOutputError,
    );
    assert.equal(provider.calls(), 3);
  });

  test('never returns a result built from invalid output', async () => {
    const provider = scriptedProvider([
      JSON.stringify({ category: 'nope', priority: 'P1', summary: 'x' }),
    ]);
    await assert.rejects(
      () => runTriage({ provider, ticket: TICKET, validationAttempts: 2 }),
      InvalidModelOutputError,
    );
  });

  test('records every model call, including the rejected ones', async () => {
    const provider = scriptedProvider(['bad', VALID]);
    const outcomes = [];
    await runTriage({
      provider,
      ticket: TICKET,
      validationAttempts: 3,
      onCall: (c) => outcomes.push(c.outcome),
    });
    assert.deepEqual(outcomes, ['invalid_output', 'success']);
  });
});

describe('infrastructure failures do not consume the validation budget', () => {
  test('a transient error propagates immediately', async () => {
    const provider = scriptedProvider([new TransientLLMError('429', { kind: 'rate_limit' })]);
    await assert.rejects(
      () => runTriage({ provider, ticket: TICKET, validationAttempts: 3 }),
      TransientLLMError,
    );
    assert.equal(provider.calls(), 1);
  });

  test('a permanent error propagates immediately', async () => {
    const provider = scriptedProvider([new PermanentLLMError('401', { kind: 'auth' })]);
    await assert.rejects(
      () => runTriage({ provider, ticket: TICKET, validationAttempts: 3 }),
      PermanentLLMError,
    );
    assert.equal(provider.calls(), 1);
  });
});

describe('failure classification', () => {
  const map = (status) => mapGeminiError(new ApiError({ status, message: 'err' }), { model: 'm' });

  test('429 and 5xx are retryable', () => {
    assert.ok(map(429) instanceof TransientLLMError);
    assert.ok(map(503) instanceof TransientLLMError);
  });

  test('401 is permanent - retrying a bad key only burns the budget', () => {
    assert.ok(map(401) instanceof PermanentLLMError);
  });

  test('an unrecognised failure is treated as retryable, never as a lost ticket', () => {
    assert.ok(mapGeminiError(new Error('socket hang up')) instanceof TransientLLMError);
  });
});

describe('backoff', () => {
  const OPTS = { baseMs: 1000, maxMs: 60_000 };

  test('grows exponentially and is capped', () => {
    const fixed = { ...OPTS, random: () => 0 };
    assert.equal(backoffMs(1, fixed), 500);
    assert.equal(backoffMs(2, fixed), 1000);
    assert.equal(backoffMs(3, fixed), 2000);
    assert.ok(backoffMs(30, { ...OPTS, random: () => 1 }) <= OPTS.maxMs);
  });

  test('is jittered, so tickets failing together do not retry together', () => {
    const delays = new Set(Array.from({ length: 50 }, () => backoffMs(4, OPTS)));
    assert.ok(delays.size > 1);
  });
});
