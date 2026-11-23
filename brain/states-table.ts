import type { JournalEvent } from './journal';
import type { Column, Ray, Table } from './ray';
import { boundAs, type Projection } from './store';

// Notes that say how something stands now, as one table of the database: a row for each such
// note, with what it is about (`key`) and how it says that stands (`state`).
//
//   states   seq kind key state gen data
//
// A job the agent left running, a subagent, how the agent chose to listen in a channel, a place
// it has heard from: each is said again in a new note when it changes, and what holds is the
// last said of each key. That is asked of the database: the last row of every key, the newest
// row among a few keys, whether a key was ever said (`lastStates`, `newestState`, `saidOf`).
//
// What a kind's notes are about is the business of whoever writes them: each registers here how
// its note is read (`readsState`), and a note it does not take is no row.

export const STATES = 'states';
/** Changed with the columns below. A change in how a kind's notes are read is that kind's to count: see `readsState`. */
export const STATES_VERSION = 1;

/** What a note says: about what, and how it stands; `gen` where it matters which generation said it. */
export interface Said { key: string; state: string; gen?: string }
export interface StateRow extends Required<Said> { seq: number; event: JournalEvent }

type Reads = (e: JournalEvent & { type: 'note' }) => Said | Said[] | null;
const readers = new Map<string, { name: string; read: Reads }>();

/**
 * Says how notes of `kind` are read. `name` is the short word the rows carry for the kind, and
 * what they are asked for by. Called once by the module that writes those notes, when it loads.
 * Several kinds of note may speak of one kind of thing under one name, and one note of several things.
 */
export function readsState(kind: string, name: string, read: Reads): void {
  if (!/^[a-z][a-z0-9]*$/.test(name)) throw new Error(`not a name for a kind of state: ${name}`);
  readers.set(kind, { name, read });
}

/** What `e` says of how things stand, when it is a note some module reads that way: nothing, one thing, or several. */
export function stateOf(e: JournalEvent): (Said & { name: string })[] {
  if (e.type !== 'note') return [];
  const reader = readers.get(e.kind);
  if (reader === undefined) return [];
  const said = reader.read(e);
  return (said === null ? [] : Array.isArray(said) ? said : [said]).map((one) => ({ ...one, name: reader.name }));
}

/** How things stand, kept in a table. The store drives it (brain/store.ts). Of everything the journal holds: a note is a record, and stays when a conversation is taken back. */
export function statesProjection(): Projection {
  let rows: { seq: number; name: string; key: string; state: string; gen: string; data: string }[] = [];
  let made: Record<string, Record<string, Column>> | null = null;
  return {
    name: STATES,
    // Which kinds are read, and by what names, is part of what the table holds: read otherwise, it is made again.
    get version() { return STATES_VERSION * 1_000_003 + [...readers].reduce((sum, [kind, r]) => (sum * 31 + [...`${kind}=${r.name}`].reduce((h, c) => (h * 33 + c.charCodeAt(0)) % 1_000_003, 7)) % 1_000_003, 0); },
    reset() { rows = []; made = null; },
    step(e: JournalEvent, seq: number): boolean {
      const said = stateOf(e);
      if (said.length === 0) return false;
      const data = JSON.stringify(e);
      for (const one of said) rows.push({ seq, name: one.name, key: one.key, state: one.state.slice(0, 64), gen: (one.gen ?? '').slice(0, 64), data });
      made = null;
      return true;
    },
    tables() {
      made ??= {
        states: {
          seq: { type: 'i64', data: BigInt64Array.from(rows, (r) => BigInt(r.seq)) }, kind: { type: 'sym', data: rows.map((r) => r.name) }, key: { type: 'str', data: rows.map((r) => r.key) },
          state: { type: 'sym', data: rows.map((r) => r.state) }, gen: { type: 'sym', data: rows.map((r) => r.gen) }, data: { type: 'str', data: rows.map((r) => r.data) },
        },
      };
      return made;
    },
    restore(tables: Record<string, Table>) {
      made = null;
      const t = tables.states;
      rows = Array.from({ length: t?.rows ?? 0 }, (_, i) => ({
        seq: Number((t!.columns.seq as BigInt64Array)[i]), name: String((t!.columns.kind as string[])[i]), key: String((t!.columns.key as string[])[i]),
        state: String((t!.columns.state as string[])[i]), gen: String((t!.columns.gen as string[])[i]), data: String((t!.columns.data as string[])[i]),
      })).sort((a, b) => a.seq - b.seq);
    },
  };
}

