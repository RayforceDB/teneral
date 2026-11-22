import type { JournalEvent } from './journal';
import { WITHDRAW_KIND, fromOwner } from './owned';

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
//
// A question is for whoever can answer it: the owner, one person, the people of some chat. Whom
// it is for and where to reach them is the agent's to decide and to say, in its own words (`to`);
// nothing here knows of any channel, and the agent asks by whatever way its body has.
//
// An idea of its own that the agent is not sure its owner allows is neither done nor dropped: it
// is kept, waiting for the owner's word, and the agent puts it to the owner as a question, where
// it judges the owner will see it. A yes is recorded with the owner's own words, which must stand
// in a message of the owner's that came after the idea was set down, and with where that message
// came from; then the idea joins the agenda. A no closes it, with the reason. A message is the
// owner's when its source says so (`fromOwner` in brain/owned.ts): the terminal, or any sensor
// that has made sure of the sender. No idea is lost for want of a permission.

export const FACT_KIND = 'memory.fact.v1';
export const INTENTION_KIND = 'memory.intention.v1';
export const DONE_KIND = 'memory.intention.done.v1';
/** The owner's, or the agent's own, word that a fact or an intention is to be left out from now on. The note it names stays in the journal. */
export const FORGET_KIND = 'memory.forget.v1';
/** The owner said yes to an idea that waited for their word: the idea, the owner's words, and the message they stand in. */
export const ALLOWED_KIND = 'memory.intention.allowed.v1';
/** A saved commitment's progress. The intention remains the one agenda item; these notes only update its work state. */
export const WORK_KIND = 'memory.work.v1';
/** A legacy JSON task already considered by the importer, including one later closed or withdrawn. */
export const LEGACY_WORK_KIND = 'memory.work.import.v1';

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
  /** The person it is about, when it is about one: how the agent knows whom to ask what. */
  about?: string;
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
  /** An idea of its own that the agent is not sure its owner allows: it waits for the owner's word. */
  unsure?: true;
  /** Whom a question is for and where to reach them, in the agent's own words. Absent: the owner, wherever the agent reaches them. */
  to?: string;
  /** The day it is due, as YYYY-MM-DD, when it has one. */
  due?: string;
  episode?: string;
}
export interface Intention extends IntentionData {
  id: string;
  mark: string;
  at: string;
  /** Waits for the owner: a question for them, or an idea they have not said yes to. It is no part of the agenda. */
  waits: boolean;
  /** Whether the agent has put it to the owner: its mark stands in something the agent said, or sent with a tool, since. Only of what waits. */
  put: boolean;
  /** When it was last put to whom it is for, and on how many occasions so far. */
  putAt?: string;
  puts: number;
  /** How it ended, once it is closed (`Known.closed`), when, and in which generation the record of it was written. */
  ended?: Ended;
  endedAt?: string;
  endedGen?: string;
  /** The owner's words that allowed it, for an idea that waited and waits no longer, and the source of the message they stood in. */
  allowed?: string;
  allowedIn?: string;
  /** Optional execution state for a commitment made with the work tool. */
  work?: WorkState;
}

export interface WorkState {
  status: 'queued' | 'waiting';
  next: string;
  attempts: number;
  /** Milliseconds since epoch: when an automatic resumption may be offered, not a calendar due date. */
  resumeAt: number;
  /**
   * Of what waits: milliseconds since epoch at which it is worth looking again. Absent, it waits for
   * something that arrives by itself (the owner's word, a notification) and is not looked at on a schedule.
   */
  checkAt?: number;
  /**
   * Of what waits: the id of another intention that this one comes after. When that one is no longer
   * open, this one is ready, and the agent is woken to take it (body/work.ts). It is how "finish this,
   * then go on to that" is held: the second is on the agenda from the start, and is not lost when the first is closed.
   */
  after?: string;
  /** When this state was recorded: the time of the note that holds it. Worked out, never stored. */
  at?: string;
  outcome?: string;
  recovery?: string;
  evidence?: string;
}

/**
 * How a closed intention ended. `done`: it was carried out. `dropped`: it was given up. `refused`: an idea
 * that waited for the owner's word, and the word was no. `answered`: a question that got its answer.
 */
export const ENDS = ['done', 'dropped', 'refused', 'answered'] as const;
export type Ended = (typeof ENDS)[number];
/** Being named again within this long is the same occasion of asking, not a new one. */
const SAME_ASKING_MS = 12 * 3_600_000;

export interface Known {
  /** The facts that hold now: not replaced and not forgotten, in the order they were learned. */
  facts: Fact[];
  /** The intentions that are open, in the order they were made. */
  intentions: Intention[];
  /** The intentions that were closed, each with how it ended: what the agent's initiative is measured by (brain/agenda.ts). */
  closed: Intention[];
}

