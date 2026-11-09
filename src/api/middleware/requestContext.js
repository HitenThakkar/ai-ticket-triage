import { randomUUID } from 'node:crypto';
import { logger } from '../../lib/logger.js';

/** Attach a request id (honouring an upstream one) and echo it back on the response. */
export function requestId(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = incoming && incoming.length <= 128 ? incoming : randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
}

/** One structured log line per completed request. */
export function accessLog(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level]('http_request', {
      requestId: req.id,
      method: req.method,
      // `req.originalUrl`, not `req.baseUrl + req.route.path`: by the time 'finish'
      // fires on an error response, Express has unwound the router stack and reset
      // `baseUrl`, so that form logged a 400 on GET /api/v1/tickets/:id as just
      // "/:id". Higher cardinality, but a log line that names the wrong endpoint is
      // worse than one you have to group yourself.
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(1)),
      keyId: req.auth?.keyId ?? null,
    });
  });

  next();
}
