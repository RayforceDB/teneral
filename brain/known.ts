import type { JournalEvent } from './journal';
import { withdrawn } from './owned';

// What the agent knows and what it means to do, as they lie in the journal. Beside the memory of
// an episode (brain/remembered.ts) there are two smaller things that outlive it.
//
// A fact is one thing that holds: something the owner said about themselves or how to work,
// something the agent saw. It is never changed. When it stops holding, a new fact says so by
// naming the one it replaces, and the old one stays in the journal, replaced. So "what holds now"
// is always worked out, never stored, and what was believed at any earlier time can be read back.
// Every fact says where it comes from, because a thing read on a web page and a thing the owner
// said are not the same kind of knowledge, however alike their words.
//
// An intention is something to do later. It stays open until a record says it was done or given
// up. An agent that forgets what it promised is worse than one that forgets what happened.
// Most are taken on for someone, in the course of work. Two kinds are the agent's own, set down
// when it looks over its memories (brain/agenda.ts): a thing nobody asked for that it means to do
// in time of its own, and a question it means to put to its owner. Together, in order, the open
// intentions are the agent's agenda: what a clock tick offers it (body/sensors.ts).

export const FACT_KIND = 'memory.fact.v1';
export const INTENTION_KIND = 'memory.intention.v1';
export const DONE_KIND = 'memory.intention.done.v1';
/** The owner's, or the agent's own, word that a fact or an intention is to be left out from now on. The note it names stays in the journal. */
export const FORGET_KIND = 'memory.forget.v1';

/** Where a fact comes from. `owner`: the owner said it. `seen`: the agent saw it itself. `read`: it stood in something from outside. `inferred`: the agent concluded it. */
export const SOURCES = ['owner', 'seen', 'read', 'inferred'] as const;
export type Source = (typeof SOURCES)[number];

export interface FactData {
  text: string;
  source: Source;
  /** The id of the first event of the episode it was learned in: where to open the journal to see it said. */
  episode: string;
  /** Ids of the fact notes this one takes the place of. */
  replaces?: string[];
}
export interface Fact extends FactData {
  id: string;
  /** What the agent calls it: short enough to type, and to say which fact a new one replaces. */
  mark: string;
  at: string;
}

/** Whose idea an intention was, when not taken on for someone: `own`, a thing nobody asked for; `ask`, a question for the owner. */
export const ORIGINS = ['own', 'ask'] as const;
export type Origin = (typeof ORIGINS)[number];

export interface IntentionData {
  text: string;
  /** Absent for what was taken on for the owner or anyone else. */
  origin?: Origin;
  /** The day it is due, as YYYY-MM-DD, when it has one. */
  due?: string;
  episode?: string;
}
export interface Intention extends IntentionData {
  id: string;
  mark: string;
  at: string;
}

export interface Known {
  /** The facts that hold now: not replaced and not forgotten, in the order they were learned. */
  facts: Fact[];
  /** The intentions that are open, in the order they were made. */
  intentions: Intention[];
}

/** The first characters of a note's id, with a letter saying what it is: a mark the agent can type. */
const markOf = (letter: 'F' | 'I', id: string): string => `${letter}${id.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}`;
const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Everything known in `events`, as it holds after the last of them. Notes are the body's to write, so none is taken on trust. */
export function known(events: JournalEvent[]): Known {
  const facts = new Map<string, Fact>();
  const intentions = new Map<string, Intention>();
  // What the owner withdrew is gone like what was replaced or forgotten.
  const gone = withdrawn(events);
  for (const e of events) {
    if (e.type !== 'note' || typeof e.data !== 'object' || e.data === null) continue;
    const d = e.data as Record<string, unknown>;
    if (e.kind === FACT_KIND) {
      if (!text(d.text) || !SOURCES.includes(d.source as Source) || !text(d.episode)) continue;
      const replaces = Array.isArray(d.replaces) ? d.replaces.filter((id): id is string => typeof id === 'string') : [];
      for (const id of replaces) gone.add(id);
      facts.set(e.id, { id: e.id, mark: markOf('F', e.id), at: e.ts, text: d.text, source: d.source as Source, episode: d.episode, ...(replaces.length > 0 ? { replaces } : {}) });
    } else if (e.kind === INTENTION_KIND) {
      if (!text(d.text)) continue;
      intentions.set(e.id, {
        id: e.id, mark: markOf('I', e.id), at: e.ts, text: d.text,
        ...(ORIGINS.includes(d.origin as Origin) ? { origin: d.origin as Origin } : {}),
        ...(typeof d.due === 'string' && DAY.test(d.due) ? { due: d.due } : {}), ...(text(d.episode) ? { episode: d.episode } : {}),
      });
    } else if (e.kind === DONE_KIND) {
      if (typeof d.intention === 'string') gone.add(d.intention);
    } else if (e.kind === FORGET_KIND) {
      if (Array.isArray(d.ids)) for (const id of d.ids) if (typeof id === 'string') gone.add(id);
    }
  }
  return {
    facts: [...facts.values()].filter((fact) => !gone.has(fact.id)),
    intentions: [...intentions.values()].filter((intention) => !gone.has(intention.id)),
  };
}