/** The first characters of a note's id, with a letter saying what it is: a mark the agent can type. */
const markOf = (letter: 'F' | 'I', id: string): string => `${letter}${id.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}`;
const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const short = (value: unknown, most = 2000): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= most;
/** Progress is accepted only from well-formed notes; older journals have no work fields. */
function workState(d: Record<string, unknown>): WorkState | undefined {
  const base = d.work;
  if (base === undefined && (d.status !== 'queued' && d.status !== 'waiting')) return undefined;
  const w = (base !== undefined && typeof base === 'object' && base !== null ? base : d) as Record<string, unknown>;
  if ((w.status !== 'queued' && w.status !== 'waiting') || !short(w.next, 4000) || !Number.isSafeInteger(w.attempts) || (w.attempts as number) < 0) return undefined;
  const state: WorkState = { status: w.status, next: w.next as string, attempts: w.attempts as number, resumeAt: Number.isFinite(w.resumeAt) ? w.resumeAt as number : 0 };
  if (w.status === 'waiting' && Number.isFinite(w.checkAt) && (w.checkAt as number) > 0) state.checkAt = w.checkAt as number;
  if (w.status === 'waiting' && typeof w.after === 'string' && w.after !== '' && w.after.length <= 80) state.after = w.after;
  for (const key of ['outcome', 'recovery', 'evidence'] as const) if (w[key] !== undefined) {
    if (!short(w[key])) return undefined;
    state[key] = w[key] as string;
  }
  return state;
}

/**
 * What is known, while it is being read from a journal: every fact and intention ever set down,
 * as each stands after the events read so far, and the ids of what no longer holds. It is what
 * `known` folds over a journal, and what a table of the database holds between two events
 * (brain/known-table.ts): the same step makes both, so they cannot come to differ.
 */
export interface KnownState {
  facts: Map<string, Fact>;
  intentions: Map<string, Intention>;
  /** Replaced, forgotten, closed or withdrawn by the owner. */
  gone: Set<string>;
}

export const knownStart = (): KnownState => ({ facts: new Map(), intentions: new Map(), gone: new Set() });

/** The kinds of notes `knownStep` reads; beside them it reads every reply, for the marks of what waits. */
export const KNOWN_NOTES: readonly string[] = [FACT_KIND, INTENTION_KIND, DONE_KIND, FORGET_KIND, ALLOWED_KIND, WORK_KIND, WITHDRAW_KIND];

/** Takes one more event into `state`. Returns whether anything in it may have changed. Notes are the body's to write, so none is taken on trust. */
export const knownStep = (state: KnownState, e: JournalEvent): boolean => step(state, e);

