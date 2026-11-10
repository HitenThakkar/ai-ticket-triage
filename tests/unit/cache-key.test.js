import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildCacheKey } from '../../src/triage/cacheKey.js';

/**
 * The cache key is what makes "don't pay twice" safe. A stale result must be
 * unreachable after a prompt or model change, without anyone having to clear anything.
 */

const BASE = {
  subject: 'Charged twice',
  body: 'We were billed twice for invoice INV-1.',
  provider: 'gemini',
  model: 'gemini-3.5-flash-lite',
  promptFingerprint: 'v1-abc123',
};

describe('cache key', () => {
  test('is stable for identical input', () => {
    assert.equal(buildCacheKey(BASE), buildCacheKey({ ...BASE }));
  });

  test('ignores casing and whitespace, so near-identical tickets share an entry', () => {
    const noisy = { ...BASE, subject: '  CHARGED   twice ', body: 'We  were billed twice\nfor invoice INV-1.' };
    assert.equal(buildCacheKey(BASE), buildCacheKey(noisy));
  });

  test('changes when the ticket text changes', () => {
    assert.notEqual(buildCacheKey(BASE), buildCacheKey({ ...BASE, body: 'Something else' }));
  });

  test('changes when the model changes', () => {
    assert.notEqual(buildCacheKey(BASE), buildCacheKey({ ...BASE, model: 'gemini-3.8-flash' }));
  });

  test('changes when the prompt changes', () => {
    assert.notEqual(buildCacheKey(BASE), buildCacheKey({ ...BASE, promptFingerprint: 'v2-def456' }));
  });
});
