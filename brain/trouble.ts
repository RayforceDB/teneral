import type { JournalEvent } from './journal';

// What went wrong in the agent's own working, as notes in its journal.
//
// A body says what it does in lines on its standard error: `[memory] formed a memory`, `[tool]
// bash`. Among them are the ones that say something failed: the database could not be used, the
// store could not be written, a turn failed. Those lines went to the log of whatever started the
// body and nowhere else, so an owner at the terminal saw an agent that still answered and nothing
// of what it was working around. A line that says something failed is now also a note, and the
// owner's terminal shows that there are such, and each in full (keeper/tui/talk.ts).

/** Something failed in the body's own working: `{ where, text }`, the part that said so and what it said. */
export const TROUBLE_KIND = 'body.trouble.v1';
/** The same trouble said again within this long is not set down again: a thing that fails every few seconds is one trouble. */
export const SAME_MS = 10 * 60_000;
/** The most of one line that is kept. */
const TEXT_CHARS = 4000;

/** The parts whose lines never say a failure of the agent's working: what it is doing, and waits that are meant. */
const NOT_TROUBLE = new Set(['tool', 'thinking', 'interrupted', 'retry', 'glance', 'teneral']);
/** The parts whose every line is one. */
const ALWAYS = new Set(['turn failed', 'giving up']);
const SAYS_FAILED = /\b(failed|could not|cannot be|can not be|not seeded|not imported|not gone over|was dropped)\b/i;

/**
 * A trouble that was a state and is over: `{ where, was }`, the part that said it and how the
 * text of what is over begins. A day is how long a trouble is shown, and a state that ended an
 * hour after it began would be shown for the twenty-three after: an owner reads "the database
 * failed" of a database that has long run again. What happened and is not a state (a process
 * that was killed, a turn that failed) is over by nothing, and is shown its day.
 */
export const OVER_KIND = 'body.trouble.over.v1';
/** The lines that say a state is over, and the troubles each ends. */
const ENDS: { where: string; says: RegExp; was: string[] }[] = [
  // The database is asked again, by this body or the next: nothing is read through the journal any more.
  { where: 'memory', says: /^the database runs (in a process of its own|again)\b/, was: ['the database failed, the journal is read through', 'the database is gone, the journal is read through'] },
];

/** What a line the body says ends, when it says that something is well again. */
export function overOf(line: string): { where: string; was: string }[] {
  const m = /^\[([a-z][a-z ]{0,30})\]\s*([\s\S]+)$/.exec(line.trim());
  if (m === null) return [];
  return ENDS.filter((end) => end.where === m[1] && end.says.test(m[2]!.trim())).flatMap((end) => end.was.map((was) => ({ where: end.where, was })));
}

/** What a line the body says comes to as a trouble, or null when it only tells what the body is doing. */
export function troubleOf(line: string): { where: string; text: string } | null {
  const m = /^\[([a-z][a-z ]{0,30})\]\s*([\s\S]+)$/.exec(line.trim());
  if (m === null) return null;
  const [where, text] = [m[1]!, m[2]!.trim()];
  if (NOT_TROUBLE.has(where) || text === '') return null;
  return ALWAYS.has(where) || SAYS_FAILED.test(text) ? { where, text: text.slice(0, TEXT_CHARS) } : null;
}

/**
 * Says a line as a body always did, and sets it down when it says something failed. Returns the
 * function to say lines with; `note` writes the note, and a failure to write it is not a trouble
 * of its own. `over` writes the note of a state that has ended (`OVER_KIND`).
 */
export function teller(
  note: (data: { where: string; text: string }) => void, out: (line: string) => void = (line) => console.error(line), now: () => number = Date.now,
  over: (data: { where: string; was: string }) => void = () => {},
): (line: string) => void {
  const said = new Map<string, number>();
  return (line) => {
    out(line);
    for (const ended of overOf(line)) {
      // Said again after it, the same trouble is a new one, and is set down at once.
      for (const key of [...said.keys()]) if (key.startsWith(`${ended.where}\n${ended.was}`)) said.delete(key);
      try { over(ended); } catch { /* the journal could not be written: the line was still said */ }
    }
    const trouble = troubleOf(line);
    if (trouble === null) return;
    const key = `${trouble.where}\n${trouble.text.slice(0, 200)}`;
    const at = now();
    if (at - (said.get(key) ?? -Infinity) < SAME_MS) return;
    said.set(key, at);
    try { note(trouble); } catch { /* the journal could not be written: the line was still said */ }
  };
}

/** One trouble as the owner is shown it: what failed, how often since `since`, and when first and last. */
export interface Trouble { where: string; text: string; times: number; first: string; last: string }

/** The troubles journaled since `since` that are not over, the same one once with how often it was said, the latest first. */
export function troubles(events: JournalEvent[], since: number): Trouble[] {
  const by = new Map<string, Trouble>();
  for (const e of events) {
    if (e.type === 'note' && e.kind === OVER_KIND && typeof e.data === 'object' && e.data !== null) {
      const d = e.data as { where?: unknown; was?: unknown };
      if (typeof d.where !== 'string' || typeof d.was !== 'string' || d.was === '') continue;
      // What was said before this is over; said after it, it is a trouble again.
      for (const [key, held] of [...by]) if (held.where === d.where && held.text.startsWith(d.was)) by.delete(key);
      continue;
    }
    if (e.type !== 'note' || e.kind !== TROUBLE_KIND || typeof e.data !== 'object' || e.data === null || Date.parse(e.ts) < since) continue;
    const d = e.data as { where?: unknown; text?: unknown };
    if (typeof d.where !== 'string' || typeof d.text !== 'string') continue;
    const key = `${d.where}\n${d.text.slice(0, 200)}`;
    const held = by.get(key);
    if (held === undefined) by.set(key, { where: d.where, text: d.text, times: 1, first: e.ts, last: e.ts });
    else { held.times += 1; held.last = e.ts; held.text = d.text; }
  }
  return [...by.values()].sort((a, b) => b.last.localeCompare(a.last));
}
