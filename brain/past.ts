import { existsSync, statSync } from 'node:fs';
import { readEvents, type JournalEvent } from './journal';
import { episodes, type Episode } from './episodes';
import { BACK_KIND, standing, wasSaid, fromOwner } from './owned';
import { libraryAt, openRay, type Ray } from './ray';
import { serverAt, startRayServer, type RayServer } from './rayserver';
import { documentOf, fused, FUSED, keyed, recall, scanIndex, type Hit, type Index, type Kind } from './recall';
import { openVectors } from './vectors';
import { LINE_MAX, OUTDATED_KIND, links, tiesOf, type Since } from './links';
import { known, type Known } from './known';
import { acceptanceNotes } from './acceptance';
import { acceptedSince, frameProjection, standsFrom, type Stands } from './frame-table';
import { idleTicks, ownStart, ownStep } from './idle';
import { ownSpentSince, spendProjection } from './spend-table';
import { countOf, countStates, firstOf, firstStates, lastOf, lastStates, newestState, statesOf, statesProjection, type StateRow } from './states-table';
import { quietFrom, quietOf, wakeStart, wakeStep, wakesProjection } from './wakes-table';
import { useLift, usedFrom, usedOf, usesProjection } from './uses-table';
import { aboutFrom, aboutOf, entitiesFrom, entitiesOf, entitiesProjection, entityGraph, read as namings, type About, type Entity } from './entities-table';
import { knownFrom, knownProjection } from './known-table';
import { lessonPlaces, lessonStart, lessonStep, lessons, lessonsOf, type Lesson } from './lessons';
import { lessonsFrom, lessonsProjection } from './lessons-table';
import { counted } from './wire';
import { MEMORY, countedBefore, countsFrom, countsOf, episodesFrom, keptFrom, memoryProjection, rememberedFrom, type MemoryCounts, type Placed } from './memory-table';
import { remembered, type Remembered } from './remembered';
import { TIES, tiesProjection } from './ties-table';
import { boundAs, openStore, readLine, scan, type Line, type Projection, type Store } from './store';
import { clip } from '../body/text';

// The past as the agent can ask for it: found by words, opened where something happened, and
// laid out as a line of episodes. It is what the tools `recall`, `open` and `timeline` stand on.
//
// It works in two ways and answers the same in both. With the database's library at hand, the
// journal is laid out in a store (brain/store.ts) and a question costs about a millisecond
// however long the agent has lived. Without it, the journal is read through for every question,
// which is right but grows slower with every day.

export interface Past {
  /** `store` when the database answers, `journal` when the journal is read through. */
  by: 'store' | 'journal';
  /** The events that answer `question` best, each with the event itself. */
  find(question: string, options?: { kinds?: Kind[]; limit?: number; /** Only what shares words with the question: nothing found by meaning alone (brain/vectors.ts). */ words?: boolean }): Found[];
  /** Where the line of the latest thing said to the agent begins: what it is answering now, which is no find of its own past. Null when nothing was said yet. */
  asked(): number | null;
  /** The event with this id and the ones around it, in order; null when the journal has no such event. */
  around(id: string, before: number, after: number): { events: JournalEvent[]; at: number } | null;
  /** The newest event of this type, and of this source when one is given (a stimulus's source, a note's kind, a called tool's name); null when there is none. */
  latest(type: string, source?: string): JournalEvent | null;
  /** The notes of these kinds, in order. */
  notes(kinds: readonly string[]): JournalEvent[];
  /** What was said to the agent from these sources, in order: also what the owner took back, as a record of who spoke. */
  stimuli(sources: readonly string[]): JournalEvent[];
  /** The calls of the tool `name` made at or after the time `since` (milliseconds), as their intents were journaled, the newest first. */
  callsSince(name: string, since: number): JournalEvent[];
  /** Every event of this type, in order: for the rare kinds of record. */
  ofType(type: string): JournalEvent[];
  /** What the owner said after the event numbered `seq` (from the terminal or a source `owner:…`), in order, of the conversation as it stands. */
  ownerSaidSince(seq: number): JournalEvent[];
  /** The lessons as they stand (brain/lessons.ts), and the conversation being lived as the rules alone cut the journal: the first event of it. */
  lessons(): { held: Lesson[]; conversation: string | undefined };
  /** What was said from these sources and the notes of these kinds, together, in order: what a sensor reads to know where it was. Read once for as long as the journal has not grown. */
  picked(sources: readonly string[], kinds: readonly string[]): JournalEvent[];
  /** The same, each with its number (the place of its line, when the journal is read through). */
  notesAt(kinds: readonly string[]): { event: JournalEvent; seq: number }[];
  /**
   * What the agent knows and means to do now: the facts that hold, the intentions that are open, and the ones that were closed (brain/known.ts).
   * Of everything the journal holds: what was put to the owner in a conversation taken back was put all the same.
   */
  known(): Known;
  /** The conversation as it stands from the event numbered `seq` on (the place of its line, when the journal is read through) and before the one numbered `end`. */
  standingFrom(seq: number, end?: number): JournalEvent[];
  /** The byte of the journal just after the newest reply or interruption: where what no turn has settled yet begins. 0 when there is none. */
  settled(): number;
  /** How many events the journal holds: the number the next one will have. */
  count(): number;
  /** How the conversation stands in what is asked between turns: idle clock ticks in a row, when the owner last spoke and the clock last ticked ('' when never), and the number of the event a reading for the next report begins at. */
  stands(): Stands;
  /** How everything of one kind stands (brain/states-table.ts): the last said of each key, in the order said; with `state` or `gen`, only those that stand so. */
  states(name: string, where?: { state?: string; gen?: string }): StateRow[];
  /** How often each key of one kind was said to stand in each way. */
  stateCounts(name: string): { key: string; state: string; n: number }[];
  /** The first note about each of `keys`, in the order said. */
  firstStates(name: string, keys: string[]): StateRow[];
  /** How the newest note about any of `keys` says it stands; null when none was ever said. */
  stateOf(name: string, keys: string[]): string | null;
  /** Whether the newest `run` wakes from `source` that carry `mark` (the words naming a channel) and that no glance settled were all answered with silence (brain/wakes-table.ts). */
  quiet(source: string, mark: string, run: number): boolean;
  /** Everyone and everything the agent named as what a stretch was about, the most named first (brain/entities-table.ts). */
  entities(): Entity[];
  /** What is tied to one of them, by name: the stretches that named it, who was named beside it, and the memories that have the name in their words. */
  about(name: string): About;
  /** The tokens the agent's own time took from `since` on, in milliseconds (`ownSpend` in brain/agenda.ts). */
  ownSpent(since: number): number;
  /** What the stem's acceptance of a species commit says to the agent, by the id of the event that records it (brain/acceptance.ts). */
  accepted(): Map<string, string>;
  /** The numbers of the events with these ids, of those that stand. */
  places(ids: string[]): Map<string, number>;
  /** What is remembered: the memories, the stretches no memory could be formed of, and the wider memories (brain/remembered.ts). */
  remembered(): Remembered;
  /** The conversation as it stands, cut into episodes, each with the numbers of its events in the database (the place after the last for `toSeq`). */
  episodes(): Placed[];
  /** The remembered episodes in order, each with what everything up to its end counts for once old. */
  kept(): (Placed & { lies: number })[];
  /** What the episodes ending at or before the place `to` count for together (characters, calls, places for images), and what all episodes count for once old. */
  countedBefore(to: number): { chars: number; calls: number; slots: number; whole: number };
  /** How the memory stands in numbers: remembered, given up on, wider memories and the mechanical among them, episodes waiting and the end of the oldest. */
  counts(): MemoryCounts;
  /** What became of a memory or a fact since it was written: what made it outdated, and what stands now in its place (brain/links.ts). Null when nothing did. */
  since(id: string): Since | null;
  /** Brings the store up to the journal's end, and writes it out. Both are nothing to do when the journal is read through. */
  sync(): void;
  persist(): void;
  /**
   * Gives the database a little of what it has not embedded yet to embed (brain/vectors.ts), for at
   * most about `ms` milliseconds. Returns how many documents have a vector; nothing to do, and 0,
   * when there are to be no vectors.
   */
  embed(ms: number): number;
  close(): void;
  /** The database itself, when it answers: for other tables made from the journal (body/community.ts). A process has one runtime. */
  ray?: Ray;
}

