import { acceptanceStart, acceptanceStep, type AcceptanceState } from './acceptance';
import { idleOf, idleStart, idleStep, type IdleState } from './idle';
import type { JournalEvent } from './journal';
import { reply, wireNames } from './wire';
import type { Column, Ray, Table } from './ray';
import { boundAs, type Projection } from './store';

// What a request has to know of the conversation before the part it shows, beside what the
// episodes hold (brain/memory-table.ts), as tables of the database:
//
//   names      ord name odd     the name every call went out under, in order from the first
//   accepted   seq id note      what the stem's acceptance of a species commit says to the agent
//   state      data idle        what the reading holds between two events, and how many clock ticks in a row ended with nothing done
//
// A call goes out under its journaled id where that will do, otherwise under one made from its
// place among all the calls (`wireNames` in brain/memory.ts); and a name that went out once is
// not used again. So a request that begins in the middle of the conversation asks which of the
// names it would use went out before. `odd` marks a journaled id that looks like a made one:
// the only kind a made name of a later call can meet.
//
// Both are made from the conversation as it stands, by the steps a journal read whole is folded
// with, so the two cannot come to differ.

export const FRAME = 'frame';
/** Changed with the naming of calls, with the acceptance step, or with the columns below. */
export const FRAME_VERSION = 2;

const strs = (data: string[]): Column => ({ type: 'str', data });
const nums = (data: number[]): Column => ({ type: 'i64', data: BigInt64Array.from(data, BigInt) });
const bools = (data: boolean[]): Column => ({ type: 'bool', data: Uint8Array.from(data, (b) => (b ? 1 : 0)) });

/** A journaled id that looks like a name made from a place. */
const MADE = /^call_\d+(_\d+)?$/;

interface State {
  names: string[];
  odd: boolean[];
  used: Set<string>;
  name: (id: unknown) => string;
  acceptance: AcceptanceState;
  accepted: { seq: number; id: string; note: string }[];
  idle: IdleState;
}

function start(names: string[] = [], odd: boolean[] = []): State {
  const used = new Set(names);
  // The names so far are given as names that went out before; the namer adds its own to those.
  return { names, odd, used, name: wireNames(names.length, (name) => used.has(name)), acceptance: acceptanceStart(), accepted: [], idle: idleStart() };
}

/** The names of the calls and the acceptance notes, kept in tables. The store drives it (brain/store.ts). */
export function frameProjection(): Projection {
  let state = start();
  let made: Record<string, Record<string, Column>> | null = null;
  return {
    name: FRAME,
    version: FRAME_VERSION,
    standing: true,
    reset() { state = start(); made = null; },
    step(e: JournalEvent, seq: number): boolean {
      let changed = false;
      if (e.type === 'assistant') {
        for (const call of reply(e).calls) {
          const id = (typeof call === 'object' && call !== null ? call as { id?: unknown } : {}).id;
          const name = state.name(id);
          state.names.push(name);
          state.odd.push(name === id && MADE.test(name));
          changed = true;
        }
      }
      const pending = state.acceptance.pending;
      if (acceptanceStep(state.acceptance, e)) state.accepted.push({ seq, id: e.id, note: state.acceptance.notes.get(e.id)! });
      if (state.acceptance.pending !== pending) changed = true;
      if (idleStep(state.idle, e)) changed = true;
      if (changed) made = null;
      return changed;
    },
    tables() {
      made ??= {
        names: { ord: nums(state.names.map((_, i) => i + 1)), name: strs(state.names), odd: bools(state.odd) },
        accepted: { seq: nums(state.accepted.map((a) => a.seq)), id: strs(state.accepted.map((a) => a.id)), note: strs(state.accepted.map((a) => a.note)) },
        state: { data: strs([JSON.stringify({ pending: state.acceptance.pending ?? null, idle: state.idle })]), idle: nums([idleOf(state.idle)]) },
      };
      return made;
    },
    restore(tables: Record<string, Table>) {
      made = null;
      const ord = [...(tables.names?.columns.ord as BigInt64Array | undefined ?? [])].map(Number);
      const names = tables.names?.columns.name as string[] | undefined ?? [];
      const odd = tables.names?.columns.odd as ArrayLike<unknown> | undefined ?? [];
      const order = ord.map((_, i) => i).sort((a, b) => ord[a]! - ord[b]!);
      state = start(order.map((i) => names[i]!), order.map((i) => Boolean(odd[i])));
      const a = tables.accepted;
      state.accepted = Array.from({ length: a?.rows ?? 0 }, (_, i) => ({ seq: Number((a!.columns.seq as BigInt64Array)[i]), id: String((a!.columns.id as string[])[i]), note: String((a!.columns.note as string[])[i]) }))
        .sort((x, y) => x.seq - y.seq);
      for (const one of state.accepted) state.acceptance.notes.set(one.id, one.note);
      const held = (tables.state?.columns.data as string[] | undefined)?.[0];
      const was = held === undefined ? null : JSON.parse(held) as { pending: AcceptanceState['pending'] | null; idle: IdleState };
      if (was?.pending) state.acceptance.pending = was.pending;
      if (was?.idle) state.idle = was.idle;
    },
  };
}

/** The name the ids asked about are bound under for the length of one question. */
const ASKED = 'mem_frame_asked';

/**
 * Which names went out among the first `calls` calls, of those a request beginning after them
 * could meet: the journaled ids of its own calls (`ids`), and every journaled id that looks like
 * a made name.
 */
export function namesBefore(ray: Ray, calls: number, ids: string[]): Set<string> {
  if (calls <= 0) return new Set();
  const names = boundAs(FRAME, 'names');
  const out = new Set<string>(ray.table(`(select {from: ${names} where: (and (<= ord ${calls}) odd) name: name})`).columns.name as string[] | undefined ?? []);
  const asked = [...new Set(ids)];
  if (asked.length === 0) return out;
  ray.bind(ASKED, { ids: { type: 'str', data: asked } });
  for (const name of ray.table(`(select {from: ${names} where: (and (<= ord ${calls}) (in name (at ${ASKED} 'ids))) name: name})`).columns.name as string[] | undefined ?? []) out.add(name);
  return out;
}

/** What the stem's acceptance says to the agent, for the events numbered `from` and later, by the id of the event. */
export function acceptedSince(ray: Ray, from: number): Map<string, string> {
  const t = ray.table(`(select {from: ${boundAs(FRAME, 'accepted')} where: (>= seq ${from}) asc: seq id: id note: note})`);
  const ids = t.columns.id as string[] | undefined ?? [];
  const notes = t.columns.note as string[] | undefined ?? [];
  return new Map(ids.map((id, i) => [id, notes[i]!]));
}

/** How many of the latest clock ticks in a row ended with nothing done (`idleTicks` in brain/agenda.ts). */
export function idleFrom(ray: Ray): number {
  return Number((ray.table(`(select {from: ${boundAs(FRAME, 'state')} idle: idle})`).columns.idle as BigInt64Array | undefined)?.[0] ?? 0);
}
