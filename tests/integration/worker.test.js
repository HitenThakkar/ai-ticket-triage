import test, { after, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  databaseAvailable,
  getTicketRow,
  insertTicket,
  newWorker,
  pool,
  repo,
  resetDatabase,
  setupDatabase,
  teardown,
} from './helpers.js';

const available = await databaseAvailable();
const skip = available
  ? false
  : 'No database reachable - set TEST_DATABASE_URL (see README > Running the tests)';

describe('background processing', { skip }, () => {
  before(setupDatabase);
  beforeEach(resetDatabase);
  after(teardown);

  // The happy path end to end: claim, call the model, validate, store, release the
  // lock. Everything below is a deviation from this.
  test('stores a validated result and marks the ticket triaged', async () => {
    const created = await insertTicket({
      subject: 'Charged twice for invoice INV-1',
      body: 'Our card was charged twice and we need one charge reversed.',
    });

    assert.equal(await newWorker().runOnce(), 1);

    const row = await getTicketRow(created.id);
    assert.equal(row.status, 'triaged');
    assert.equal(row.category, 'billing');
    assert.equal(row.locked_at, null);
  });

  // The single most important assertion in the suite: a ticket can fail without
  // leaving any trace of invalid data behind, in either the results or the cache.
  test('invalid output goes to needs_review, with no result row and nothing cached', async () => {
    const created = await insertTicket({
      subject: 'Export is empty',
      body: 'Only headers in the CSV. [[fail:bad_enum]]',
    });

    await newWorker().runOnce();

    const row = await getTicketRow(created.id);
    assert.equal(row.status, 'needs_review');
    assert.equal(row.category, null, 'no triage_results row may exist');
    assert.match(row.last_error, /invalid_model_output/);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM triage_cache');
    assert.equal(rows[0].n, 0, 'invalid output must never be cached');
  });

  // A rate limit must not lose the ticket or retry instantly. The future timestamp is
  // what makes the backoff real rather than a loop that hammers the provider.
  test('a transient failure requeues the ticket with a future retry time', async () => {
    const created = await insertTicket({
      subject: 'Billing question',
      body: 'Why was I charged in USD? [[fail:rate_limit]]',
    });

    await newWorker().runOnce();

    const row = await getTicketRow(created.id);
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 1);
    assert.ok(row.next_attempt_at > new Date(), 'retry is scheduled in the future');
  });

  // attempts stays at 1: a bad key fails identically every time, so retrying only
  // delays the operator seeing the real problem.
  test('an authentication failure fails fast instead of burning retries', async () => {
    const created = await insertTicket({ subject: 'Anything', body: 'A question. [[fail:auth]]' });

    await newWorker().runOnce();

    const row = await getTicketRow(created.id);
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 1);
  });

  // The concurrency guarantee, against a real database because FOR UPDATE SKIP
  // LOCKED is Postgres behaviour and cannot be mocked honestly. Measured by its
  // consequence: no duplicate results and no duplicate model calls.
  test('three workers on one backlog produce exactly one result per ticket', async () => {
    for (let i = 0; i < 12; i += 1) {
      await insertTicket({ subject: `Billing issue ${i}`, body: `Invoice ${i} looks wrong.` });
    }

    await Promise.all([newWorker().runOnce(), newWorker().runOnce(), newWorker().runOnce()]);

    const { rows } = await pool.query(`
      SELECT (SELECT count(*)::int FROM triage_results) AS results,
             (SELECT count(*)::int FROM tickets WHERE status <> 'triaged') AS unfinished,
             (SELECT count(*)::int FROM (SELECT ticket_id FROM llm_calls
                WHERE outcome = 'success' GROUP BY ticket_id HAVING count(*) > 1) x) AS twice
    `);
    assert.deepEqual(rows[0], { results: 12, unfinished: 0, twice: 0 });
  });

  // How work survives a worker being killed mid-call. Both halves matter: it must be
  // reclaimed once stale, and left alone before then, or two workers would overlap.
  test('a ticket locked by a dead worker is reclaimed after the stale window', async () => {
    const created = await insertTicket({ subject: 'Stuck', body: 'This one was abandoned.' });
    await pool.query(
      `UPDATE tickets SET status='processing', locked_by='dead-worker',
         locked_at = now() - interval '10 minutes', attempts = 1 WHERE id = $1`,
      [created.id],
    );

    const notYet = await repo.claimTickets({ workerId: 'fresh', limit: 10, staleLockMs: 3_600_000 });
    assert.equal(notYet.length, 0, 'not stale against a one-hour threshold');

    const reclaimed = await repo.claimTickets({ workerId: 'fresh', limit: 10, staleLockMs: 60_000 });
    assert.equal(reclaimed.length, 1, 'stale against a one-minute threshold');
  });

  // Proves the cache saves real money: two tickets, one model call. Different casing
  // and a different customer still hit, because neither changes the work.
  test('identical ticket text is triaged once and reused', async () => {
    const SAME = {
      subject: 'Charged twice for invoice INV-77',
      body: 'Our card was charged twice for invoice INV-77. Please reverse one charge.',
    };

    const first = await insertTicket(SAME);
    await newWorker().runOnce();

    // Different casing and padding, different customer - still the same work.
    const second = await insertTicket({
      ...SAME,
      subject: `  ${SAME.subject.toUpperCase()}  `,
      customerEmail: 'someone-else@example.com',
    });
    await newWorker().runOnce();

    const rowA = await getTicketRow(first.id);
    const rowB = await getTicketRow(second.id);
    assert.equal(rowA.from_cache, false);
    assert.equal(rowB.from_cache, true);
    assert.equal(rowA.summary, rowB.summary);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM llm_calls WHERE outcome = 'success'",
    );
    assert.equal(rows[0].n, 1, 'the model was called exactly once for two tickets');
  });
});
