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
