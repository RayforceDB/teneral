import { expect, test } from 'bun:test';
import type { JournalEvent } from '../../brain/journal';
import { cacheUse } from '../../keeper/tui/view';
import { REMEMBERING, formatUsage, memoryLine, share, usageReport } from '../../keeper/usage';

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

test('what forming memories cost is counted, in a row of its own: those requests belong to no turn', () => {
  const memory = (minutesAgo: number, usage: unknown): JournalEvent => ev({ type: 'note', kind: 'memory.episode.v1', data: { title: 't', usage }, ts: at(minutesAgo), gen: 'g2' });
  const r = usageReport([
    said('terminal', 30), reply(29, { input: 1000, output: 10, cached: 900 }),
    memory(20, { input: 500, output: 60 }), memory(10, { input: 700, output: 80, cached: 100 }),
    // A memory without usage, and a note of another kind that happens to carry one, count for nothing.
    memory(5, undefined), ev({ type: 'note', kind: 'other.v1', data: { usage: { input: 9, output: 9 } }, ts: at(4), gen: 'g2' }),
  ], NOW, 'g2');
  expect(r.spans[0]!.spent).toEqual({ requests: 3, input: 2200, cached: 1000, output: 150 });
  expect(Object.fromEntries(r.sources.map((s) => [s.name, s.spent]))).toEqual({
    [REMEMBERING]: { requests: 2, input: 1200, cached: 100, output: 140 },
    terminal: { requests: 1, input: 1000, cached: 900, output: 10 },
  });
  expect(formatUsage(r).join('\n')).toContain('remembering');
});

test('the report says how the memory stands: what is remembered, what waits, what could not be, and what is held', () => {
  const t = (minutesAgo: number): string => at(minutesAgo);
  const a = [ev({ id: 'a1', type: 'stimulus', source: 'terminal', text: 'set up the mail please', ts: t(600), gen: 'g' }), ev({ id: 'a2', type: 'assistant', text: 'done, it works now', toolCalls: [], ts: t(599), gen: 'g' })];
  const b = [ev({ id: 'b1', type: 'stimulus', source: 'terminal', text: 'and the calendar too please', ts: t(300), gen: 'g' }), ev({ id: 'b2', type: 'assistant', text: 'the calendar is set up', toolCalls: [], ts: t(299), gen: 'g' })];
  const c = [ev({ id: 'c1', type: 'stimulus', source: 'terminal', text: 'thanks', ts: t(10), gen: 'g' })];
  const memory = ev({ id: 'n1', type: 'note', kind: 'memory.episode.v1', data: { from: 'a1', to: 'a2', start: t(600), end: t(599), title: 'Mail', text: 'I set up the mail.', outcome: 'done' }, ts: t(9), gen: 'g' });
  const fact = ev({ id: 'f1', type: 'note', kind: 'memory.fact.v1', data: { text: 'The owner uses the work address', source: 'owner', episode: 'a1' }, ts: t(9), gen: 'g' });
  const intention = ev({ id: 'i1', type: 'note', kind: 'memory.intention.v1', data: { text: 'Send the weekly report' }, ts: t(9), gen: 'g' });
  expect(memoryLine([...a, ...b, ...c, memory, fact, intention], NOW)).toBe(
    'Memory: 1 episodes remembered, 1 waiting to be (the oldest ended 5 h ago), 1 facts held, 1 intentions open.',
  );
  expect(memoryLine([...a, memory], NOW)).toBe('Memory: 1 episodes remembered, none waiting, 0 facts held, 0 intentions open.');
  expect(memoryLine(c, NOW)).toBe('');
  expect(formatUsage(usageReport([...a, { ...a[1]!, usage: { input: 5, output: 1 } } as JournalEvent, memory], NOW, 'g')).join('\n')).toContain('Memory: 1 episodes remembered');
});
