import { cosineSimilarity } from '../llm/embeddings.js';
import * as repo from '../db/tickets.repo.js';

/**
 * Optional feature: flag a new ticket that looks like an open ticket from the same
 * customer, and link the two.
 *
 * Best effort by design - this never throws into the triage path. A duplicate link is
 * a convenience for the support team; failing to produce one must not stop a ticket
 * being triaged.
 */
export async function detectDuplicates({ ticket, embedder, threshold, candidateLimit, logger }) {
  if (!embedder) return [];

  try {
    const vector = await embedder.embed(ticket.subject, ticket.body);

    // Store first, then search (the search excludes this ticket). If two near-identical
    // tickets are processed concurrently, both find each other and link both ways,
    // which is the right outcome - "link the two" - rather than neither seeing the
    // other because each was still unembedded.
    await repo.saveEmbedding({ ticketId: ticket.id, model: embedder.model, vector });

    const candidates = await repo.findDuplicateCandidates({
      ticketId: ticket.id,
      customerEmail: ticket.customer_email,
      model: embedder.model,
      limit: candidateLimit,
    });

    const matches = [];
    for (const candidate of candidates) {
      const exact = candidate.content_hash === ticket.content_hash;
      const similarity = exact ? 1 : cosineSimilarity(vector, candidate.vector);
      if (similarity >= threshold) {
        matches.push({
          ticketId: candidate.id,
          similarity: Number(similarity.toFixed(4)),
          method: exact ? 'content_hash' : `embedding:${embedder.model}`,
        });
      }
    }

    matches.sort((a, b) => b.similarity - a.similarity);

    for (const match of matches) {
      await repo.linkDuplicate({
        ticketId: ticket.id,
        duplicateOf: match.ticketId,
        similarity: match.similarity,
        method: match.method,
      });
    }

    if (matches.length > 0) {
      logger?.info('Linked duplicate tickets', {
        ticketId: ticket.id,
        duplicates: matches.map((m) => m.ticketId),
      });
    }

    return matches;
  } catch (err) {
    logger?.warn('Duplicate detection failed (ignored)', { ticketId: ticket.id, err });
    return [];
  }
}