export interface Found extends Hit {
  event: JournalEvent;
}

/** The journal read through, and read again only when it has grown. */
function reader(journal: string): (() => Line[]) & { all: () => Line[] } {
  let all: Line[] = [];
  let lines: Line[] = [];
  let end = 0;
  const read = (): Line[] => {
    if (existsSync(journal) && statSync(journal).size < end) {
      // Shorter than what was read: another file than before. Start over.
      all = [];
      lines = [];
      end = 0;
    }
    const more = scan(journal, end);
    if (more.lines.length > 0) {
      all = [...all, ...more.lines];
      // Without what the owner took back (brain/owned.ts): it is in the journal and is not found.
      const stands = all.some((line) => line.event.type === 'note' && line.event.kind === BACK_KIND) ? new Set(standing(all.map((line) => line.event))) : null;
      lines = stands === null ? all : all.filter((line) => stands.has(line.event));
    }
    end = more.end;
    return lines;
  };
  // Everything the journal holds, also what the owner took back: for what asks after a record, not after the conversation.
  return Object.assign(read, { all: (): Line[] => { read(); return all; } });
}

/** What is made from the events and kept in tables of the store, for everything that asks the database. */
export const projections = (): Projection[] => [knownProjection(), memoryProjection(), tiesProjection(), frameProjection(), lessonsProjection(), spendProjection(), wakesProjection(), statesProjection(), entitiesProjection(), usesProjection()];

/** How many of the best memories lend weight to the events of their stretches, and how much of their own score they lend. */
const LENDERS = 3;
/** How many keys a question may be led by, and what share of a key's score the event it leads to gains. */
const KEYS = 5;
const KEY_LENT = 1;
const KEY_COVER = 0.75;
// Measured on the first life that wrote its own questions (15 of them, each put in other words than its answer): with nothing lent, the
// answering event was among the first five finds for 3; with 0.3 for 6; with 0.6 to 1 for 7; past 1, questions that name the answer's own
// words began to lose it. The exam is how this number is to be changed (brain/exam.ts).
export const LENT = 0.8;
/** How many finds are looked through before the selected memories' own stretches add their matches. */
const LOOKED = 80;
/** How much the best memory lends to its closing reply, beyond the ordinary lending to every event. */
const CLOSING = 0.4;

/**
 * Finding in two steps. A question put in other words than the answer shares few words with the
 * message that answers it, but many with the memory of that stretch, which the agent wrote in the
 * words it thinks in. So the memories are found first, and the best of them lend part of their
 * score to every find that lies in their stretch: the answer rises because its episode was
 * recognised, not because its own words matched. Matches inside those stretches are included even
 * when they fall below LOOKED globally. The closing reply of the best stretch gets a further lift:
 * after a complaint and the work, it is usually where the outcome is stated. `offsetsOf` says where
 * the lines of events lie; `closingReply` finds the last nonempty assistant reply in a stretch.
 */
