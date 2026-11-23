import { acceptanceNotes } from './acceptance';
import { acceptedSince, idleFrom, namesBefore } from './frame-table';
import { idleTicks } from './idle';
import { RESULT_KIND, lastResult } from './exam';
import { healthOf } from './health';
import { RECENT, lessonPlaces, lessonTextOf, lessonsOf } from './lessons';
import { lessonsFrom } from './lessons-table';
import { LINK_NOTES, outdatedStretches } from './links';
import { MEMORY_MARK, knowingOf, swapped, type Head, type Sizes } from './logbook';
import { OVERLAP_EPISODES, assemble, buildMessages, frameOf, narrow, type Frame, type Sight, type View } from './memory';
import type { ChatMessage } from './provider';
import { PIN_KIND, UNPIN_KIND, pinned } from './owned';
import type { JournalEvent } from './journal';
import type { Past } from './past';
import type { Ray } from './ray';
import { reply } from './wire';

/**
 * The frame of a request (brain/memory.ts), asked of the database: the last part of the
 * conversation as it stands, and beside it what the tables hold of everything before. It is the
 * frame `narrow` makes of a journal held whole, and gives the same request; the two are held
 * against each other on every kind of journal in test/brain/frame.test.ts.
 *
 * `room`, `chosen` and `sees` are as for `narrow`. A journal read through (no database at hand)
 * is answered by `narrow` itself.
 *
 * With `end`, the conversation is read up to the event of that number, without it: for a request
 * made again after its turn wrote notes of its own that are no part of any request (the mark of
 * what was shown, brain/shown.ts). Only such notes may lie at `end` and after.
 */
export function frameFrom(past: Past, room: number, chosen: Sizes = {}, sees = false, end?: number): Frame {
  if (past.by !== 'store' || past.ray === undefined) return narrow(frameOf(past.standingFrom(0, end), past.known()), room, chosen, sees);
  const ray = past.ray;
  const told = past.remembered();
  const cut = past.episodes();
  let lies = 0;
  const all = cut.map((e) => ({ ...e, lies: lies += e.shown }));
  const kept = all.filter((e) => e.why === 'kept');
  const whole = lies;

  // The episodes that hold an event the owner pinned: such a stretch is shown as it happened wherever it lies.
  const marked = pinned(past.notes([PIN_KIND, UNPIN_KIND]));
  const held = new Set<number>();
  if (marked.size > 0) {
    for (const seq of past.places([...marked]).values()) {
      const place = kept.findIndex((e) => e.fromSeq <= seq && seq < e.toSeq);
      if (place !== -1) held.add(place);
    }
  }

  // Where the part at hand begins: as `narrow` has it.
  const count = swapped({ kept, whole }, room, chosen);
  const begin = count === 0 || held.size > 0 ? null : kept[Math.max(0, count - 1 - OVERLAP_EPISODES)]!;
  const first = begin === null ? 0 : begin.from;
  const events = past.standingFrom(first === 0 ? 0 : begin!.fromSeq, end);
  const before = { chars: 0, calls: 0, slots: 0 };
  for (const e of all) {
    if (e.to > first) break;
    before.chars += e.chars;
    before.calls += e.calls;
    if (sees) before.slots += e.slots;
  }
  let used = new Set<string>();
  if (before.calls > 0) {
    const ids: string[] = [];
    for (const e of events) if (e.type === 'assistant') for (const call of reply(e).calls) {
      const id = (typeof call === 'object' && call !== null ? call as { id?: unknown } : {}).id;
      if (typeof id === 'string') ids.push(id);
    }
    used = namesBefore(ray, before.calls, ids);
  }

  const last = events.at(-1)?.ts ?? '';
  const known = past.known();
  const lessons = process.env.TENERAL_LESSONS === '0' ? null : lessonsText(past, ray, events, first === 0, last, end);
  const health = healthOf({ told, cut, known, exam: lastResult(past.notes([RESULT_KIND])), idle: first === 0 ? idleTicks(events) : idleFrom(ray) }, Date.parse(last) || 0);
  const head: Head = { last, knowing: knowingOf(known, last, lessons, health), told, kept, whole, pinned: held, outdated: outdatedStretches(past.notes(LINK_NOTES), told) };
  return { events, first, before, usedBefore: (id) => used.has(id), accepted: first === 0 ? acceptanceNotes(events) : acceptedSince(ray, begin!.fromSeq), head };
}

/** The lessons that bear on now, as they are shown (`lessonText` in brain/lessons.ts), from the notes about them the tables hold. */
function lessonsText(past: Past, ray: Ray, events: JournalEvent[], whole: boolean, last: string, end: number | undefined): string | null {
  const { records, conversation } = lessonsFrom(ray);
  if (records.length === 0) return null;
  const ids = lessonPlaces(records);
  const places = ids.length === 0 ? new Map<string, number>() : past.places(ids);
  const all = lessonsOf(records, (id) => places.get(id), Date.parse(last) || Date.now());
  // What the agent is at now is read in the latest events: more of them are asked for when the part at hand is shorter than that.
  let latest = events;
  for (let back = 4 * RECENT; latest.length < RECENT && !whole; back *= 4) {
    const from = Math.max(0, (end ?? past.count()) - back);
    latest = past.standingFrom(from, end);
    if (from === 0) break;
  }
  return lessonTextOf(all, conversation, latest, MEMORY_MARK);
}

/**
 * The request for `events`, which is the journal up to some event. Asked of the database where
 * there is a past: the same request, made from the last part of the conversation and what the
 * tables hold of the rest, read up to the last of `events` whatever was journaled since (a turn's
 * own mark of what was shown, or something that arrived just now). Made from `events` themselves
 * when there is no past, or when asking it fails: nothing is lost to the database.
 */
export function requestFrom(past: Past | undefined, events: JournalEvent[], system: string, budgetChars: number, sight: Sight | undefined, view: View = {}): ChatMessage[] {
  const last = events.at(-1)?.id;
  if (past !== undefined && last !== undefined) {
    try {
      const at = past.places([last]).get(last);
      if (at !== undefined) return assemble(frameFrom(past, budgetChars - system.toWellFormed().length, view, sight !== undefined, at + 1), system, budgetChars, sight, view);
    } catch (err) {
      console.error(`[memory] the request was made from the journal, not the database: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return buildMessages(events, system, budgetChars, sight, view);
}
