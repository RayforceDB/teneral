import type { JournalEvent } from './journal';

// Counted here, apart from the agenda that reads it (brain/agenda.ts), so that the table kept of it (brain/frame-table.ts) needs nothing else.

/**
 * How many of the latest clock ticks in a row ended with nothing done: no tool was called between
 * the tick and whatever arrived next. A tick still being answered is not counted.
 */
export function idleTicks(events: JournalEvent[]): number {
  const state = idleStart();
  for (const e of events) idleStep(state, e);
  return idleOf(state);
}

/** What counting idle ticks holds between two events: the ticks that ended idle since one that did not, and how the latest thing that arrived is being answered. */
export interface IdleState { ended: number; clock: boolean; worked: boolean; answered: boolean }
export const idleStart = (): IdleState => ({ ended: 0, clock: false, worked: false, answered: false });

/** Takes one more event in; true when the state changed. */
export function idleStep(state: IdleState, e: JournalEvent): boolean {
  return idleTake(state, e.type, e.type === 'assistant' && Array.isArray(e.toolCalls) && e.toolCalls.length > 0, e.type === 'stimulus' && e.source === 'clock');
}

/** The same from what the step reads of an event: its type, whether it is a reply that called a tool, and whether it is a tick of the clock. */
export function idleTake(state: IdleState, type: string, calls: boolean, clock: boolean): boolean {
  if (type === 'assistant') {
    const worked = state.worked || calls;
    if (state.answered && worked === state.worked) return false;
    state.answered = true;
    state.worked = worked;
    return true;
  }
  if (type !== 'stimulus') return false;
  // What arrived before is over: a tick that was worked on ends the run of idle ones, one only answered adds to it.
  if (state.clock) state.ended = state.worked ? 0 : state.ended + (state.answered ? 1 : 0);
  state.clock = clock;
  state.worked = false;
  state.answered = false;
  return true;
}

export const idleOf = (state: IdleState): number => (state.clock && state.worked ? 0 : state.ended + (state.clock && state.answered ? 1 : 0));

/** The mark a report to the owner carries, so that it is known to have been made (`reportAsk` in brain/agenda.ts): `R` and the day. */
export const REPORT_MARK = /\bR\d{8}\b/;

export const SUBAGENT_KIND = 'body.subagent.v1';

/** What counting the cost of the agent's own time holds between two events: whether the turn being lived began with a tick of the clock, and the subagents started in such turns that have not ended. */
export interface OwnState { own: boolean; started: string[] }
export const ownStart = (): OwnState => ({ own: false, started: [] });

/**
 * Takes one more event in. Returns the tokens it spent in time of the agent's own: a reply in a
 * turn the clock began, or a subagent started in one, counted when it ends. 0 for anything else.
 */
export function ownStep(state: OwnState, e: JournalEvent): number {
  if (e.type === 'stimulus') { state.own = e.source === 'clock'; return 0; }
  if (state.own && e.type === 'assistant' && e.usage !== undefined) return (e.usage.input ?? 0) + (e.usage.output ?? 0);
  if (e.type === 'note' && e.kind === SUBAGENT_KIND && typeof e.data === 'object' && e.data !== null) {
    const d = e.data as { name?: unknown; state?: unknown; usage?: { input?: unknown; output?: unknown } };
    if (typeof d.name !== 'string') return 0;
    if (d.state === 'running' || d.state === 'queued') { if (state.own && !state.started.includes(d.name)) state.started.push(d.name); }
    else if (d.state === 'ended' && state.started.includes(d.name)) {
      state.started = state.started.filter((name) => name !== d.name);
      return (Number(d.usage?.input) || 0) + (Number(d.usage?.output) || 0);
    }
  }
  return 0;
}
