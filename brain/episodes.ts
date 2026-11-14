import { fromOwner } from './owned';
import type { JournalEvent } from './journal';
import { stemNote } from './stemnote';

// An episode is a stretch of the journal that belongs together: what was asked, what was done
// about it, how it ended. It is the unit the agent remembers by. Where one ends and the next
// begins is decided here by rules, never by a model, so the same journal always gives the same
// episodes and a store built from it can be built again.
//
// A boundary is placed where nothing is in progress: before something that asks for a turn (a
// stimulus, or a note of the stem), at a moment when no turn is owed. A question and its answer
// are then never on two sides of one. An agent that is never idle would give one episode without
// end that way, too large to remember in one piece, so an episode past twice the size limit is
// also cut in the middle of a turn, between two rounds of it. Even then a tool call and its
// result stay together.

/** Silence longer than this, before something new arrives, ends an episode. */
export const GAP_MS = 30 * 60_000;
/** An episode that has grown past this many characters ends at the next quiet moment. */
export const EPISODE_CHARS = 60_000;
/** Past this many it ends at the next round of the turn in progress, quiet or not. */
export const EPISODE_HARD_CHARS = 2 * EPISODE_CHARS;
/** Below this many characters said by anyone, with no tool used and no word from the owner, nothing happened worth remembering. */
export const THIN_CHARS = 200;

/** Why an episode began where it did. `start`: nothing unremembered came before it. `kept`: a span that was remembered before and is not cut again. */
export type Boundary = 'start' | 'gap' | 'generation' | 'size' | 'kept';
// `size` covers both limits: the reader of an episode does not need to know which one ended the one before.

export interface Episode {
  /** The id of its first event: the episode's own name, the same for as long as the journal lasts. */
  id: string;
  /** Positions in the events it was cut from: `from` is its first event, `to` the one after its last. */
  from: number;
  to: number;
  /** The ids and times of its first and last events. */
  first: string;
  last: string;
  start: string;
  end: string;
  /** What its events count for against a request, roughly. */
  chars: number;
  why: Boundary;
  /** Whether another episode begins after it. The last one is still being lived and is never closed. */
  closed: boolean;
}

/** A stretch that was already remembered, or given up on: its first and last event ids. It stays one episode whatever the rules say now. */
export interface Span {
  from: string;
  to: string;
}

const asText = (value: unknown): string => (typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value) ?? '');

/** What one event counts for: the text a request would carry for it. Records nobody is shown count nothing. */
export function eventChars(e: JournalEvent): number {
  const r = e as { text?: unknown; toolCalls?: unknown; output?: unknown };
  switch (e.type) {
    case 'stimulus': return asText(r.text).length;
    case 'assistant': return asText(r.text).length + (Array.isArray(r.toolCalls) && r.toolCalls.length > 0 ? JSON.stringify(r.toolCalls).length : 0);
    case 'tool.result': return asText(r.output).length;
    default: return stemNote(e)?.length ?? 0;
  }
}

/** Whether `e` asks for a turn: the only kind of event an episode may begin with. */
const asks = (e: JournalEvent): boolean => e.type === 'stimulus' || stemNote(e) !== null;

/** Milliseconds between two journal times; 0 when either cannot be read, so a damaged time never cuts an episode. */
function between(earlier: string, later: string): number {
  const ms = Date.parse(later) - Date.parse(earlier);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * The journal as episodes, in order, covering every event exactly once.
 *
 * `kept` names the stretches that were remembered already (brain/sleep.ts journals them). Each is
 * given back as it was, so changing a rule here never cuts through something that has a memory;
 * the rules only decide what comes after the last of them. A span whose events cannot be found is
 * passed over.
 */
export function episodes(events: JournalEvent[], kept: Span[] = []): Episode[] {
  const at = new Map(events.map((e, i) => [e.id, i]));
  const out: Episode[] = [];
  const push = (from: number, to: number, why: Boundary): void => {
    if (to <= from) return;
    let chars = 0;
    for (let i = from; i < to; i++) chars += eventChars(events[i]!);
    const first = events[from]!;
    const last = events[to - 1]!;
    out.push({ id: first.id, from, to, first: first.id, last: last.id, start: first.ts, end: last.ts, chars, why, closed: true });
  };

  // What was remembered comes first and is contiguous from the journal's start; anything out of order is dropped.
  let next = 0;
  for (const span of kept) {
    const from = at.get(span.from);
    const to = at.get(span.to);
    if (from === undefined || to === undefined || from !== next || to < from) continue;
    push(from, to + 1, 'kept');
    next = to + 1;
  }

  let from = next;
  let why: Boundary = 'start';
  let chars = 0;
  // Whether a turn is owed after the events read so far: the same reading as `needsTurn` in brain/memory.ts.
  let owed = false;
  // Calls of the latest reply that have no result yet. A new reply means the round before it is over, answered or not.
  let pending = 0;
  /** Whether the episode being read has anything in it that the agent was shown. */
  let begun = false;
  for (let i = next; i < events.length; i++) {
    const e = events[i]!;
    // An episode begins with something said to the agent. Records nobody is shown, such as the notes of its own
    // memory, may lie before that; they are no episode of their own and go with the one that follows.
    if (i > from && begun) {
      const quiet = asks(e) && !owed;
      const betweenRounds = e.type === 'assistant' || (asks(e) && pending <= 0);
      const reason: Boundary | null = !quiet ? (betweenRounds && chars >= EPISODE_HARD_CHARS ? 'size' : null)
        : e.type === 'generation.promoted' || e.type === 'generation.rolledback' ? 'generation'
        : between(events[i - 1]!.ts, e.ts) > GAP_MS ? 'gap'
        : chars >= EPISODE_CHARS ? 'size'
        : null;
      if (reason !== null) {
        push(from, i, why);
        from = i;
        why = reason;
        chars = 0;
        begun = false;
      }
    }
    if (asks(e) || e.type === 'assistant') begun = true;
    chars += eventChars(e);
    if (e.type === 'assistant') {
      const calls = (e as { toolCalls?: unknown }).toolCalls;
      pending = Array.isArray(calls) ? calls.length : 0;
      owed = pending > 0;
    } else if (e.type === 'tool.result') pending -= 1;
    else if (e.type === 'turn.interrupted') owed = false;
    else if (asks(e)) owed = true;
  }
  push(from, events.length, why);
  // The last one is where the agent is now, unless it is a remembered span with nothing after it.
  const last = out.at(-1);
  if (last !== undefined && last.why !== 'kept') last.closed = false;
  return out;
}

/**
 * Whether nothing happened in these events that is worth a memory: the owner said nothing, no
 * tool was used, and all that was said fits in a line or two. A clock tick answered with "nothing
 * to do" is the usual case. Such an episode is recorded as quiet without asking a model, which
 * would otherwise be asked to remember nothing and might invent something.
 */
export function thin(events: JournalEvent[]): boolean {
  let said = 0;
  for (const e of events) {
    if (e.type === 'stimulus' && fromOwner(e.source)) return false;
    if (e.type === 'tool.intent' || e.type === 'tool.result') return false;
    if (e.type === 'assistant') {
      const r = e as { text?: unknown; toolCalls?: unknown };
      if (Array.isArray(r.toolCalls) && r.toolCalls.length > 0) return false;
      said += asText(r.text).trim().length;
    }
  }
  return said < THIN_CHARS;
}