function step(state: KnownState, e: JournalEvent): boolean {
  const { facts, intentions, gone } = state;
  // What the owner withdrew is gone like what was replaced or forgotten.
  if (e.type === 'note' && e.kind === WITHDRAW_KIND) {
    const ids = (e.data as { ids?: unknown } | null)?.ids;
    if (Array.isArray(ids)) for (const one of ids) if (typeof one === 'string') gone.add(one);
    return true;
  }
  if (e.type === 'assistant') {
    // What waits for the owner has been put to them once the agent has said it, with its mark.
    // In a reply, or in what it gave a tool: an agent that can write to its owner elsewhere asks there.
    const r = e as { text?: unknown; toolCalls?: unknown };
    const said = `${typeof r.text === 'string' ? r.text : ''}\n${Array.isArray(r.toolCalls) && r.toolCalls.length > 0 ? JSON.stringify(r.toolCalls) : ''}`;
    let put = false;
    if (said.length > 1) {
      for (const i of intentions.values()) {
        if (!i.waits || i.ended !== undefined || !said.includes(i.mark)) continue;
        if (!i.put || Date.parse(e.ts) - Date.parse(i.putAt ?? '') >= SAME_ASKING_MS) i.puts += 1;
        i.put = true;
        i.putAt = e.ts;
        put = true;
      }
    }
    return put;
  }
  if (e.type !== 'note' || typeof e.data !== 'object' || e.data === null) return false;
  const d = e.data as Record<string, unknown>;
  if (e.kind === FACT_KIND) {
    if (!text(d.text) || !SOURCES.includes(d.source as Source) || !text(d.episode)) return false;
    const replaces = Array.isArray(d.replaces) ? d.replaces.filter((id): id is string => typeof id === 'string') : [];
    for (const id of replaces) gone.add(id);
    facts.set(e.id, { id: e.id, mark: markOf('F', e.id), at: e.ts, text: d.text, source: d.source as Source, episode: d.episode, ...(replaces.length > 0 ? { replaces } : {}), ...(text(d.about) ? { about: d.about.trim().slice(0, 80) } : {}) });
  } else if (e.kind === INTENTION_KIND) {
    if (!text(d.text)) return false;
    const origin = ORIGINS.includes(d.origin as Origin) ? (d.origin as Origin) : undefined;
    const unsure = origin === 'own' && d.unsure === true;
    intentions.set(e.id, {
      id: e.id, mark: markOf('I', e.id), at: e.ts, text: d.text, waits: origin === 'ask' || unsure, put: false, puts: 0,
      ...(origin === undefined ? {} : { origin }), ...(unsure ? { unsure: true as const } : {}),
      ...((origin === 'ask' || unsure) && text(d.to) ? { to: d.to.trim().slice(0, 200) } : {}),
      ...(typeof d.due === 'string' && DAY.test(d.due) ? { due: d.due } : {}), ...(text(d.episode) ? { episode: d.episode } : {}),
      ...(workState(d) === undefined ? {} : { work: { ...workState(d)!, at: e.ts } }),
    });
  } else if (e.kind === WORK_KIND) {
    const item = typeof d.intention === 'string' ? intentions.get(d.intention) : undefined;
    const work = workState(d);
    // A late progress note must not reopen a commitment after `done` (including a same-tick
    // scheduler checkpoint). Its evidence remains in the journal, but it is no longer runnable.
    if (item !== undefined && work !== undefined && item.ended === undefined) item.work = { ...work, at: e.ts };
  } else if (e.kind === ALLOWED_KIND) {
    const idea = typeof d.intention === 'string' ? intentions.get(d.intention) : undefined;
    if (idea !== undefined && idea.unsure === true && text(d.words)) {
      idea.waits = false;
      idea.allowed = d.words;
      if (text(d.source)) idea.allowedIn = d.source;
    }
  } else if (e.kind === DONE_KIND) {
    if (typeof d.intention !== 'string') return false;
    const ended = intentions.get(d.intention);
    // What waited for a word ends by that word; anything else ends as the record says, done unless it says dropped.
    if (ended !== undefined && ended.ended === undefined) {
      ended.ended = ended.waits ? (ended.unsure === true ? 'refused' : 'answered') : d.ended === 'dropped' ? 'dropped' : 'done';
      ended.endedAt = e.ts;
      ended.endedGen = e.gen;
      // Closed commitments no longer have an executable state. Keeping the checkpoint as
      // `queued` made a late scheduler note resurrect work after the done record.
      delete ended.work;
    }
    gone.add(d.intention);
  } else if (e.kind === FORGET_KIND) {
    if (Array.isArray(d.ids)) for (const id of d.ids) if (typeof id === 'string') gone.add(id);
  }
  // A note of a kind this reads: whether it changed anything is for the reader of the tables to find out.
  return KNOWN_NOTES.includes((e as { kind: string }).kind);
}

/** What holds in `state`: see `Known`. */
export function knownOf(state: KnownState): Known {
  const { facts, intentions, gone } = state;
  return {
    facts: [...facts.values()].filter((fact) => !gone.has(fact.id)),
    intentions: [...intentions.values()].filter((intention) => !gone.has(intention.id)),
    closed: [...intentions.values()].filter((intention) => intention.ended !== undefined),
  };
}

/** Everything known in `events`, as it holds after the last of them. */
export function known(events: JournalEvent[]): Known {
  const state = knownStart();
  for (const e of events) step(state, e);
  return knownOf(state);
}

/** The fact or intention the agent means by `mark`, among what holds now; null when there is none, or more than one. */
export function byMark(held: Pick<Known, 'facts' | 'intentions'>, mark: string): Fact | Intention | null {
  const wanted = mark.trim();
  const found = [...held.facts, ...held.intentions].filter((item) => item.mark === wanted || item.id === wanted);
  return found.length === 1 ? found[0]! : null;
}

/** Characters the list below may take in a request. Past it the oldest facts are left out, and found by `recall` like everything else. */
export const KNOWN_CHARS = 6000;
/** Characters the agent's own ideas may take there. Past it the oldest are left out of the list, not off the agenda. */
export const OWN_CHARS = 4000;

/**
 * What is known, as the agent is shown it in every request: the facts that hold, each with its
 * mark and its source, and the open intentions, with those that are due said to be due. `today`
 * is the day of the journal's last event, so the same journal always gives the same text.
 */
