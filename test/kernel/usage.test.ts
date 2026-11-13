import { expect, test } from 'bun:test';
import type { JournalEvent } from '../../brain/journal';
import { cacheUse } from '../../kernel/tui/view';
import { formatUsage, share, usageReport } from '../../kernel/usage';

const NOW = Date.parse('2027-01-15T12:00:00Z');
const at = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();
const ev = (e: Record<string, unknown>): JournalEvent => e as unknown as JournalEvent;
const said = (source: string, minutesAgo: number): JournalEvent => ev({ type: 'stimulus', source, text: 'x', ts: at(minutesAgo), gen: 'g2' });
const reply = (minutesAgo: number, usage: unknown, gen = 'g2'): JournalEvent => ev({ type: 'assistant', text: 'ok', toolCalls: [], ts: at(minutesAgo), gen, ...(usage === undefined ? {} : { usage }) });

test('usage is added up by span of time and by what woke the agent, and a reply without usage or with one of another shape counts for nothing', () => {
  const r = usageReport([
    said('terminal', 3000), reply(2999, { input: 1000, output: 10 }, 'g1'),
    said('clock', 120), reply(119, { input: 2000, output: 20, cached: 500 }),
    said('terminal', 30), reply(29, { input: 4000, output: 40, cached: 4000 }), reply(28, { input: 4000, output: 5, cached: 9999 }),
    reply(27, undefined), reply(26, 'much'), reply(25, { input: 'many', output: -1 }),
  ], NOW, 'g2');
  const span = Object.fromEntries(r.spans.map((s) => [s.name, s.spent]));
  expect(span['the last hour']).toEqual({ requests: 3, input: 8000, cached: 8000, output: 45 });
  expect(span['the last 24 hours']).toEqual({ requests: 4, input: 10_000, cached: 8500, output: 65 });
  expect(span['this generation']).toEqual({ requests: 4, input: 10_000, cached: 8500, output: 65 });
  expect(span['this whole life']).toEqual({ requests: 5, input: 11_000, cached: 8500, output: 75 });
  // What is read from the cache is never more than what was sent.
  expect(share(span['the last hour']!)).toBe('100%');
  expect(r.sources.map((s) => [s.name, s.spent.requests, s.spent.input])).toEqual([['terminal', 3, 8000], ['clock', 1, 2000]]);
  const lines = formatUsage(r);
  expect(lines[0]).toMatch(/requests +input +cached +output +input\/request$/);
  expect(lines[2]).toMatch(/^the last 24 hours +4 +10k +85% +65 +2\.5k$/);
  expect(lines.join('\n')).toContain('by what woke it');
});

test('a journal with no usage says so, and the footer says nothing of a cache the body does not report', () => {
  expect(formatUsage(usageReport([said('terminal', 5), reply(4, undefined)], NOW, null))).toEqual(['The journal holds no usage: this body does not journal what its requests cost.']);
  expect(cacheUse(50_000, null)).toBe('');
  expect(cacheUse(50_000, 0)).toBe('cached 0%');
  expect(cacheUse(54_396, 52_608)).toBe('cached 97%');
});
