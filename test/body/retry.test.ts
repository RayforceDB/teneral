import { expect, test } from 'bun:test';
import { ProviderError } from '../../body/provider';
import { describeDelay, failureKind, refusalNote, retryDelayMs, saysTooLong, verdict } from '../../body/retry';

test('the wait after a failed turn grows: 10 s, 1 min, 5 min, then every 15 min', () => {
  expect([1, 2, 3, 4, 5, 100].map(retryDelayMs)).toEqual([10_000, 60_000, 300_000, 900_000, 900_000, 900_000]);
});

test('a count that makes no sense still gives a wait, never zero', () => {
  for (const failures of [0, -1, NaN, 1.5, Infinity]) expect(retryDelayMs(failures)).toBeGreaterThanOrEqual(10_000);
});

test('delays are said the way a person reads them', () => {
  expect([10_000, 60_000, 300_000, 900_000].map(describeDelay)).toEqual(['10 s', '1 min', '5 min', '15 min']);
});

const refused = (status: number | null, body = 'nope') => new ProviderError(`provider answered ${status}: ${body}`, status, body);

test('a refusal for length is told by status and words, and only from the provider', () => {
  expect(saysTooLong(refused(400, 'maximum context length is 8192 tokens'))).toBe(true);
  expect(saysTooLong(refused(413, 'Request too LONG: reduce the Length'))).toBe(true);
  expect(saysTooLong(refused(400, 'unknown model'))).toBe(false);
  expect(saysTooLong(refused(429, 'token rate limit'))).toBe(false);
  expect(saysTooLong(refused(null, 'context'))).toBe(false);
  expect(saysTooLong(new Error('provider answered 400: context length'))).toBe(false);
});

test('a failure is the body\'s own, a refusal of this request, or something that may pass', () => {
  for (const err of [new TypeError('x is not a function'), new Error('provider answered 400: text only'), 'a string', undefined]) {
    expect(failureKind(err)).toBe('own');
  }
  for (const status of [400, 404, 405, 409, 415, 422, 499]) expect(failureKind(refused(status))).toBe('refused');
  // A bad key, a timeout, a rate limit, a server fault, no answer at all: the same request may be accepted later.
  for (const status of [401, 403, 408, 429, 500, 502, 503, 529, 200, null]) expect(failureKind(refused(status))).toBe('passing');
  // Too long is a kind of its own: the loop has already tried it at half the budget before the turn failed.
  expect(failureKind(refused(400, 'maximum context length exceeded'))).toBe('long');
  expect(failureKind(refused(413, 'too many tokens'))).toBe('long');
});

test('three of a kind in a row: a refusal is put on the record, the body\'s own fault goes to the kernel, the rest is retried', () => {
  expect([1, 2, 3, 4].map((n) => verdict('refused', n))).toEqual(['retry', 'retry', 'record', 'record']);
  expect([1, 2, 3, 4].map((n) => verdict('own', n))).toEqual(['retry', 'retry', 'exit', 'exit']);
  expect([1, 2, 3, 50].map((n) => verdict('passing', n))).toEqual(['retry', 'retry', 'retry', 'retry']);
});

test('a request that stays too long is put on the record after three turns as well, not sent every 15 minutes for ever', () => {
  expect([1, 2, 3, 4].map((n) => verdict('long', n))).toEqual(['retry', 'retry', 'record', 'record']);
});

test('the note for a request that stays too long says it does not fit even at half the budget, and which setting to lower', () => {
  const err = refused(400, `maximum context length is 8192 tokens ${'x'.repeat(2000)}`);
  const note = refusalNote(err, failureKind(err));
  expect(note.startsWith('[not from the model]')).toBe(true);
  expect(note).toContain('400');
  expect(note).toContain('maximum context length is 8192 tokens');
  expect(note).toMatch(/no longer fits the model, even at half the budget/);
  expect(note).toContain('TENERAL_CONTEXT_CHARS');
  expect(note).toMatch(/lower/);
  expect(note).toMatch(/could not be answered/);
  expect(note).toMatch(/owner/i);
  expect(note.length).toBeLessThan(1000);
  expect(note.isWellFormed()).toBe(true);
  // The other refusals keep their own words.
  expect(refusalNote(refused(422, 'bad'), 'refused')).not.toContain('TENERAL_CONTEXT_CHARS');
});

test('the note for a refusal names the status, the start of what the provider said, and the owner', () => {
  const note = refusalNote(refused(422, `tool_calls.0.function.name: invalid ${'x'.repeat(2000)}`), 'refused');
  expect(note).toContain('422');
  expect(note).toContain('tool_calls.0.function.name: invalid');
  expect(note).toMatch(/could not be answered/);
  expect(note).toMatch(/owner/i);
  expect(note.length).toBeLessThan(900);
  expect(note.isWellFormed()).toBe(true);
});
