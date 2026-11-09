import { timingSafeEqual } from 'node:crypto';
import { HttpError } from '../../lib/errors.js';

/**
 * Shared-secret API key auth via the `x-api-key` header.
 *
 * Scope note: this is deliberately the simplest thing that is still correct - keys come
 * from config, comparison is constant-time, and auth is off when no keys are configured
 * so the service runs out of the box. Real deployments want per-customer keys stored
 * hashed in the database with scopes and rotation; that is a different feature, not a
 * different middleware.
 */
export function apiKeyAuth(keys) {
  const configured = keys.filter(Boolean);

  if (configured.length === 0) {
    return (req, _res, next) => {
      req.auth = { enabled: false, keyId: null };
      next();
    };
  }

  const buffers = configured.map((k) => Buffer.from(k, 'utf8'));

  return (req, _res, next) => {
    const presented = req.get('x-api-key') ?? '';
    const presentedBuf = Buffer.from(presented, 'utf8');

    const index = buffers.findIndex(
      (buf) => buf.length === presentedBuf.length && timingSafeEqual(buf, presentedBuf),
    );

    if (index === -1) return next(HttpError.unauthorized());

    // Never log the key itself; an index is enough to tell callers apart.
    req.auth = { enabled: true, keyId: `key_${index + 1}` };
    next();
  };
}
