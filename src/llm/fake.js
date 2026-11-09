import { sleep } from '../lib/backoff.js';
import { InvalidModelOutputError, PermanentLLMError, TransientLLMError } from './errors.js';

/**
 * Deterministic stand-in for a hosted model.
 *
 * Why it exists: the service (and its test suite) must run end to end with no paid API
 * key. It implements exactly the same interface as the real provider, so the worker,
 * the validation layer and the cache cannot tell the difference.
 *
 * It can also be told to misbehave, which is how we exercise the failure paths:
 *
 *   - env:  FAKE_FAILURE_RATE=0.3 FAKE_FAILURE_MODE=rate_limit
 *   - text: put a marker in the ticket body, e.g. `[[fail:timeout]]`
 *           or `[[fail:malformed:2]]` to fail the first two calls and then succeed.
 *
 * Markers are scoped per ticket id and per process, which is enough for demos and tests.
 */

export const FAILURE_MODES = Object.freeze([
  'timeout',
  'rate_limit',
  'outage',
  'auth',
  'malformed',
  'missing_field',
  'bad_enum',
  'extra_field',
]);

const MARKER_RE = /\[\[fail:([a-z_]+)(?::(\d+))?\]\]/i;

export function createFakeProvider({
  latencyMs = 50,
  failureRate = 0,
  failureMode = 'rate_limit',
  random = Math.random,
  model = 'fake-triage-v1',
} = {}) {
  const attemptsByTicket = new Map();

  return {
    name: 'fake',
    model,

    async triage({ ticket, signal }) {
      if (latencyMs > 0) await sleep(latencyMs, { signal });
      if (signal?.aborted) throw new TransientLLMError('Request aborted', { kind: 'timeout' });

      const text = `${ticket.subject}\n${ticket.body}`;
      const marker = MARKER_RE.exec(text);

      if (marker) {
        const mode = marker[1].toLowerCase();
        const budget = marker[2] ? Number(marker[2]) : Infinity;
        const key = `${ticket.id ?? text}:${mode}`;
        const used = attemptsByTicket.get(key) ?? 0;
        if (used < budget) {
          attemptsByTicket.set(key, used + 1);
          return failWith(mode, ticket, model);
        }
      } else if (failureRate > 0 && random() < failureRate) {
        return failWith(failureMode, ticket, model);
      }

      const result = classify(ticket);
      return {
        model,
        raw: JSON.stringify(result),
        usage: estimateUsage(text, result),
      };
    },
  };
}

function failWith(mode, ticket, model) {
  switch (mode) {
    case 'timeout':
      throw new TransientLLMError('Simulated provider timeout', { kind: 'timeout' });
    case 'rate_limit':
      throw new TransientLLMError('Simulated rate limit (429)', {
        kind: 'rate_limit',
        retryAfterMs: 2000,
      });
    case 'outage':
      throw new TransientLLMError('Simulated provider outage (503)', { kind: 'outage' });
    case 'auth':
      throw new PermanentLLMError('Simulated invalid API key (401)', { kind: 'auth' });
    case 'malformed':
      return { model, raw: 'Sure! Here is the triage:\n{ category: billing, priority: ', usage: estimateUsage('', {}) };
    case 'missing_field': {
      const { category, summary } = classify(ticket);
      return { model, raw: JSON.stringify({ category, summary }), usage: estimateUsage('', {}) };
    }
    case 'bad_enum': {
      const result = { ...classify(ticket), priority: 'P0', category: 'refunds' };
      return { model, raw: JSON.stringify(result), usage: estimateUsage('', {}) };
    }
    case 'extra_field': {
      const result = { ...classify(ticket), internal_notes: 'escalate to finance' };
      return { model, raw: JSON.stringify(result), usage: estimateUsage('', {}) };
    }
    default:
      throw new InvalidModelOutputError(`Unknown simulated failure mode: ${mode}`);
  }
}

const CATEGORY_RULES = [
  ['billing', /\b(invoice|refund|charge[ds]?|payment|billing|subscription|card|price|pricing|receipt|vat)\b/i],
  ['account', /\b(log ?in|login|sign ?in|password|2fa|mfa|account|seat|permission|access|locked out|sso)\b/i],
  ['technical', /\b(error|bug|crash|exception|stack ?trace|500|502|timeout|api|endpoint|broken|fails?|not working|down)\b/i],
  ['feedback', /\b(feedback|suggestion|feature request|love|great job|thank you|thanks|idea|would be nice)\b/i],
];

const URGENT_RE = /\b(outage|production (is )?down|data loss|breach|hacked|security incident|charged twice|double charged|cannot work|completely broken|all users)\b/i;
const HIGH_RE = /\b(blocked|urgent|asap|critical|cannot (log ?in|access|submit)|failing|refund)\b/i;
const LOW_RE = /\b(question|how do i|documentation|feature request|suggestion|feedback|thanks|thank you)\b/i;

function classify(ticket) {
  const text = `${ticket.subject ?? ''} ${ticket.body ?? ''}`.replace(MARKER_RE, ' ');

  const category = CATEGORY_RULES.find(([, re]) => re.test(text))?.[0] ?? 'other';

  let priority = 'medium';
  if (URGENT_RE.test(text)) priority = 'urgent';
  else if (HIGH_RE.test(text)) priority = 'high';
  else if (LOW_RE.test(text) || category === 'feedback') priority = 'low';

  const summary = buildSummary(ticket, category, priority);

  return {
    category,
    priority,
    summary,
    suggested_reply: buildReply(ticket, category, priority),
    // The fake never "obeys" ticket text, but it does report when the text tries.
    injection_suspected: /\b(ignore (all |your |the )?(previous |prior |above )?instructions|system prompt|you are now)\b/i.test(text),
  };
}

function buildSummary(ticket, category, priority) {
  const subject = collapse(ticket.subject) || 'Support request';
  const firstSentence = collapse(String(ticket.body ?? '').replace(MARKER_RE, ' ')).split(/(?<=[.!?])\s/)[0] ?? '';
  const sentence = `Customer reports ${lowerFirst(subject)}${firstSentence ? `: ${lowerFirst(firstSentence)}` : ''}`;
  const clean = sentence.replace(/[.\s]+$/, '');
  const withMeta = `${clean} (${category}, ${priority} priority).`;
  return withMeta.length <= 200 ? withMeta : `${withMeta.slice(0, 196)}...`;
}

function buildReply(ticket, category, priority) {
  const opener = priority === 'urgent' ? 'Thanks for flagging this - we are treating it as urgent.' : 'Thanks for getting in touch.';
  const middle = {
    billing: 'I am reviewing your billing records now and will confirm the charge in question.',
    technical: 'I am looking into the error you described and will confirm what we find.',
    account: 'I am checking your account access now and will get you back in.',
    feedback: 'I have passed your feedback to the product team.',
    other: 'I am looking into this and will come back to you shortly.',
  }[category];
  return `${opener} ${middle} I will follow up with an update shortly.`;
}

function collapse(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function lowerFirst(value) {
  if (!value) return value;
  // Keep acronyms (API, 500) as-is.
  return /^[A-Z]{2,}/.test(value) ? value : value.charAt(0).toLowerCase() + value.slice(1);
}

function estimateUsage(input, output) {
  const chars = (s) => String(s ?? '').length;
  return {
    inputTokens: Math.ceil(chars(input) / 4),
    outputTokens: Math.ceil(chars(JSON.stringify(output)) / 4),
  };
}
