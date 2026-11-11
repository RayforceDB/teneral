import { expect, test } from 'bun:test';
import { describeDelay, retryDelayMs } from '../../body/retry';

test('the wait after a failed turn grows: 10 s, 1 min, 5 min, then every 15 min', () => {
  expect([1, 2, 3, 4, 5, 100].map(retryDelayMs)).toEqual([10_000, 60_000, 300_000, 900_000, 900_000, 900_000]);
});

test('a count that makes no sense still gives a wait, never zero', () => {
  for (const failures of [0, -1, NaN, 1.5, Infinity]) expect(retryDelayMs(failures)).toBeGreaterThanOrEqual(10_000);
});

test('delays are said the way a person reads them', () => {
  expect([10_000, 60_000, 300_000, 900_000].map(describeDelay)).toEqual(['10 s', '1 min', '5 min', '15 min']);
});