function finder(
  index: Index,
  read: (off: number) => JournalEvent | null,
  offsetsOf: (ids: string[]) => Map<string, number>,
  closingReply: (from: number, to: number) => number | null,
  used: () => Map<string, number>,
): Past['find'] {
  return (question, options) => {
    const limit = options?.limit ?? 10;
    const withEvent = (hits: Hit[]): Found[] => hits.flatMap((hit) => {
      const event = read(hit.doc);
      return event === null ? [] : [{ ...hit, event }];
    });
    // The questions written of what happened are keys: each that matches leads to the events it names, which are
    // found by it as well as by their own words, or by it alone.
    const led = new Map<number, number>();
    // Only a key that most of the question's words are in: a word or two in common is no sign that the same thing is asked.
    // The words are weighed by how rare they are among the keys: the telling word of a question counts for most of it.
    const keys = withEvent(recall(index, question, { kinds: ['key'], limit: KEYS }).filter((key) => key.cover >= KEY_COVER));
    if (keys.length > 0) {
      const where = offsetsOf(keys.flatMap((key) => keyed(key.event)));
      for (const key of keys) for (const id of keyed(key.event)) {
        const doc = where.get(id);
        if (doc !== undefined) led.set(doc, Math.max(led.get(doc) ?? 0, key.score));
      }
    }
    // What the agent went back to before counts for a little more (brain/uses-table.ts).
    const opened = new Map<number, number>();
    const times = used();
    if (times.size > 0) for (const [id, doc] of offsetsOf([...times.keys()])) opened.set(doc, times.get(id)!);
    const recallWith: typeof recall = (ix, q, o) => {
      if (led.size === 0 && opened.size === 0) return recall(ix, q, o);
      const all = recall(ix, q, { ...o, limit: Number.MAX_SAFE_INTEGER }).map((hit) => (opened.has(hit.doc) ? { ...hit, score: hit.score * useLift(opened.get(hit.doc)!) } : hit));
      const seen = new Set(all.map((hit) => hit.doc));
      const lifted = all.map((hit) => (led.has(hit.doc) ? { ...hit, score: hit.score + KEY_LENT * led.get(hit.doc)! } : hit));
      for (const [doc, score] of led) {
        if (seen.has(doc)) continue;
        const event = read(doc);
        const kind = event === null ? undefined : documentOf(event)?.kind;
        if (kind !== undefined && kind !== 'key' && (o?.kinds === undefined || o.kinds.includes(kind))) lifted.push({ doc, kind, score: KEY_LENT * score, terms: [], cover: 0 });
      }
      return lifted.sort((a, b) => b.score - a.score || b.doc - a.doc).slice(0, o?.limit ?? 10);
    };
    const memories = withEvent(recall(index, question, { kinds: ['memory'], limit: LENDERS }));
    const stretches = memories.flatMap((m) => {
      const d = (m.event as { data?: { from?: unknown; to?: unknown } }).data;
      return typeof d?.from === 'string' && typeof d?.to === 'string' ? [{ from: d.from, to: d.to, score: m.score }] : [];
    });
    if (stretches.length === 0 || LENT <= 0) return withEvent(recallWith(index, question, options));
    const at = offsetsOf(stretches.flatMap((st) => [st.from, st.to]));
    const spans = stretches.flatMap((st) => {
      const [from, to] = [at.get(st.from), at.get(st.to)];
      return from === undefined || to === undefined ? [] : [{ from, to, score: st.score }];
    });
    if (spans.length === 0) return withEvent(recallWith(index, question, options));
    // Recall has already scored every matching document. Keep the ordinary global pool, then add
    // matches from the selected stretches without another index scan or a local rarity calculation.
    const all = recallWith(index, question, { ...options, limit: Number.MAX_SAFE_INTEGER });
    const inside = all.filter((hit) => hit.kind !== 'memory' && spans.some((sp) => hit.doc >= sp.from && hit.doc <= sp.to));
    const candidates = [...new Map([...all.slice(0, LOOKED + limit), ...inside].map((hit) => [hit.doc, hit])).values()];
    const closing = closingReply(spans[0]!.from, spans[0]!.to);
    const lifted = candidates.map((hit) => {
      // A memory is not lifted by a memory: only what happened is.
      const lent = hit.kind === 'memory' ? 0 : Math.max(0, ...spans.filter((sp) => hit.doc >= sp.from && hit.doc <= sp.to).map((sp) => sp.score));
      const close = hit.kind !== 'memory' && hit.doc === closing ? CLOSING * spans[0]!.score : 0;
      return lent === 0 && close === 0 ? hit : { ...hit, score: hit.score + LENT * lent + close };
    });
    return withEvent(lifted.sort((a, b) => b.score - a.score || b.doc - a.doc).slice(0, limit));
  };
}

