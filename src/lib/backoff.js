/**
 * Exponential backoff with "equal jitter": half the delay is fixed, half is random.
 *
 * Fixed half  -> the delay still grows predictably with each attempt.
 * Random half -> a provider outage that fails 500 tickets at once does not produce
 *                500 simultaneous retries when it recovers (thundering herd).
 */
export function backoffMs(attempt, { baseMs, maxMs, random = Math.random } = {}) {
  const safeAttempt = Math.max(1, attempt);
  const exponential = Math.min(maxMs, baseMs * 2 ** (safeAttempt - 1));
  const half = exponential / 2;
  return Math.round(half + random() * half);
}

export function sleep(ms, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
