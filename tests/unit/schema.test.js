import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractJsonObject,
  parseTriageOutput,
  triageResultSchema,
} from '../../src/triage/schema.js';

const VALID = {
  category: 'billing',
  priority: 'high',
  summary: 'Customer was charged twice for the October invoice and wants one charge reversed.',
  suggested_reply: 'Thanks for flagging this - I am checking the duplicate charge now.',
  injection_suspected: false,
};

describe('triage output validation', () => {
  test('accepts a well-formed result', () => {
    const parsed = parseTriageOutput(JSON.stringify(VALID));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.category, 'billing');
    assert.equal(parsed.value.priority, 'high');
  });

  test('accepts an object as well as a JSON string', () => {
    assert.equal(parseTriageOutput(VALID).ok, true);
  });

  test('rejects a category outside the allowed list', () => {
    const parsed = parseTriageOutput({ ...VALID, category: 'refunds' });
    assert.equal(parsed.ok, false);
    assert.match(parsed.issues.join(' '), /category/);
  });

  test('rejects a priority outside the allowed list', () => {
    const parsed = parseTriageOutput({ ...VALID, priority: 'P0' });
    assert.equal(parsed.ok, false);
    assert.match(parsed.issues.join(' '), /priority/);
  });

  test('rejects missing required fields', () => {
    const { priority, ...withoutPriority } = VALID;
    const parsed = parseTriageOutput(withoutPriority);
    assert.equal(parsed.ok, false);
    assert.match(parsed.issues.join(' '), /priority/);
  });

  test('rejects an empty summary', () => {
    const parsed = parseTriageOutput({ ...VALID, summary: '   ' });
    assert.equal(parsed.ok, false);
  });

  test('rejects a summary longer than the column allows', () => {
    const parsed = parseTriageOutput({ ...VALID, summary: 'x'.repeat(201) });
    assert.equal(parsed.ok, false);
    assert.match(parsed.issues.join(' '), /summary/);
  });

  test('rejects unexpected extra keys', () => {
    const parsed = parseTriageOutput({ ...VALID, internal_notes: 'escalate' });
    assert.equal(parsed.ok, false);
  });

  test('rejects malformed JSON', () => {
    const parsed = parseTriageOutput('{ category: billing, priority: ');
    assert.equal(parsed.ok, false);
  });

  test('rejects a JSON array', () => {
    const parsed = parseTriageOutput('[{"category":"billing"}]');
    assert.equal(parsed.ok, false);
  });

  test('rejects a wrongly typed field', () => {
    const parsed = parseTriageOutput({ ...VALID, injection_suspected: 'yes' });
    assert.equal(parsed.ok, false);
  });

  test('tolerates a code fence and surrounding prose', () => {
    const wrapped = ['Sure! Here is the triage:', '```json', JSON.stringify(VALID), '```'].join('\n');
    assert.equal(parseTriageOutput(wrapped).ok, true);
  });

  test('normalises an absent suggested_reply to null', () => {
    const { suggested_reply, ...withoutReply } = VALID;
    const parsed = parseTriageOutput(withoutReply);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.suggested_reply, null);
  });

  test('defaults injection_suspected to false when omitted', () => {
    const { injection_suspected, ...rest } = VALID;
    const parsed = triageResultSchema.safeParse(rest);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.injection_suspected, false);
  });
});

describe('extractJsonObject', () => {
  test('finds a balanced object inside prose', () => {
    assert.equal(extractJsonObject('before {"a":{"b":1}} after'), '{"a":{"b":1}}');
  });

  test('ignores braces inside strings', () => {
    assert.equal(extractJsonObject('{"a":"}"}'), '{"a":"}"}');
  });

  test('returns null when there is no object', () => {
    assert.equal(extractJsonObject('no json here'), null);
  });
});