/** The fact or intention the agent means by `mark`, among what holds now; null when there is none, or more than one. */
export function byMark(held: Known, mark: string): Fact | Intention | null {
  const wanted = mark.trim();
  const found = [...held.facts, ...held.intentions].filter((item) => item.mark === wanted || item.id === wanted);
  return found.length === 1 ? found[0]! : null;
}

/** Characters the list below may take in a request. Past it the oldest facts are left out, and found by `recall` like everything else. */
export const KNOWN_CHARS = 6000;

/**
 * What is known, as the agent is shown it in every request: the facts that hold, each with its
 * mark and its source, and the open intentions, with those that are due said to be due. `today`
 * is the day of the journal's last event, so the same journal always gives the same text.
 */
export function knownText(held: Known, today: string, mark: string): string | null {
  if (held.facts.length === 0 && held.intentions.length === 0) return null;
  const lines: string[] = [];
  const todo = held.intentions.filter((i) => i.origin !== 'ask');
  const asks = held.intentions.filter((i) => i.origin === 'ask');
  if (todo.length > 0) {
    lines.push(`${mark} What you mean to do, each with its mark:`);
    for (const i of todo) {
      const due = i.due === undefined ? '' : i.due <= today ? ` [due ${i.due}, which has come]` : ` [due ${i.due}]`;
      lines.push(`${i.mark}${i.origin === 'own' ? ' [your own idea]' : ''}${due} ${i.text}`);
    }
  }
  if (asks.length > 0) {
    lines.push(`${mark} What you mean to ask your owner when they next write, each with its mark; close it with \`done\` once it is asked and answered:`);
    for (const i of asks) lines.push(`${i.mark} ${i.text}`);
  }
  if (held.facts.length > 0) {
    const rows = held.facts.map((f) => `${f.mark} [${f.source}] ${f.text}`);
    // The newest that fit; an agent's life should not push out what it learned last.
    let from = rows.length;
    let size = 0;
    while (from > 0 && size + rows[from - 1]!.length + 1 <= KNOWN_CHARS) size += rows[--from]!.length + 1;
    lines.push(`${mark} What you know, each with its mark and where it comes from${from > 0 ? ` (${from} older ones are not shown; \`recall\` finds them)` : ''}:`);
    lines.push(...rows.slice(from));
  }
  return lines.join('\n');
}

/**
 * The agenda: what is open and can be done without the owner, in the order to take it. First what
 * is past its day or due today, the earliest day first; then what was taken on for someone, the
 * oldest first; then the agent's own ideas. Questions for the owner are no part of it: they wait
 * for the owner.
 */
export function agenda(held: Known, today: string): Intention[] {
  const todo = held.intentions.filter((i) => i.origin !== 'ask');
  const come = todo.filter((i) => i.due !== undefined && i.due <= today).sort((a, b) => a.due!.localeCompare(b.due!));
  const rest = todo.filter((i) => !come.includes(i));
  return [...come, ...rest.filter((i) => i.origin === undefined), ...rest.filter((i) => i.origin === 'own')];
}
