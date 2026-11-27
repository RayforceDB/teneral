import type { JournalEvent } from './journal';
import type { Lesson } from './lessons';

// How the agent works, in numbers it can act on: which of its tools it calls and which it never
// does, and what has come of its lessons. The agent is shown this when it looks ahead
// (brain/agenda.ts), beside what has come of its ideas.
//
// A part of the agent can fail without anything going wrong: a tool that is never called fails
// nobody, and a lesson that is never proposed is missed by nobody. For weeks an agent held a tool
// for lessons and no lesson, and a tool for scripts it was never told of, and that was found only
// by someone counting from outside. What is counted here is what that someone counted, and the
// one who can do most about it is the agent: the descriptions of its tools and the words of its
// prompt are its own body.

/** The days looked back over. */
export const WORKING_DAYS = 30;
/** Fewer calls than this in those days say nothing about any one tool. */
const CALLS_MIN = 200;
/** The most tools named as never called. */
const NAMED = 12;

export interface Working {
  /** How often each tool was called in the days looked back over. */
  calls: { name: string; n: number }[];
  /** The tools the agent has. */
  tools: string[];
  /** The lessons that stand. */
  lessons: Lesson[];
}

/**
 * The note of a count, written when the agent is shown it: `{ days, total, never, kept, waiting }`,
 * `never` only where there were calls enough to judge by, the lessons only where there is a tool
 * for them. It is what the owner's status line reads: the keeper has no list of the agent's tools.
 */
export const WORKING_KIND = 'working.counted.v1';
export interface Counted { days: number; total: number; never?: string[]; kept?: number; waiting?: number }

export function countedOf(w: Working): Counted {
  const total = w.calls.reduce((sum, c) => sum + c.n, 0);
  const called = new Set(w.calls.filter((c) => c.n > 0).map((c) => c.name));
  const kept = w.lessons.filter((l) => l.accepted !== undefined).length;
  return {
    days: WORKING_DAYS, total,
    ...(total >= CALLS_MIN ? { never: w.tools.filter((name) => !called.has(name)).sort() } : {}),
    ...(w.tools.includes('lesson') ? { kept, waiting: w.lessons.length - kept } : {}),
  };
}

/** The last count in a few characters, for a status line: empty when nothing was counted yet or there is nothing to remark. */
export function workingBadge(events: JournalEvent[]): string {
  let last: Counted | null = null;
  for (let i = events.length - 1; i >= 0 && last === null; i--) {
    const e = events[i]!;
    if (e.type === 'note' && e.kind === WORKING_KIND && typeof e.data === 'object' && e.data !== null) last = e.data as Counted;
  }
  if (last === null) return '';
  const parts: string[] = [];
  if (Array.isArray(last.never) && last.never.length > 0) parts.push(`${last.never.length} ${last.never.length === 1 ? 'tool' : 'tools'} unused`);
  if (typeof last.kept === 'number' && typeof last.waiting === 'number') parts.push(last.kept + last.waiting === 0 ? 'no lessons' : `lessons ${last.kept} kept${last.waiting > 0 ? `, ${last.waiting} waiting` : ''}`);
  return parts.join(' · ');
}

/** The same in a few lines of words; empty when there is nothing worth saying. */
export function workingText(w: Working): string {
  const parts: string[] = [];
  const total = w.calls.reduce((sum, c) => sum + c.n, 0);
  if (total >= CALLS_MIN) {
    const called = new Set(w.calls.filter((c) => c.n > 0).map((c) => c.name));
    const never = w.tools.filter((name) => !called.has(name)).sort();
    if (never.length > 0) {
      parts.push(`in the last ${WORKING_DAYS} days you called your tools ${total} times and never called ${never.slice(0, NAMED).map((name) => `\`${name}\``).join(', ')}${never.length > NAMED ? ` and ${never.length - NAMED} more` : ''}`);
    }
  }
  const kept = w.lessons.filter((l) => l.accepted !== undefined).length;
  const waiting = w.lessons.length - kept;
  if (w.tools.includes('lesson')) parts.push(w.lessons.length === 0 ? 'you hold no lesson' : `of your lessons ${kept} ${kept === 1 ? 'is' : 'are'} kept and ${waiting} ${waiting === 1 ? 'waits' : 'wait'} to be`);
  return parts.join('; ');
}
