import { expect, test } from 'bun:test';
import { CRASH_LIMIT, MUTATION_EXIT, decide } from '../../stem/supervisor';

const fresh = { hasPrevious: true, crashes: 0 };

test('a clean exit stops the supervisor', () => {
  expect(decide({ code: 0, ready: true }, fresh)).toBe('stop');
});

test('exit 75 sends the candidate to the gates', () => {
  expect(decide({ code: MUTATION_EXIT, ready: true }, fresh)).toBe('gate');
});

test('a generation that never became ready is rolled back', () => {
  expect(decide({ code: 1, ready: false }, fresh)).toBe('rollback');
});

test('with nothing to roll back to, the supervisor halts', () => {
  expect(decide({ code: 1, ready: false }, { hasPrevious: false, crashes: 0 })).toBe('halt');
  expect(decide({ code: 1, ready: true }, { hasPrevious: false, crashes: CRASH_LIMIT - 1 })).toBe('halt');
});

test('a ready generation is restarted until the crash limit', () => {
  expect(decide({ code: 1, ready: true }, { hasPrevious: true, crashes: 0 })).toBe('restart');
  expect(decide({ code: 1, ready: true }, { hasPrevious: true, crashes: CRASH_LIMIT - 2 })).toBe('restart');
  expect(decide({ code: 1, ready: true }, { hasPrevious: true, crashes: CRASH_LIMIT - 1 })).toBe('rollback');
});

test('exit 75 from a generation that never became ready is not a mutation request', () => {
  expect(decide({ code: MUTATION_EXIT, ready: false }, fresh)).toBe('rollback');
  expect(decide({ code: MUTATION_EXIT, ready: false }, { hasPrevious: false, crashes: 0 })).toBe('halt');
});
