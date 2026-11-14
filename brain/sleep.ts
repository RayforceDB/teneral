import { appendEvent, readEvents, type JournalEvent, type Usage } from './journal';
import { DEFAULT_BUDGET, buildMessages } from './memory';
import { MEMORY_MARK } from './logbook';
import { episodes, thin, type Episode } from './episodes';
import { FACT_KIND, INTENTION_KIND, SOURCES, byMark, known, type FactData, type IntentionData, type Source } from './known';
import { EPISODE_KIND, OUTCOMES, QUARANTINE_KIND, remembered, type MemoryData, type Outcome, type QuarantineData } from './remembered';
import type { ChatMessage, Provider, ToolSpec } from './provider';
import { saysTooLong } from './retry';
import { asText } from './stemnote';

// Sleep is when the agent forms its memories. While nothing is asked of it, it takes the oldest
// episode that is over and has no memory yet, and asks its own model, as itself, what it will
// remember of it. The answer is journaled as a note and from then on stands for that episode
// wherever the episode itself no longer fits (brain/logbook.ts).
//
// Three rules keep a memory honest.
//   The request shows the journal only up to the end of the episode: the agent remembers it as it
//   knew things then, not with what it learned later. Of that, it shows what was remembered
//   before as memories and only the episode itself as it happened. By the time an episode is over
//   no provider still keeps its work on the conversation, so everything sent is paid for in full;
//   sent this way, a memory costs one more reading of its episode and little else.
//   Only a whole answer in the form asked for becomes a memory. A refusal, half an answer or a
//   tool call does not; after a second try the stretch is recorded as one no memory could be
//   formed of, and it stays in the journal as it happened.
//   An episode in which nothing happened is recorded as quiet without asking a model, which,
//   asked to remember nothing, might invent something.
//
// With the memory the agent may set down what it learned that will hold beyond the episode, and
// what it took on to do later (brain/known.ts). Those are asked for sparingly: a fact is worth
// keeping only if it would change what the agent does some later week, and its own remarks are
// not facts. What it sets down is checked line by line, and a line that is not in form is left
// out; the memory itself is kept all the same.

/** A memory is asked to be about this share of its episode's size, within the two bounds below. */
const SHARE = 1 / 25;
const MIN_CHARS = 600;
const MAX_CHARS = 4000;
/** An answer longer than this many times what was asked for is not a memory but a copy. */
const TOO_LONG = 3;
/** The shortest text that can be a memory of something. */
const LEAST_CHARS = 40;
/** How many characters of the episode's first message the request quotes, to say where the episode begins. */
const OPENING_CHARS = 160;
const TITLE_CHARS = 120;

/** What the journal says for an episode in which nothing happened. */
export const QUIET = { title: 'A quiet stretch', text: 'Nothing happened that is worth remembering.' };

export interface SleepDeps {
  journal: string;
  gen: string;
  provider: Provider;
  /** The agent's tools as a turn declares them. None is to be called; they are sent so that this request starts as a turn's does. */
  specs: ToolSpec[];
  system: () => string;
  /** Characters for one request, as for a turn. */
  budgetChars?: number;
  /** Aborts when something arrives: the agent wakes, and the memory is formed another time. */
  signal?: AbortSignal;
}

/** What one call did. `nothing`: no episode is waiting. `woken`: something arrived first, and nothing was written. */
export type Slept = 'nothing' | 'remembered' | 'quiet' | 'quarantined' | 'woken';

/** How many characters the memory of an episode of this size is asked to be. */
export function targetChars(episodeChars: number): number {
  return Math.min(MAX_CHARS, Math.max(MIN_CHARS, Math.round(episodeChars * SHARE)));
}

/** The episodes that are over and have neither a memory nor a record of there being none, oldest first. */
export function waiting(events: JournalEvent[]): Episode[] {
  return episodes(events, remembered(events).spans).filter((e) => e.closed && e.why !== 'kept');
}

/** How the agent's memory stands, for its owner to see: what is still to be remembered and what could not be. */
export interface MemoryHealth {
  remembered: number;
  waiting: number;
  /** The end of the oldest episode still waiting, or null. */
  oldest: string | null;
  quarantined: number;
}

export function memoryHealth(events: JournalEvent[]): MemoryHealth {
  const { memories, quarantined } = remembered(events);
  const owed = waiting(events);
  return { remembered: memories.size, waiting: owed.length, oldest: owed[0]?.end ?? null, quarantined: quarantined.size };
}

/** A journal time to the minute, in UTC. */
const when = (ts: string): string => `${ts.slice(0, 16).replace('T', ' ')} UTC`;

/** The first words of the episode, as the agent was shown them: how the request says where the episode begins. */
function opening(events: JournalEvent[]): string {
  for (const e of events) {
    const r = e as { text?: unknown };
    const text = e.type === 'stimulus' || e.type === 'assistant' ? asText(r.text).trim() : '';
    if (text !== '') return text.slice(0, OPENING_CHARS).replace(/\s+/g, ' ');
  }
  return '';
}