const ASKED = 'mem_states_asked';
const rowsOf = (t: Table): StateRow[] => Array.from({ length: t.rows }, (_, i): StateRow => ({
  seq: Number((t.columns.seq as BigInt64Array)[i]), key: String((t.columns.key as string[])[i]), state: String((t.columns.state as string[])[i]),
  gen: String((t.columns.gen as string[])[i]), event: JSON.parse(String((t.columns.data as string[])[i])) as JournalEvent,
})).sort((a, b) => a.seq - b.seq);

/**
 * How everything of one kind stands: the last said of each key, by the database. With `state`,
 * only the keys that stand so; with `gen`, only those last said by that generation.
 */
export function lastStates(ray: Ray, name: string, where: { state?: string; gen?: string } = {}): StateRow[] {
  ray.bind(ASKED, { w: { type: 'sym', data: [name, where.state ?? '', where.gen ?? ''] } });
  const last = `(select {from: ${boundAs(STATES, 'states')} where: (== kind (at (at ${ASKED} 'w) 0)) by: key state: (last state) gen: (last gen) data: (last data) seq: (last seq)})`;
  const conditions = [...(where.state === undefined ? [] : [`(== state (at (at ${ASKED} 'w) 1))`]), ...(where.gen === undefined ? [] : [`(== gen (at (at ${ASKED} 'w) 2))`])];
  const source = conditions.length === 0 ? last : `(select {from: ${last} where: ${conditions.length === 1 ? conditions[0] : `(and ${conditions.join(' ')})`}})`;
  return rowsOf(ray.table(source));
}

/** How the newest note about any of `keys` says it stands; null when none of them was ever said. */
export function newestState(ray: Ray, name: string, keys: string[]): string | null {
  if (keys.length === 0) return null;
  ray.bind(ASKED, { w: { type: 'sym', data: keys.map(() => name) }, k: { type: 'str', data: keys } });
  const state = ray.table(`(select {from: ${boundAs(STATES, 'states')} where: (and (== kind (at (at ${ASKED} 'w) 0)) (in key (at ${ASKED} 'k))) desc: seq take: 1 state: state})`).columns.state as string[] | undefined;
  return state?.[0] ?? null;
}

/** The same two questions of a journal held whole, by the step the table is made with. */
export function statesOf(events: JournalEvent[], name: string): StateRow[] {
  const rows: StateRow[] = [];
  events.forEach((event, seq) => { for (const said of stateOf(event)) if (said.name === name) rows.push({ seq, key: said.key, state: said.state.slice(0, 64), gen: (said.gen ?? '').slice(0, 64), event }); });
  return rows;
}
export function lastOf(rows: StateRow[], where: { state?: string; gen?: string } = {}): StateRow[] {
  const last = new Map<string, StateRow>();
  for (const row of rows) last.set(row.key, row);
  return [...last.values()].filter((r) => (where.state === undefined || r.state === where.state) && (where.gen === undefined || r.gen === where.gen)).sort((a, b) => a.seq - b.seq);
}

/** The first note about each of `keys`, in the order said: what a thing was when it was first set down. */
export function firstStates(ray: Ray, name: string, keys: string[]): StateRow[] {
  if (keys.length === 0) return [];
  ray.bind(ASKED, { w: { type: 'sym', data: keys.map(() => name) }, k: { type: 'str', data: keys } });
  return rowsOf(ray.table(`(select {from: ${boundAs(STATES, 'states')} where: (and (== kind (at (at ${ASKED} 'w) 0)) (in key (at ${ASKED} 'k))) by: key state: (first state) gen: (first gen) data: (first data) seq: (first seq)})`));
}
export function firstOf(rows: StateRow[], keys: string[]): StateRow[] {
  const first = new Map<string, StateRow>();
  for (const row of rows) if (keys.includes(row.key) && !first.has(row.key)) first.set(row.key, row);
  return [...first.values()].sort((a, b) => a.seq - b.seq);
}