/** The past of `journal`, asked of the journal itself. */
export function journalPast(journal: string): Past {
  const lines = reader(journal);
  let tied: { seen: number; ties: ReturnType<typeof tiesOf> } | null = null;
  const mentioned = () => namings(lines.all().map((line) => line.event));
  return {
    by: 'journal',
    remembered: () => remembered(lines().map((line) => line.event)),
    episodes() {
      const standing = lines();
      const events = standing.map((line) => line.event);
      // A journal read through has no numbers but the places of its lines: the place of each event among all the journal holds.
      const place = new Map(lines.all().map((line, i) => [line.event.id, i]));
      return counted(events, episodes(events, remembered(events).spans)).map((e) => ({ ...e, fromSeq: place.get(e.first) ?? e.from, toSeq: (place.get(e.last) ?? e.to - 1) + 1 }));
    },
    kept() {
      let lies = 0;
      return this.episodes().filter((e) => e.why === 'kept').map((e) => ({ ...e, lies: lies += e.shown }));
    },
    countedBefore(to) {
      const out = { chars: 0, calls: 0, slots: 0, whole: 0 };
      for (const e of this.episodes()) {
        out.whole += e.shown;
        if (e.to <= to) { out.chars += e.chars; out.calls += e.calls; out.slots += e.slots; }
      }
      return out;
    },
    counts() { return countsOf(this.episodes(), this.remembered()); },
    // Of everything the journal holds: what was put to the owner in a conversation taken back was put all the same.
    known: () => known(lines.all().map((line) => line.event)),
    standingFrom(seq, end) {
      const stands = new Set(lines());
      return lines.all().flatMap((line, i) => (i >= seq && (end === undefined || i < end) && stands.has(line) ? [line.event] : []));
    },
    count: () => lines.all().length,
    ofType: (type) => lines.all().flatMap((line) => (line.event.type === type ? [line.event] : [])),
    callsSince: (name, since) => lines.all().flatMap((line) => (line.event.type === 'tool.intent' && line.event.name === name && Date.parse(line.event.ts) >= since ? [line.event] : [])).reverse(),
    ownerSaidSince(seq) {
      const stands = new Set(lines());
      return lines.all().flatMap((line, i) => (i > seq && stands.has(line) && line.event.type === 'stimulus' && fromOwner(line.event.source) ? [line.event] : []));
    },
    lessons() {
      const events = lines().map((line) => line.event);
      const state = lessonStart();
      for (const e of events) lessonStep(state, e);
      return { held: lessons(events), conversation: state.conversation === '' ? undefined : state.conversation };
    },
    settled: () => lines.all().findLast((line) => line.event.type === 'assistant' || line.event.type === 'turn.interrupted')?.next ?? 0,
    accepted: () => acceptanceNotes(lines().map((line) => line.event)),
    stands() {
      const events = lines().map((line) => line.event);
      return {
        idle: idleTicks(events), owner: events.findLast((e) => e.type === 'stimulus' && fromOwner(e.source))?.ts ?? '',
        clock: events.findLast((e) => e.type === 'stimulus' && e.source === 'clock')?.ts ?? '', report: 0,
      };
    },
    states(name, where) { return lastOf(statesOf(lines.all().map((line) => line.event), name), where); },
    stateOf(name, keys) { return statesOf(lines.all().map((line) => line.event), name).findLast((row) => keys.includes(row.key))?.state ?? null; },
    firstStates(name, keys) { return firstOf(statesOf(lines.all().map((line) => line.event), name), keys); },
    stateCounts(name) { return countOf(statesOf(lines.all().map((line) => line.event), name)); },
    entities() { return entitiesOf(mentioned()); },
    about(name) { return aboutOf(mentioned(), name, [...this.remembered().memories].map(([from, m]) => ({ from, text: `${m.title}\n${m.text}` }))); },
    quiet(source, mark, run) {
      const state = wakeStart();
      lines.all().forEach((line, seq) => { wakeStep(state, line.event, seq); });
      return quietOf(state.wakes, source, mark, run);
    },
    ownSpent(since) {
      const state = ownStart();
      let spent = 0;
      for (const { event } of lines.all()) { const tokens = ownStep(state, event); if (tokens > 0 && Date.parse(event.ts) >= since) spent += tokens; }
      return spent;
    },
    places(ids) {
      const wanted = new Set(ids);
      const stands = new Set(lines());
      const out = new Map<string, number>();
      lines.all().forEach((line, i) => { if (wanted.has(line.event.id) && stands.has(line)) out.set(line.event.id, i); });
      return out;
    },
    latest(type, source) {
      const named = (e: JournalEvent): unknown => (e.type === 'stimulus' ? (e as { source?: unknown }).source : e.type === 'tool.intent' ? (e as { name?: unknown }).name : e.type === 'note' ? e.kind : '');
      return lines.all().findLast((line) => line.event.type === type && (source === undefined || named(line.event) === source))?.event ?? null;
    },
    notes: (kinds) => lines.all().flatMap((line) => (line.event.type === 'note' && kinds.includes(line.event.kind) ? [line.event] : [])),
    stimuli: (sources) => lines.all().flatMap((line) => (line.event.type === 'stimulus' && sources.includes(line.event.source) ? [line.event] : [])),
    picked: (sources, kinds) => lines.all().flatMap((line) => ((line.event.type === 'stimulus' ? sources.includes(line.event.source) : line.event.type === 'note' && kinds.includes(line.event.kind)) ? [line.event] : [])),
    notesAt: (kinds) => lines.all().flatMap((line, seq) => (line.event.type === 'note' && kinds.includes(line.event.kind) ? [{ event: line.event, seq }] : [])),
    since(id) {
      const now = lines();
      if (tied?.seen !== now.length) tied = { seen: now.length, ties: tiesOf(links(now.map((line) => line.event))) };
      return tied.ties.since(id);
    },
    find: finder(scanIndex(lines), (off) => readLine(journal, off), (ids) => {
      const wanted = new Set(ids);
      return new Map(lines().filter((line) => wanted.has(line.event.id)).map((line) => [line.event.id, line.off]));
    }, (from, to) => lines().filter((line) => line.off >= from && line.off <= to).findLast((line) => {
      const text = (line.event as { text?: unknown }).text;
      return line.event.type === 'assistant' && typeof text === 'string' && text.trim() !== '';
    })?.off ?? null, () => usedOf(lines().map((line) => line.event))),
    asked: () => lines().findLast((line) => line.event.type === 'stimulus')?.off ?? null,
    around(id, before, after) {
      const all = lines();
      const at = all.findIndex((line) => line.event.id === id);
      if (at === -1) return null;
      const from = Math.max(0, at - before);
      return { events: all.slice(from, at + after + 1).map((line) => line.event), at: at - from };
    },
    sync() {},
    persist() {},
    embed: () => 0,
    close() {},
  };
}

