import { createHash } from 'node:crypto';
import { normalizeTicketText } from '../lib/text.js';

/**
 * Embeddings, used only by the optional duplicate-detection feature.
 *
 * The default implementation is a local hashed bag-of-words ("hashing trick"): no API
 * key, no cost, deterministic, works offline. It is lexical rather than semantic, so it
 * reliably catches the case we actually care about - the same customer re-sending the
 * same complaint in slightly different words - and will miss a paraphrase that shares no
 * vocabulary. Swapping in a hosted embedding model means implementing one method; see
 * the README for how that changes storage (pgvector) at scale.
 */
export function createEmbeddingProvider({ provider = 'hash', dimensions = 128 } = {}) {
  if (provider === 'none') return null;
  if (provider !== 'hash') throw new Error(`Unsupported EMBEDDING_PROVIDER: ${provider}`);

  return {
    name: 'hash',
    model: `hash-bow-${dimensions}`,
    dimensions,
    async embed(subject, body) {
      return hashEmbedding(
        // The body carries the detail; subjects get rephrased ("Charged twice for the
        // October invoice" vs "Double charge on October invoice") for what is plainly
        // the same complaint. Weighting the body higher is what makes those two match
        // while keeping a different billing complaint below the threshold.
        [
          { text: normalizeTicketText('', body), weight: 1 },
          { text: normalizeTicketText('', subject), weight: 0.4 },
        ],
        dimensions,
      );
    },
  };
}

/**
 * @param {string | Array<{text: string, weight: number}>} input
 */
export function hashEmbedding(input, dimensions = 128) {
  const parts = typeof input === 'string' ? [{ text: input, weight: 1 }] : input;
  const vector = new Array(dimensions).fill(0);

  for (const part of parts) addFeatures(vector, part.text, part.weight ?? 1, dimensions);

  const norm = Math.sqrt(vector.reduce((acc, v) => acc + v * v, 0));
  return norm === 0 ? vector : vector.map((v) => v / norm);
}

function addFeatures(vector, text, weight, dimensions) {
  const words = String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);

  // Unigrams alone are too forgiving on support tickets: two unrelated billing
  // complaints share "invoice", "charged", "card" and score as duplicates. Word
  // bigrams carry the detail that actually distinguishes them ("inv 20418" vs
  // "inv 5"), so both are hashed into the same vector.
  const features = [...words];
  for (let i = 0; i < words.length - 1; i += 1) features.push(`${words[i]} ${words[i + 1]}`);

  for (const feature of features) {
    const digest = createHash('md5').update(feature).digest();
    const index = digest.readUInt32BE(0) % dimensions;
    const sign = digest[4] % 2 === 0 ? 1 : -1;
    vector[index] += sign * weight;
  }
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