/** What the agent is asked, after the journal up to the end of the episode. */
export function question(episode: Episode, events: JournalEvent[], chars: number): string {
  const begins = opening(events);
  return [
    `${MEMORY_MARK} It is time to form a memory. It is of the stretch of the conversation above from ${when(episode.start)} to ${when(episode.end)}: `
    + `${begins === '' ? 'the last part of it' : `it begins with the message that starts "${begins}"`} and ends with the last message above. `
    + 'What came before that stretch you already remember or still see above; do not tell it again.',
    'Write in the first person, as yourself, in the language you were speaking. Keep what you would need later: what was asked and by whom, '
    + 'what you did, what you decided and why, exact names, paths, numbers and commands, what failed, and what is left open. '
    + 'Where your owner\'s own words matter, quote them. Do not copy long output, and do not say anything that the conversation above does not show.',
    'Call no tool. Reply in exactly this form and with nothing else:',
    `Title: <one line>\nOutcome: <one of: done, failed, dropped, open>\n\n<the memory, about ${chars} characters>`,
    'Outcome is how the stretch ended: done when what was asked got done, failed when it did not work, dropped when it was given up or set aside, open when it is still going on.',
    'After the memory you may add two lists, each only when there is something for it. Most stretches have neither.',
    'Facts:\n- [owner] <one thing that holds, in a sentence that can be understood on its own>\n'
    + 'A fact is worth a line only if knowing it would change what you do some later week: who your owner is and what they want, how they want things done, '
    + 'where things are, what turned out to be true about the world you work in. What you did belongs in the memory, not here, and your own opinions are not facts. '
    + `In the brackets say where it comes from: ${SOURCES.join(', ')} (owner: your owner said it; seen: you saw it yourself, as in a tool's output; `
    + 'read: it stood in something from outside, such as a page or a message from someone else; inferred: you concluded it). '
    + 'When a fact takes the place of one you already hold, listed above with its mark, name that mark: - [owner] (replaces F1a2b3c4) <the fact as it holds now>',
    'Intentions:\n- [YYYY-MM-DD] <something you took on to do later and have not done; the day it is due>\n- [] <the same, when no day was named>',
  ].join('\n\n');
}

