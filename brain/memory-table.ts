import { episodesOf, slimOf, type Episode, type Slim } from './episodes';
import { idleStart, idleTake, type IdleState } from './idle';
import type { JournalEvent } from './journal';
import { imagePlaces, reply, showsImages, stimulusText } from './wire';
import { WITHDRAW_KIND } from './owned';
import type { Column, Ray, Table } from './ray';
import { EPISODE_KIND, MERGE_KIND, QUARANTINE_KIND, remembered, type Memory, type Merge, type QuarantineData, type Remembered } from './remembered';
import { asText } from './stemnote';
import { boundAs, type Projection } from './store';

// How the journal is cut into episodes, and what is remembered of each, as tables of the database.
//
//   episodes     ord from to from_seq to_seq first last start end chars shown calls slots idle why closed kept
//   memories     ord from data          the memory of each stretch that has one, by its first event
//   quarantined  ord from data          the stretches no memory could be formed of
//   merges       ord data               the memories that stand for several
//   spans        ord from to            every stretch that was remembered or given up on, in order
//   notes        seq data               the notes all of that is made from
//   open         seq id ts type chars shown calls slots asks clock      the events not remembered yet, as the cutting reads them
//   reply        seq data               the last reply and which of its calls were answered, while results may still come
//
// Beside what the cutting needs, an episode holds what a request counts of it (brain/memory.ts):
// what its events count for when they are old (`shown`), how many calls its replies made, and how
// many images it holds a place for (`slots`: in what the owner said, and in what `look` returned
// to a call of a reply in it). Summed over the episodes before a point, they are what a request
// that begins there has to know of everything it does not show. `idle` is how the count of idle
// clock ticks stands at the end of the episode (brain/idle.ts): what a request made as of then reads.
//
// It is made by the functions that read a whole journal (`episodesOf` in brain/episodes.ts,
// `remembered` in brain/remembered.ts), fed here with no more than they read. What is remembered
// is made from its notes, a few hundred of them, each time one is written. The cutting needs every
// event, but of an event only its type, its time, its size and whether it asks for a turn, and
// only until the stretch it lies in is remembered: after that the stretch is one row, and its
// events are let go. So what is held is as long as what waits to be remembered, not as the journal.
//
// It is made from the conversation as it stands: the store leaves out what the owner took back,
// and makes this again when a conversation is taken back (`standing` in brain/store.ts). `from`
// and `to` are places in that conversation, as `episodes` gives them; `from_seq` and `to_seq` are
// the numbers of the events in the database, which is where to read them.

export const MEMORY = 'memory';
/** Changed with the cutting, with what a memory is, or with the columns below. */
export const MEMORY_VERSION = 3;

const NOTES: readonly string[] = [EPISODE_KIND, QUARANTINE_KIND, MERGE_KIND, WITHDRAW_KIND];

const strs = (data: string[]): Column => ({ type: 'str', data });
const syms = (data: string[]): Column => ({ type: 'sym', data });
const nums = (data: number[]): Column => ({ type: 'i64', data: BigInt64Array.from(data, BigInt) });
const bools = (data: boolean[]): Column => ({ type: 'bool', data: Uint8Array.from(data, (b) => (b ? 1 : 0)) });

/** An episode with the numbers of its events (`to_seq` is the number after its last) and what a request counts of it. */
export interface Placed extends Episode { fromSeq: number; toSeq: number; shown: number; calls: number; slots: number; idle: IdleState }

/** A call id as a key: ids are the model's, and may be anything. One that is no plain value answers to nothing, as in a journal read whole. */
const keyOf = (id: unknown): string | null => (id === undefined ? 'u' : typeof id === 'object' && id !== null ? null : `j${JSON.stringify(id)}`);

/** The last reply, while results of its calls may still come: the nth call with an id gets the nth result (`answers` in brain/memory.ts). */
interface Reply { seq: number; calls: { key: string | null; look: boolean }[]; got: Record<string, number> }

