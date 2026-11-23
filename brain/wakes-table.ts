import type { JournalEvent } from './journal';
import { QUIET_REPLY } from './quiet';
import type { Column, Ray, Table } from './ray';
import { boundAs, type Projection } from './store';

// How the agent answered what other agents and services sent it, as a table of the database: a
// row for everything said to it from a source `agent:…`, with
//
//   wakes   seq source heads outcome glanced
//   state   data
//
// `heads`: the lines of it that name a channel the agent is a member of (body/chat.ts writes them);
// `outcome`: what the agent did before the next thing arrived: `spoke` when it answered in words
// or called a tool that replies or reacts, `quiet` when its last word was to say nothing, and ''
// when it has not answered; `glanced`: whether a glance had settled it as nothing to say, which
// is then no wake at all (heart/glance.ts).
//
// It is what `modeOf` in body/chat-tools.ts reads back from the end of a whole journal to learn
// that the agent has nothing to say in a channel: here each wake is one small row.
// Of everything the journal holds, as that reading is.

export const WAKES = 'wakes';
/** Changed with the step below or with the columns. */
export const WAKES_VERSION = 1;

/** The kind of the note a glance writes before the talk it settles (`SETTLED_KIND` in heart/glance.ts), and the words that name a channel in what arrives from it (`memberOf` in body/chat.ts). The tests hold both to their sources. */
export const SETTLED = 'chat.glance.settled.v1';
export const MEMBER_OF = 'a channel you are a member of (';
const REPLIES = /^chat_(reply|send|react)$|_reply$/;

export interface Wake { seq: number; source: string; heads: string; outcome: '' | 'quiet' | 'spoke'; glanced: boolean }

/** What the reading holds between two events: the wakes so far, how many of the next things said a glance has settled, and how the latest thing said is being answered. */
export interface WakeState {
  wakes: Wake[];
  settling: number;
  /** The wake being answered, if the latest thing said was one; and of the answer so far, whether a replying tool was called and what the last reply in words was. */
  open: Wake | null;
  called: boolean;
  last: '' | 'quiet' | 'spoke';
}

export const wakeStart = (): WakeState => ({ wakes: [], settling: 0, open: null, called: false, last: '' });

/** Takes one more event in; true when a row was added or changed. */
export function wakeStep(state: WakeState, e: JournalEvent, seq: number): boolean {
  if (e.type === 'note' && e.kind === SETTLED) {
    const d = e.data as { of?: unknown } | null;
    state.settling = Array.isArray(d?.of) ? d.of.length : 0;
    return false;
  }
  if (e.type === 'stimulus') {
    const glanced = state.settling > 0;
    if (glanced) state.settling -= 1;
    state.open = null;
    state.called = false;
    state.last = '';
    if (typeof e.source !== 'string' || !e.source.startsWith('agent:')) return false;
    const heads = typeof e.text === 'string' ? e.text.split('\n').filter((line) => line.includes(MEMBER_OF)).join('\n') : '';
    state.open = { seq, source: e.source, heads, outcome: '', glanced };
    state.wakes.push(state.open);
    return true;
  }
  if (state.open === null) {
    // Still read, for the answer to whatever was said last: nothing is kept of it.
    return false;
  }
  if (e.type === 'assistant' && !(Array.isArray(e.toolCalls) && e.toolCalls.length > 0)) state.last = typeof e.text === 'string' && e.text.trim() === QUIET_REPLY ? 'quiet' : 'spoke';
  else if (e.type === 'tool.intent' && typeof e.name === 'string' && REPLIES.test(e.name)) state.called = true;
  else return false;
  const outcome = state.called ? 'spoke' : state.last;
  if (outcome === state.open.outcome) return false;
  state.open.outcome = outcome;
  return true;
}

/** The wakes, kept in a table. The store drives it (brain/store.ts). */
export function wakesProjection(): Projection {
  let state = wakeStart();
  let made: Record<string, Record<string, Column>> | null = null;
  return {
    name: WAKES,
    version: WAKES_VERSION,
    reset() { state = wakeStart(); made = null; },
    step(e: JournalEvent, seq: number): boolean {
      const [settling, open] = [state.settling, state.open];
      const changed = wakeStep(state, e, seq);
      if (changed || state.settling !== settling || state.open !== open) made = null;
      return changed || state.settling !== settling || state.open !== open;
    },
    tables() {
      made ??= {
        wakes: {
          seq: { type: 'i64', data: BigInt64Array.from(state.wakes, (w) => BigInt(w.seq)) }, source: { type: 'sym', data: state.wakes.map((w) => w.source.slice(0, 64)) },
          heads: { type: 'str', data: state.wakes.map((w) => w.heads) }, outcome: { type: 'sym', data: state.wakes.map((w) => w.outcome) },
          glanced: { type: 'bool', data: Uint8Array.from(state.wakes, (w) => (w.glanced ? 1 : 0)) },
        },
        state: { data: { type: 'str', data: [JSON.stringify({ settling: state.settling, open: state.open?.seq ?? -1, called: state.called, last: state.last })] } },
      };
      return made;
    },
    restore(tables: Record<string, Table>) {
      made = null;
      state = wakeStart();
      const t = tables.wakes;
      state.wakes = Array.from({ length: t?.rows ?? 0 }, (_, i): Wake => ({
        seq: Number((t!.columns.seq as BigInt64Array)[i]), source: String((t!.columns.source as string[])[i]), heads: String((t!.columns.heads as string[])[i]),
        outcome: String((t!.columns.outcome as string[])[i]) as Wake['outcome'], glanced: Boolean((t!.columns.glanced as ArrayLike<unknown>)[i]),
      })).sort((a, b) => a.seq - b.seq);
      const held = (tables.state?.columns.data as string[] | undefined)?.[0];
      if (held === undefined) return;
      const was = JSON.parse(held) as { settling: number; open: number; called: boolean; last: WakeState['last'] };
      state.settling = was.settling;
      state.called = was.called;
      state.last = was.last;
      state.open = was.open < 0 ? null : state.wakes.findLast((w) => w.seq === was.open) ?? null;
    },
  };
}

/**
 * Whether the newest `run` wakes from `source` that carry `mark` and that no glance settled were
 * all answered with silence: asked of the database, which finds them by the mark, takes the
 * newest and counts. False when there are fewer than `run` of them.
 */
export function quietFrom(ray: Ray, source: string, mark: string, run: number): boolean {
  // What is looked for goes over as columns, never as part of the statement: a channel's name is whatever its service calls it.
  ray.bind('mem_wakes_asked', { w: { type: 'sym', data: [source.slice(0, 64)] }, m: { type: 'str', data: [mark] } });
  const newest = `(select {from: ${boundAs(WAKES, 'wakes')} where: (and (in source (at mem_wakes_asked 'w)) (not glanced) (>= (str-find heads (first (at mem_wakes_asked 'm))) 0)) desc: seq take: ${Math.trunc(run)} outcome: outcome})`;
  const t = ray.table(`(select {from: ${newest} n: (count outcome) quiet: (sum (== outcome 'quiet))})`);
  const one = (name: string): number => Number((t.columns[name] as ArrayLike<bigint | number> | undefined)?.[0] ?? 0);
  return run > 0 && one('n') >= run && one('quiet') >= run;
}

/** The same from wakes held here, as a journal read through gives them. */
export function quietOf(wakes: Wake[], source: string, mark: string, run: number): boolean {
  const newest = wakes.filter((w) => w.source === source && !w.glanced && w.heads.includes(mark)).slice(-run);
  return run > 0 && newest.length >= run && newest.every((w) => w.outcome === 'quiet');
}
