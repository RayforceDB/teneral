import { acceptanceNotes } from './acceptance';
import { episodesOf, shownChars, slimOf } from './episodes';
import { acceptedSince, idleFrom, namesBefore } from './frame-table';
import { idleOf, idleStart, idleStep, idleTicks } from './idle';
import { RESULT_KIND, lastResult } from './exam';
import { healthOf } from './health';
import { KNOWN_NOTES, knownOf, knownStart, knownStep } from './known';
import { putsFrom } from './known-table';
import { RECENT, lessonPlaces, lessonTextOf, lessonsOf } from './lessons';
import { conversationBefore, lessonsBefore, lessonsFrom } from './lessons-table';
import type { Placed } from './memory-table';
import { LATER_NOTES, LINK_NOTES, laterNoteOf, outdatedStretches } from './links';
import { MEMORY_MARK, knowingOf, swapped, type Head, type Sizes } from './logbook';
import { OVERLAP_EPISODES, assemble, buildMessages, frameOf, narrow, needsTurn, owes, type Frame, type Sight, type View } from './memory';
import type { ChatMessage } from './provider';
import { BACK_KIND, PIN_KIND, UNPIN_KIND, WITHDRAW_KIND, pinned } from './owned';
import { EPISODE_KIND, MERGE_KIND, QUARANTINE_KIND, remembered } from './remembered';
import { readEvents, readEventsFrom, type JournalEvent } from './journal';
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
 * when there is no past, or when asking it fails: nothing is lost to the database. A reader that
 * holds only the last part of the journal gives `whole`, which reads the rest for that case.
 */
