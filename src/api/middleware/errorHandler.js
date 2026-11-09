import { HttpError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

export function notFoundHandler(req, _res, next) {
  next(new HttpError(404, 'not_found', `No route for ${req.method} ${req.path}`));
}

/**
 * Single place that turns an error into a response. Every error leaves here with the
 * same envelope, and nothing internal (stack traces, SQL, provider messages) leaks to
 * the caller.
 */
// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
export function errorHandler(err, req, res, _next) {
  const requestId = req.id;

  if (err instanceof HttpError) {
    if (err.status >= 500) logger.error(err.message, { requestId, err });
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      request_id: requestId,
    });
  }

  // body-parser signals these with properties rather than types.
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({
      error: { code: 'payload_too_large', message: 'Request body too large' },
      request_id: requestId,
    });
  }
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({
      error: { code: 'invalid_json', message: 'Request body is not valid JSON' },
      request_id: requestId,
    });
  }

  logger.error('Unhandled request error', { requestId, method: req.method, path: req.path, err });

  return res.status(500).json({
    error: { code: 'internal_error', message: 'Internal server error' },
    request_id: requestId,
  });
}
