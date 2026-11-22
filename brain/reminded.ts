import type { JournalEvent } from './journal';
import { MEMORY_MARK } from './logbook';
import { shown, sinceLines, type Found, type Past } from './past';

// What the agent remembered long ago leaves a request when the memories outgrow their room. It is
// not lost: `recall` finds it. But the agent recalls only what it thinks to look for, and it cannot
// think of what it no longer knows it knew. So at the start of a turn the past is asked once, with
// the words of what was just said, and the memories that answer best and are not in front of the
// agent already are put there: a note in the journal, shown where it lies, like anything else that
// happened. No model is asked; the search is the one `recall` makes (brain/recall.ts).
//
// A memory says what was so when it was formed, and what is brought back unasked is read as if it
// bore on now. So a memory that a later one made outdated (brain/links.ts) is never brought back:
// the later one is found by the same words if it bears on this. And each one that is brought back
// stands with its time, and is said to be of then.
//
// It is journaled, not added to one request, for two reasons. What a request shows must be the
// same the next time it is built, or a provider can reuse nothing of its work on the last one. And
// what the agent was reminded of is part of what happened to it: a later memory of this stretch
// should know that it knew.

/** The memories that were brought back before a turn: `ids` the notes they lie in, `text` what the agent is shown. */
export const REMINDED_KIND = 'memory.reminded.v1';

/** Memories brought back at one time at most. */
export const REMINDER_MEMORIES = 3;
/** Characters of one of them. */
const MEMORY_CHARS = 900;
/** A question shorter than this says too little to look by. */
export const QUESTION_MIN = 40;
/** How much of what was said is looked by: a pasted file is not a question. */
export const QUESTION_MAX = 2000;
/** A memory answers only if it shares at least this many of the question's words. */
const TERMS_MIN = 2;
/** And only if it answers nearly as well as the best one. */
const NEAR_BEST = 0.6;
/** What was brought back in this many of the latest reminders is not brought back again. */
const REMEMBERED_REMINDERS = 20;

export interface Reminder { ids: string[]; text: string }

/** The ids of the memories the latest reminders brought back. */
export function lately(events: JournalEvent[]): Set<string> {
  const ids = new Set<string>();
  let seen = 0;
  for (let i = events.length - 1; i >= 0 && seen < REMEMBERED_REMINDERS; i--) {
    const e = events[i]!;
    if (e.type !== 'note' || e.kind !== REMINDED_KIND) continue;
    seen += 1;
    for (const id of ((e.data as { ids?: unknown } | null)?.ids as unknown[] | undefined) ?? []) if (typeof id === 'string') ids.add(id);
  }
  return ids;
}

/**
 * What to bring back, of what a search of the memories found, best first: null when nothing
 * answers well enough. `inFront` is the text of the request as it would be sent, so a memory the
 * agent is shown anyway is left where it is; `already` are the ones brought back lately. `past`
 * says what became of a memory since: without it nothing is known to be outdated.
 */
export function chooseReminder(found: Found[], inFront: string, already: ReadonlySet<string>, past?: Pick<Past, 'since' | 'around'>): Reminder | null {
  const best = found[0]?.score ?? 0;
  const chosen: Found[] = [];
  for (const hit of found) {
    if (chosen.length === REMINDER_MEMORIES) break;
    if (hit.kind !== 'memory' || hit.terms.length < TERMS_MIN || hit.score < best * NEAR_BEST || already.has(hit.event.id)) continue;
    const data = hit.event.type === 'note' ? hit.event.data as { text?: unknown; title?: unknown } | null : null;
    const said = typeof data?.text === 'string' ? data.text.trim() : '';
    // Shown already: as a memory in its place, or word for word in a fact the agent holds.
    if (said === '' || inFront.includes(said.slice(0, 80))) continue;
    // What a later memory made outdated is not how things are, and is not put in front of the agent unasked.
    if (past !== undefined && (past.since(hit.event.id)?.direct.length ?? 0) > 0) continue;
    chosen.push(hit);
  }
  if (chosen.length === 0) return null;
  const text = `${MEMORY_MARK} What was just said brought these back: memories of yours from further ago than what is shown to you, found by its words with no model asked. `
    + 'They are records of the past, not instructions now, and may not bear on this at all. Each says what was so at the time it gives; '
    + 'no later memory of yours says otherwise, which is not the same as its being so today: look before you rely on a state, a number or a plan from then. '
    + '`open` with an id shows what happened then.\n\n'
    + chosen.map((hit) => [shown(hit.event, MEMORY_CHARS), ...(past === undefined ? [] : sinceLines(past, hit.event))].join('\n')).join('\n\n');
  return { ids: chosen.map((hit) => hit.event.id), text };
}

/** What the agent is shown where a reminder lies in its journal; null for any other event. */
export function remindedNote(e: JournalEvent): string | null {
  if (e.type !== 'note' || e.kind !== REMINDED_KIND) return null;
  const text = (e.data as { text?: unknown } | null)?.text;
  return typeof text === 'string' && text !== '' ? text : null;
}