export function requestFrom(past: Past | undefined, events: JournalEvent[], system: string, budgetChars: number, sight: Sight | undefined, view: View = {}, whole?: () => JournalEvent[]): ChatMessage[] {
  const last = events.at(-1)?.id;
  if (past !== undefined && last !== undefined) {
    try {
      const at = past.places([last]).get(last);
      if (at !== undefined) return assemble(frameFrom(past, budgetChars - system.toWellFormed().length, view, sight !== undefined, at + 1), system, budgetChars, sight, view);
    } catch (err) {
      console.error(`[memory] the request was made from the journal, not the database: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return buildMessages(whole === undefined ? events : whole(), system, budgetChars, sight, view);
}

/**
 * The frame of the request a memory of `episode` is formed from (brain/sleep.ts): the journal as
 * of the end of that episode, with the notes written later that are about what came before it
 * (`asOfEvents`). Asked of the database, it is the frame `frameOf` makes of that journal, narrowed:
 * what was remembered, known, pinned and outdated then is made from the notes up to then and the
 * later ones that belong, each by the function that reads a whole journal; the counts of what lies
 * before, the idle ticks and the conversation being lived are read where the tables keep them for
 * the end of every episode.
 */
export function frameAsOf(past: Past, episode: Placed, room: number, chosen: Sizes = {}): Frame {
  const ray = past.ray;
  if (ray === undefined) throw new Error('a frame as of an earlier moment is asked of the database');
  const end = episode.toSeq;
  const kinds = [...new Set([EPISODE_KIND, QUARANTINE_KIND, MERGE_KIND, WITHDRAW_KIND, ...KNOWN_NOTES, ...LINK_NOTES, ...LATER_NOTES, PIN_KIND, UNPIN_KIND, RESULT_KIND])];
  const noted = past.notesAt(kinds);
  // The notes written after the episode that are about what came before it.
  const after = noted.filter((n) => n.seq >= end && n.event.type === 'note' && LATER_NOTES.includes(n.event.kind));
  const named = after.flatMap((n) => {
    const about = (n.event as { data?: { from?: unknown; episode?: unknown } | null }).data;
    return [about?.from, about?.episode].filter((id): id is string => typeof id === 'string');
  });
  const places = named.length === 0 ? new Map<string, number>() : past.places([...new Set(named)]);
  const before = (id: unknown): boolean => typeof id === 'string' && (places.get(id) ?? Infinity) < episode.fromSeq;
  const earlier = after.filter((n) => laterNoteOf(n.event, before)).map((n) => n.event);
  const then = noted.filter((n) => n.seq < end);
  const notes = [...then.map((n) => n.event), ...earlier];

  const told = remembered(notes);
  const cut = past.episodes();
  let lies = 0;
  const kept = cut.filter((e) => e.why === 'kept' && e.to <= episode.from).map((e) => ({ ...e, lies: lies += e.shown }));
  const keptTo = kept.at(-1)?.to ?? 0;
  const keptSeq = kept.at(-1)?.toSeq ?? 0;

  const marked = pinned(notes);
  const held = new Set<number>();
  if (marked.size > 0) {
    for (const seq of past.places([...marked]).values()) {
      const place = kept.findIndex((e) => e.fromSeq <= seq && seq < e.toSeq);
      if (place !== -1) held.add(place);
    }
  }

  // Everything after what was remembered then, up to the end of the episode: read once, for what it counts for and for what is shown of it.
  const rest = [...past.standingFrom(keptSeq, end), ...earlier];
  const whole = lies + rest.reduce((sum, e) => sum + shownChars(e), 0);
  const count = swapped({ kept, whole }, room, chosen);
  const begin = count === 0 || held.size > 0 ? null : kept[Math.max(0, count - 1 - OVERLAP_EPISODES)]!;
  const first = begin === null ? 0 : begin.from;
  const events = first === keptTo ? rest : [...past.standingFrom(first === 0 ? 0 : begin!.fromSeq, keptSeq), ...rest];
  const counts = { chars: 0, calls: 0, slots: 0 };
  for (const e of cut) {
    if (e.to > first) break;
    counts.chars += e.chars;
    counts.calls += e.calls;
  }
  let used = new Set<string>();
  if (counts.calls > 0) {
    const ids: string[] = [];
    for (const e of events) if (e.type === 'assistant') for (const call of reply(e).calls) {
      const id = (typeof call === 'object' && call !== null ? call as { id?: unknown } : {}).id;
      if (typeof id === 'string') ids.push(id);
    }
    used = namesBefore(ray, counts.calls, ids);
  }

  const last = (earlier.at(-1) ?? rest.at(-1) ?? events.at(-1))?.ts ?? '';
  // What was known then: the step that reads a whole journal, taken over the notes up to then and the replies that put something to the owner, in their order, and then over the later notes that belong.
  const state = knownStart();
  const read = [...then.filter((n) => n.event.type === 'note' && KNOWN_NOTES.includes(n.event.kind)), ...putsFrom(ray).filter((p) => p.seq < end)].sort((a, b) => a.seq - b.seq);
  for (const { event } of read) knownStep(state, event);
  for (const event of earlier) knownStep(state, event);
  const known = knownOf(state);

  // The episodes as they stood: the remembered ones, then what the rules make of the rest.
  const open = episodesOf(rest.map(slimOf)).map((e) => ({ ...e, from: e.from + keptTo, to: e.to + keptTo }));
  const idle = { ...(kept.at(-1)?.idle ?? idleStart()) };
  for (const e of rest) idleStep(idle, e);
  const health = healthOf({ told, cut: [...kept, ...open], known, exam: lastResult(then.map((n) => n.event)), idle: idleOf(idle) }, Date.parse(last) || 0);

  let lessons: string | null = null;
  if (process.env.TENERAL_LESSONS !== '0') {
    const records = lessonsBefore(ray, end);
    if (records.length > 0) {
      const ids = lessonPlaces(records);
      const at = ids.length === 0 ? new Map<string, number>() : past.places(ids);
      let latest = events;
      for (let back = 4 * RECENT; latest.length < RECENT && first > 0; back *= 4) {
        const from = Math.max(0, end - back);
        latest = [...past.standingFrom(from, end), ...earlier];
        if (from === 0) break;
      }
      lessons = lessonTextOf(lessonsOf(records, (id) => at.get(id), Date.parse(last) || Date.now()), conversationBefore(ray, end), latest, MEMORY_MARK);
    }
  }
  const head: Head = { last, knowing: knowingOf(known, last, lessons, health), told, kept, whole, pinned: held, outdated: outdatedStretches(notes, told) };
  return { events, first, before: counts, usedBefore: (id) => used.has(id), accepted: first === 0 ? acceptanceNotes(events) : acceptedSince(ray, begin!.fromSeq), head };
}

/**
 * Whether a turn is owed (`needsTurn` in brain/memory.ts), asked without reading the journal
 * through: nothing before the latest thing said to the agent bears on it, so the past is asked
 * where that lies and the journal is read from there. The journal is read whole when there is no
 * past, when nothing was ever said, or when a conversation was taken back since.
 */
export function turnOwed(past: Past | undefined, journal: string): boolean {
  if (past?.by === 'store') {
    try {
      const from = past.asked();
      const tail = from === null ? [] : readEventsFrom(journal, from);
      if (tail[0]?.type === 'stimulus' && !tail.some((e) => e.type === 'note' && e.kind === BACK_KIND)) return owes(tail, past.accepted());
    } catch (err) {
      console.error(`[memory] whether a turn is owed was read from the journal, not asked of the database: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return needsTurn(readEvents(journal));
}
