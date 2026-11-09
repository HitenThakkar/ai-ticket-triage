#!/usr/bin/env node
import { closePool } from '../src/db/pool.js';
import { migrationStatus, runMigrations } from '../src/db/migrate.js';
import { createLogger, setLogLevel } from '../src/lib/logger.js';
import config from '../src/config.js';

setLogLevel(config.logLevel);
const log = createLogger({ component: 'migrate' });

const command = process.argv[2] ?? 'up';

try {
  if (command === 'up') {
    const results = await runMigrations({ log });
    const applied = results.filter((r) => r.status === 'applied');
    log.info(applied.length ? 'Migrations applied' : 'Nothing to apply', {
      applied: applied.map((r) => r.name),
      total: results.length,
    });
  } else if (command === 'status') {
    const status = await migrationStatus();
    for (const m of status) {
      process.stdout.write(
        `${m.applied ? '[x]' : '[ ]'} ${m.name}${m.appliedAt ? `  (${m.appliedAt.toISOString()})` : ''}\n`,
      );
    }
  } else {
    process.stderr.write(`Unknown command: ${command}\nUsage: node scripts/migrate.js [up|status]\n`);
    process.exitCode = 1;
  }
} catch (err) {
  log.error('Migration failed', { err });
  process.exitCode = 1;
} finally {
  await closePool();
}
