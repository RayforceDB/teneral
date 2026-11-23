import type { JournalEvent } from './journal';
import { knownOf, knownStart, knownStep, type Fact, type Intention, type Known, type KnownState } from './known';
import type { Column, Ray, Table } from './ray';
import { boundAs, type Projection } from './store';

// What the agent knows and means to do, as tables of the database: one row for every fact and
// every intention ever set down, as each stands now, and the ids of what no longer holds.
//
// The tables are made by the very step that `known` folds over a journal (brain/known.ts), taken
// once for each event as it is laid out, so the two cannot come to differ; and everything that
// asks what is known asks the tables, not a list of events. A row holds what is asked by
// (whether it stands, whether it waits, how it ended, its day) in columns of their own, and the
// fact or intention whole, as it is given out.
//
//   facts        seq id at text source about episode standing data
//   intentions   seq id at text origin due waits open closed ended data
//   gone         id

export const KNOWN = 'known';
/** The same of the conversation as it stands: without the replies of a stretch the owner took back, which is how a request reads it. */
export const KNOWN_STANDING = 'stands';
/** Changed with the step in brain/known.ts or with the columns below. */
export const KNOWN_VERSION = 1;

const strs = (data: string[]): Column => ({ type: 'str', data });
const syms = (data: string[]): Column => ({ type: 'sym', data });
const nums = (data: number[]): Column => ({ type: 'i64', data: BigInt64Array.from(data, BigInt) });
const bools = (data: boolean[]): Column => ({ type: 'bool', data: Uint8Array.from(data, (b) => (b ? 1 : 0)) });

/** What is known, kept in tables. The store drives it (brain/store.ts). */
export function knownProjection(name: string = KNOWN): Projection {
  let state: KnownState = knownStart();
  /** The number of the note each fact and intention was set down in: the order they are given out in. */
  let seqs = new Map<string, number>();
  /** The tables as they were last made: the same objects until something changes, so that they are not sent or written again for nothing. */
  let made: Record<string, Record<string, Column>> | null = null;
  return {
    name,
    version: KNOWN_VERSION,
    ...(name === KNOWN_STANDING ? { standing: true } : {}),
    reset() {
      state = knownStart();
      seqs = new Map();
      made = null;
    },
    step(e: JournalEvent, seq: number): boolean {
      const [facts, intentions] = [state.facts.size, state.intentions.size];
      const changed = knownStep(state, e);
      // A fact or an intention is set down by the note that has its id.
      if (state.facts.size !== facts || state.intentions.size !== intentions) seqs.set(e.id, seq);
      if (changed) made = null;
      return changed;
    },
    tables() {
      if (made !== null) return made;
      const facts = [...state.facts.values()];
      const intentions = [...state.intentions.values()];
      const seq = (id: string): number => seqs.get(id) ?? -1;
      made = {
        facts: {
          seq: nums(facts.map((f) => seq(f.id))), id: strs(facts.map((f) => f.id)), at: strs(facts.map((f) => f.at)), text: strs(facts.map((f) => f.text)),
          source: syms(facts.map((f) => f.source)), about: strs(facts.map((f) => f.about ?? '')), episode: strs(facts.map((f) => f.episode)),
          standing: bools(facts.map((f) => !state.gone.has(f.id))), data: strs(facts.map((f) => JSON.stringify(f))),
        },
        intentions: {
          seq: nums(intentions.map((i) => seq(i.id))), id: strs(intentions.map((i) => i.id)), at: strs(intentions.map((i) => i.at)), text: strs(intentions.map((i) => i.text)),
          origin: syms(intentions.map((i) => i.origin ?? '')), due: strs(intentions.map((i) => i.due ?? '')), waits: bools(intentions.map((i) => i.waits)),
          open: bools(intentions.map((i) => !state.gone.has(i.id))), closed: bools(intentions.map((i) => i.ended !== undefined)), ended: syms(intentions.map((i) => i.ended ?? '')),
          data: strs(intentions.map((i) => JSON.stringify(i))),
        },
        gone: { id: strs([...state.gone]) },
      };
      return made;
    },
    restore(tables: Record<string, Table>) {
      made = null;
      state = knownStart();
      seqs = new Map();
      const rows = <T extends { id: string }>(table: Table | undefined): { item: T; seq: number }[] => {
        const data = table?.columns.data as string[] | undefined ?? [];
        const seq = table?.columns.seq as BigInt64Array | undefined ?? new BigInt64Array(0);
        return data.map((cell, i) => ({ item: JSON.parse(cell) as T, seq: Number(seq[i]) })).sort((a, b) => a.seq - b.seq);
      };
      for (const { item, seq } of rows<Fact>(tables.facts)) { state.facts.set(item.id, item); seqs.set(item.id, seq); }
      for (const { item, seq } of rows<Intention>(tables.intentions)) { state.intentions.set(item.id, item); seqs.set(item.id, seq); }
      for (const id of tables.gone?.columns.id as string[] | undefined ?? []) state.gone.add(id);
    },
  };
}

/** What is known, asked of the tables: the same `Known` that `known` makes of the journal the tables were made from. */
export function knownFrom(ray: Ray, name: string = KNOWN): Known {
  const of = <T>(table: string, where: string): T[] =>
    ((ray.table(`(select {from: ${boundAs(name, table)} where: ${where} asc: seq data: data})`).columns.data as string[] | undefined) ?? []).map((cell) => JSON.parse(cell) as T);
  return { facts: of<Fact>('facts', 'standing'), intentions: of<Intention>('intentions', 'open'), closed: of<Intention>('intentions', 'closed') };
}

/** The same from a state held in memory: what a journal read through gives. */
export { knownOf };
