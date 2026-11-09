import config from './config.js';
import { createApp } from './api/app.js';
import { closePool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { createLogger, setLogLevel } from './lib/logger.js';
import { Worker } from './worker/worker.js';

setLogLevel(config.logLevel);
const log = createLogger({ component: 'server', role: config.role });

/**
 * Entry point for all three deployment shapes:
 *
 *   --role=all     API + worker in one process (default; simplest to run locally)
 *   --role=api     HTTP only
 *   --role=worker  background processing only
 *
 * They are the same image with a different flag, so scaling workers independently of
 * the API is a deployment change rather than a code change.
 */
async function main() {
  const shouldServeHttp = config.role === 'all' || config.role === 'api';
  const shouldWork = (config.role === 'all' || config.role === 'worker') && config.worker.enabled;

  // Migrating at boot is convenient and safe here: the runner takes an advisory lock,
  // so N instances starting together do not race. For a larger deployment this moves
  // into a release step so schema changes are not tied to pod restarts.
  if (process.env.AUTO_MIGRATE !== 'false') {
    const applied = await runMigrations({ log });
    const fresh = applied.filter((m) => m.status === 'applied');
    log.info('Migrations up to date', { applied: fresh.length, total: applied.length });
  }

  let server;
  let worker;

  if (shouldServeHttp) {
    const app = createApp();
    server = await new Promise((resolve, reject) => {
      const s = app.listen(config.http.port);
      s.once('listening', () => resolve(s));
      s.once('error', reject);
    });
    log.info('HTTP server listening', {
      port: config.http.port,
      authEnabled: config.http.apiKeys.length > 0,
    });
  }

  if (shouldWork) {
    worker = new Worker({ logger: log });
    await worker.start();
  }

  if (!shouldServeHttp && !shouldWork) {
    log.warn('Nothing to do: HTTP disabled and worker disabled');
  }

  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Shutting down', { signal });

    const timer = setTimeout(() => {
      log.error('Graceful shutdown timed out, exiting');
      process.exit(1);
    }, config.worker.shutdownGraceMs + 5000);
    timer.unref();

    try {
      if (server) await new Promise((resolve) => server.close(resolve));
      if (worker) await worker.stop();
      await closePool();
      log.info('Shutdown complete');
      process.exit(0);
    } catch (err) {
      log.error('Error during shutdown', { err });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // A crash with in-flight work is survivable (locks go stale and are reclaimed), but
  // it should be loud, and the process should not continue in an unknown state.
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled promise rejection', { err: reason });
  });
  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception, exiting', { err });
    shutdown('uncaughtException').finally(() => process.exit(1));
  });
}

main().catch((err) => {
  log.error('Failed to start', { err });
  process.exit(1);
});