/** The past of `journal`, asked of a store in the database `ray`. `owned` says the runtime was opened for this and is closed with it. */
export function storePast(journal: string, ray: Ray, store: Store, owned: boolean, log: (line: string) => void = () => {}): Past {
  const offsets = (source: string): number[] => [...(store.ask(source).columns.off as BigInt64Array | undefined ?? [])].map(Number);
  /** The documents as vectors, when this agent has a model and the database can use it: null otherwise, and then everything below is as it was. */
  const vectors = openVectors(ray, journal, (off, take) => {
    const t = store.ask(`(select {from: events where: (> off ${Math.floor(off)}) asc: off take: ${Math.floor(take)} off: off date: date line: line})`);
    const offs = t.columns.off as BigInt64Array | undefined ?? new BigInt64Array(0);
    const days = t.columns.date as Int32Array | undefined ?? new Int32Array(0);
    return (t.columns.line as string[] | undefined ?? []).flatMap((line, i) => {
      try { return [{ off: Number(offs[i]), day: Number(days[i]), event: JSON.parse(line) as JournalEvent }]; } catch { return []; }
    });
  }, log);
  /**
   * The stretches of the journal the owner took back, as bytes from and to: from the line of the
   * message a note names up to the note's own line. The store holds every line; what stands is
   * decided here, so that taking a conversation back needs no row changed.
   */
  const aside = (): [number, number][] => {
    const ranges: [number, number][] = [];
    for (const off of offsets(`(select {from: events where: (== source '${BACK_KIND}) off: off})`)) {
      const to = (store.read(off) as { data?: { to?: unknown } } | null)?.data?.to;
      if (typeof to !== 'string') continue;
      ray.bind('mem_wanted', { wanted: { type: 'str', data: [to] } });
      const [from] = offsets("(select {from: events where: (in id (at mem_wanted 'wanted)) off: off})");
      if (from !== undefined && from < off) ranges.push([from, off]);
    }
    return ranges;
  };
  /** Where the lines of the events with these ids begin. The ids go over as a column: they come out of notes, which are the body's own, and are still never part of a statement. */
  const offsetsOf = (ids: string[]): Map<string, number> => {
    if (ids.length === 0) return new Map();
    ray.bind('mem_wanted', { wanted: { type: 'str', data: ids } });
    const t = store.ask("(select {from: events where: (in id (at mem_wanted 'wanted)) id: id off: off})");
    return new Map((t.columns.id as string[] | undefined ?? []).map((id, i) => [id, Number((t.columns.off as BigInt64Array)[i])]));
  };
  /** The last assistant event with text in this stretch, or null when it has none. */
  const closingReply = (from: number, to: number): number | null => {
    const candidates = offsets(`(select {from: events where: (and (>= off ${from}) (and (<= off ${to}) (== type 'assistant))) desc: off off: off})`);
    for (const off of candidates) {
      const event = store.read(off) as { text?: unknown } | null;
      if (typeof event?.text === 'string' && event.text.trim() !== '') return off;
    }
    return null;
  };
  /** Whether the event at `off` still stands: records and notes always do, what was said in a stretch taken back does not. */
  const stands = (ranges: [number, number][], off: number, e: JournalEvent): boolean =>
    !wasSaid(e) || !ranges.some(([from, to]) => off >= from && off < to);
  /**
   * The ties between notes as the database holds them: a table of edges between numbered notes,
   * and two graphs over it, one of what outdates or replaces what and one of what a wider memory
   * stands for. They are made again when a note they are made from has been written; walking them
   * is the database's work.
   */
  let graph: { stamp: number; at: Map<string, number>; ids: string[]; why: Map<string, string> } | null = null;
  const tied = (): NonNullable<typeof graph> => {
    const edges = boundAs(TIES, 'edges');
    const stamp = Number(((ray.table(`(select {from: ${boundAs(TIES, 'stamp')}})`).columns.n as BigInt64Array | undefined) ?? [])[0] ?? -1);
    if (graph?.stamp === stamp) return graph;
    // The ties were made again (brain/ties-table.ts): the graphs are built anew from the table, in the database.
    if (graph !== null) ray.run('(do (.graph.free mem_line_graph) (.graph.free mem_part_graph) null)');
    ray.run(`(do (set mem_lines (select {from: ${edges} where: (!= kind 'covers)})) (set mem_parts (select {from: ${edges} where: (== kind 'covers)})) `
      + "(set mem_line_graph (.graph.build mem_lines 'src 'dst)) (set mem_part_graph (.graph.build mem_parts 'src 'dst)) (set mem_outdated (distinct (at mem_lines 'dst))) null)");
    const named = ray.table(`(select {from: ${boundAs(TIES, 'nodes')}})`);
    const ids: string[] = [];
    (named.columns.id as string[] | undefined ?? []).forEach((id, i) => { ids[Number((named.columns.n as BigInt64Array)[i])] = id; });
    const lines = ray.table('(select {from: mem_lines later: later earlier: earlier why: why})');
    const why = new Map((lines.columns.later as string[] | undefined ?? []).map((later, i) => [`${later} ${(lines.columns.earlier as string[])[i]}`, (lines.columns.why as string[])[i]!]));
    graph = { stamp, at: new Map(ids.map((id, n) => [id, n])), ids, why };
    return graph;
  };
  const notesRead = new Map<string, { count: number; events: JournalEvent[] }>();
  const nodes = (source: string, column: string): number[] => [...(ray.table(source).columns[column] as BigInt64Array | undefined ?? [])].map(Number);
  const entities = entityGraph(ray);
  return {
    ray,
    by: 'store',
    remembered() {
      store.sync();
      store.settle();
      return rememberedFrom(ray);
    },
    episodes() {
      store.sync();
      store.settle();
      return episodesFrom(ray);
    },
    kept() {
      store.sync();
      store.settle();
      return keptFrom(ray);
    },
    countedBefore(to) {
      store.sync();
      store.settle();
      return countedBefore(ray, to);
    },
    counts() {
      store.sync();
      store.settle();
      return countsFrom(ray);
    },
    known() {
      store.sync();
      store.settle();
      return knownFrom(ray);
    },
    standingFrom(seq, end) {
      store.sync();
      return store.standingFrom(seq, end);
    },
    count() {
      store.sync();
      return store.count();
    },
    ofType(type) {
      store.sync();
      return store.ofType(type);
    },
    callsSince(name, since) {
      store.sync();
      // The newest first, and more of them while the oldest taken is still within the time asked for.
      for (let limit = 64; ; limit *= 4) {
        const calls = store.calls(name, limit);
        if (calls.length < limit || Date.parse(calls.at(-1)!.ts) < since) return calls.filter((e) => Date.parse(e.ts) >= since);
      }
    },
    ownerSaidSince(seq) {
      store.sync();
      // Which sources are the owner's is a property of their names: the database says which names there are, and gives what was said from those.
      return store.stimuliAfter(store.sources().filter(fromOwner), seq);
    },
    lessons() {
      store.sync();
      store.settle();
      const { records, conversation } = lessonsFrom(ray);
      const ids = lessonPlaces(records);
      const at = ids.length === 0 ? new Map<string, number>() : store.places(ids);
      const last = store.standingFrom(Math.max(0, store.count() - 1))[0]?.ts ?? '';
      return { held: lessonsOf(records, (id) => at.get(id), Date.parse(last) || Date.now()), conversation };
    },
    settled() {
      store.sync();
      return store.settled();
    },
    accepted() {
      store.sync();
      store.settle();
      return acceptedSince(ray, 0);
    },
    stands() {
      store.sync();
      store.settle();
      return standsFrom(ray);
    },
    ownSpent(since) {
      store.sync();
      store.settle();
      return ownSpentSince(ray, since);
    },
    quiet(source, mark, run) {
      store.sync();
      store.settle();
      return quietFrom(ray, source, mark, run);
    },
    entities() {
      store.sync();
      store.settle();
      return entitiesFrom(ray);
    },
    about(name) {
      store.sync();
      store.settle();
      return aboutFrom(ray, entities, name, boundAs(MEMORY, 'memories'));
    },
    states(name, where) {
      store.sync();
      store.settle();
      return lastStates(ray, name, where);
    },
    stateOf(name, keys) {
      store.sync();
      store.settle();
      return newestState(ray, name, keys);
    },
    firstStates(name, keys) {
      store.sync();
      store.settle();
      return firstStates(ray, name, keys);
    },
    stateCounts(name) {
      store.sync();
      store.settle();
      return countStates(ray, name);
    },
    places(ids) {
      store.sync();
      return store.places(ids);
    },
    latest(type, source) {
      store.sync();
      return store.latest(type, source);
    },
    notes(kinds) {
      store.sync();
      // Asked again and again by what watches for something new (body/main.ts): read once for as long as the journal has not grown.
      const key = kinds.join(' ');
      const had = notesRead.get(key);
      if (had !== undefined && had.count === store.count()) return had.events;
      const events = store.noted(kinds);
      notesRead.set(key, { count: store.count(), events });
      return events;
    },
    stimuli(sources) {
      store.sync();
      return store.stimuli(sources);
    },
    picked(sources, kinds) {
      store.sync();
      const key = `${sources.join(' ')}\n${kinds.join(' ')}`;
      const had = notesRead.get(key);
      if (had !== undefined && had.count === store.count()) return had.events;
      const events = store.picked(sources, kinds);
      notesRead.set(key, { count: store.count(), events });
      return events;
    },
    notesAt(kinds) {
      store.sync();
      return store.notedAt(kinds);
    },
    since(id) {
      store.sync();
      store.settle();
      const g = tied();
      const n = g.at.get(id);
      if (n === undefined) return null;
      // Against the direction of an edge: from a note to the ones that came after it and say it no longer holds.
      const direct = nodes(`(.graph.expand mem_line_graph ${n} 1)`, '_dst').map((one) => g.ids[one]!).sort();
      const covered = nodes(`(.graph.expand mem_part_graph ${n} 0)`, '_dst');
      const parts = covered.length === 0 ? undefined
        : { outdated: nodes(`(select {from: (.graph.expand mem_part_graph ${n} 0) where: (in _dst mem_outdated)})`, '_dst').length, of: covered.length };
      if (direct.length === 0) return parts !== undefined && parts.outdated > 0 ? { direct: [], latest: [], parts } : null;
      const latest = nodes(`(select {from: (.graph.var-expand mem_line_graph ${n} 1 ${LINE_MAX} 1) where: (not (in _end mem_outdated))})`, '_end');
      return {
        direct: direct.map((one) => ({ id: one, why: g.why.get(`${one} ${id}`) ?? '' })),
        latest: [...new Set(latest.map((one) => g.ids[one]!))].sort(),
        ...(parts === undefined ? {} : { parts }),
      };
    },
    find(question, options) {
      store.sync();
      const ranges = aside();
      const limit = options?.limit ?? 10;
      // By meaning too, when there are vectors: the questions of the exam are found among themselves by their words, and stay so.
      const meant = vectors !== null && options?.words !== true && options?.kinds?.includes('key') !== true && vectors.covered() > 0;
      const wide = meant ? Math.max(limit, FUSED) : limit;
      const found = finder(store.index, store.read, offsetsOf, closingReply, () => { store.settle(); return usedFrom(ray); })(question, ranges.length === 0 ? { ...options, limit: wide } : { ...options, limit: wide + 50 });
      const byWords = ranges.length === 0 ? found : found.filter((hit) => stands(ranges, hit.doc, hit.event)).slice(0, wide);
      if (!meant) return byWords.slice(0, limit);
      const current = store.index.current?.();
      const held = new Map(byWords.map((hit) => [hit.doc, hit]));
      // What is nearest in meaning, of what may be found at all: a memory that still stands, an event the owner did not take back.
      const near = vectors.near(question, FUSED, options?.kinds).flatMap((one): Found[] => {
        if (one.kind === 'memory' && current !== undefined && !current.has(one.doc)) return [];
        const had = held.get(one.doc);
        if (had !== undefined) return [had];
        const event = store.read(one.doc);
        return event === null || !stands(ranges, one.doc, event) ? [] : [{ doc: one.doc, kind: one.kind, score: 0, terms: [], cover: 0, event }];
      });
      for (const hit of near) if (!held.has(hit.doc)) held.set(hit.doc, hit);
      return fused(byWords.map((hit) => hit.doc), near.map((hit) => hit.doc)).slice(0, limit).map(({ doc, score }) => ({ ...held.get(doc)!, score }));
    },
    asked() {
      store.sync();
      return offsets("(select {from: events where: (== type 'stimulus) desc: off take: 1 off: off})")[0] ?? null;
    },
    around(id, before, after) {
      store.sync();
      // The id is something a model typed: it goes over as a column, and never into the statement.
      ray.bind('mem_wanted', { wanted: { type: 'str', data: [id] } });
      const [off] = offsets("(select {from: events where: (in id (at mem_wanted 'wanted)) off: off})");
      if (off === undefined) return null;
      const earlier = before <= 0 ? [] : offsets(`(select {from: events where: (< off ${off}) desc: off take: ${Math.floor(before)} off: off})`).reverse();
      const later = offsets(`(select {from: events where: (>= off ${off}) asc: off take: ${Math.floor(after) + 1} off: off})`);
      const ranges = aside();
      const read = (offs: number[]): JournalEvent[] => offs.flatMap((at) => {
        const e = store.read(at);
        // The event asked for is shown whatever became of it; around it, only what still stands.
        return e !== null && (at === off || stands(ranges, at, e)) ? [e] : [];
      });
      const shownBefore = read(earlier);
      return { events: [...shownBefore, ...read(later)], at: shownBefore.length };
    },
    sync: () => { store.sync(); },
    persist: () => { store.persist(); vectors?.persist(); },
    embed(ms) {
      if (vectors === null) return 0;
      store.sync();
      const until = Date.now() + ms;
      // At least one portion, then more while there is time: a portion is about a second of the database's work.
      do { if (vectors.step() === 0) break; } while (Date.now() < until);
      return vectors.covered();
    },
    close() {
      store.persist();
      vectors?.persist();
      if (owned) ray.close();
    },
  };
}

