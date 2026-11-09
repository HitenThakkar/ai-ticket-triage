import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import config from '../config.js';
import * as repo from '../db/tickets.repo.js';
import { sleep } from '../lib/backoff.js';
import { createLogger } from '../lib/logger.js';
import { createEmbeddingProvider } from '../llm/embeddings.js';
import { createLLMProvider } from '../llm/index.js';
import { processTicket } from '../triage/service.js';

/**
 * Background worker.
 *
 * Postgres is the queue. The loop is intentionally dull:
 *
 *   1. claim a batch atomically (FOR UPDATE SKIP LOCKED - see claimTickets)
 *   2. process the batch with bounded concurrency
 *   3. if there was work, loop immediately; otherwise wait for a NOTIFY or a poll tick
 *
 * Several workers can run at once, in one process or across machines. Nothing here
 * assumes it is the only worker, and nothing is held in memory that matters after a
 * crash: the ticket row is the state.
 */
export class Worker {
  constructor({ provider, embedder, settings = {}, logger } = {}) {
    this.id = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.settings = { ...config.worker, ...settings };
    this.provider = provider;
    this.embedder = embedder;
    this.log = (logger ?? createLogger({})).child({ component: 'worker', workerId: this.id });

    this.running = false;
    this.inFlight = 0;
    this.stats = { claimed: 0, triaged: 0, cached: 0, needsReview: 0, failed: 0, retried: 0 };

    this.abort = new AbortController();
    this.wakeUp = () => {};
    this.listener = null;
    this.loopPromise = null;
  }

  async start() {
    if (this.running) return;
    this.running = true;

    this.provider ??= await createLLMProvider();
    this.embedder ??= config.duplicates.enabled
      ? createEmbeddingProvider({ provider: config.duplicates.provider })
      : null;

    // Low-latency wake-up. Polling alone would also work; this just removes the
    // "submitted a ticket, waited a second for the poll" lag.
    this.listener = await repo
      .createNotificationListener({
        onNotify: () => this.wakeUp(),
        onError: (err) => this.log.warn('Notification listener error', { err }),
      })
      .catch((err) => {
        this.log.warn('LISTEN unavailable, falling back to polling only', { err });
        return null;
      });

    this.log.info('Worker started', {
      provider: this.provider.name,
      model: this.provider.model,
      concurrency: this.settings.concurrency,
      batchSize: this.settings.batchSize,
    });

    this.loopPromise = this.#loop();
  }

  async #loop() {
    while (this.running) {
      let processed = 0;
      try {
        processed = await this.runOnce();
      } catch (err) {
        // A failure here means the database is unhappy. Back off and try again:
        // the worker must not die because Postgres restarted.
        this.log.error('Worker iteration failed', { err });
        await sleep(this.settings.pollIntervalMs * 5, { signal: this.abort.signal });
      }

      if (!this.running) break;
      if (processed === 0) await this.#idle();
    }
  }

  /** Wait for a NOTIFY, a poll tick, or shutdown - whichever comes first. */
  async #idle() {
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.abort.signal.removeEventListener('abort', done);
        this.wakeUp = () => {};
        resolve();
      };
      // Jitter spreads out the polls of N workers that all started together.
      const jitter = Math.random() * this.settings.pollIntervalMs * 0.25;
      const timer = setTimeout(done, this.settings.pollIntervalMs + jitter);
      this.wakeUp = done;
      this.abort.signal.addEventListener('abort', done, { once: true });
    });
  }

  /** One claim-and-process cycle. Exposed for tests. Returns the number processed. */
  async runOnce() {
    const batch = await repo.claimTickets({
      workerId: this.id,
      limit: this.settings.batchSize,
      staleLockMs: this.settings.staleLockMs,
    });

    if (batch.length === 0) return 0;
    this.stats.claimed += batch.length;

    await this.#withConcurrency(batch, this.settings.concurrency, async (ticket) => {
      this.inFlight += 1;
      try {
        const outcome = await processTicket(ticket, {
          provider: this.provider,
          embedder: this.embedder,
          logger: this.log,
        });
        this.#countOutcome(outcome);
      } catch (err) {
        // processTicket handles expected failures; reaching here means something
        // unexpected (usually the database). Put the ticket back rather than leaving
        // it locked until the stale-lock timeout.
        this.log.error('Unhandled error while processing ticket', { ticketId: ticket.id, err });
        await repo
          .scheduleRetry({
            ticketId: ticket.id,
            delayMs: this.settings.backoffBaseMs,
            error: `unexpected: ${err?.message ?? err}`,
          })
          .catch((e) => this.log.error('Could not requeue ticket', { ticketId: ticket.id, err: e }));
      } finally {
        this.inFlight -= 1;
      }
    });

    return batch.length;
  }

  #countOutcome(outcome) {
    if (outcome.outcome === 'triaged') this.stats.triaged += 1;
    else if (outcome.outcome === 'cached') this.stats.cached += 1;
    else if (outcome.outcome === 'needs_review') this.stats.needsReview += 1;
    else if (outcome.outcome === 'failed') this.stats.failed += 1;
    else if (outcome.outcome === 'retry_scheduled') this.stats.retried += 1;
  }

  async #withConcurrency(items, limit, fn) {
    const queue = [...items];
    const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        await fn(item);
      }
    });
    await Promise.all(runners);
  }

  /**
   * Graceful shutdown: stop claiming, let in-flight tickets finish, then release any
   * locks we still hold so a restart picks them up immediately instead of waiting for
   * the stale-lock window.
   */
  async stop() {
    if (!this.running) return;
    this.log.info('Worker stopping', { inFlight: this.inFlight });

    this.running = false;
    this.abort.abort();
    this.wakeUp();

    const deadline = Date.now() + this.settings.shutdownGraceMs;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    await this.loopPromise?.catch(() => {});
    await this.listener?.close().catch(() => {});

    const released = await repo.releaseWorkerLocks(this.id).catch((err) => {
      this.log.warn('Could not release worker locks', { err });
      return 0;
    });

    this.log.info('Worker stopped', { released, stats: this.stats });
  }
}
