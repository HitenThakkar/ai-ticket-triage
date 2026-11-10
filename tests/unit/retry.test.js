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

/**
 * Retry behaviour, tested against a stub provider so there is no database and no
 * network involved. This is the reason `triager.js` has no database access: the rules
 * below can be exercised in isolation.
 */

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
  // A good response must cost exactly one call - no speculative retries, no second
  // opinion. Every extra call is money.
  test('returns the result on the first valid response', async () => {
    const provider = scriptedProvider([VALID]);
    const out = await runTriage({ provider, ticket: TICKET, validationAttempts: 3 });
    assert.equal(out.result.category, 'billing');
    assert.equal(provider.calls(), 1);
  });

  // The point of retrying at all: a model that fails twice and then answers correctly
  // should produce a triaged ticket, not one sitting in needs_review.
  test('retries invalid output and succeeds within the budget', async () => {
    const provider = scriptedProvider(['not json at all', '{"category":"billing"}', VALID]);
    const out = await runTriage({ provider, ticket: TICKET, validationAttempts: 3 });
    assert.equal(out.attempts, 3);
    assert.equal(out.result.priority, 'high');
  });

  // Two guarantees at once: the budget is a hard stop, and on exhaustion it throws
  // rather than returning partial data - so the caller has nothing invalid to persist.
  test('gives up after the configured attempts, throwing rather than returning', async () => {
    const provider = scriptedProvider(['nonsense']);
    await assert.rejects(
      () => runTriage({ provider, ticket: TICKET, validationAttempts: 3 }),
      InvalidModelOutputError,
    );
    assert.equal(provider.calls(), 3);
  });

  // Rejected calls still cost tokens, so they have to reach the usage ledger. Counting
  // only successes would understate what the service actually spends.
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

  // A 429 says nothing about the model's ability to answer, and a bad key fails the
  // same way every time. Spending the validation budget on either would send a
  // perfectly good ticket to needs_review for an unrelated reason.
  test('infrastructure failures propagate without consuming the budget', async () => {
    for (const err of [
      new TransientLLMError('429', { kind: 'rate_limit' }),
      new PermanentLLMError('401', { kind: 'auth' }),
    ]) {
      const provider = scriptedProvider([err]);
      await assert.rejects(() => runTriage({ provider, ticket: TICKET, validationAttempts: 3 }));
      assert.equal(provider.calls(), 1);
    }
  });
});

describe('failure classification', () => {
  const map = (status) => mapGeminiError(new ApiError({ status, message: 'err' }), { model: 'm' });

  // 429s and 5xx recover on their own, so the ticket stays queued. A credentials
  // failure never will, so retrying only burns the budget and buries the real error.
  test('sorts provider errors into retryable and permanent', () => {
    assert.ok(map(429) instanceof TransientLLMError);
    assert.ok(map(503) instanceof TransientLLMError);
    assert.ok(map(401) instanceof PermanentLLMError);
  });

  // The default branch matters most: an error we have not seen before must keep the
  // ticket alive. Losing a ticket is the worst outcome available to this service.
  test('treats an unrecognised failure as retryable', () => {
    assert.ok(mapGeminiError(new Error('socket hang up')) instanceof TransientLLMError);
  });
});

describe('backoff', () => {
  const OPTS = { baseMs: 1000, maxMs: 60_000 };

  // Growth must be exponential so a struggling provider gets progressively more
  // breathing room, and capped so a ticket never waits for hours.
  test('grows exponentially and is capped', () => {
    const fixed = { ...OPTS, random: () => 0 };
    assert.equal(backoffMs(1, fixed), 500);
    assert.equal(backoffMs(2, fixed), 1000);
    assert.equal(backoffMs(3, fixed), 2000);
    assert.ok(backoffMs(30, { ...OPTS, random: () => 1 }) <= OPTS.maxMs);
  });

  // Without jitter, every ticket that failed during one outage would retry in the same
  // millisecond when it recovers, and knock the provider over again.
  test('is jittered, so tickets failing together do not retry together', () => {
    const delays = new Set(Array.from({ length: 50 }, () => backoffMs(4, OPTS)));
    assert.ok(delays.size > 1);
  });
});
