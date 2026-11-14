import { episodes } from './episodes';
import { QUESTIONS_MIN, lastResult, rate, type Result } from './exam';
import type { JournalEvent } from './journal';
import { known } from './known';
import { remembered } from './remembered';

// How the agent's memory stands, as one word with its reasons. A memory fails quietly: episodes
// pile up unremembered, a model that will not answer in form leaves stretches with no memory at
// all, promises go past their day, a change to recall finds less than it did. None of that stops
// the agent from answering, so none of it is noticed unless something looks. This looks, from the
// journal alone, and says the same thing to the owner (in their terminal's status line and on
// `/memory`) and to the agent (in every request, while anything is wrong).
//
// The thresholds are judgements, and are here to be changed by whoever finds them wrong.

/** `well`: nothing to do. `behind`: it works, and something has fallen back. `failing`: part of it does not do what it is for. */
export type State = 'well' | 'behind' | 'failing';

/** This many episodes waiting to be remembered, the oldest for this long, is behind; the larger pair is failing. */
const WAITING_BEHIND = { count: 3, hours: 6 };
const WAITING_FAILING = { count: 10, hours: 48 };
/** No memory could be formed of this share of the stretches, and of at least this many: the model does not answer in form. */
const QUARANTINED = { count: 3, share: 0.2 };
/** This share of the wider memories, of at least this many, were made without a model, as lists of titles. */
const MECHANICAL = { count: 2, share: 0.5 };
/** The memories tell less than this share of what the agent's own questions ask: what mattered did not get into them. */
const TOLD_LOW = 0.5;

export interface Health {
  state: State;
  /** What is wrong, each in a clause that reads after "because". Empty when well. */
  reasons: string[];
  remembered: number;
  waiting: number;
  /** The end of the oldest episode still waiting, or null. */
  oldest: string | null;
  quarantined: number;
  /** Intentions whose day has passed. */
  overdue: number;
  /** What the last exam came to, or null when none was sat. */
  exam: (Result & { at: string }) | null;
}

/** A length of time in the coarse words a status needs: it should not change with every minute. */
function since(hours: number): string {
  return hours >= 48 ? `${Math.floor(hours / 24)} days` : hours >= 24 ? 'a day' : `${Math.floor(hours)} hours`;
}

/** How the memory stands in `events`, as of `now`. The same journal and the same moment always give the same answer. */
export function health(events: JournalEvent[], now: number): Health {
  const all = remembered(events);
  const cut = episodes(events, all.spans);
  const owed = cut.filter((e) => e.closed && (e.why !== 'kept' || (!all.memories.has(e.first) && !all.quarantined.has(e.first))));
  const oldest = owed[0]?.end ?? null;
  const hours = oldest === null ? 0 : Math.max(0, (now - Date.parse(oldest)) / 3_600_000);
  const today = new Date(now).toISOString().slice(0, 10);
  const overdue = known(events).intentions.filter((i) => i.due !== undefined && i.due < today).length;
  const exam = lastResult(events);
  const formed = all.memories.size + all.quarantined.size;
  const mechanical = all.merges.filter((m) => m.mechanical === true).length;

  const failing: string[] = [];
  const behind: string[] = [];
  if (owed.length >= WAITING_FAILING.count && hours >= WAITING_FAILING.hours) failing.push(`${owed.length} episodes wait to be remembered, the oldest for ${since(hours)}`);
  else if (owed.length >= WAITING_BEHIND.count && hours >= WAITING_BEHIND.hours) behind.push(`${owed.length} episodes wait to be remembered, the oldest for ${since(hours)}`);
  if (all.quarantined.size >= QUARANTINED.count && all.quarantined.size / formed > QUARANTINED.share) failing.push(`of ${all.quarantined.size} stretches in ${formed} no memory could be formed`);
  if (mechanical >= MECHANICAL.count && mechanical / all.merges.length > MECHANICAL.share) failing.push(`${mechanical} of ${all.merges.length} wider memories are only lists of titles`);
  if (exam !== null && exam.recall.questions >= QUESTIONS_MIN && rate(exam.recall) < rate(exam.plain)) failing.push('recall finds less than looking for the words as they stand');
  if (exam !== null && exam.written && rate(exam.told) < TOLD_LOW) behind.push(`the memories tell ${Math.round(rate(exam.told) * 100)}% of what the exam asks`);
  if (overdue > 0) behind.push(`${overdue} ${overdue === 1 ? 'thing' : 'things'} meant to be done ${overdue === 1 ? 'is' : 'are'} past the day`);

  return {
    state: failing.length > 0 ? 'failing' : behind.length > 0 ? 'behind' : 'well',
    reasons: [...failing, ...behind],
    remembered: all.memories.size, waiting: owed.length, oldest, quarantined: all.quarantined.size, overdue, exam,
  };
}

/** What the agent is told of its memory in a request, while anything is wrong; null while it is well. */
export function healthNote(h: Health, mark: string): string | null {
  if (h.state === 'well') return null;
  return `${mark} Your memory is ${h.state}: ${h.reasons.join('; ')}.`;
}

/**
 * The memory in a few characters, for a status line: its state, and what recall scored in the
 * last exam. Empty while nothing has been remembered yet and nothing is wrong: there is nothing
 * to say of a memory that has not begun.
 */
export function healthBadge(h: Health): string {
  if (h.state === 'well' && h.remembered + h.quarantined === 0) return '';
  const exam = h.exam === null ? '' : ` · exam ${Math.round(rate(h.exam.recall) * 100)}%`;
  return `memory ${h.state}${exam}`;
}
