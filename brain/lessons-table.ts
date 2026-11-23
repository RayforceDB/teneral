import type { JournalEvent } from './journal';
import { lessonStart, lessonStep, type LessonRecord, type LessonState } from './lessons';
import type { Column, Ray, Table } from './ray';
import { boundAs, type Projection } from './store';

// The notes lessons are made from, as a table of the database, each with what could be said of
// it when it was written (brain/lessons.ts): the conversation it lies in, and whether its
// evidence lies there too.
//
//   records   seq conversation within data
//   current   id                              the events of the conversation being lived
//   begun     seq id                          where every conversation began: which one was being lived at any earlier moment
//   state     data                            how the cutting stands, and which conversation that is
//
// A lesson belongs to a conversation as the rules alone cut the journal, without regard to what
// was remembered. That cut is decided event by event and never moved, so only the conversation
// being lived is held of the journal: a proposal may give as evidence only what lies in it.
//
// Made from the conversation as it stands, by the step a journal read whole is folded with.

export const LESSONS = 'lessons';
/** Changed with the step in brain/lessons.ts, with the rules of cutting (brain/episodes.ts), or with the columns below. */
export const LESSONS_VERSION = 2;

const strs = (data: string[]): Column => ({ type: 'str', data });
const nums = (data: number[]): Column => ({ type: 'i64', data: BigInt64Array.from(data, BigInt) });
const bools = (data: boolean[]): Column => ({ type: 'bool', data: Uint8Array.from(data, (b) => (b ? 1 : 0)) });

/** The notes about lessons, kept in tables. The store drives it (brain/store.ts). */
export function lessonsProjection(): Projection {
  let state: LessonState = lessonStart();
  let seqs: number[] = [];
  let begun: { seq: number; id: string }[] = [];
  let begunTable: Record<string, Column> | null = null;
  /** The table of records, made again only when one was added; the rest changes with every event. */
  let records: Record<string, Column> | null = null;
  let rest: Record<string, Record<string, Column>> | null = null;
  return {
    name: LESSONS,
    version: LESSONS_VERSION,
    standing: true,
    reset() { state = lessonStart(); seqs = []; begun = []; begunTable = null; records = null; rest = null; },
    step(e: JournalEvent, seq: number): boolean {
      const was = state.conversation;
      if (lessonStep(state, e)) { seqs.push(seq); records = null; }
      if (state.conversation !== was) { begun.push({ seq, id: state.conversation }); begunTable = null; }
      rest = null;
      return true;
    },
    tables() {
      records ??= {
        seq: nums(seqs), conversation: strs(state.records.map((r) => r.conversation)), within: bools(state.records.map((r) => r.within)),
        data: strs(state.records.map((r) => JSON.stringify(r.event))),
      };
      rest ??= { current: { id: strs(state.ids) }, state: { data: strs([JSON.stringify({ rules: state.rules, conversation: state.conversation })]) } };
      begunTable ??= { seq: nums(begun.map((b) => b.seq)), id: strs(begun.map((b) => b.id)) };
      return { records, begun: begunTable, ...rest };
    },
    restore(tables: Record<string, Table>) {
      state = lessonStart();
      records = null;
      rest = null;
      const t = tables.records;
      const rows = Array.from({ length: t?.rows ?? 0 }, (_, i) => ({
        seq: Number((t!.columns.seq as BigInt64Array)[i]), conversation: String((t!.columns.conversation as string[])[i]),
        within: Boolean((t!.columns.within as ArrayLike<unknown>)[i]), event: JSON.parse(String((t!.columns.data as string[])[i])) as JournalEvent,
      })).sort((a, b) => a.seq - b.seq);
      seqs = rows.map((row) => row.seq);
      state.records = rows.map(({ event, conversation, within }) => ({ event, conversation, within }));
      state.ids = [...(tables.current?.columns.id as string[] | undefined ?? [])];
      const at = tables.begun?.columns.seq as BigInt64Array | undefined ?? new BigInt64Array(0);
      begun = (tables.begun?.columns.id as string[] | undefined ?? []).map((id, i) => ({ seq: Number(at[i]), id })).sort((a, b) => a.seq - b.seq);
      begunTable = null;
      const held = (tables.state?.columns.data as string[] | undefined)?.[0];
      if (held !== undefined) {
        const was = JSON.parse(held) as Pick<LessonState, 'rules' | 'conversation'>;
        state.rules = was.rules;
        state.conversation = was.conversation;
      }
    },
  };
}

/** The notes about lessons and the conversation being lived, asked of the tables. */
export function lessonsFrom(ray: Ray): { records: LessonRecord[]; conversation: string | undefined } {
  const t = ray.table(`(select {from: ${boundAs(LESSONS, 'records')} asc: seq conversation: conversation within: within data: data})`);
  const data = t.columns.data as string[] | undefined ?? [];
  const records = data.map((cell, i): LessonRecord => ({
    event: JSON.parse(cell) as JournalEvent, conversation: String((t.columns.conversation as string[])[i]), within: Boolean((t.columns.within as ArrayLike<unknown>)[i]),
  }));
  const held = (ray.table(`(select {from: ${boundAs(LESSONS, 'state')} data: data})`).columns.data as string[] | undefined)?.[0];
  const conversation = held === undefined ? '' : (JSON.parse(held) as { conversation: string }).conversation;
  return { records, conversation: conversation === '' ? undefined : conversation };
}

/** The conversation that was being lived just before the event numbered `seq`: the first event of it, or nothing when the journal began later. */
export function conversationBefore(ray: Ray, seq: number): string | undefined {
  const ids = ray.table(`(select {from: ${boundAs(LESSONS, 'begun')} where: (< seq ${seq}) desc: seq take: 1 id: id})`).columns.id as string[] | undefined;
  return ids?.[0];
}

/** The notes about lessons written before the event numbered `seq`. */
export function lessonsBefore(ray: Ray, seq: number): LessonRecord[] {
  const t = ray.table(`(select {from: ${boundAs(LESSONS, 'records')} where: (< seq ${seq}) asc: seq conversation: conversation within: within data: data})`);
  return (t.columns.data as string[] | undefined ?? []).map((cell, i): LessonRecord => ({
    event: JSON.parse(cell) as JournalEvent, conversation: String((t.columns.conversation as string[])[i]), within: Boolean((t.columns.within as ArrayLike<unknown>)[i]),
  }));
}
