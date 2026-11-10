import test, { after, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {
  API_KEY,
  createApp,
  databaseAvailable,
  insertTicket,
  newWorker,
  resetDatabase,
  setupDatabase,
  teardown,
} from './helpers.js';

const available = await databaseAvailable();
const skip = available
  ? false
  : 'No database reachable - set TEST_DATABASE_URL (see README > Running the tests)';

describe('HTTP API', { skip }, () => {
  let app;

  before(async () => {
    await setupDatabase();
    app = createApp();
  });

  beforeEach(resetDatabase);
  after(teardown);

  const VALID = {
    subject: 'Charged twice for invoice INV-1',
    body: 'Our card was charged twice for invoice INV-1 and we need one charge reversed.',
    customer_email: 'ap@northwind.example',
  };

  const post = (payload) =>
    request(app).post('/api/v1/tickets').set('x-api-key', API_KEY).send(payload);

  // The headline requirement: submission is one INSERT. The timing assertion is what
  // would catch someone accidentally awaiting the model on this path.
  test('submitting returns an id and a status without waiting for the model', async () => {
    const started = Date.now();
    const res = await post(VALID).expect(201);

    assert.match(res.body.id, /^[0-9a-f-]{36}$/);
    assert.equal(res.body.status, 'pending');
    assert.ok(Date.now() - started < 500, 'submission does no triage work');
  });

  // Reporting all problems at once lets a client fix them in a single round trip,
  // rather than discovering them one 400 at a time.
  test('rejects invalid input with 400 and names every bad field', async () => {
    const res = await post({ ...VALID, subject: '', customer_email: 'nope' }).expect(400);
    const fields = res.body.error.details.issues.map((i) => i.field);
    assert.ok(fields.includes('subject'));
    assert.ok(fields.includes('customer_email'));
  });

  // Priority is the model's judgement, not the customer's. Silently ignoring the field
  // would let a client believe it set something it did not.
  test('rejects unknown fields rather than silently dropping them', async () => {
    // Otherwise a client believes it set the priority and never finds out it did not.
    await post({ ...VALID, priority: 'urgent' }).expect(400);
  });

  // Auth is off by default so the service runs out of the box; this proves it is
  // actually enforced once keys are configured.
  test('requires an API key when one is configured', async () => {
    await request(app).post('/api/v1/tickets').send(VALID).expect(401);
  });

  // The support team's view: the asynchronous result arriving in the API response,
  // with values inside the allowed sets and a summary that fits the column.
  test('returns the triage result once the worker has run', async () => {
    const { body: created } = await post(VALID).expect(201);
    await newWorker().runOnce();

    const res = await request(app)
      .get(`/api/v1/tickets/${created.id}`)
      .set('x-api-key', API_KEY)
      .expect(200);

    assert.equal(res.body.status, 'triaged');
    assert.equal(res.body.triage.category, 'billing');
    assert.ok(res.body.triage.summary.length <= 200);
    assert.ok(res.body.usage.calls >= 1);
  });

  // The distinction matters: a malformed id is the client's mistake (400), a valid id
  // that does not exist is a 404. Without the UUID check Postgres would raise a 500.
  test('404s for an unknown ticket, 400s for an id that is not a UUID', async () => {
    await request(app)
      .get('/api/v1/tickets/3f1d2b7c-1b3e-4a1e-9f4a-2c7f1a9d5e01')
      .set('x-api-key', API_KEY)
      .expect(404);

    // Caught before it reaches Postgres, which would otherwise raise a 500.
    await request(app).get('/api/v1/tickets/abc').set('x-api-key', API_KEY).expect(400);
  });

  // category and priority live in a joined table, so this covers the join. The invalid
  // filter returns 400 rather than an empty list that looks like 'no results'.
  test('filters by status, category and priority', async () => {
    await insertTicket({
      subject: 'Invoice charged twice',
      body: 'We were billed twice for invoice INV-9 and need a refund.',
    });
    await insertTicket({
      subject: 'Love the new dashboard',
      body: 'Just a quick note to say thanks, the new dashboard is great.',
    });
    await newWorker().runOnce();

    const res = await request(app)
      .get('/api/v1/tickets?status=triaged&category=billing')
      .set('x-api-key', API_KEY)
      .expect(200);

    assert.equal(res.body.data.length, 1);
    assert.equal(res.body.data[0].triage.category, 'billing');

    await request(app).get('/api/v1/tickets?status=archived').set('x-api-key', API_KEY).expect(400);
  });

  // Ordering is created_at DESC, id DESC. Without the id tiebreaker, rows created in
  // the same millisecond can appear on two pages at once.
  test('paginates without overlapping pages', async () => {
    for (let i = 0; i < 3; i += 1) {
      await insertTicket({ subject: `Ticket ${i}`, body: `Body number ${i}.` });
    }

    const page1 = await request(app)
      .get('/api/v1/tickets?limit=2&offset=0')
      .set('x-api-key', API_KEY)
      .expect(200);
    const page2 = await request(app)
      .get('/api/v1/tickets?limit=2&offset=2')
      .set('x-api-key', API_KEY)
      .expect(200);

    assert.equal(page1.body.pagination.has_more, true);
    assert.equal(page2.body.pagination.has_more, false);
    const ids = [...page1.body.data, ...page2.body.data].map((t) => t.id);
    assert.equal(new Set(ids).size, 3, 'pages must not overlap');
  });

  // The operator's recovery path after fixing a key or a prompt. The 409 proves it is
  // a guarded transition rather than a blanket 'reprocess anything'.
  test('a needs_review ticket can be requeued, a triaged one cannot', async () => {
    const needsReview = await insertTicket({
      subject: 'Export is empty',
      body: 'The CSV export has only headers. [[fail:bad_enum]]',
    });
    const { body: ok } = await post(VALID).expect(201);
    await newWorker().runOnce();

    await request(app)
      .post(`/api/v1/tickets/${needsReview.id}/retry`)
      .set('x-api-key', API_KEY)
      .expect(202);

    await request(app).post(`/api/v1/tickets/${ok.id}/retry`).set('x-api-key', API_KEY).expect(409);
  });

  // Orchestrator probes must not need a secret, and readiness must actually check the
  // database - liveness deliberately does not, so a database blip cannot kill the pod.
  test('health and readiness need no API key', async () => {
    await request(app).get('/healthz').expect(200);
    const ready = await request(app).get('/readyz').expect(200);
    assert.equal(ready.body.database.ok, true);
  });
});