interface State {
  /** The notes memories are made from, each with its number. */
  notes: { seq: number; event: JournalEvent }[];
  /** What they come to; made again when a note is added. */
  told: Remembered;
  /** The remembered stretches, in order from the first event. */
  kept: Placed[];
  /** The stretches already looked at: one that was not next in line when it was recorded is passed over for good, as reading the whole journal passes it over. */
  seen: Set<string>;
  /** The events after the last remembered stretch, as the cutting reads them, each with its number and the images it holds a place for. */
  open: { slim: Slim; seq: number; slots: number }[];
  reply: Reply | null;
}

const start = (): State => ({ notes: [], told: remembered([]), kept: [], seen: new Set(), open: [], reply: null });

const sum = <T>(items: T[], of: (item: T) => number): number => items.reduce((n, item) => n + of(item), 0);

/** How the count of idle ticks stands after `its` events, having stood at `from` before them. */
function idleAfter(from: IdleState, its: { slim: Slim }[]): IdleState {
  const state = { ...from };
  for (const { slim } of its) idleTake(state, slim.type, slim.calls > 0, slim.clock);
  return state;
}

/** Images a result holds a place for belong to the reply that made the call, wherever that reply lies by now. */
function credit(state: State, seq: number, slots: number): void {
  for (let i = state.open.length - 1; i >= 0 && state.open[i]!.seq >= seq; i--) {
    if (state.open[i]!.seq === seq) { state.open[i]!.slots += slots; return; }
  }
  const held = state.kept.find((e) => e.fromSeq <= seq && seq < e.toSeq);
  if (held !== undefined) held.slots += slots;
}

/** The images `e` holds a place for by itself, and the pairing of results with the calls of the last reply. */
function slotsOf(state: State, e: JournalEvent, seq: number): number {
  if (e.type === 'stimulus') return showsImages(e.source) ? imagePlaces(stimulusText(e.source, e.text)) : 0;
  if (e.type === 'assistant') {
    state.reply = { seq, got: {}, calls: reply(e).calls.map((call) => {
      const c = (typeof call === 'object' && call !== null ? call : {}) as { id?: unknown; name?: unknown };
      return { key: keyOf(c.id), look: c.name === 'look' };
    }) };
    return 0;
  }
  if (e.type === 'tool.result' && state.reply !== null) {
    const key = keyOf(e.callId);
    if (key === null) return 0;
    const nth = state.reply.got[key] ?? 0;
    state.reply.got[key] = nth + 1;
    const call = state.reply.calls.filter((c) => c.key === key)[nth];
    if (call?.look === true && e.ok === true) credit(state, state.reply.seq, imagePlaces(asText(e.output)));
  }
  return 0;
}

/** Takes the stretches recorded since the last look, in order: each is kept when it begins where the remembered part ends. */
function keep(state: State): void {
  for (const span of state.told.spans) {
    if (state.seen.has(span.from)) continue;
    state.seen.add(span.from);
    if (state.open[0]?.slim.id !== span.from) continue;
    const last = state.open.findIndex((one) => one.slim.id === span.to);
    if (last === -1) continue;
    const taken = state.open.splice(0, last + 1);
    const from = state.kept.at(-1)?.to ?? 0;
    state.kept.push({
      id: span.from, from, to: from + taken.length, first: span.from, last: span.to, start: taken[0]!.slim.ts, end: taken.at(-1)!.slim.ts,
      chars: sum(taken, (one) => one.slim.chars), why: 'kept', closed: true, fromSeq: taken[0]!.seq, toSeq: taken.at(-1)!.seq + 1,
      shown: sum(taken, (one) => one.slim.shown), calls: sum(taken, (one) => one.slim.calls), slots: sum(taken, (one) => one.slots),
      idle: idleAfter(state.kept.at(-1)?.idle ?? idleStart(), taken),
    });
  }
}

/** Every episode as it stands: the remembered ones, then what the rules make of the rest. */
function placed(state: State): Placed[] {
  const at = state.kept.at(-1)?.to ?? 0;
  let idle = state.kept.at(-1)?.idle ?? idleStart();
  const rest = episodesOf(state.open.map((one) => one.slim)).map((e): Placed => {
    const its = state.open.slice(e.from, e.to);
    idle = idleAfter(idle, its);
    return {
      idle,
      ...e, from: e.from + at, to: e.to + at, fromSeq: its[0]!.seq, toSeq: its.at(-1)!.seq + 1,
      shown: sum(its, (one) => one.slim.shown), calls: sum(its, (one) => one.slim.calls), slots: sum(its, (one) => one.slots),
    };
  });
  return [...state.kept, ...rest];
}

