import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildCacheKey } from '../../src/triage/cacheKey.js';

/**
 * The cache key is what makes "don't pay twice" safe. Reuse has to be impossible once
 * the work has changed - and because the key encodes everything that defines the work,
 * there is no invalidation step anyone can forget.
 */

const BASE = {
  subject: 'Charged twice',
  body: 'We were billed twice for invoice INV-1.',
  provider: 'gemini',
  model: 'gemini-3.5-flash-lite',
  promptFingerprint: 'v1-abc123',
};

describe('cache key', () => {
  // Without determinism the cache never hits and the feature is pointless - every
  // ticket would pay for a model call it had already paid for.
  test('is stable for identical input', () => {
    assert.equal(buildCacheKey(BASE), buildCacheKey({ ...BASE }));
  });

  // Templated and copy-pasted tickets differ only in spacing and case. If those missed,
  // the cache would barely hit on exactly the traffic it exists to serve.
  test('ignores casing and whitespace, so near-identical tickets share an entry', () => {
    const noisy = { ...BASE, subject: '  CHARGED   twice ', body: 'We  were billed twice\nfor invoice INV-1.' };
    assert.equal(buildCacheKey(BASE), buildCacheKey(noisy));
  });

  // The question the brief asks directly. Changing the model or editing the prompt must
  // make old results unreachable, so there is no cache to clear during a deploy - and
  // two different tickets must never collide onto one cached answer.
  test('changes when the text, the model or the prompt changes', () => {
    for (const change of [
      { body: 'Something else' },
      { model: 'gemini-3.8-flash' },
      { promptFingerprint: 'v2-def456' },
    ]) {
      assert.notEqual(buildCacheKey(BASE), buildCacheKey({ ...BASE, ...change }));
    }
  });
});
