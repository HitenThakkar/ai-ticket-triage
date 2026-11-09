import rateLimit, * as erl from 'express-rate-limit';

// `ipKeyGenerator` normalises IPv6 addresses to a /64 prefix, so a single host cannot
// cycle through addresses to get a fresh bucket. It only exists in newer releases of
// the library, hence the fallback.
const ipKeyGenerator = typeof erl.ipKeyGenerator === 'function' ? erl.ipKeyGenerator : (ip) => ip;

/**
 * Rate limit on ticket submission.
 *
 * Keyed by API key when auth is on, by client IP otherwise. The store is in-process:
 * with N API instances the effective limit is N x max. That is an accepted trade-off
 * for this exercise - it needs no Redis, and the limiter's job here is to stop one
 * misbehaving client flooding the queue, not to meter billing. A shared store (Redis,
 * or a Postgres-backed counter) is the swap when limits must be exact.
 */
export function submissionRateLimit({ windowMs, max }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => req.auth?.keyId ?? ipKeyGenerator(req.ip ?? 'unknown'),
    handler: (req, res) => {
      res.status(429).json({
        error: {
          code: 'rate_limited',
          message: 'Too many tickets submitted. Slow down and retry shortly.',
        },
        request_id: req.id,
      });
    },
  });
}