export function knownText(held: Pick<Known, 'facts' | 'intentions'>, today: string, mark: string): string | null {
  if (held.facts.length === 0 && held.intentions.length === 0) return null;
  const lines: string[] = [];
  const todo = held.intentions.filter((i) => !i.waits);
  const asks = held.intentions.filter((i) => i.waits);
  if (todo.length > 0) {
    lines.push(`${mark} What you mean to do, each with its mark:`);
    // What was taken on for someone is always shown. Ideas of its own are the agent's to pile up, so only the newest that fit are; a tick offers the others in turn.
    const own = todo.filter((i) => i.origin === 'own' && !(i.due !== undefined && i.due <= today));
    let size = 0;
    const shown = new Set<string>();
    for (const i of [...own].reverse()) {
      if (size + i.text.length > OWN_CHARS) break;
      size += i.text.length;
      shown.add(i.id);
    }
    for (const i of todo) {
      if (own.includes(i) && !shown.has(i.id)) continue;
      const due = i.due === undefined ? '' : i.due <= today ? ` [due ${i.due}, which has come]` : ` [due ${i.due}]`;
      const before = i.work?.after === undefined ? undefined : todo.find((o) => o.id === i.work!.after)?.mark;
      const again = i.work?.status !== 'waiting' ? '' : i.work.after !== undefined ? `, to be taken up when ${before ?? 'what it comes after'} is closed` : i.work.checkAt === undefined ? ', until what it waits for arrives' : `, to look again ${new Date(i.work.checkAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
      const progress = i.work === undefined ? '' : ` [${i.work.status}${again}; ${i.work.status === 'waiting' ? 'for' : 'next'}: ${i.work.next.replace(/\s+/g, ' ').slice(0, 300)}]`;
      lines.push(`${i.mark}${i.origin === 'own' ? (i.allowed === undefined ? ' [your own idea]' : ' [your own idea, your owner said yes]') : ''}${due}${progress} ${i.text}`);
      if (i.work !== undefined) for (const key of ['outcome', 'recovery', 'evidence'] as const) {
        const value = i.work[key];
        if (value !== undefined) lines.push(`  ${key}: ${value.replace(/\s+/g, ' ').slice(0, 600)}`);
      }
    }
    if (own.length > shown.size) lines.push(`(${own.length - shown.size} older ideas of your own are not shown here; they are on your agenda still, and a tick offers them in turn.)`);
  }
  if (asks.length > 0) {
    lines.push(`${mark} What waits for an answer, each with its mark: your questions, each for whoever you named, and ideas of your own you were not sure your owner allows. `
      + 'Put each, with its mark, to whom it is for, where you judge they will see it. When the answer comes: `allowed` with your owner\'s own words for an idea they say yes to, `done` for a question answered or an idea refused.');
    for (const i of asks) {
      const whom = i.unsure === true ? ' [an idea, may I? for your owner]' : ` [for ${i.to ?? 'your owner'}]`;
      lines.push(`${i.mark}${whom}${i.put ? ` [asked ${(i.putAt ?? '').slice(0, 10)}, no answer yet]` : ' [not yet asked]'} ${i.text}`);
    }
  }
  if (held.facts.length > 0) {
    const rows = held.facts.map((f) => `${f.mark} [${f.source}]${f.about === undefined ? '' : ` (about ${f.about})`} ${f.text}`);
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
 * oldest first; then the agent's own ideas. What waits for the owner's word is no part of it.
 */
export function agenda(held: Known, today: string): Intention[] {
  const todo = held.intentions.filter((i) => !i.waits);
  const come = todo.filter((i) => i.due !== undefined && i.due <= today).sort((a, b) => a.due!.localeCompare(b.due!));
  const rest = todo.filter((i) => !come.includes(i));
  return [...come, ...rest.filter((i) => i.origin === undefined), ...rest.filter((i) => i.origin === 'own')];
}

/**
 * The owner's message that holds `words`, among those that reached the agent after `idea` was set
 * down; null when there is none. It is the owner's when its source says so (`fromOwner`), by
 * whatever sensor it came. Spaces and case aside, the words must stand there as given: a yes is
 * the owner's to say, and is recorded only in the words it was said with.
 */
export function ownerSaid(events: JournalEvent[], idea: Intention, words: string): (JournalEvent & { type: 'stimulus' }) | null {
  const flat = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();
  const wanted = flat(words);
  if (wanted.length < 2) return null;
  const from = events.findIndex((e) => e.id === idea.id);
  if (from === -1) return null;
  const found = events.slice(from + 1).findLast((e) => e.type === 'stimulus' && fromOwner(e.source) && typeof e.text === 'string' && flat(e.text).includes(wanted));
  return (found as (JournalEvent & { type: 'stimulus' }) | undefined) ?? null;
}
