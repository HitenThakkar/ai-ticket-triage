/**
 * Express 4 does not forward rejected promises to the error middleware, so every async
 * handler is wrapped. Without this, one `await` that throws becomes a hung request and
 * an unhandled rejection instead of a 500.
 *
 * (Express 5 does this natively; the wrapper is kept so the behaviour is explicit and
 * does not depend on the major version in package.json.)
 */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
