import type { JournalEvent } from './journal';
import { LINK_NOTES, links } from './links';
import type { Column, Table } from './ray';
import type { Projection } from './store';

// The ties between memories and between facts (brain/links.ts), as a table of edges in the
// database: what made what outdated, what replaced what, what a wider memory stands for.
//
//   edges   src dst kind why later earlier   an edge from the later note to the earlier, by number and by id
//   nodes   n id                         the notes that are tied, numbered from 0 for the graph
//   notes   seq data                     the notes the ties are made from
//   stamp   n                            how many times the ties were made: what a reader watches to build its graph anew
//
// The edges are made by `links`, the function that reads a whole journal, from the notes it reads
// and nothing else. The database builds its graph from the table and walks it (brain/past.ts).

export const TIES = 'ties';
export const TIES_VERSION = 1;

const strs = (data: string[]): Column => ({ type: 'str', data });
const nums = (data: number[]): Column => ({ type: 'i64', data: BigInt64Array.from(data, BigInt) });

type Tables = Record<string, Record<string, Column>>;

/** The ties, kept in tables. The store drives it (brain/store.ts). */
export function tiesProjection(): Projection {
  let notes: { seq: number; event: JournalEvent }[] = [];
  let made = 0;
  let tables: Tables | null = null;
  const kinds: readonly string[] = LINK_NOTES;
  return {
    name: TIES,
    version: TIES_VERSION,
    reset() {
      notes = [];
      made = 0;
      tables = null;
    },
    step(e: JournalEvent, seq: number): boolean {
      if (e.type !== 'note' || !kinds.includes(e.kind)) return false;
      notes.push({ seq, event: e });
      tables = null;
      return true;
    },
    tables() {
      if (tables !== null) return tables;
      const all = links(notes.map((note) => note.event));
      const numbered = new Map<string, number>();
      const node = (id: string): number => {
        let n = numbered.get(id);
        if (n === undefined) { n = numbered.size; numbered.set(id, n); }
        return n;
      };
      const [src, dst] = [all.map((link) => node(link.from)), all.map((link) => node(link.to))];
      made += 1;
      tables = {
        edges: { src: nums(src), dst: nums(dst), kind: { type: 'sym', data: all.map((link) => link.kind) }, why: strs(all.map((link) => link.why ?? '')), later: strs(all.map((link) => link.from)), earlier: strs(all.map((link) => link.to)) },
        nodes: { n: nums([...numbered.values()]), id: strs([...numbered.keys()]) },
        notes: { seq: nums(notes.map((note) => note.seq)), data: strs(notes.map((note) => JSON.stringify(note.event))) },
        stamp: { n: nums([made]) },
      };
      return tables;
    },
    restore(read: Record<string, Table>) {
      const data = read.notes?.columns.data as string[] | undefined ?? [];
      const seqs = read.notes?.columns.seq as BigInt64Array | undefined ?? new BigInt64Array(0);
      notes = data.map((cell, i) => ({ seq: Number(seqs[i]), event: JSON.parse(cell) as JournalEvent })).sort((a, b) => a.seq - b.seq);
      // One past what was written: a reader that built its graph from the tables as they were written builds it anew.
      made = Number((read.stamp?.columns.n as BigInt64Array | undefined)?.[0] ?? 0);
      tables = null;
    },
  };
}
