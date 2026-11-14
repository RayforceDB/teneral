import type { EventBody, JournalEvent } from './journal';

// The owner's hand on the agent's memory. Three things are the owner's to say, and none of them
// is asked of a model.
//
//   Pin: a stretch is to stay in front of the agent word for word, and never be told as a memory.
//   Withdraw: a memory, a wider memory or a fact does not stand. The stretch it was about is
//     remembered again, from the journal.
//   Take back: the conversation returns to before something the owner said. What was said and
//     done from there on is set aside: the agent no longer sees it, and `recall` no longer finds
//     it. It is one life going on from an earlier point, not a second one beside it.
//
// The journal is never cut for any of this. Each is a note, written after what it is about, and
// everything that reads the journal as a conversation or a memory reads it through `standing`.
// So what was set aside is still on disk, and the order in which things were decided can be read
// back. Taking a conversation back does not undo what was done in the world while it went on:
// files that were changed stay changed, and a message that was sent stays sent.

export const PIN_KIND = 'memory.pin.v1';
export const UNPIN_KIND = 'memory.unpin.v1';
export const WITHDRAW_KIND = 'memory.withdraw.v1';
export const BACK_KIND = 'memory.back.v1';

/** What the owner says, as it travels from the owner's terminal to the body (keeper/owner.ts). Events and notes are named by their ids. */
export type Word =
  | { do: 'pin' | 'unpin'; event: string }
  | { do: 'withdraw'; ids: string[] }
  | { do: 'back'; to: string };

const id = (value: unknown): value is string => typeof value === 'string' && value !== '' && value.length <= 200;

/** The word in `text`, or null for anything else. It arrives as a file's contents, and is read as nothing more than it says. */
export function parseWord(text: string): Word | null {
  let w: Record<string, unknown>;
  try {
    w = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof w !== 'object' || w === null) return null;
  if ((w.do === 'pin' || w.do === 'unpin') && id(w.event)) return { do: w.do, event: w.event };
  if (w.do === 'withdraw' && Array.isArray(w.ids) && w.ids.length > 0 && w.ids.length <= 50 && w.ids.every(id)) return { do: 'withdraw', ids: w.ids as string[] };
  if (w.do === 'back' && id(w.to)) return { do: 'back', to: w.to };
  return null;
}

/** The note a word is journaled as, when it names things `events` holds; null for a word about nothing that is there. */
export function noteOf(word: Word, events: JournalEvent[]): EventBody | null {
  const has = (wanted: string): boolean => events.some((e) => e.id === wanted);
  switch (word.do) {
    case 'pin': return has(word.event) ? { type: 'note', kind: PIN_KIND, data: { event: word.event } } : null;
    case 'unpin': return has(word.event) ? { type: 'note', kind: UNPIN_KIND, data: { event: word.event } } : null;
    case 'withdraw': {
      const ids = word.ids.filter(has);
      return ids.length > 0 ? { type: 'note', kind: WITHDRAW_KIND, data: { ids } } : null;
    }
    case 'back': return events.some((e) => e.id === word.to && e.type === 'stimulus') ? { type: 'note', kind: BACK_KIND, data: { to: word.to } } : null;
  }
}

/** The events of a conversation: what is set aside when the owner takes it back. What the stem did, and the notes, are records and stay. */
const SAID = new Set(['stimulus', 'assistant', 'tool.intent', 'tool.result', 'turn.interrupted']);
/** Whether `e` is part of a conversation, and so is set aside when its stretch is taken back. */
export const wasSaid = (e: JournalEvent): boolean => SAID.has(e.type);

/**
 * The journal as it stands: without what the owner took back. For every such note, the events of
 * the conversation from the message it names up to the note itself are left out. The note stays,
 * and is shown to the agent in their place (`backNote`).
 */
export function standing(events: JournalEvent[]): JournalEvent[] {
  let aside: Set<number> | null = null;
  const at = new Map<string, number>();
  events.forEach((e, i) => {
    at.set(e.id, i);
    if (e.type !== 'note' || e.kind !== BACK_KIND) return;
    const from = at.get((e.data as { to?: unknown } | null)?.to as string);
    if (from === undefined) return;
    aside ??= new Set();
    for (let j = from; j < i; j++) if (SAID.has(events[j]!.type)) aside.add(j);
  });
  return aside === null ? events : events.filter((_, i) => !aside!.has(i));
}

/** What the agent is told where a conversation was taken back; null for any other event. */
export function backNote(e: JournalEvent, mark: string): string | null {
  if (e.type !== 'note' || e.kind !== BACK_KIND) return null;
  return `${mark} Your owner took the conversation back to this point. What was said and done after it is set aside: it is not shown to you and \`recall\` does not find it. `
    + 'Whatever it changed outside this conversation, in files or in what was sent, stays changed; look before you rely on anything from then.';
}

/** The ids of the events the owner has pinned and not let go again. A stretch is pinned by any one event in it. */
export function pinned(events: JournalEvent[]): Set<string> {
  const held = new Set<string>();
  for (const e of events) {
    if (e.type !== 'note' || (e.kind !== PIN_KIND && e.kind !== UNPIN_KIND)) continue;
    const event = (e.data as { event?: unknown } | null)?.event;
    if (typeof event !== 'string') continue;
    if (e.kind === PIN_KIND) held.add(event);
    else held.delete(event);
  }
  return held;
}

/** The ids of the notes the owner has withdrawn: memories, wider memories, facts, intentions. */
export function withdrawn(events: JournalEvent[]): Set<string> {
  const gone = new Set<string>();
  for (const e of events) {
    if (e.type !== 'note' || e.kind !== WITHDRAW_KIND) continue;
    const ids = (e.data as { ids?: unknown } | null)?.ids;
    if (Array.isArray(ids)) for (const one of ids) if (typeof one === 'string') gone.add(one);
  }
  return gone;
}
