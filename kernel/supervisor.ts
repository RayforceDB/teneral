/** The agent exits with this code to ask for a molt. */
export const MOLT_EXIT = 75;
/** Crashes in a row, with no reply in between, before a generation is given up on. */
export const CRASH_LIMIT = 3;

export interface Exit {
  code: number;
  /** The generation journaled `generation.ready` during this run. */
  ready: boolean;
}

export type Decision = 'stop' | 'gate' | 'restart' | 'rollback' | 'halt';

/** `crashes` counts earlier crashes of this generation since its last reply. */
export function decide(exit: Exit, s: { hasPrevious: boolean; crashes: number }): Decision {
  if (exit.code === 0) return 'stop';
  if (exit.code === MOLT_EXIT) return 'gate';
  const givenUp = !exit.ready || s.crashes + 1 >= CRASH_LIMIT;
  if (!givenUp) return 'restart';
  return s.hasPrevious ? 'rollback' : 'halt';
}
