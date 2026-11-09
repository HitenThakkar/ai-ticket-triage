import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { backoffMs } from '../../src/lib/backoff.js';

const OPTS = { baseMs: 1000, maxMs: 60_000 };

describe('backoff', () => {
  test('grows exponentially', () => {
    const fixed = { ...OPTS, random: () => 0 };
    assert.equal(backoffMs(1, fixed), 500);
    assert.equal(backoffMs(2, fixed), 1000);
    assert.equal(backoffMs(3, fixed), 2000);
    assert.equal(backoffMs(4, fixed), 4000);
  });

  test('never exceeds the ceiling', () => {
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      assert.ok(backoffMs(attempt, { ...OPTS, random: () => 1 }) <= OPTS.maxMs);
    }
  });

  test('jitter stays within [half, full] of the exponential delay', () => {
    const lower = backoffMs(5, { ...OPTS, random: () => 0 });
    const upper = backoffMs(5, { ...OPTS, random: () => 1 });
    assert.equal(lower, 8000);
    assert.equal(upper, 16_000);
    for (let i = 0; i < 100; i += 1) {
      const value = backoffMs(5, OPTS);
      assert.ok(value >= lower && value <= upper, `${value} outside [${lower}, ${upper}]`);
    }
  });

  test('two callers failing at the same instant get different delays', () => {
    const delays = new Set(Array.from({ length: 50 }, () => backoffMs(4, OPTS)));
    assert.ok(delays.size > 1, 'backoff must be jittered, not deterministic');
  });

  test('treats attempt 0 as attempt 1 rather than producing a negative exponent', () => {
    assert.equal(backoffMs(0, { ...OPTS, random: () => 0 }), 500);
  });
});
