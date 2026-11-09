import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTicketSchema,
  listTicketsSchema,
  parseOrThrow,
  ticketIdSchema,
} from '../../src/api/validation.js';
import { HttpError } from '../../src/lib/errors.js';
import { cosineSimilarity, hashEmbedding } from '../../src/llm/embeddings.js';

const VALID_TICKET = {
  subject: 'Charged twice',
  body: 'We were billed twice for invoice INV-1.',
  customer_email: 'AP@Northwind.example',
};

describe('ticket input validation', () => {
  test('accepts a valid ticket and normalises the email', () => {
    const parsed = createTicketSchema.parse(VALID_TICKET);
    assert.equal(parsed.customer_email, 'ap@northwind.example');
  });

  test('trims surrounding whitespace', () => {
    const parsed = createTicketSchema.parse({ ...VALID_TICKET, subject: '  Charged twice  ' });
    assert.equal(parsed.subject, 'Charged twice');
  });

  test('rejects a missing subject', () => {
    const { subject, ...rest } = VALID_TICKET;
    assert.equal(createTicketSchema.safeParse(rest).success, false);
  });

  test('rejects an empty body', () => {
    assert.equal(createTicketSchema.safeParse({ ...VALID_TICKET, body: '   ' }).success, false);
  });

  test('rejects a malformed email', () => {
    assert.equal(
      createTicketSchema.safeParse({ ...VALID_TICKET, customer_email: 'not-an-email' }).success,
      false,
    );
  });

  test('rejects an oversized body', () => {
    assert.equal(
      createTicketSchema.safeParse({ ...VALID_TICKET, body: 'x'.repeat(20_001) }).success,
      false,
    );
  });

  test('rejects unknown fields rather than silently dropping them', () => {
    assert.equal(
      createTicketSchema.safeParse({ ...VALID_TICKET, status: 'triaged' }).success,
      false,
    );
  });

  test('rejects non-string types', () => {
    assert.equal(createTicketSchema.safeParse({ ...VALID_TICKET, subject: 42 }).success, false);
  });

  test('parseOrThrow raises a 400 with field details', () => {
    try {
      parseOrThrow(createTicketSchema, { subject: '', body: '', customer_email: 'x' }, 'ticket');
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 400);
      assert.ok(err.details.issues.length >= 3);
    }
  });
});

describe('list query validation', () => {
  test('applies defaults', () => {
    const parsed = listTicketsSchema.parse({});
    assert.deepEqual({ limit: parsed.limit, offset: parsed.offset, order: parsed.order }, {
      limit: 20,
      offset: 0,
      order: 'desc',
    });
  });

  test('coerces numeric strings from the query string', () => {
    const parsed = listTicketsSchema.parse({ limit: '50', offset: '100' });
    assert.equal(parsed.limit, 50);
    assert.equal(parsed.offset, 100);
  });

  test('caps the page size', () => {
    assert.equal(listTicketsSchema.safeParse({ limit: '1000' }).success, false);
  });

  test('rejects an unknown status', () => {
    assert.equal(listTicketsSchema.safeParse({ status: 'archived' }).success, false);
  });

  test('rejects an unknown filter key', () => {
    assert.equal(listTicketsSchema.safeParse({ assignee: 'me' }).success, false);
  });
});

describe('ticket id validation', () => {
  test('accepts a UUID', () => {
    assert.equal(ticketIdSchema.safeParse('3f1d2b7c-1b3e-4a1e-9f4a-2c7f1a9d5e01').success, true);
  });

  test('rejects anything else (so a bad id is a 400, not a 500 from Postgres)', () => {
    assert.equal(ticketIdSchema.safeParse('123').success, false);
  });
});

describe('embeddings', () => {
  test('near-identical texts score above the duplicate threshold', () => {
    const a = hashEmbedding('our card was charged twice for invoice inv-20418 on 2 october');
    const b = hashEmbedding('our card was charged twice for invoice inv-20418 on 2nd october');
    assert.ok(cosineSimilarity(a, b) > 0.85, 'expected a high similarity score');
  });

  test('unrelated texts score low', () => {
    const a = hashEmbedding('our card was charged twice for invoice inv-20418');
    const b = hashEmbedding('how do i add a second administrator to my workspace');
    assert.ok(cosineSimilarity(a, b) < 0.5);
  });

  test('identical text is exactly similar to itself', () => {
    const a = hashEmbedding('the export endpoint returns a 500 error');
    assert.ok(Math.abs(cosineSimilarity(a, a) - 1) < 1e-9);
  });

  test('similarity of mismatched or empty vectors is 0 rather than NaN', () => {
    assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
    assert.equal(cosineSimilarity([], []), 0);
    assert.equal(cosineSimilarity([0, 0], [0, 0]), 0);
  });
});
