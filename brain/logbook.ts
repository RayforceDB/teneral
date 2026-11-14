import type { JournalEvent } from './journal';
import type { ChatMessage } from './provider';
import { IMAGE_CHARS } from '../body/images';
import { episodes, type Episode } from './episodes';
import { health, healthNote } from './health';
import { known, knownText } from './known';
import { pinned } from './owned';
import { remembered, type Memory, type Merge, type QuarantineData, type Remembered } from './remembered';

// The logbook is the remembered past as a request shows it: for every episode that no longer fits
// as it happened, the memory the agent formed of it, in order, before the part that is still
// shown word for word.
//
// Forming a memory and showing it are two things: brain/sleep.ts forms them early, while the
// episode is still in view, and here they are swapped in later, whole episodes at a time and in
// steps, so that the start of a request stays the same for as long as possible (a provider reuses
// its work on a request only up to the first character that changed).
//
// After the memories, in every request, stands what the agent knows and means to do
// (brain/known.ts): a few lines that hold whatever is in view. They come last in the logbook, so
// that a new fact changes a request only from there on.
//
// How much is shown as it happened is not what the model could take but what is worth paying
// for. Every character in a request is read again at every step of every turn, hundreds of times
// before it leaves, and reading costs money and time even when the provider has kept its work.
// So the part shown as it happened is held near a size chosen for that, far below the model's
// limit, and what is older is in the logbook, where an episode takes a few lines.

/** What a message counts for against the budget. An image counts a fixed amount, whatever its bytes: see IMAGE_CHARS. */
export function sizeOf(m: ChatMessage): number {
  return (m.content?.length ?? 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0) + (m.images?.length ?? 0) * IMAGE_CHARS;
}

/** Episodes are swapped for their memories in steps of this share of the room. Each step moves where a request first differs from the one before. */
const STEP = 0.2;
/** Characters of the conversation shown as it happened, unless the owner says otherwise. About 30 thousand tokens. */
export const DEFAULT_TAIL_CHARS = 100_000;
/** Characters the logbook may take. Past it, the oldest memories leave the request; they stay in the journal. */
export const DEFAULT_LOGBOOK_CHARS = 50_000;
/** And never more than this share of the room. */
const LOGBOOK_SHARE = 0.5;

export interface Sizes {
  /** Characters of the conversation to show as it happened. 0 shows only the episode that has no memory yet. */
  tailChars?: number;
  logbookChars?: number;
}

/** The mark of everything this file puts in a request. No stimulus can carry it: see `stimulusText` in brain/memory.ts. */
export const MEMORY_MARK = '[memory]';

