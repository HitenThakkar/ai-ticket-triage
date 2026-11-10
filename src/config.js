import 'dotenv/config';
import { z } from 'zod';

/**
 * All configuration is read once, here, and validated.
 * Anything missing or malformed fails loudly at boot rather than at 3am in a worker.
 */

const bool = (def) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .optional()
    .default(def)
    .transform((v) => v === 'true' || v === '1' || v === 'yes');

const int = (def, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) =>
  z.coerce.number().int().min(min).max(max).optional().default(def);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).optional().default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).optional().default('info'),

  // --- HTTP ---
  PORT: int(3000, { min: 1, max: 65535 }),
  ROLE: z.enum(['all', 'api', 'worker']).optional().default('all'),
  API_KEYS: z.string().optional().default(''), // comma separated; empty disables auth
  RATE_LIMIT_WINDOW_MS: int(60_000, { min: 1000 }),
  RATE_LIMIT_MAX: int(60, { min: 1 }),
  BODY_LIMIT: z.string().optional().default('64kb'),

  // --- Database ---
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PGPOOL_MAX: int(10, { min: 1, max: 200 }),
  PG_STATEMENT_TIMEOUT_MS: int(10_000, { min: 100 }),

  // --- LLM provider ---
  LLM_PROVIDER: z.enum(['fake', 'gemini']).optional().default('fake'),
  GEMINI_API_KEY: z.string().optional().default(''),
  // Gemini model IDs are retired on a published schedule, so this is configuration,
  // never a constant in code. `npm run models` lists what the current key can use.
  TRIAGE_MODEL: z.string().optional().default('gemini-3.5-flash-lite'),
  // Optional: omitted from the request unless set, because not every model accepts it.
  GEMINI_THINKING_LEVEL: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
  TRIAGE_MAX_TOKENS: int(1024, { min: 256, max: 8192 }),
  LLM_TIMEOUT_MS: int(20_000, { min: 500 }),
  LLM_STRUCTURED_OUTPUT: bool('true'),

  // Fake provider knobs (used by tests and by `npm start` without an API key)
  FAKE_LATENCY_MS: int(50, { min: 0 }),
  FAKE_FAILURE_RATE: z.coerce.number().min(0).max(1).optional().default(0),
  FAKE_FAILURE_MODE: z
    .enum(['timeout', 'rate_limit', 'outage', 'malformed', 'missing_field', 'bad_enum'])
    .optional()
    .default('rate_limit'),

  // --- Worker ---
  WORKER_ENABLED: bool('true'),
  WORKER_CONCURRENCY: int(4, { min: 1, max: 64 }),
  WORKER_BATCH_SIZE: int(5, { min: 1, max: 100 }),
  WORKER_POLL_INTERVAL_MS: int(1000, { min: 50 }),
  WORKER_STALE_LOCK_MS: int(120_000, { min: 1000 }),
  WORKER_MAX_ATTEMPTS: int(5, { min: 1, max: 20 }), // delivery attempts before `failed`
  WORKER_BACKOFF_BASE_MS: int(5_000, { min: 100 }),
  WORKER_BACKOFF_MAX_MS: int(300_000, { min: 1000 }),
  WORKER_SHUTDOWN_GRACE_MS: int(15_000, { min: 0 }),

  // --- Triage behaviour ---
  TRIAGE_VALIDATION_ATTEMPTS: int(3, { min: 1, max: 10 }), // model calls per delivery attempt
  TRIAGE_CACHE_ENABLED: bool('true'),

  // --- Duplicate detection (optional feature) ---
  DUPLICATE_DETECTION_ENABLED: bool('true'),
  EMBEDDING_PROVIDER: z.enum(['hash', 'none']).optional().default('hash'),
  // 0.80 with the local hash embedder: measured near-duplicates land around 0.83+
  // while two different billing complaints from one customer sit near 0.60.
  DUPLICATE_SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).optional().default(0.8),
  DUPLICATE_CANDIDATE_LIMIT: int(25, { min: 1, max: 500 }),
});

/**
 * Convenience default: if someone supplies a Gemini key but does not say which
 * provider to use, they clearly want the real one. Setting LLM_PROVIDER explicitly
 * always wins, and with no key at all we stay on the fake - so a fresh clone still
 * runs with no credentials and no configuration.
 */
if (!process.env.LLM_PROVIDER && process.env.GEMINI_API_KEY) {
  process.env.LLM_PROVIDER = 'gemini';
}

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${details.join('\n')}`);
  process.exit(1);
}

const env = parsed.data;

const roleFromArgv = process.argv
  .slice(2)
  .find((a) => a.startsWith('--role='))
  ?.split('=')[1];

if (roleFromArgv && !['all', 'api', 'worker'].includes(roleFromArgv)) {
  // eslint-disable-next-line no-console
  console.error(`Invalid --role=${roleFromArgv} (expected all|api|worker)`);
  process.exit(1);
}

const role = roleFromArgv ?? env.ROLE;

export const config = Object.freeze({
  env: env.NODE_ENV,
  isTest: env.NODE_ENV === 'test',
  logLevel: env.LOG_LEVEL,
  role,

  http: Object.freeze({
    port: env.PORT,
    bodyLimit: env.BODY_LIMIT,
    apiKeys: Object.freeze(
      env.API_KEYS.split(',')
        .map((k) => k.trim())
        .filter(Boolean),
    ),
    rateLimit: Object.freeze({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX,
    }),
  }),

  db: Object.freeze({
    url: env.DATABASE_URL,
    poolMax: env.PGPOOL_MAX,
    statementTimeoutMs: env.PG_STATEMENT_TIMEOUT_MS,
  }),

  llm: Object.freeze({
    provider: env.LLM_PROVIDER,
    apiKey: env.GEMINI_API_KEY,
    model: env.TRIAGE_MODEL,
    thinkingLevel: env.GEMINI_THINKING_LEVEL,
    maxTokens: env.TRIAGE_MAX_TOKENS,
    timeoutMs: env.LLM_TIMEOUT_MS,
    structuredOutput: env.LLM_STRUCTURED_OUTPUT,
    fake: Object.freeze({
      latencyMs: env.FAKE_LATENCY_MS,
      failureRate: env.FAKE_FAILURE_RATE,
      failureMode: env.FAKE_FAILURE_MODE,
    }),
  }),

  worker: Object.freeze({
    enabled: env.WORKER_ENABLED,
    concurrency: env.WORKER_CONCURRENCY,
    batchSize: env.WORKER_BATCH_SIZE,
    pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
    staleLockMs: env.WORKER_STALE_LOCK_MS,
    maxAttempts: env.WORKER_MAX_ATTEMPTS,
    backoffBaseMs: env.WORKER_BACKOFF_BASE_MS,
    backoffMaxMs: env.WORKER_BACKOFF_MAX_MS,
    shutdownGraceMs: env.WORKER_SHUTDOWN_GRACE_MS,
  }),

  triage: Object.freeze({
    validationAttempts: env.TRIAGE_VALIDATION_ATTEMPTS,
    cacheEnabled: env.TRIAGE_CACHE_ENABLED,
  }),

  duplicates: Object.freeze({
    enabled: env.DUPLICATE_DETECTION_ENABLED && env.EMBEDDING_PROVIDER !== 'none',
    provider: env.EMBEDDING_PROVIDER,
    threshold: env.DUPLICATE_SIMILARITY_THRESHOLD,
    candidateLimit: env.DUPLICATE_CANDIDATE_LIMIT,
  }),
});

export default config;
