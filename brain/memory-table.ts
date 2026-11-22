import { episodesOf, slimOf, type Episode, type Slim } from './episodes';
import type { JournalEvent } from './journal';
import { WITHDRAW_KIND } from './owned';
import type { Column, Ray, Table } from './ray';
import { EPISODE_KIND, MERGE_KIND, QUARANTINE_KIND, remembered, type Memory, type Merge, type QuarantineData, type Remembered } from './remembered';
import { boundAs, type Projection } from './store';

// How the journal is cut into episodes, and what is remembered of each, as tables of the database.
//
//   episodes     ord from to from_seq to_seq first last start end chars why closed kept
//   memories     ord from data          the memory of each stretch that has one, by its first event
//   quarantined  ord from data          the stretches no memory could be formed of
//   merges       ord data               the memories that stand for several
//   spans        ord from to            every stretch that was remembered or given up on, in order
//   notes        seq data               the notes all of that is made from
//   open         seq id ts type chars calls asks      the events not remembered yet, as the cutting reads them
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
export const MEMORY_VERSION = 1;

const NOTES: readonly string[] = [EPISODE_KIND, QUARANTINE_KIND, MERGE_KIND, WITHDRAW_KIND];

const strs = (data: string[]): Column => ({ type: 'str', data });
const syms = (data: string[]): Column => ({ type: 'sym', data });
const nums = (data: number[]): Column => ({ type: 'i64', data: BigInt64Array.from(data, BigInt) });
const bools = (data: boolean[]): Column => ({ type: 'bool', data: Uint8Array.from(data, (b) => (b ? 1 : 0)) });

/** An episode with the numbers of its events: `to_seq` is the number after its last. */
export interface Placed extends Episode { fromSeq: number; toSeq: number }

interface State {
  /** The notes memories are made from, each with its number. */
  notes: { seq: number; event: JournalEvent }[];
  /** What they come to; made again when a note is added. */
  told: Remembered;
  /** The remembered stretches, in order from the first event. */
  kept: Placed[];
  /** The stretches already looked at: one that was not next in line when it was recorded is passed over for good, as reading the whole journal passes it over. */
  seen: Set<string>;
  /** The events after the last remembered stretch, as the cutting reads them, each with its number. */
  open: { slim: Slim; seq: number }[];
}

const start = (): State => ({ notes: [], told: remembered([]), kept: [], seen: new Set(), open: [] });

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
      chars: taken.reduce((sum, one) => sum + one.slim.chars, 0), why: 'kept', closed: true, fromSeq: taken[0]!.seq, toSeq: taken.at(-1)!.seq + 1,
    });
  }
}

/** Every episode as it stands: the remembered ones, then what the rules make of the rest. */
function placed(state: State): Placed[] {
  const at = state.kept.at(-1)?.to ?? 0;
  const rest = episodesOf(state.open.map((one) => one.slim)).map((e): Placed => ({
    ...e, from: e.from + at, to: e.to + at, fromSeq: state.open[e.from]!.seq, toSeq: state.open[e.to - 1]!.seq + 1,
  }));
  return [...state.kept, ...rest];
}

/** The episodes and what is remembered of them, kept in tables. The store drives it (brain/store.ts). */
export function memoryProjection(): Projection {
  let state = start();
  /** The tables made from the notes, made again only when a note was added. */
  let fromNotes: Record<string, Record<string, Column>> | null = null;
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
    reset() { state = start(); fromNotes = null; },
    step(e: JournalEvent, seq: number): boolean {
      state.open.push({ slim: slimOf(e), seq });
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
      const all = placed(state);
      return {
        ...noteTables(),
        episodes: {
          ord: nums(all.map((_, i) => i)), from: nums(all.map((e) => e.from)), to: nums(all.map((e) => e.to)), from_seq: nums(all.map((e) => e.fromSeq)), to_seq: nums(all.map((e) => e.toSeq)),
          first: strs(all.map((e) => e.first)), last: strs(all.map((e) => e.last)), start: strs(all.map((e) => e.start)), end: strs(all.map((e) => e.end)),
          chars: nums(all.map((e) => e.chars)), why: syms(all.map((e) => e.why)), closed: bools(all.map((e) => e.closed)), kept: bools(all.map((e) => e.why === 'kept')),
        },
        open: {
          seq: nums(state.open.map((one) => one.seq)), id: strs(state.open.map((one) => one.slim.id)), ts: strs(state.open.map((one) => one.slim.ts)), type: syms(state.open.map((one) => one.slim.type)),
          chars: nums(state.open.map((one) => one.slim.chars)), calls: nums(state.open.map((one) => one.slim.calls)), asks: bools(state.open.map((one) => one.slim.asks)),
        },
      };
    },
    restore(tables: Record<string, Table>) {
      state = start();
      fromNotes = null;
      const notes = rows(tables.notes, ['seq', 'data']).sort((a, b) => Number(a.seq) - Number(b.seq));
      state.notes = notes.map((row) => ({ seq: Number(row.seq), event: JSON.parse(String(row.data)) as JournalEvent }));
      state.told = remembered(state.notes.map((note) => note.event));
      state.kept = episodesIn(tables.episodes).filter((e) => e.why === 'kept');
      // Every stretch recorded so far has had its turn: kept then, or passed over.
      state.seen = new Set(state.told.spans.map((span) => span.from));
      state.open = rows(tables.open, ['seq', 'id', 'ts', 'type', 'chars', 'calls', 'asks']).sort((a, b) => Number(a.seq) - Number(b.seq)).map((row) => ({
        seq: Number(row.seq),
        slim: { id: String(row.id), ts: String(row.ts), type: String(row.type), chars: Number(row.chars), calls: Number(row.calls), asks: Boolean(row.asks) },
      }));
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
  return rows(table, ['ord', 'from', 'to', 'from_seq', 'to_seq', 'first', 'last', 'start', 'end', 'chars', 'why', 'closed']).sort((a, b) => Number(a.ord) - Number(b.ord)).map((row) => ({
    id: String(row.first), from: Number(row.from), to: Number(row.to), first: String(row.first), last: String(row.last), start: String(row.start), end: String(row.end),
    chars: Number(row.chars), why: String(row.why) as Episode['why'], closed: Boolean(row.closed), fromSeq: Number(row.from_seq), toSeq: Number(row.to_seq),
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
