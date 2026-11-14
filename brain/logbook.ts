import type { JournalEvent } from './journal';
import type { ChatMessage } from './provider';
import { IMAGE_CHARS } from '../body/images';
import { episodes, type Episode } from './episodes';
import { known, knownText } from './known';
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
function recalled(m: Memory | Merge): ChatMessage[] {
  return [
    { role: 'user', content: `${MEMORY_MARK} ${when(m.start)} to ${when(m.end)}. What do you remember of it?${whose(m)}` },
    { role: 'assistant', content: `${m.title}\n\n${m.text}` },
  ];
}

/** One thing in the logbook: the memory of one episode, or one memory that stands for several. `from` and `to` are places among the remembered episodes. */
export interface Entry {
  from: number;
  to: number;
  /** 1 for an episode, more for a memory of several. */
  level: number;
  messages: ChatMessage[];
}

/**
 * The first `count` remembered episodes as the logbook shows them: each as its own memory, or
 * several as the one memory that stands for them. Where memories of several nest, the widest is
 * shown. A wider memory is used only when everything it stands for is among those `count`: an
 * episode still shown as it happened is not also told in a summary.
 */
export function entries(kept: Episode[], count: number, { memories, quarantined, merges }: Remembered): Entry[] {
  const endsAt = new Map(kept.map((e, i) => [e.last, i]));
  const out: Entry[] = [];
  for (let i = 0; i < count;) {
    const episode = kept[i]!;
    let wide: Merge | null = null;
    let reach = i;
    for (const merge of merges) {
      if (merge.from !== episode.first) continue;
      const to = endsAt.get(merge.to);
      if (to === undefined || to >= count || to <= i) continue;
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
    const messages = memory !== undefined ? (memory.outcome === 'quiet' ? [] : recalled(memory)) : given === undefined ? [] : unremembered(given);
    out.push({ from: i, to: i, level: 1, messages });
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
  const held = knownText(known(events), (events.at(-1)?.ts ?? '').slice(0, 10), MEMORY_MARK);
  const knowing: ChatMessage[] = held === null ? [] : [{ role: 'user', content: held }];
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
  const headOf = (count: number): ChatMessage[] => [...(count === 0 ? [] : trimmed(entries(kept, count, all).flatMap((entry) => entry.messages), cap)), ...knowing];
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
 * The logbook within `cap` characters: the oldest memories leave, in steps, and a line says
 * how many. They are not lost; brain/memory.ts only stops showing them.
 */
function trimmed(pairs: ChatMessage[], cap: number): ChatMessage[] {
  const total = pairs.reduce((n, m) => n + sizeOf(m), 0);
  if (total <= cap) return pairs;
  const step = Math.max(1, Math.floor(cap * STEP));
  const toDrop = Math.ceil((total - cap) / step) * step;
  let dropped = 0;
  let start = 0;
  let memoriesGone = 0;
  while (start < pairs.length && (dropped < toDrop || pairs[start]!.role !== 'user')) {
    if (pairs[start]!.role === 'user') memoriesGone += 1;
    dropped += sizeOf(pairs[start]!);
    start += 1;
  }
  return [{ role: 'user', content: `${MEMORY_MARK} ${memoriesGone} earlier memories are not shown here. They are in your journal.` }, ...pairs.slice(start)];
}