/**
 * The past of `journal`: of a store when `library` names the database's library and it can be
 * loaded, of the journal itself otherwise. A library that is named and cannot be used is said so
 * through `log`, and is no reason not to remember.
 */
export function openPast(journal: string, library: string | null, log: (line: string) => void = () => {}): Past {
  if (library !== null && existsSync(library)) {
    try {
      const ray = openRay({ library });
      try {
        const store = openStore(ray, journal, undefined, projections());
        if (store.rebuilt !== null) log(`[memory] the store was built again from the journal: ${store.rebuilt}`);
        return storePast(journal, ray, store, true, log);
      } catch (err) {
        ray.close();
        throw err;
      }
    } catch (err) {
      log(`[memory] the database could not be used, the journal is read through instead: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return journalPast(journal);
}

/**
 * The past as a running agent has it: asked of the database in a process of its own
 * (brain/rayserver.ts), which this starts, with the journal read through whenever that cannot be
 * had. `organsDir` is where the pinned build lies: its library, to be the client with, and its
 * program, to be the server.
 *
 * The database is a help and never a condition. When its process dies, or answers with something
 * that is not an answer, what was asked is asked of the journal instead, and so is everything
 * after it until the database runs again: it is started afresh a while later, a few times at
 * growing intervals, and the store is brought up to the journal then. Nothing is lost by any of
 * that; it is only slower in between.
 */
export async function openServedPast(journal: string, organsDir: string | null, log: (line: string) => void = () => {}, o: { againMs?: number } = {}): Promise<Past> {
  if (organsDir === null || !existsSync(libraryAt(organsDir)) || !existsSync(serverAt(organsDir))) return journalPast(journal);
  const serve = async (): Promise<{ served: Past; server: RayServer }> => {
    let server: RayServer | null = null;
    try {
      server = await startRayServer(serverAt(organsDir), journal, { log });
      const ray = openRay({ library: libraryAt(organsDir), server: { port: server.port } });
      try {
        const store = openStore(ray, journal, undefined, projections());
        if (store.rebuilt !== null) log(`[memory] the store was built again from the journal: ${store.rebuilt}`);
        return { served: storePast(journal, ray, store, true, log), server };
      } catch (err) {
        ray.close();
        throw err;
      }
    } catch (err) {
      server?.stop();
      throw err;
    }
  };
  try {
    return guarded(await serve(), serve, journal, log, o.againMs ?? AGAIN_MS);
  } catch (err) {
    log(`[memory] the database could not be used, the journal is read through instead: ${err instanceof Error ? err.message : String(err)}`);
    return journalPast(journal);
  }
}

/** How long after the database failed it is started again, the first time; each later time after twice as long. */
export const AGAIN_MS = 60_000;
/** How many times. A database that fails this often in one body's life is left alone until the next body. */
export const AGAIN_TIMES = 4;

/**
 * A served past, with the journal read through in its place from the moment it fails, and the
 * database started again a while later. See `openServedPast`. The new start is asked for by
 * `sync`, which a body calls between turns, so nothing is started in the middle of a question.
 */
function guarded(first: { served: Past; server: RayServer }, serve: () => Promise<{ served: Past; server: RayServer }>, journal: string, log: (line: string) => void, againMs: number): Past {
  let { served, server } = first;
  let now: Past = served;
  let fell = false;
  let failures = 0;
  let notBefore = 0;
  let starting = false;
  let closed = false;
  const fall = (err: unknown): Past => {
    if (!fell) {
      fell = true;
      failures += 1;
      notBefore = Date.now() + againMs * 2 ** (failures - 1);
      log(`[memory] the database ${server.alive() ? 'failed' : 'is gone'}, the journal is read through from here on: ${err instanceof Error ? err.message : String(err)}`);
      try { served.close(); } catch { /* it was the one that failed */ }
      server.stop();
      now = journalPast(journal);
    }
    return now;
  };
  const again = (): void => {
    if (!fell || starting || closed || failures > AGAIN_TIMES || Date.now() < notBefore) return;
    starting = true;
    void serve().then((next) => {
      if (closed) {
        try { next.served.close(); } finally { next.server.stop(); }
        return;
      }
      ({ served, server } = next);
      now = served;
      fell = false;
      log('[memory] the database runs again, and is asked from here on');
    }, (err) => {
      failures += 1;
      notBefore = Date.now() + againMs * 2 ** (failures - 1);
      log(`[memory] the database could not be started again${failures > AGAIN_TIMES ? '; it is left until the next start of the body' : ''}: ${err instanceof Error ? err.message : String(err)}`);
    }).finally(() => { starting = false; });
  };
  const through = <T>(asked: (past: Past) => T): T => {
    if (fell) return asked(now);
    try { return asked(now); } catch (err) { return asked(fall(err)); }
  };
  return {
    get by() { return now.by; },
    get ray() { return fell ? undefined : served.ray; },
    find: (question, options) => through((past) => past.find(question, options)),
    since: (id) => through((past) => past.since(id)),
    known: () => through((past) => past.known()),
    standingFrom: (seq, end) => through((past) => past.standingFrom(seq, end)),
    count: () => through((past) => past.count()),
    ownerSaidSince: (seq) => through((past) => past.ownerSaidSince(seq)),
    callsSince: (name, since) => through((past) => past.callsSince(name, since)),
    ofType: (type) => through((past) => past.ofType(type)),
    lessons: () => through((past) => past.lessons()),
    settled: () => through((past) => past.settled()),
    accepted: () => through((past) => past.accepted()),
    stands: () => through((past) => past.stands()),
    ownSpent: (since) => through((past) => past.ownSpent(since)),
    quiet: (source, mark, run) => through((past) => past.quiet(source, mark, run)),
    entities: () => through((past) => past.entities()),
    about: (name) => through((past) => past.about(name)),
    states: (name, where) => through((past) => past.states(name, where)),
    stateOf: (name, keys) => through((past) => past.stateOf(name, keys)),
    firstStates: (name, keys) => through((past) => past.firstStates(name, keys)),
    stateCounts: (name) => through((past) => past.stateCounts(name)),
    places: (ids) => through((past) => past.places(ids)),
    remembered: () => through((past) => past.remembered()),
    episodes: () => through((past) => past.episodes()),
    kept: () => through((past) => past.kept()),
    countedBefore: (to) => through((past) => past.countedBefore(to)),
    counts: () => through((past) => past.counts()),
    latest: (type, source) => through((past) => past.latest(type, source)),
    notes: (kinds) => through((past) => past.notes(kinds)),
    notesAt: (kinds) => through((past) => past.notesAt(kinds)),
    stimuli: (sources) => through((past) => past.stimuli(sources)),
    picked: (sources, kinds) => through((past) => past.picked(sources, kinds)),
    asked: () => through((past) => past.asked()),
    around: (id, before, after) => through((past) => past.around(id, before, after)),
    sync: () => { again(); through((past) => past.sync()); },
    persist: () => through((past) => past.persist()),
    embed: (ms) => through((past) => past.embed(ms)),
    close: () => { closed = true; try { now.close(); } finally { server.stop(); } },
  };
}

/**
 * What became of a memory or a fact since, as lines to stand under it where it is shown: what made
 * it outdated, in the agent's own words, and where the later one is. Empty when nothing did. So
 * that what is found is never taken for how things are now.
 */
export function sinceLines(past: Pick<Past, 'since' | 'around'>, e: JournalEvent): string[] {
  if (e.type !== 'note') return [];
  let since: Since | null;
  try { since = past.since(e.id); } catch { return []; }
  if (since === null) return [];
  const lines: string[] = [];
  const note = (id: string): JournalEvent | null => past.around(id, 0, 0)?.events[0] ?? null;
  for (const one of since.direct.slice(0, 2)) {
    const later = note(one.id);
    const d = (later as { data?: { from?: unknown; start?: unknown; title?: unknown; text?: unknown } } | null)?.data;
    if (later === null || d === undefined) continue;
    if (later.type === 'note' && later.kind === OUTDATED_KIND) {
      // Not a later memory: the agent said so itself.
      lines.push(`[outdated since ${when(later.ts)}: ${one.why === '' ? 'you marked it as no longer holding' : one.why} (you said so yourself)]`);
      continue;
    }
    lines.push(typeof d.from === 'string'
      ? `[outdated since ${when(typeof d.start === 'string' ? d.start : later.ts)}: ${one.why === '' ? 'a later memory says otherwise' : one.why} (your memory "${String(d.title)}", of the stretch that begins at event ${d.from})]`
      : `[replaced on ${when(later.ts)} by: ${clip(String(d.text), 300)}]`);
  }
  const more = since.latest.filter((id) => !since.direct.some((one) => one.id === id));
  if (more.length > 0) {
    const last = note(more.at(-1)!);
    const d = (last as { data?: { from?: unknown; title?: unknown; text?: unknown } } | null)?.data;
    if (last !== null && d !== undefined) lines.push(typeof d.from === 'string'
      ? `[and that one was outdated in turn; the latest is your memory "${String(d.title)}", of the stretch that begins at event ${d.from}]`
      : `[and that one was replaced in turn; what holds now: ${clip(String(d.text), 300)}]`);
  }
  if (since.parts !== undefined && since.parts.outdated > 0) lines.push(`[${since.parts.outdated} of the ${since.parts.of} memories this one stands for were outdated by later ones]`);
  return lines;
}

/** Where a stimulus came from; undefined for anything else, and for none. */
export const sourceOf = (e: JournalEvent | null | undefined): string | undefined => (e?.type === 'stimulus' ? e.source : undefined);

/** A journal time to the minute, in UTC, as the agent reads times everywhere. */
export const when = (ts: string): string => `${ts.slice(0, 16).replace('T', ' ')} UTC`;

/** Who or what an event is, in a word, for a line that shows it. */
function speaker(e: JournalEvent): string {
  const r = e as { source?: unknown; name?: unknown; ok?: unknown };
  switch (e.type) {
    case 'stimulus': return r.source === 'terminal' ? 'your owner' : fromOwner(r.source) ? `your owner [${String(r.source)}]` : `[${String(r.source)}]`;
    case 'assistant': return 'you';
    case 'tool.intent': return `you called ${String(r.name)}`;
    case 'tool.result': return r.ok === false ? 'the tool failed' : 'the tool returned';
    default: return e.type;
  }
}

/** An event as text: when, who, and what, cut to `chars`. Events that say nothing are named and no more. */
export function shown(e: JournalEvent, chars: number): string {
  const document = documentOf(e);
  const calls = e.type === 'assistant' ? (e as { toolCalls?: { name?: unknown }[] }).toolCalls ?? [] : [];
  const called = calls.length > 0 ? ` (and called ${calls.map((call) => String(call.name)).join(', ')})` : '';
  // A memory is of a stretch: the id given is where that stretch begins, which is what `open` should be asked for, not the note the memory lies in.
  const about = e.type === 'note' ? (e.data as { from?: unknown } | null)?.from : undefined;
  const head = `[${when(e.ts)}] ${document?.kind === 'memory' ? 'your memory' : speaker(e)}${called} (${typeof about === 'string' ? `of the stretch that begins at event ${about}` : `event ${e.id}`})`;
  return document === null ? head : `${head}:\n${clip(document.text, chars)}`;
}

export interface TimelineEntry {
  episode: Episode;
  /** What is remembered of it, when anything is. */
  title: string | null;
  outcome: string | null;
}

/**
 * The episodes whose time overlaps `from`..`to` (ISO times, either may be left out), in order, with
 * what is remembered of each. Asked of `past`, which asks the tables of the database where it has
 * them; a journal's path is read through, as before there were tables.
 */
export function timeline(past: Pick<Past, 'episodes' | 'remembered'> | string, from?: string, to?: string): TimelineEntry[] {
  const asked = typeof past === 'string' ? journalPast(past) : past;
  const lo = from === undefined ? Number.NEGATIVE_INFINITY : Date.parse(from);
  const hi = to === undefined ? Number.POSITIVE_INFINITY : Date.parse(to);
  if (Number.isNaN(lo) || Number.isNaN(hi)) throw new Error('`from` and `to` must be times such as 2026-11-14 or 2026-11-14T09:30:00Z');
  const { memories, quarantined } = asked.remembered();
  return asked.episodes()
    .filter((e) => Date.parse(e.end) >= lo && Date.parse(e.start) <= hi)
    .map(({ fromSeq: _from, toSeq: _to, ...episode }) => {
      const memory = memories.get(episode.first);
      return {
        episode,
        title: memory?.title ?? null,
        outcome: memory?.outcome ?? (quarantined.has(episode.first) ? 'no memory could be formed' : null),
      };
    });
}
