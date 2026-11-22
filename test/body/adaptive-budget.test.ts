import { expect, test } from 'bun:test';
import { decideBudget, SENT_KIND, REFUSED_KIND, shares } from '../../body/adaptive-budget';
import { buildMessages, DEFAULT_BUDGET } from '../../brain/memory';
import type { JournalEvent } from '../../brain/journal';

const ev = (kind: string, data: unknown): JournalEvent => ({ type: 'note', kind, data } as unknown as JournalEvent);

function sent(chars: number, input: number, cached: number, dropped = 0): JournalEvent {
  return ev(SENT_KIND, { chars, input, cached, dropped });
}

const lastUsage = (): JournalEvent[] => [];
const FOUR = 4; // fallback chars/token, used before any measurement exists

test('with no measurements and no known window, the historical default stands', () => {
  const d = decideBudget(lastUsage(), null, undefined, DEFAULT_BUDGET);
  expect(d.budgetChars).toBe(DEFAULT_BUDGET);
  expect(d).not.toHaveProperty('stepShare');
  expect(d.report).not.toHaveProperty('cutRate');
  expect(d.report.samples).toBe(0);
  expect(d.report.cachedRatio).toBeNull();
  expect(d.report.durationMs).toBeNull();
  expect(d.report.firstByteMs).toBeNull();
  expect(d.report.timedSamples).toBe(0);
});

test('optional request timings are aggregated without changing the budget or excluding legacy notes', () => {
  const plain = sent(200_000, 50_000, 45_000);
  const measured = [
    plain,
    ev(SENT_KIND, { chars: 200_000, input: 50_000, cached: 45_000, dropped: 0, durationMs: 1000, firstByteMs: 100 }),
    ev(SENT_KIND, { chars: 200_000, input: 50_000, cached: 45_000, dropped: 0, durationMs: 2000, firstByteMs: 400 }),
    ev(SENT_KIND, { chars: 200_000, input: 50_000, cached: 45_000, dropped: 0, durationMs: -1, firstByteMs: 'bad' }),
  ];
  const report = decideBudget(measured, 262_144, undefined, DEFAULT_BUDGET);
  expect(report.budgetChars).toBe(decideBudget([plain], 262_144, undefined, DEFAULT_BUDGET).budgetChars);
  expect(report.report.durationMs).toBe(1500);
  expect(report.report.firstByteMs).toBe(250);
  expect(report.report.timedSamples).toBe(2);
  expect(decideBudget([plain], 262_144, undefined, DEFAULT_BUDGET).report.durationMs).toBeNull();
});

test('with a known window, the budget scales to it; the owner ceiling caps but never raises', () => {
  const window = 262_144; // k3.1-pro
  const measured = [sent(200_000, 50_000, 45_000)];
  const charsPerToken = 200_000 / 50_000; // 4.0
  const scaled = decideBudget(measured, window, undefined, DEFAULT_BUDGET);
  expect(scaled.budgetChars).toBe(Math.round(window * charsPerToken * 0.75));
  // Ceiling below the measurement caps it; above it, it changes nothing.
  expect(decideBudget(measured, window, 120_000, DEFAULT_BUDGET).budgetChars).toBe(120_000);
  expect(decideBudget(measured, window, 9_000_000, DEFAULT_BUDGET).budgetChars).toBe(scaled.budgetChars);
});

test('a recent refusal pulls the next budget below what just failed', () => {
  const events = [sent(200_000, 50_000, 45_000), ev(REFUSED_KIND, { chars: 120_000 })];
  const d = decideBudget(events, 262_144, undefined, DEFAULT_BUDGET);
  expect(d.budgetChars).toBeLessThanOrEqual(Math.round(120_000 * 0.8));
  expect(d.report.refused).toBe(1);
});

test('legacy cut and cache-step fields remain readable but no longer drive a fixed-step logbook', () => {
  const cold = decideBudget([sent(100_000, 50_000, 5_000)], 262_144, undefined, DEFAULT_BUDGET);
  const boundary = decideBudget([sent(100_000, 50_000, 25_000)], 262_144, undefined, DEFAULT_BUDGET);
  const warm = decideBudget([sent(100_000, 50_000, 45_000)], 262_144, undefined, DEFAULT_BUDGET);
  expect(boundary.report.cachedRatio).toBe(0.5);
  expect(warm.report.cachedRatio).toBe(0.9);
  expect(cold.budgetChars).toBe(boundary.budgetChars);
  expect(boundary.budgetChars).toBe(warm.budgetChars);
});

test('new measurements without dropped are equivalent to legacy measurements that carry it', () => {
  const current = ev(SENT_KIND, { chars: 200_000, input: 50_000, cached: 45_000 });
  expect(decideBudget([current], 262_144, undefined, DEFAULT_BUDGET))
    .toEqual(decideBudget([sent(200_000, 50_000, 45_000)], 262_144, undefined, DEFAULT_BUDGET));
});

test('a refusal caps only while what it refused is still recent', () => {
  // A refusal with few samples after it: it caps.
  const recent = decideBudget([sent(200_000, 50_000, 45_000), ev(REFUSED_KIND, { chars: 60_000 })], 262_144, undefined, DEFAULT_BUDGET);
  // The cap is 80% of what was refused, but never below the usability floor of 50k chars:
  // 60000*0.8=48000 floors to 50000, so the floor itself is what a live refusal settles at.
  expect(recent.budgetChars).toBe(50_000);
  expect(recent.report.refused).toBe(1);
  // After enough later requests, the cap lifts and the window-derived budget stands again.
  const aged = decideBudget([sent(200_000, 50_000, 45_000), ev(REFUSED_KIND, { chars: 60_000 }), ...Array.from({ length: 20 }, () => sent(150_000, 50_000, 46_000))], 262_144, undefined, DEFAULT_BUDGET);
  // chars/token is measured (~3.03 here), so compare against the window-scaled budget, not a fixed 3.0.
  expect(aged.budgetChars).toBeGreaterThan(Math.round(262_144 * 3 * 0.75) - 10_000);
  expect(aged.budgetChars).toBeLessThan(Math.round(262_144 * 3 * 0.75) + 10_000);
});

test('how much of the past a request shows is a share of the budget, between the old constants and a ceiling', () => {
  // An unknown or small window keeps what every request had before.
  expect(shares(250_000)).toEqual({ tailChars: 100_000, logbookChars: 50_000 });
  expect(shares(50_000)).toEqual({ tailChars: 100_000, logbookChars: 50_000 });
  // A window of 272,000 tokens at 3.3 characters a token and three quarters of it used.
  expect(shares(673_000)).toEqual({ tailChars: 168_250, logbookChars: 80_760 });
  // A larger one stops at the ceilings: every character is paid for in every request.
  expect(shares(1_190_000)).toEqual({ tailChars: 250_000, logbookChars: 100_000 });
  expect(shares(10_000_000)).toEqual({ tailChars: 250_000, logbookChars: 100_000 });
});