/** A journal time as the agent reads it: to the minute, in UTC. */
function when(ts: string): string {
  const at = new Date(ts);
  return Number.isNaN(at.getTime()) ? ts : `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * What the memory system says of whose experience a memory is, where that matters: a stretch in
 * which the owner said nothing. What such a memory holds came from other people, from tools, from
 * pages, or from the agent itself, however it is worded, and none of it is the owner's word.
 */
function whose(m: Memory | Merge): string {
  if (m.voices === undefined || m.voices.owner > 0) return '';
  const outside = m.voices.others + m.voices.tools;
  return outside > m.voices.own
    ? ' Your owner said nothing in that stretch: most of it was what others wrote and what tools returned, which you read, not what you were told by your owner.'
    : ' Your owner said nothing in that stretch.';
}

/** A memory as two messages: the question is the memory system's, the answer is the agent's own, as it wrote it. */
function recalled(m: Memory | Merge, more = ''): ChatMessage[] {
  return [
    { role: 'user', content: `${MEMORY_MARK} ${when(m.start)} to ${when(m.end)}. What do you remember of it?${whose(m)}${more}` },
    { role: 'assistant', content: `${m.title}\n\n${m.text}` },
  ];
}

/** One thing in the logbook: the memory of one episode, one memory that stands for several, or a stretch the owner pinned, shown as it happened. `from` and `to` are places among the remembered episodes. */
export interface Entry {
  from: number;
  to: number;
  /** 1 for an episode, more for a memory of several, 0 for a pinned stretch, which is never made into anything wider. */
  level: number;
  messages: ChatMessage[];
}

/** The share of the room that pinned stretches may take together. What is pinned beyond it is shown as its memory, and said to be. */
export const PIN_SHARE = 0.3;
const PINNED = `${MEMORY_MARK} Your owner pinned the stretch that follows: it is shown as it happened.`;
const PIN_UNMET = ' Your owner pinned this stretch to be shown as it happened, but it no longer fits; `open` shows it.';

/** What the owner pinned, among the remembered episodes, and how to show a stretch as it happened. */
export interface Pins {
  /** Places, among the remembered episodes, of those that hold a pinned event. */
  held: Set<number>;
  /** The messages of the episode at a place, as they happened. */
  verbatim: (place: number) => ChatMessage[];
  /** Characters pinned stretches may take together. */
  room: number;
}

/** The places, among `kept`, of the episodes that hold an event the owner pinned. */
export function pinnedAmong(events: JournalEvent[], kept: Episode[]): Set<number> {
  const held = new Set<number>();
  const marked = pinned(events);
  if (marked.size === 0) return held;
  const at = new Map(events.map((e, i) => [e.id, i]));
  for (const id of marked) {
    const index = at.get(id);
    if (index === undefined) continue;
    const place = kept.findIndex((e) => e.from <= index && index < e.to);
    if (place !== -1) held.add(place);
  }
  return held;
}

/**
 * The first `count` remembered episodes as the logbook shows them: each as its own memory, or
 * several as the one memory that stands for them. Where memories of several nest, the widest is
 * shown. A wider memory is used only when everything it stands for is among those `count`: an
 * episode still shown as it happened is not also told in a summary. A stretch the owner pinned is
 * shown as it happened, for as long as the pinned stretches together fit their share of the room,
 * and is never taken into a wider memory.
 */
export function entries(kept: Episode[], count: number, { memories, quarantined, merges }: Remembered, pins?: Pins): Entry[] {
  const endsAt = new Map(kept.map((e, i) => [e.last, i]));
  const out: Entry[] = [];
  let pinRoom = pins?.room ?? 0;
  for (let i = 0; i < count;) {
    const episode = kept[i]!;
    let unmet = '';
    if (pins?.held.has(i)) {
      const lived = pins.verbatim(i);
      const size = lived.reduce((n, m) => n + sizeOf(m), 0);
      if (size <= pinRoom) {
        pinRoom -= size;
        out.push({ from: i, to: i, level: 0, messages: [{ role: 'user', content: PINNED }, ...lived] });
        i += 1;
        continue;
      }
      unmet = PIN_UNMET;
    }
    let wide: Merge | null = null;
    let reach = i;
    for (const merge of merges) {
      if (merge.from !== episode.first) continue;
      const to = endsAt.get(merge.to);
      if (to === undefined || to >= count || to <= i) continue;
      // A pinned stretch is told by no wider memory.
      if (pins !== undefined && Array.from({ length: to - i + 1 }, (_, k) => i + k).some((place) => pins.held.has(place))) continue;
      if (to > reach || (to === reach && wide !== null && merge.level > wide.level)) {
        wide = merge;
        reach = to;
      }
    }
    if (wide !== null) {
      out.push({ from: i, to: reach, level: wide.level, messages: recalled(wide) });
      i = reach + 1;
      continue;
    }
    const memory = memories.get(episode.first);
    const given = quarantined.get(episode.first);
    const messages = memory !== undefined ? (memory.outcome === 'quiet' ? [] : recalled(memory, unmet))
      : given !== undefined ? unremembered(given)
      // Remembered once, and the memory withdrawn by the owner: it is being formed again.
      : [{ role: 'user' as const, content: `${MEMORY_MARK} ${when(episode.start)} to ${when(episode.end)}: your memory of this stretch was withdrawn and is being formed again. It is in your journal as it happened.` }];
    out.push({ from: i, to: i, level: unmet === '' ? 1 : 0, messages });
    i += 1;
  }
  return out;
}

/** A stretch that has no memory and no longer fits. It is not passed over in silence: the agent can open it. */
function unremembered(q: QuarantineData): ChatMessage[] {
  return [{
    role: 'user',
    content: `${MEMORY_MARK} ${when(q.start)} to ${when(q.end)}: no memory could be formed of this stretch (${q.reason}). It is in your journal as it happened.`,
  }];
}

const SEAM = `${MEMORY_MARK} What follows is shown as it happened.`;

export interface Logbook {
  /** What stands before the part shown as it happened: the memories of what no longer fits, then what the agent knows. Empty when there is neither. */
  head: ChatMessage[];
  /**
   * The line between the two, when there is a head: the first message of the part shown as it
   * happened. That part may begin in the middle of a turn, with a reply; a provider wants a
   * conversation to go on from something said to the agent, and this is it.
   */
  seam: ChatMessage | null;
  /** The position in `messages` at which that part begins. */
  start: number;
}

/**
 * Decides how much of the conversation is shown as memories.
 *
 * `messages` is the whole journal as a conversation and `origin[i]` the position, in `events`, of
 * the event that `messages[i]` was made from. Only episodes that were remembered (or given up on)
 * can be swapped, and those are always the oldest ones. What is left over when they do not suffice
 * is for `fit` in brain/memory.ts to cut, as it did before there were memories.
 */
export function logbook(events: JournalEvent[], messages: ChatMessage[], origin: number[], room: number, chosen: Sizes = {}): Logbook {
  // "Today" is the day of the journal's last event: the same journal always gives the same request.
  const last = events.at(-1)?.ts ?? '';
  // How the memory itself stands, while anything is wrong with it (brain/health.ts): the agent is the first who can do something about it.
  const ill = healthNote(health(events, Date.parse(last) || 0), MEMORY_MARK);
  const held = [knownText(known(events), last.slice(0, 10), MEMORY_MARK), ill].filter((text) => text !== null).join('\n');
  const knowing: ChatMessage[] = held === '' ? [] : [{ role: 'user', content: held }];
  const nothingSwapped: Logbook = { head: knowing, seam: null, start: 0 };
  const all = remembered(events);
  if (all.spans.length === 0) return nothingSwapped;
  const kept = episodes(events, all.spans).filter((e) => e.why === 'kept');
  if (kept.length === 0) return nothingSwapped;

  // Where each remembered episode ends in `messages`, and how much everything before that point counts.
  const sizes = messages.map(sizeOf);
  const total = sizes.reduce((sum, n) => sum + n, 0);
  const ends: number[] = [];
  const before: number[] = [];
  let at = 0;
  let sum = 0;
  for (const episode of kept) {
    while (at < messages.length && origin[at]! < episode.to) sum += sizes[at++]!;
    ends.push(at);
    before.push(sum);
  }

  const cap = Math.min(Math.max(0, chosen.logbookChars ?? DEFAULT_LOGBOOK_CHARS), Math.floor(room * LOGBOOK_SHARE));
  const starts = (place: number): number => (place === 0 ? 0 : ends[place - 1]!);
  const pins: Pins = { held: pinnedAmong(events, kept), verbatim: (place) => messages.slice(starts(place), ends[place]!), room: Math.floor(room * PIN_SHARE) };
  const headOf = (count: number): ChatMessage[] => [...(count === 0 ? [] : trimmed(entries(kept, count, all, pins), cap)), ...knowing];
  const fits = (count: number): boolean => headOf(count).reduce((n, m) => n + sizeOf(m), SEAM.length) + total - (count === 0 ? 0 : before[count - 1]!) <= room;

  // The amount swapped, measured from the start of the journal, is a multiple of one step: it stays where it is while the journal grows by up to a step.
  // What is wanted is the chosen size; the room is only the most that can be sent.
  const want = Math.min(room, Math.max(0, chosen.tailChars ?? DEFAULT_TAIL_CHARS));
  const step = Math.max(1, Math.floor(want * STEP));
  const toSwap = total > want ? Math.ceil((total - want) / step) * step : 0;
  let count = 0;
  if (toSwap > 0) {
    count = 1;
    while (count < kept.length && before[count - 1]! < toSwap) count += 1;
  }
  // The memories take room themselves; one more episode at a time until it all fits or there is none left to swap.
  while (count > 0 && count < kept.length && !fits(count)) count += 1;
  return count === 0 ? nothingSwapped : { head: headOf(count), seam: { role: 'user', content: SEAM }, start: ends[count - 1]! };
}

/**
 * The logbook within `cap` characters: the oldest memories leave, in steps, and a line says how
 * many. They are not lost; brain/memory.ts only stops showing them. A stretch the owner pinned
 * never leaves this way: it has a room of its own.
 */
function trimmed(shown: Entry[], cap: number): ChatMessage[] {
  const sizeOfEntry = (entry: Entry): number => entry.messages.reduce((n, m) => n + sizeOf(m), 0);
  const told = shown.filter((entry) => entry.level !== 0 || entry.messages.length === 1);
  const total = told.reduce((n, entry) => n + sizeOfEntry(entry), 0);
  const leave = new Set<Entry>();
  if (total > cap) {
    const step = Math.max(1, Math.floor(cap * STEP));
    const toDrop = Math.ceil((total - cap) / step) * step;
    let dropped = 0;
    for (const entry of told) {
      if (dropped >= toDrop) break;
      dropped += sizeOfEntry(entry);
      leave.add(entry);
    }
  }
  const gone = [...leave].filter((entry) => entry.messages.length > 0).length;
  return [
    ...(gone === 0 ? [] : [{ role: 'user' as const, content: `${MEMORY_MARK} ${gone} earlier memories are not shown here. They are in your journal.` }]),
    ...shown.filter((entry) => !leave.has(entry)).flatMap((entry) => entry.messages),
  ];
}