/** A line of the answer without the marks a model may put around a label. */
const plain = (line: string): string => line.replace(/^[\s#*_>-]+/, '').replace(/[*_]+/g, '').trim();

/** A fact as the agent set it down: the fact it replaces is still only a mark. */
export interface NotedFact { text: string; source: Source; replaces: string[] }
export interface Formed {
  title: string;
  text: string;
  outcome: Outcome;
  facts: NotedFact[];
  intentions: { text: string; due?: string }[];
}

const FACT_LINE = /^-\s*\[\s*([a-z]+)\s*\]\s*(?:\(\s*replaces\s+([^)]*)\)\s*)?(.+)$/i;
const INTENTION_LINE = /^-\s*\[\s*(\d{4}-\d{2}-\d{2})?\s*\]\s*(.+)$/;
/** The most of either that one episode may set down: a list longer than this is not a list of what matters. */
const LIST_MAX = 12;

/** The two lists at the end of an answer, and the answer without them. A line that is not in form is left out. */
function lists(lines: string[]): { body: string[]; facts: NotedFact[]; intentions: Formed['intentions'] } {
  const heading = (line: string): 'facts' | 'intentions' | null => {
    const word = plain(line).toLowerCase();
    return word === 'facts:' ? 'facts' : word === 'intentions:' ? 'intentions' : null;
  };
  const first = lines.findIndex((line) => heading(line) !== null);
  const facts: NotedFact[] = [];
  const intentions: Formed['intentions'] = [];
  if (first === -1) return { body: lines, facts, intentions };
  let list: 'facts' | 'intentions' | null = null;
  for (const line of lines.slice(first)) {
    list = heading(line) ?? list;
    const item = line.trim();
    if (list === 'facts' && facts.length < LIST_MAX) {
      const m = FACT_LINE.exec(item);
      const source = SOURCES.find((s) => s === m?.[1]?.toLowerCase());
      if (m && source !== undefined && m[3]!.trim().length >= 8) facts.push({ source, text: m[3]!.trim(), replaces: (m[2] ?? '').split(/[\s,]+/).filter((mark) => mark !== '') });
    } else if (list === 'intentions' && intentions.length < LIST_MAX) {
      const m = INTENTION_LINE.exec(item);
      if (m && m[2]!.trim().length >= 8) intentions.push({ text: m[2]!.trim(), ...(m[1] ? { due: m[1] } : {}) });
    }
  }
  return { body: lines.slice(0, first), facts, intentions };
}

/**
 * The memory in a reply, or the reason it is not one. The form is strict on purpose: a refusal or
 * a rambling answer read leniently would become a false memory, and those are kept for good.
 */
export function parseMemory(reply: string, chars: number): Formed | { problem: string } {
  const { body: lines, facts, intentions } = lists(reply.replaceAll('\r', '').split('\n'));
  let at = 0;
  const next = (): string => {
    while (at < lines.length && lines[at]!.trim() === '') at += 1;
    return at < lines.length ? plain(lines[at++]!) : '';
  };
  const title = /^title\s*:\s*(.+)$/i.exec(next())?.[1]?.trim();
  if (title === undefined || title === '') return { problem: 'the first line was not "Title: ..."' };
  const said = /^outcome\s*:\s*([a-z]+)/i.exec(next())?.[1]?.toLowerCase();
  const outcome = OUTCOMES.find((o) => o === said && o !== 'quiet');
  if (outcome === undefined) return { problem: 'the second line was not "Outcome:" with one of done, failed, dropped, open' };
  const text = lines.slice(at).join('\n').trim();
  if (text.length < LEAST_CHARS) return { problem: 'there was no memory after the two lines' };
  if (text.length > chars * TOO_LONG) return { problem: `the memory was ${text.length} characters, far more than the ${chars} asked for` };
  return { title: title.slice(0, TITLE_CHARS), text, outcome, facts, intentions };
}

const span = (e: Episode): Pick<MemoryData, 'from' | 'to' | 'start' | 'end'> => ({ from: e.first, to: e.last, start: e.start, end: e.end });

/**
 * Forms one memory: of the oldest episode that waits for one. Throws what the provider throws; a
 * failed request writes nothing, and the episode waits on.
 */
export async function sleep(d: SleepDeps): Promise<Slept> {
  const events = readEvents(d.journal);
  const episode = waiting(events)[0];
  if (episode === undefined) return 'nothing';
  const lived = events.slice(episode.from, episode.to);
  if (thin(lived)) {
    appendEvent(d.journal, d.gen, { type: 'note', kind: EPISODE_KIND, data: { ...span(episode), ...QUIET, outcome: 'quiet' } satisfies MemoryData });
    return 'quiet';
  }

  const chars = targetChars(episode.chars);
  const ask = question(episode, lived, chars);
  let budget = (d.budgetChars ?? DEFAULT_BUDGET) - JSON.stringify(d.specs).length;
  // Only the journal up to the end of the episode: the memory is formed as of then. The memories of
  // what came before it belong to that, wherever they were journaled: they are written when there is
  // time, which is always later than what they are about.
  const earlier = events.slice(episode.to).filter((e) => e.type === 'note' && (
    e.kind === EPISODE_KIND || e.kind === QUARANTINE_KIND || e.kind === FACT_KIND
    // An intention set down with a memory names its episode; one the agent made itself, in some later turn, is no part of what it knew then.
    || (e.kind === INTENTION_KIND && typeof (e.data as { episode?: unknown } | null)?.episode === 'string')
  ));
  const asOf = [...events.slice(0, episode.to), ...earlier];
  let messages: ChatMessage[] = buildMessages(asOf, d.system(), budget, undefined, { ask, tailChars: 0 });
  let usage: Usage | undefined;
  let problem = '';
  let halved = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let reply;
    try {
      reply = await d.provider(messages, d.specs, d.signal && { signal: d.signal });
    } catch (err) {
      if (d.signal?.aborted) return 'woken';
      if (halved || !saysTooLong(err)) throw err;
      // Characters are only an estimate of tokens: once more with half, as a turn does.
      halved = true;
      budget = Math.floor(budget / 2);
      messages = buildMessages(asOf, d.system(), budget, undefined, { ask, tailChars: 0 });
      attempt -= 1;
      continue;
    }
    if (d.signal?.aborted) return 'woken';
    usage = reply.usage;
    const memory = reply.toolCalls.length > 0 ? { problem: 'a tool was called' } : parseMemory(reply.text, chars);
    if (!('problem' in memory)) {
      const { facts, intentions, ...kept } = memory;
      appendEvent(d.journal, d.gen, {
        type: 'note', kind: EPISODE_KIND,
        data: { ...span(episode), ...kept, ...(usage ? { usage } : {}) } satisfies MemoryData & { usage?: Usage },
      });
      // A fact may name the one it replaces only by a mark it was shown: a mark that names nothing, or an intention, replaces nothing.
      const held = known(asOf);
      for (const fact of facts) {
        const replaces = fact.replaces.map((mark) => byMark(held, mark)).filter((item) => item !== null && held.facts.some((f) => f.id === item.id)).map((item) => item!.id);
        appendEvent(d.journal, d.gen, {
          type: 'note', kind: FACT_KIND,
          data: { text: fact.text, source: fact.source, episode: episode.first, ...(replaces.length > 0 ? { replaces } : {}) } satisfies FactData,
        });
      }
      for (const intention of intentions) {
        appendEvent(d.journal, d.gen, { type: 'note', kind: INTENTION_KIND, data: { ...intention, episode: episode.first } satisfies IntentionData });
      }
      return 'remembered';
    }
    problem = memory.problem;
    messages = [
      ...messages,
      { role: 'assistant', content: reply.text.trim() === '' ? '(no text)' : reply.text },
      { role: 'user', content: `${MEMORY_MARK} That cannot be kept as a memory: ${problem}. Reply again in exactly the form asked for, and call no tool.` },
    ];
  }
  appendEvent(d.journal, d.gen, { type: 'note', kind: QUARANTINE_KIND, data: { ...span(episode), reason: problem } satisfies QuarantineData });
  return 'quarantined';
}
