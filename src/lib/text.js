import { createHash } from 'node:crypto';

/**
 * Canonical form of a ticket's text, used for cache keys and exact-duplicate checks.
 *
 * Normalisation is deliberately conservative: unicode-normalise, collapse whitespace,
 * lowercase and trim. Two tickets that differ only in casing or spacing are the same
 * work for the model, so they should share a cache entry.
 */
export function normalizeTicketText(subject, body) {
  return `${subject ?? ''}\n\n${body ?? ''}`
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Short, stable fingerprint - used for prompt versions where 64 hex chars is noise. */
export function fingerprint(value, length = 12) {
  return sha256(value).slice(0, length);
}

export function truncate(value, max) {
  if (typeof value !== 'string') return value;
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
