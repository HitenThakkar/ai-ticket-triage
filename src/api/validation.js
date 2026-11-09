import { z } from 'zod';
import { CATEGORIES, PRIORITIES } from '../triage/schema.js';
import { HttpError } from '../lib/errors.js';

export const TICKET_STATUSES = Object.freeze([
  'pending',
  'processing',
  'triaged',
  'needs_review',
  'failed',
]);

export const MAX_SUBJECT_LENGTH = 200;
export const MAX_BODY_LENGTH = 20_000;

export const createTicketSchema = z
  .object({
    subject: z
      .string()
      .trim()
      .min(1, 'subject must not be empty')
      .max(MAX_SUBJECT_LENGTH, `subject must be at most ${MAX_SUBJECT_LENGTH} characters`),
    body: z
      .string()
      .trim()
      .min(1, 'body must not be empty')
      .max(MAX_BODY_LENGTH, `body must be at most ${MAX_BODY_LENGTH} characters`),
    customer_email: z
      .string()
      .trim()
      .toLowerCase()
      .email('customer_email must be a valid email address')
      .max(320),
  })
  .strict();

export const listTicketsSchema = z
  .object({
    status: z.enum(TICKET_STATUSES).optional(),
    category: z.enum(CATEGORIES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    customer_email: z.string().trim().toLowerCase().email().max(320).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    offset: z.coerce.number().int().min(0).max(1_000_000).optional().default(0),
    order: z.enum(['asc', 'desc']).optional().default('desc'),
  })
  .strict();

export const ticketIdSchema = z.string().uuid('ticket id must be a UUID');

export const usageQuerySchema = z
  .object({ days: z.coerce.number().int().min(1).max(90).optional().default(7) })
  .strict();

/** Validate or throw a 400 carrying field-level details. */
export function parseOrThrow(schema, value, what = 'request') {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;

  throw HttpError.badRequest(`Invalid ${what}`, {
    issues: parsed.error.issues.map((issue) => ({
      field: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
  });
}
