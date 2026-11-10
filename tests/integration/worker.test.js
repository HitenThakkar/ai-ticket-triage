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

  test('gives up once the attempt budget is spent', async () => {
    const created = await insertTicket({
      subject: 'Outage',
      body: 'Everything is down. [[fail:outage]]',
    });

    // Three claim-and-fail cycles, with the retry delay skipped.
    for (let i = 0; i < 3; i += 1) {
      await pool.query('UPDATE tickets SET next_attempt_at = now() WHERE id = $1', [created.id]);
      await newWorker().runOnce();
    }

    const row = await getTicketRow(created.id);
    assert.equal(row.status, 'failed');
    assert.match(row.last_error, /gave up after 3 attempts/);
  });

  test('an authentication failure fails fast instead of burning retries', async () => {
    const created = await insertTicket({ subject: 'Anything', body: 'A question. [[fail:auth]]' });

    await newWorker().runOnce();

    const row = await getTicketRow(created.id);
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 1);
  });

  test('two workers claiming at the same moment never get the same ticket', async () => {
    for (let i = 0; i < 20; i += 1) {
      await insertTicket({ subject: `Ticket ${i}`, body: `Body number ${i}.` });
    }

    const [a, b] = await Promise.all([
      repo.claimTickets({ workerId: 'worker-a', limit: 20, staleLockMs: 60_000 }),
      repo.claimTickets({ workerId: 'worker-b', limit: 20, staleLockMs: 60_000 }),
    ]);

    const ids = [...a, ...b].map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length, 'claims must be disjoint');
  });

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
