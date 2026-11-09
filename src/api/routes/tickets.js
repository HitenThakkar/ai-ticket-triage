import { Router } from 'express';
import config from '../../config.js';
import * as repo from '../../db/tickets.repo.js';
import { HttpError } from '../../lib/errors.js';
import { normalizeTicketText, sha256 } from '../../lib/text.js';
import { paginationMeta, serializeTicket } from '../serializers.js';
import {
  createTicketSchema,
  listTicketsSchema,
  parseOrThrow,
  ticketIdSchema,
} from '../validation.js';
import { submissionRateLimit } from '../middleware/rateLimit.js';
import { asyncHandler } from '../asyncHandler.js';

export function ticketsRouter() {
  const router = Router();

  /**
   * POST /api/v1/tickets
   *
   * Writes one row and returns. No model call happens on this path - the worker picks
   * the ticket up asynchronously - so submission latency is a single INSERT regardless
   * of how slow or unavailable the provider is.
   */
  router.post('/', submissionRateLimit(config.http.rateLimit), asyncHandler(async (req, res) => {
    const input = parseOrThrow(createTicketSchema, req.body ?? {}, 'ticket');

    const created = await repo.insertTicket({
      subject: input.subject,
      body: input.body,
      customerEmail: input.customer_email,
      contentHash: sha256(normalizeTicketText(input.subject, input.body)),
    });

    res
      .status(201)
      .location(`${req.baseUrl}/${created.id}`)
      .json({
        id: created.id,
        status: created.status,
        created_at: created.created_at,
      });
  }));

  /**
   * GET /api/v1/tickets
   * Filter by status, category and priority; offset pagination with a total count.
   */
  router.get('/', asyncHandler(async (req, res) => {
    const q = parseOrThrow(listTicketsSchema, req.query, 'query parameters');

    const { rows, total } = await repo.listTickets({
      status: q.status,
      category: q.category,
      priority: q.priority,
      customerEmail: q.customer_email,
      limit: q.limit,
      offset: q.offset,
      order: q.order,
    });

    res.json({
      data: rows.map((row) => serializeTicket(row, { includeBody: false })),
      pagination: paginationMeta({ total, limit: q.limit, offset: q.offset }),
      filters: {
        status: q.status ?? null,
        category: q.category ?? null,
        priority: q.priority ?? null,
        customer_email: q.customer_email ?? null,
      },
    });
  }));

  /** GET /api/v1/tickets/:id - the ticket, its triage result, duplicates and token usage. */
  router.get('/:id', asyncHandler(async (req, res) => {
    const id = parseOrThrow(ticketIdSchema, req.params.id, 'ticket id');

    const row = await repo.getTicketById(id);
    if (!row) throw HttpError.notFound(`Ticket ${id} not found`);

    const [duplicates, usage] = await Promise.all([
      repo.getDuplicatesForTicket(id),
      repo.getUsageByTicket(id),
    ]);

    res.json(serializeTicket(row, { duplicates, usage }));
  }));

  /**
   * POST /api/v1/tickets/:id/retry
   * Hand a ticket that ended in `needs_review` or `failed` back to the worker - for
   * after the API key was fixed, the prompt was improved, or a human wants another go.
   */
  router.post('/:id/retry', asyncHandler(async (req, res) => {
    const id = parseOrThrow(ticketIdSchema, req.params.id, 'ticket id');

    const existing = await repo.getTicketById(id);
    if (!existing) throw HttpError.notFound(`Ticket ${id} not found`);

    const requeued = await repo.requeueTicket({
      ticketId: id,
      resetAttempts: true,
      fromStatuses: ['needs_review', 'failed'],
    });

    if (!requeued) {
      throw HttpError.conflict(
        `Ticket is ${existing.status}; only needs_review or failed tickets can be retried`,
        { status: existing.status },
      );
    }

    res.status(202).json({ id: requeued.id, status: requeued.status, attempts: requeued.attempts });
  }));

  return router;
}
