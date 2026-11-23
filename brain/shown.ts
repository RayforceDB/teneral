import { acceptanceNotes } from './acceptance';
import { stemNote } from './stemnote';
import type { JournalEvent } from './journal';
import { standing } from './owned';

/** Written before a request. The id is the last journal event that request may contain. */
export const SHOWN_KIND = 'brain.shown.v1';

interface Shown { through: string; continued?: boolean }

function shownAt(e: JournalEvent): Shown | null {
  if (e.type !== 'note' || e.kind !== SHOWN_KIND) return null;
  const data = e.data as Partial<Shown> | null;
  return typeof data?.through === 'string' ? { through: data.through, ...(data.continued === true ? { continued: true } : {}) } : null;
}

/**
 * Whether the reply answers the latest thing that calls for a turn. A late stimulus is
 * journaled before the reply; order alone would otherwise lose it if the process dies
 * before the extra round. Requests and replies are paired by journal order.
 */
export function replyIsCurrent(events: JournalEvent[], reply: JournalEvent): boolean {
  const at = events.findIndex(e => e.id === reply.id);
  if (at < 0 || reply.type !== 'assistant') return false;
  const accepted = acceptanceNotes(events);
  const owed = (e: JournalEvent): boolean => e.type === 'stimulus' || stemNote(e) !== null || accepted.has(e.id);
  let latest: JournalEvent | undefined;
  for (const e of events.slice(0, at)) if (owed(e)) latest = e;
  // The boundary belongs to this request, not to a later one: stop at the previous reply.
  let previousReply = -1;
  for (let i = at - 1; i >= 0; i--) if (events[i]!.type === 'assistant') { previousReply = i; break; }
  if (latest === undefined) return true;
  // A late arrival that precedes a reply was included in its request if its id is at or
  // before the request boundary, even when the request is not the nearest preceding note
  // (a tool result or another reply may intervene).
  for (let i = at - 1; i > previousReply; i--) {
    const shown = shownAt(events[i]!);
    if (shown === null) continue;
    if (shown.through === latest.id) {
      // A cut-off reply's fragment has been shown, but its completion is still owed.
      return shown.continued !== true;
    }
    const boundary = events.findIndex(e => e.id === shown.through);
    if (boundary < 0) return false; // taken back: no proof this reply saw the current event
    const target = events.findIndex(e => e.id === latest!.id);
    return target >= 0 && target <= boundary;
  }
  // A completed continuation may end in another length-limited fragment. Older journals
  // have no explicit boundary; only a cut-off text without calls can be treated this way.
  const { toolCalls, text } = reply;
  if ((!Array.isArray(toolCalls) || toolCalls.length === 0) && typeof text === 'string' && text.includes('[this reply was cut off by the provider:')) return false;
  // Before request boundaries existed, an event before the reply is indistinguishable
  // from a late one. Do not make every historical journal permanently owe a turn.
  return true;
}

/**
 * Where what arrived during a turn is shown. A stimulus, or a note that calls for a reply, journaled while the model was writing a
 * reply lies before that reply in the journal, though the reply was written without it: for each
 * such stimulus, the position of that reply, after which (and after its tools' results) it is
 * shown instead. `during` holds those and the ones journaled while a tool ran, which already lie
 * after the results: everything that reached the agent in the middle of its work.
 *
 * It is read from the request boundaries alone, so a message never moves once a request has shown
 * it. A journal from before the boundaries, or a boundary whose event was taken back, moves nothing.
 */
export function arrivals(events: JournalEvent[], owed: (e: JournalEvent) => boolean = e => e.type === 'stimulus'): { after: Map<number, number>; during: Set<number> } {
  const after = new Map<number, number>();
  const during = new Set<number>();
  const at = new Map<string, number>();
  // The last reply so far, whether it left tools to run, and the newest boundary since it.
  let previous = -1;
  let working = false;
  let boundary: number | null = null;
  let waiting: number[] = [];
  events.forEach((e, i) => {
    at.set(e.id, i);
    const shown = shownAt(e);
    if (shown !== null) boundary = at.get(shown.through) ?? null;
    else if (e.type === 'turn.interrupted') working = false;
    else if (e.type === 'assistant') {
      if (boundary !== null) {
        for (const s of waiting) if (s > boundary && s > previous) { after.set(s, i); during.add(s); }
      }
      previous = i;
      working = Array.isArray(e.toolCalls) && e.toolCalls.length > 0;
      boundary = null;
      waiting = [];
    } else if (owed(e)) {
      // A message, or a note of the stem's that calls for a reply: whatever a turn is owed for.
      waiting.push(i);
      if (working) during.add(i);
    }
  });
  return { after, during };
}