/** The episodes and what is remembered of them, kept in tables. The store drives it (brain/store.ts). */
export function memoryProjection(): Projection {
  let state = start();
  /** The tables made from the notes, made again only when a note was added. */
  let fromNotes: Record<string, Record<string, Column>> | null = null;
  /** The tables that change with every event, as they were last made: the same objects until the next event. */
  let fromEvents: Record<string, Record<string, Column>> | null = null;
  const noteTables = (): Record<string, Record<string, Column>> => {
    if (fromNotes !== null) return fromNotes;
    const memories = [...state.told.memories.entries()];
    const quarantined = [...state.told.quarantined.entries()];
    fromNotes = {
      memories: { ord: nums(memories.map((_, i) => i)), from: strs(memories.map(([from]) => from)), data: strs(memories.map(([, memory]) => JSON.stringify(memory))) },
      quarantined: { ord: nums(quarantined.map((_, i) => i)), from: strs(quarantined.map(([from]) => from)), data: strs(quarantined.map(([, given]) => JSON.stringify(given))) },
      merges: { ord: nums(state.told.merges.map((_, i) => i)), data: strs(state.told.merges.map((merge) => JSON.stringify(merge))) },
      spans: { ord: nums(state.told.spans.map((_, i) => i)), from: strs(state.told.spans.map((span) => span.from)), to: strs(state.told.spans.map((span) => span.to)) },
      notes: { seq: nums(state.notes.map((note) => note.seq)), data: strs(state.notes.map((note) => JSON.stringify(note.event))) },
    };
    return fromNotes;
  };
  return {
    name: MEMORY,
    version: MEMORY_VERSION,
    standing: true,
    reset() { state = start(); fromNotes = null; fromEvents = null; },
    step(e: JournalEvent, seq: number): boolean {
      const slots = slotsOf(state, e, seq);
      state.open.push({ slim: slimOf(e), seq, slots });
      fromEvents = null;
      if (e.type === 'note' && NOTES.includes(e.kind)) {
        state.notes.push({ seq, event: e });
        state.told = remembered(state.notes.map((note) => note.event));
        fromNotes = null;
        keep(state);
      }
      // Every event lengthens the episode it lies in, or begins one.
      return true;
    },
    tables() {
      if (fromEvents !== null) return { ...noteTables(), ...fromEvents };
      const all = placed(state);
      fromEvents = {
        episodes: {
          ord: nums(all.map((_, i) => i)), from: nums(all.map((e) => e.from)), to: nums(all.map((e) => e.to)), from_seq: nums(all.map((e) => e.fromSeq)), to_seq: nums(all.map((e) => e.toSeq)),
          first: strs(all.map((e) => e.first)), last: strs(all.map((e) => e.last)), start: strs(all.map((e) => e.start)), end: strs(all.map((e) => e.end)),
          chars: nums(all.map((e) => e.chars)), shown: nums(all.map((e) => e.shown)), calls: nums(all.map((e) => e.calls)), slots: nums(all.map((e) => e.slots)), idle: strs(all.map((e) => JSON.stringify(e.idle))),
          why: syms(all.map((e) => e.why)), closed: bools(all.map((e) => e.closed)), kept: bools(all.map((e) => e.why === 'kept')),
        },
        reply: state.reply === null ? { seq: nums([]), data: strs([]) } : { seq: nums([state.reply.seq]), data: strs([JSON.stringify(state.reply)]) },
        open: {
          seq: nums(state.open.map((one) => one.seq)), id: strs(state.open.map((one) => one.slim.id)), ts: strs(state.open.map((one) => one.slim.ts)), type: syms(state.open.map((one) => one.slim.type)),
          chars: nums(state.open.map((one) => one.slim.chars)), shown: nums(state.open.map((one) => one.slim.shown)), calls: nums(state.open.map((one) => one.slim.calls)),
          slots: nums(state.open.map((one) => one.slots)), asks: bools(state.open.map((one) => one.slim.asks)), clock: bools(state.open.map((one) => one.slim.clock)),
        },
      };
      return { ...noteTables(), ...fromEvents };
    },
    restore(tables: Record<string, Table>) {
      state = start();
      fromNotes = null;
      fromEvents = null;
      const notes = rows(tables.notes, ['seq', 'data']).sort((a, b) => Number(a.seq) - Number(b.seq));
      state.notes = notes.map((row) => ({ seq: Number(row.seq), event: JSON.parse(String(row.data)) as JournalEvent }));
      state.told = remembered(state.notes.map((note) => note.event));
      state.kept = episodesIn(tables.episodes).filter((e) => e.why === 'kept');
      // Every stretch recorded so far has had its turn: kept then, or passed over.
      state.seen = new Set(state.told.spans.map((span) => span.from));
      state.open = rows(tables.open, ['seq', 'id', 'ts', 'type', 'chars', 'shown', 'calls', 'slots', 'asks', 'clock']).sort((a, b) => Number(a.seq) - Number(b.seq)).map((row) => ({
        seq: Number(row.seq), slots: Number(row.slots),
        slim: { id: String(row.id), ts: String(row.ts), type: String(row.type), chars: Number(row.chars), shown: Number(row.shown), calls: Number(row.calls), asks: Boolean(row.asks), clock: Boolean(row.clock) },
      }));
      const last = rows(tables.reply, ['data'])[0]?.data;
      state.reply = last === undefined ? null : JSON.parse(String(last)) as Reply;
    },
  };
}

