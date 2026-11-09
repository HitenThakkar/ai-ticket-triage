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

  const post = (payload) =>
    request(app).post('/api/v1/tickets').set('x-api-key', API_KEY).send(payload);

  const VALID = {
    subject: 'Charged twice for invoice INV-1',
    body: 'Our card was charged twice for invoice INV-1 and we need one charge reversed.',
    customer_email: 'ap@northwind.example',
  };

  describe('POST /api/v1/tickets', () => {
    test('creates a ticket and returns its id and status immediately', async () => {
      const res = await post(VALID).expect(201);

      assert.match(res.body.id, /^[0-9a-f-]{36}$/);
      assert.equal(res.body.status, 'pending');
      assert.ok(res.body.created_at);
      assert.equal(res.headers.location, `/api/v1/tickets/${res.body.id}`);
    });

    test('does not wait for the model', async () => {
      const started = Date.now();
      await post(VALID).expect(201);
      // The fake provider is instant anyway; the point is that submission does no
      // triage work at all, so this stays an insert-sized latency.
      assert.ok(Date.now() - started < 500);
    });

    test('rejects a missing field with 400 and field details', async () => {
      const res = await post({ subject: 'x', customer_email: 'a@b.com' }).expect(400);
      assert.equal(res.body.error.code, 'bad_request');
      assert.ok(res.body.error.details.issues.some((i) => i.field === 'body'));
    });

    test('rejects an invalid email with 400', async () => {
      await post({ ...VALID, customer_email: 'nope' }).expect(400);
    });

    test('rejects unknown fields with 400', async () => {
      await post({ ...VALID, priority: 'urgent' }).expect(400);
    });

    test('rejects malformed JSON with 400', async () => {
      const res = await request(app)
        .post('/api/v1/tickets')
        .set('x-api-key', API_KEY)
        .set('Content-Type', 'application/json')
        .send('{"subject": ')
        .expect(400);
      assert.equal(res.body.error.code, 'invalid_json');
    });

    test('requires an API key', async () => {
      const res = await request(app).post('/api/v1/tickets').send(VALID).expect(401);
      assert.equal(res.body.error.code, 'unauthorized');
    });

    test('rejects a wrong API key', async () => {
      await request(app)
        .post('/api/v1/tickets')
        .set('x-api-key', 'not-a-real-key')
        .send(VALID)
        .expect(401);
    });

    test('echoes a request id on every response', async () => {
      const res = await post(VALID);
      assert.ok(res.headers['x-request-id']);
    });
  });

  describe('GET /api/v1/tickets/:id', () => {
    test('returns the ticket with a null triage before processing', async () => {
      const { body: created } = await post(VALID).expect(201);

      const res = await request(app)
        .get(`/api/v1/tickets/${created.id}`)
        .set('x-api-key', API_KEY)
        .expect(200);

      assert.equal(res.body.status, 'pending');
      assert.equal(res.body.triage, null);
      assert.equal(res.body.body, VALID.body);
    });

    test('returns the triage result once the worker has run', async () => {
      const { body: created } = await post(VALID).expect(201);
      await newWorker().runOnce();

      const res = await request(app)
        .get(`/api/v1/tickets/${created.id}`)
        .set('x-api-key', API_KEY)
        .expect(200);

      assert.equal(res.body.status, 'triaged');
      assert.equal(res.body.triage.category, 'billing');
      assert.ok(['low', 'medium', 'high', 'urgent'].includes(res.body.triage.priority));
      assert.ok(res.body.triage.summary.length > 0);
      assert.equal(res.body.triage.from_cache, false);
      assert.ok(res.body.usage.calls >= 1);
    });

    test('404s for an unknown ticket', async () => {
      const res = await request(app)
        .get('/api/v1/tickets/3f1d2b7c-1b3e-4a1e-9f4a-2c7f1a9d5e01')
        .set('x-api-key', API_KEY)
        .expect(404);
      assert.equal(res.body.error.code, 'not_found');
    });

    test('400s for an id that is not a UUID', async () => {
      await request(app).get('/api/v1/tickets/abc').set('x-api-key', API_KEY).expect(400);
    });
  });

  describe('GET /api/v1/tickets', () => {
    beforeEach(async () => {
      await insertTicket({
        subject: 'Invoice charged twice',
        body: 'We were billed twice for invoice INV-9 and need a refund.',
        customerEmail: 'ap@northwind.example',
      });
      await insertTicket({
        subject: 'API returns 500',
        body: 'Every call to the exports endpoint fails with a 500 error, production is down.',
        customerEmail: 'dev@contoso.example',
      });
      await insertTicket({
        subject: 'Love the new dashboard',
        body: 'Just a quick note to say thanks, the new dashboard is great.',
        customerEmail: 'sam@tailspin.example',
      });
      await newWorker().runOnce();
    });

    const list = (query = '') =>
      request(app).get(`/api/v1/tickets${query}`).set('x-api-key', API_KEY).expect(200);

    test('lists tickets with pagination metadata', async () => {
      const res = await list();
      assert.equal(res.body.data.length, 3);
      assert.equal(res.body.pagination.total, 3);
      assert.equal(res.body.pagination.has_more, false);
      assert.equal(res.body.data[0].body, undefined, 'list responses omit the full body');
    });

    test('filters by status', async () => {
      const res = await list('?status=triaged');
      assert.equal(res.body.data.length, 3);
      assert.ok(res.body.data.every((t) => t.status === 'triaged'));

      const none = await list('?status=failed');
      assert.equal(none.body.data.length, 0);
      assert.equal(none.body.pagination.total, 0);
    });

    test('filters by category', async () => {
      const res = await list('?category=billing');
      assert.equal(res.body.data.length, 1);
      assert.equal(res.body.data[0].triage.category, 'billing');
    });

    test('filters by priority', async () => {
      const res = await list('?priority=urgent');
      assert.ok(res.body.data.every((t) => t.triage.priority === 'urgent'));
    });

    test('combines filters', async () => {
      const res = await list('?status=triaged&category=technical&priority=urgent');
      assert.ok(res.body.data.every((t) => t.triage.category === 'technical'));
    });

    test('filters by customer email', async () => {
      const res = await list('?customer_email=AP@northwind.example');
      assert.equal(res.body.data.length, 1);
    });

    test('paginates', async () => {
      const page1 = await list('?limit=2&offset=0');
      assert.equal(page1.body.data.length, 2);
      assert.equal(page1.body.pagination.has_more, true);

      const page2 = await list('?limit=2&offset=2');
      assert.equal(page2.body.data.length, 1);
      assert.equal(page2.body.pagination.has_more, false);

      const ids = new Set([...page1.body.data, ...page2.body.data].map((t) => t.id));
      assert.equal(ids.size, 3, 'pages must not overlap');
    });

    test('rejects an invalid filter value with 400', async () => {
      await request(app)
        .get('/api/v1/tickets?status=archived')
        .set('x-api-key', API_KEY)
        .expect(400);
    });

    test('rejects an out-of-range page size with 400', async () => {
      await request(app)
        .get('/api/v1/tickets?limit=5000')
        .set('x-api-key', API_KEY)
        .expect(400);
    });
  });

  describe('POST /api/v1/tickets/:id/retry', () => {
    test('requeues a ticket that needs review', async () => {
      const created = await insertTicket({
        subject: 'Export is empty',
        body: 'The CSV export has only headers. [[fail:bad_enum]]',
      });
      await newWorker().runOnce();

      const before = await request(app)
        .get(`/api/v1/tickets/${created.id}`)
        .set('x-api-key', API_KEY);
      assert.equal(before.body.status, 'needs_review');

      const res = await request(app)
        .post(`/api/v1/tickets/${created.id}/retry`)
        .set('x-api-key', API_KEY)
        .expect(202);
      assert.equal(res.body.status, 'pending');
      assert.equal(res.body.attempts, 0);
    });

    test('409s when the ticket is already triaged', async () => {
      const { body: created } = await post(VALID).expect(201);
      await newWorker().runOnce();

      const res = await request(app)
        .post(`/api/v1/tickets/${created.id}/retry`)
        .set('x-api-key', API_KEY)
        .expect(409);
      assert.equal(res.body.error.code, 'conflict');
    });
  });

  describe('system endpoints', () => {
    test('health and readiness need no API key', async () => {
      await request(app).get('/healthz').expect(200);
      const ready = await request(app).get('/readyz').expect(200);
      assert.equal(ready.body.database.ok, true);
    });

    test('reports daily usage', async () => {
      await post(VALID).expect(201);
      await newWorker().runOnce();

      const res = await request(app)
        .get('/api/v1/usage/daily?days=1')
        .set('x-api-key', API_KEY)
        .expect(200);

      assert.ok(res.body.data.length >= 1);
      assert.ok(res.body.data[0].calls >= 1);
      assert.ok(res.body.data[0].total_tokens >= 0);
    });

    test('reports queue and cache stats', async () => {
      await post(VALID).expect(201);
      const res = await request(app).get('/api/v1/stats').set('x-api-key', API_KEY).expect(200);
      assert.equal(res.body.tickets_by_status.pending, 1);
      assert.ok(res.body.triage.prompt_fingerprint);
    });

    test('unknown routes 404 with the standard envelope', async () => {
      const res = await request(app).get('/api/v1/nope').set('x-api-key', API_KEY).expect(404);
      assert.equal(res.body.error.code, 'not_found');
    });
  });
});
