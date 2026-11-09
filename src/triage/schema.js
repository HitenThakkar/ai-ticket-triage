import { z } from 'zod';

export const CATEGORIES = Object.freeze(['billing', 'technical', 'account', 'feedback', 'other']);
export const PRIORITIES = Object.freeze(['low', 'medium', 'high', 'urgent']);

export const MAX_SUMMARY_CHARS = 200;
export const MAX_SUGGESTED_REPLY_CHARS = 600;

/**
 * The single gate every model response must pass before it can touch the database.
 *
 * `.strict()` is deliberate: an unexpected extra key means the model answered a
 * different question than the one we asked, and we would rather retry than guess.
 */
export const triageResultSchema = z
  .object({
    category: z.enum(CATEGORIES),
    priority: z.enum(PRIORITIES),
    summary: z
      .string()
      .trim()
      .min(1, 'summary must not be empty')
      .max(MAX_SUMMARY_CHARS, `summary must be at most ${MAX_SUMMARY_CHARS} characters`),
    suggested_reply: z
      .string()
      .trim()
      .max(MAX_SUGGESTED_REPLY_CHARS)
      .optional()
      .nullable()
      .transform((v) => (v ? v : null)),
    injection_suspected: z.boolean().optional().default(false),
  })
  .strict();

/**
 * Parse a raw provider response (string or object) into a validated triage result.
 * Returns a discriminated result instead of throwing so callers can log the raw value.
 */
export function parseTriageOutput(raw) {
  let candidate = raw;

  if (typeof candidate === 'string') {
    const extracted = extractJsonObject(candidate);
    if (extracted === null) {
      return { ok: false, issues: ['response did not contain a JSON object'], raw };
    }
    try {
      candidate = JSON.parse(extracted);
    } catch (err) {
      return { ok: false, issues: [`response was not valid JSON: ${err.message}`], raw };
    }
  }

  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, issues: ['response was not a JSON object'], raw };
  }

  const parsed = triageResultSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      raw,
    };
  }

  return { ok: true, value: parsed.data };
}

/**
 * Models sometimes wrap JSON in prose or a ```json fence. Pulling out the first
 * balanced object is a pragmatic kindness; the strict schema still does the judging.
 */
export function extractJsonObject(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const haystack = fenced ? fenced[1] : text;

  const start = haystack.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < haystack.length; i += 1) {
    const ch = haystack[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return haystack.slice(start, i + 1);
    }
  }
  return null;
}