/** The rows of a table that was read, each as the cells of the named columns. */
function rows(table: Table | undefined, names: string[]): Record<string, unknown>[] {
  if (table === undefined) return [];
  return Array.from({ length: table.rows }, (_, i) => Object.fromEntries(names.map((name) => [name, (table.columns[name] as ArrayLike<unknown> | undefined)?.[i]])));
}

/** The episodes a table of them holds, in order. */
function episodesIn(table: Table | undefined): Placed[] {
  return rows(table, ['ord', 'from', 'to', 'from_seq', 'to_seq', 'first', 'last', 'start', 'end', 'chars', 'shown', 'calls', 'slots', 'idle', 'why', 'closed']).sort((a, b) => Number(a.ord) - Number(b.ord)).map((row) => ({
    id: String(row.first), from: Number(row.from), to: Number(row.to), first: String(row.first), last: String(row.last), start: String(row.start), end: String(row.end),
    chars: Number(row.chars), why: String(row.why) as Episode['why'], closed: Boolean(row.closed), fromSeq: Number(row.from_seq), toSeq: Number(row.to_seq),
    shown: Number(row.shown), calls: Number(row.calls), slots: Number(row.slots), idle: JSON.parse(String(row.idle)) as IdleState,
  }));
}

const whole = (ray: Ray, table: string): Table => ray.table(`(select {from: ${boundAs(MEMORY, table)}})`);

/** The episodes, asked of the table: what `episodes` makes of the journal the table was made from, each with the numbers of its events. */
export function episodesFrom(ray: Ray): Placed[] {
  return episodesIn(whole(ray, 'episodes'));
}

/** What is remembered, asked of the tables: the same `Remembered` that `remembered` makes of that journal. */
export function rememberedFrom(ray: Ray): Remembered {
  const of = <T>(table: string): { from: string; item: T }[] =>
    rows(whole(ray, table), ['ord', 'from', 'data']).sort((a, b) => Number(a.ord) - Number(b.ord)).map((row) => ({ from: String(row.from), item: JSON.parse(String(row.data)) as T }));
  return {
    memories: new Map(of<Memory>('memories').map((row) => [row.from, row.item])),
    quarantined: new Map(of<QuarantineData>('quarantined').map((row) => [row.from, row.item])),
    spans: rows(whole(ray, 'spans'), ['ord', 'from', 'to']).sort((a, b) => Number(a.ord) - Number(b.ord)).map((row) => ({ from: String(row.from), to: String(row.to) })),
    merges: of<Merge>('merges').map((row) => row.item),
  };
}
