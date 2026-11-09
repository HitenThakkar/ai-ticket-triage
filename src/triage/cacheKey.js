import { normalizeTicketText, sha256 } from '../lib/text.js';

/**
 * The cache key answers one question: "have we already paid for exactly this work?"
 *
 * "Exactly this work" = this normalised ticket text, sent to this provider and model,
 * under this prompt + output schema. Every one of those is part of the key, so a prompt
 * edit, a model upgrade or a provider switch can never serve a stale answer - the new
 * key simply misses and the ticket is triaged again. There is no invalidation step to
 * forget, which is the point: correctness does not depend on anyone remembering to
 * flush a cache.
 */
export const CACHE_KEY_VERSION = 1;

export function buildCacheKey({ subject, body, provider, model, promptFingerprint }) {
  const payload = JSON.stringify({
    v: CACHE_KEY_VERSION,
    provider,
    model,
    prompt: promptFingerprint,
    text: normalizeTicketText(subject, body),
  });
  return sha256(payload);
}
