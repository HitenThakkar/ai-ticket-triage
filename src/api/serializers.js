/**
 * Row -> JSON. Kept separate from the repository so the wire format can change without
 * touching SQL, and so a column added to a table is not silently exposed to customers.
 */

export function serializeTicket(row, { includeBody = true, duplicates, usage } = {}) {
  if (!row) return null;

  const ticket = {
    id: row.id,
    subject: row.subject,
    ...(includeBody ? { body: row.body } : {}),
    customer_email: row.customer_email,
    status: row.status,
    attempts: row.attempts,
    created_at: row.created_at,
    updated_at: row.updated_at,
    triage: serializeTriage(row),
  };

  // Only exposed when the ticket is not in a happy state - it is operational detail,
  // not something a support agent needs on every row.
  if (row.status === 'failed' || row.status === 'needs_review') {
    ticket.last_error = row.last_error ?? null;
  }
  if (row.status === 'pending' && row.attempts > 0) {
    ticket.next_attempt_at = row.next_attempt_at;
    ticket.last_error = row.last_error ?? null;
  }

  if (duplicates) {
    ticket.duplicates = duplicates.map((d) => ({
      ticket_id: d.ticket_id,
      similarity: Number(d.similarity),
      detection_method: d.detection_method,
      detected_at: d.created_at,
    }));
  }

  if (usage) ticket.usage = usage;

  return ticket;
}

function serializeTriage(row) {
  if (!row.category) return null;
  return {
    category: row.category,
    priority: row.priority,
    summary: row.summary,
    suggested_reply: row.suggested_reply ?? null,
    injection_suspected: row.injection_suspected,
    model: row.model,
    provider: row.provider,
    prompt_version: row.prompt_version,
    from_cache: row.from_cache,
    model_attempts: row.model_attempts,
    latency_ms: row.result_latency_ms,
    triaged_at: row.triaged_at,
  };
}

export function paginationMeta({ total, limit, offset }) {
  return {
    total,
    limit,
    offset,
    returned: Math.max(0, Math.min(limit, total - offset)),
    has_more: offset + limit < total,
  };
}
