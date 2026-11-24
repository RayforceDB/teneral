import type { JournalEvent } from './journal';
import type { Column, Ray, Table } from './ray';
import { boundAs, type Projection } from './store';

// What of its past the agent went back to, as a table of the database: a row for every time it
// opened its journal at an event (the tool `open`, body/tools.ts).
//
//   opened   seq target      the call, by number, and the id of the event it asked for
//
// It is what a small weight in `recall` rests on (brain/past.ts): what was worth going back to
// once is a little more likely to be what is wanted again. How often each event was opened is
// counted by the database.

export const USES = 'uses';
/** Changed with the step below or with the columns. */
export const USES_VERSION = 1;
/** The tool whose calls are counted. */
export const OPENS = 'open';
/** How much an event gains for having been opened: this share of its score when it was opened `USE_FULL` times or more, and in proportion below that. */
export const USE_WEIGHT = 0.15;
export const USE_FULL = 3;

/** The event a call went back to, or null. */
export function openedBy(e: JournalEvent): string | null {
  if (e.type !== 'tool.intent' || e.name !== OPENS) return null;
  const target = (e.args as { event?: unknown } | null | undefined)?.event;
  return typeof target === 'string' && target.trim() !== '' ? target.trim() : null;
}

/** What a score is multiplied by for an event opened `n` times. */
export const useLift = (n: number): number => 1 + USE_WEIGHT * Math.min(Math.max(n, 0), USE_FULL) / USE_FULL;

const strs = (data: string[]): Column => ({ type: 'str', data });
const nums = (data: number[]): Column => ({ type: 'i64', data: BigInt64Array.from(data, BigInt) });

/** The opens, kept in a table. The store drives it (brain/store.ts). */
export function usesProjection(): Projection {
  let rows: { seq: number; target: string }[] = [];
  let tables: Record<string, Record<string, Column>> | null = null;
  return {
    name: USES,
    version: USES_VERSION,
    reset() {
      rows = [];
      tables = null;
    },
    step(e: JournalEvent, seq: number): boolean {
      const target = openedBy(e);
      if (target === null) return false;
      rows.push({ seq, target });
      tables = null;
      return true;
    },
    tables() {
      return tables ??= { opened: { seq: nums(rows.map((row) => row.seq)), target: strs(rows.map((row) => row.target)) } };
    },
    restore(read: Record<string, Table>) {
      const seq = read.opened?.columns.seq as BigInt64Array | undefined ?? new BigInt64Array(0);
      const target = read.opened?.columns.target as string[] | undefined ?? [];
      rows = Array.from(seq, (at, i) => ({ seq: Number(at), target: target[i]! })).sort((a, b) => a.seq - b.seq);
      tables = null;
    },
  };
}

/** How many times each event was opened: counted by the database. */
export function usedFrom(ray: Ray): Map<string, number> {
  const t = ray.table(`(select {from: ${boundAs(USES, 'opened')} by: target n: (count seq)})`);
  const n = t.columns.n as ArrayLike<bigint | number> | undefined ?? [];
  return new Map((t.columns.target as string[] | undefined ?? []).map((target, i) => [target, Number(n[i] ?? 0)]));
}

/** The same from events held here, as a journal read through gives them. */
export function usedOf(events: JournalEvent[]): Map<string, number> {
  const used = new Map<string, number>();
  for (const e of events) {
    const target = openedBy(e);
    if (target !== null) used.set(target, (used.get(target) ?? 0) + 1);
  }
  return used;
}
