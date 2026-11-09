/**
 * Every provider maps its own failures onto these three classes, so the worker can
 * make a retry decision without knowing which provider ran.
 */

/** Worth retrying later: timeouts, 429s, 5xx, connection resets. */
export class TransientLLMError extends Error {
  constructor(message, { kind = 'transient', cause, retryAfterMs } = {}) {
    super(message);
    this.name = 'TransientLLMError';
    this.kind = kind; // timeout | rate_limit | outage | network
    this.retryAfterMs = retryAfterMs;
    this.cause = cause;
  }
}

/** Not worth retrying: bad API key, unknown model, malformed request, quota exhausted. */
export class PermanentLLMError extends Error {
  constructor(message, { kind = 'permanent', cause } = {}) {
    super(message);
    this.name = 'PermanentLLMError';
    this.kind = kind; // auth | invalid_request | not_found | refusal
    this.cause = cause;
  }
}

/** The call succeeded but the body was not usable triage output. */
export class InvalidModelOutputError extends Error {
  constructor(message, { issues = [], raw } = {}) {
    super(message);
    this.name = 'InvalidModelOutputError';
    this.issues = issues;
    this.raw = raw;
  }
}
