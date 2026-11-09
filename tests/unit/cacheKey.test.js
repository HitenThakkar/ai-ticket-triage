import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildCacheKey } from '../../src/triage/cacheKey.js';
import { normalizeTicketText } from '../../src/lib/text.js';

const BASE = {
  subject: 'Charged twice',
  body: 'We were billed twice for invoice INV-1.',
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  promptFingerprint: 'v1-abc123',
};

describe('cache key', () => {
  test('is stable for identical input', () => {
    assert.equal(buildCacheKey(BASE), buildCacheKey({ ...BASE }));
  });

  test('ignores casing and whitespace differences', () => {
    const noisy = {
      ...BASE,
      subject: '  CHARGED   twice ',
      body: 'We  were billed twice\nfor invoice INV-1.',
    };
    assert.equal(buildCacheKey(BASE), buildCacheKey(noisy));
  });

  test('changes when the ticket text changes', () => {
    assert.notEqual(buildCacheKey(BASE), buildCacheKey({ ...BASE, body: 'Something else' }));
  });

  test('changes when the model changes', () => {
    assert.notEqual(buildCacheKey(BASE), buildCacheKey({ ...BASE, model: 'claude-haiku-5-5' }));
  });

  test('changes when the provider changes', () => {
    assert.notEqual(buildCacheKey(BASE), buildCacheKey({ ...BASE, provider: 'fake' }));
  });

  test('changes when the prompt fingerprint changes', () => {
    assert.notEqual(buildCacheKey(BASE), buildCacheKey({ ...BASE, promptFingerprint: 'v2-def456' }));
  });

  test('does not let field boundaries blur (subject/body shuffling)', () => {
    const a = buildCacheKey({ ...BASE, subject: 'ab', body: 'c' });
    const b = buildCacheKey({ ...BASE, subject: 'a', body: 'bc' });
    assert.notEqual(a, b);
  });
});

describe('normalizeTicketText', () => {
  test('collapses whitespace and lowercases', () => {
    assert.equal(normalizeTicketText('  Hello  ', 'World\n\nAgain'), 'hello world again');
  });

  test('keeps subject and body separated', () => {
    assert.notEqual(normalizeTicketText('a', 'b'), normalizeTicketText('ab', ''));
  });
});
