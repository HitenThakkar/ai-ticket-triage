/**
 * Minimal structured (JSON-lines) logger.
 * Deliberately dependency-free: one file, easy to swap for pino if the app grows.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

let threshold = LEVELS.info;

export function setLogLevel(level) {
  threshold = LEVELS[level] ?? LEVELS.info;
}

function emit(level, bindings, msg, extra) {
  if (LEVELS[level] < threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...bindings,
    ...(extra && typeof extra === 'object' ? extra : {}),
  };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(`${JSON.stringify(line, replacer)}\n`);
}

function replacer(_key, value) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

export function createLogger(bindings = {}) {
  return {
    child: (extra) => createLogger({ ...bindings, ...extra }),
    debug: (msg, extra) => emit('debug', bindings, msg, extra),
    info: (msg, extra) => emit('info', bindings, msg, extra),
    warn: (msg, extra) => emit('warn', bindings, msg, extra),
    error: (msg, extra) => emit('error', bindings, msg, extra),
  };
}

export const logger = createLogger({});
