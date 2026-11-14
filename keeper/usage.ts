// What the model was asked for, as the journal has it: the body journals with each reply what the
// provider said the request cost. Nothing here asks anyone anything; it only adds up.
import { tokens } from './tui/view';
import type { JournalEvent } from '../brain/journal';
import { known } from '../brain/known';
import { health } from '../brain/health';
import { rate } from '../brain/exam';

export interface Spent {
  requests: number;
  input: number;
  /** Of `input`, what the provider read from its cache. Counted only where the body journals it. */
  cached: number;
  output: number;
}

const NONE = (): Spent => ({ requests: 0, input: 0, cached: 0, output: 0 });

const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0);

/** The share of the input that came from the provider's cache, as `87%`; empty when nothing was asked. */
export const share = (s: Spent): string => (s.input > 0 ? `${Math.round((s.cached / s.input) * 100)}%` : '');

/** The row for what forming memories cost: requests the agent makes of itself while nothing is asked of it. */
export const REMEMBERING = 'remembering';

export interface UsageReport {
  /** By span of time, the widest last. */
  spans: { name: string; spent: Spent }[];
  /** By what woke the agent for the turn the request belongs to, with `REMEMBERING` for the requests that belong to none; the costliest first. */
  sources: { name: string; spent: Spent }[];
  /** How the agent's memory stands, in a line; empty for a journal with no episode that is over. */
  memory: string;
}

/** The agent's memory in a line or two: how it stands and why, what is remembered and waits, what it holds, and what its last exam came to. */
export function memoryLine(events: JournalEvent[], now: number): string {
  const h = health(events, now);
  const held = known(events);
  if (h.remembered + h.waiting + h.quarantined + held.facts.length + held.intentions.length === 0) return '';
  const hours = h.oldest === null ? 0 : Math.max(0, Math.round((now - Date.parse(h.oldest)) / 3_600_000));
  const percent = (share: number): string => `${Math.round(share * 100)}%`;
  const counts = [
    `${h.remembered} episodes remembered`,
    h.waiting === 0 ? 'none waiting' : `${h.waiting} waiting to be (the oldest ended ${hours} h ago)`,
    ...(h.quarantined === 0 ? [] : [`of ${h.quarantined} no memory could be formed`]),
    `${held.facts.length} facts held`,
    `${held.intentions.length} intentions open`,
  ].join(', ');
  const exam = h.exam === null ? '' : ` Exam of ${h.exam.at.slice(0, 16).replace('T', ' ')}: recall found ${percent(rate(h.exam.recall))} of ${h.exam.recall.questions}, `
    + `the words as they stand ${percent(rate(h.exam.plain))}${h.exam.told.questions === 0 ? '' : `, and the memories themselves told ${percent(rate(h.exam.told))} of ${h.exam.told.questions}`}.`;
  return `Memory is ${h.state}${h.reasons.length === 0 ? '' : `: ${h.reasons.join('; ')}`}. ${counts}.${exam}`;
}

/** Add up every journaled usage: by span of time ending at `now`, and over the last day by what started the turn. */
export function usageReport(events: JournalEvent[], now: number, generation: string | null): UsageReport {
  const HOUR = 3_600_000;
  const spans = [
    { name: 'the last hour', from: now - HOUR, spent: NONE() },
    { name: 'the last 24 hours', from: now - 24 * HOUR, spent: NONE() },
    { name: 'this generation', from: Number.NaN, spent: NONE() },
    { name: 'this whole life', from: -Infinity, spent: NONE() },
  ];
  const sources = new Map<string, Spent>();
  let source = 'the start';
  const add = (s: Spent, input: number, cached: number, output: number): void => {
    s.requests += 1;
    s.input += input;
    s.cached += Math.min(cached, input);
    s.output += output;
  };
  for (const e of events) {
    const f = e as unknown as Record<string, unknown>;
    if (e.type === 'stimulus') {
      source = typeof f.source === 'string' && f.source !== '' ? f.source.slice(0, 40) : 'unknown';
      continue;
    }
    // A reply carries what its request cost. So does a memory (brain/sleep.ts), whose request is no part of any turn.
    const memory = e.type === 'note' && typeof f.kind === 'string' && f.kind.startsWith('memory.') && typeof f.data === 'object' && f.data !== null;
    const told = memory ? (f.data as Record<string, unknown>).usage : e.type === 'assistant' ? f.usage : null;
    if (typeof told !== 'object' || told === null) continue;
    const u = told as Record<string, unknown>;
    const input = count(u.input);
    const output = count(u.output);
    const cached = count(u.cached);
    const at = Date.parse(typeof f.ts === 'string' ? f.ts : '');
    for (const span of spans) {
      const inSpan = Number.isNaN(span.from) ? generation !== null && f.gen === generation : Number.isFinite(at) ? at >= span.from : span.from === -Infinity;
      if (inSpan) add(span.spent, input, cached, output);
    }
    if (Number.isFinite(at) && at >= now - 24 * HOUR) {
      const name = memory ? REMEMBERING : source;
      if (!sources.has(name)) sources.set(name, NONE());
      add(sources.get(name)!, input, cached, output);
    }
  }
  return {
    spans: spans.map(({ name, spent }) => ({ name, spent })),
    sources: [...sources].map(([name, spent]) => ({ name, spent })).sort((a, b) => b.spent.input - a.spent.input),
    memory: memoryLine(events, now),
  };
}

function table(head: string, rows: { name: string; spent: Spent }[]): string[] {
  const cells = rows.map(({ name, spent }) => [name, String(spent.requests), tokens(spent.input), spent.requests === 0 ? '' : share(spent), tokens(spent.output),
    spent.requests === 0 ? '' : tokens(spent.input / spent.requests)]);
  const all = [[head, 'requests', 'input', 'cached', 'output', 'input/request'], ...cells];
  const wide = all[0]!.map((_, i) => Math.max(...all.map((row) => row[i]!.length)));
  return all.map((row) => row.map((cell, i) => (i === 0 ? cell.padEnd(wide[i]!) : cell.padStart(wide[i]!))).join('  ').trimEnd());
}

/** The report as lines of plain text, in two tables. */
export function formatUsage(r: UsageReport): string[] {
  if (r.spans.at(-1)!.spent.requests === 0) return ['The journal holds no usage: this body does not journal what its requests cost.'];
  return [
    ...table('', r.spans),
    '',
    ...(r.sources.length > 0 ? [...table('the last 24 hours, by what woke it', r.sources), ''] : []),
    ...(r.memory === '' ? [] : [r.memory, '']),
    'Tokens, as the provider counted them. "cached" is the share of the input it read from its cache: a request that only adds to the one before should be nearly all cached, and what is not is paid in full.',
  ];
}
