import { ownStart, ownStep, type OwnState } from './idle';
import type { JournalEvent } from './journal';
import type { Column, Ray, Table } from './ray';
import { boundAs, type Projection } from './store';

// What the agent's own time cost, as a table of the database: a row for every reply in a turn the
// clock began and every subagent started in one, with when it was and the tokens it took.
//
//   spent   seq at tokens
//   state   data              whether the turn being lived is of its own time, and the subagents begun in such turns
//
// The owner allows a day so much for time of the agent's own; what the last day cost is a sum
// over the rows of that day (`ownSpentSince`), where it was a reading of the whole journal. Of
// everything the journal holds: what was spent in a conversation taken back was spent.

export const SPEND = 'spend';
/** Changed with the step in brain/idle.ts or with the columns below. */
export const SPEND_VERSION = 1;

/** The cost of the agent's own time, kept in tables. The store drives it (brain/store.ts). */
export function spendProjection(): Projection {
  let state: OwnState = ownStart();
  let rows: { seq: number; at: number; tokens: number }[] = [];
  let made: Record<string, Record<string, Column>> | null = null;
  const nums = (data: number[]): Column => ({ type: 'i64', data: BigInt64Array.from(data, (n) => BigInt(Math.trunc(n))) });
  return {
    name: SPEND,
    version: SPEND_VERSION,
    reset() { state = ownStart(); rows = []; made = null; },
    step(e: JournalEvent, seq: number): boolean {
      const [own, started] = [state.own, state.started.length];
      const tokens = ownStep(state, e);
      const at = Date.parse(e.ts);
      if (tokens > 0 && Number.isFinite(at)) rows.push({ seq, at, tokens });
      const changed = tokens > 0 || state.own !== own || state.started.length !== started;
      if (changed) made = null;
      return changed;
    },
    tables() {
      made ??= {
        spent: { seq: nums(rows.map((r) => r.seq)), at: nums(rows.map((r) => r.at)), tokens: nums(rows.map((r) => r.tokens)) },
        state: { data: { type: 'str', data: [JSON.stringify(state)] } },
      };
      return made;
    },
    restore(tables: Record<string, Table>) {
      made = null;
      const t = tables.spent;
      rows = Array.from({ length: t?.rows ?? 0 }, (_, i) => ({ seq: Number((t!.columns.seq as BigInt64Array)[i]), at: Number((t!.columns.at as BigInt64Array)[i]), tokens: Number((t!.columns.tokens as BigInt64Array)[i]) }))
        .sort((a, b) => a.seq - b.seq);
      const held = (tables.state?.columns.data as string[] | undefined)?.[0];
      state = held === undefined ? ownStart() : JSON.parse(held) as OwnState;
    },
  };
}

/** The tokens the agent's own time took from the moment `since` on (milliseconds): `ownSpend` of brain/agenda.ts for the day before now. */
export function ownSpentSince(ray: Ray, since: number): number {
  const tokens = ray.table(`(select {from: ${boundAs(SPEND, 'spent')} where: (>= at ${Math.trunc(since)}) tokens: tokens})`).columns.tokens as BigInt64Array | undefined ?? new BigInt64Array(0);
  let sum = 0;
  for (const n of tokens) sum += Number(n);
  return sum;
}
