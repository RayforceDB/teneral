import { followUps, idleTicks, offered, reportAsk, toAsk } from '../brain/agenda';
import { known, type Known } from '../brain/known';
import { needsTurn } from '../brain/memory';
import { fromOwner, standing } from '../brain/owned';
import { QUIET_REPLY, ROUND_LIMIT_REPLY } from '../brain/quiet';
import type { JournalEvent } from '../brain/journal';
import { clockText, type Stimulus } from '../body/sensors';

// The heart decides what happens between turns. Two rules shape it.
//
// What a turn leaves behind is settled at once, while it is fresh: one short request that asks
// what remains of the work, queues the step that can be taken now and records what waits
// (`settle` in brain/agenda.ts). That is the end of the turn's own work, not housekeeping.
//
// What the agent waits for is looked for here too, and nowhere else: a job it left running that
// has ended, a time it set itself to look again, a step that is ready to be taken up. The heart
// asks whether one has come (`arrived`) after every turn and at every wake, and says how long the
// body may sleep before one can (`waitFor`). No sensor keeps a timer of its own for any of it.
//
// Everything else the agent does for itself waits for rest: forming memories, making them into
// wider ones, looking ahead, and the clock's ticks that offer time of its own. Rest begins when
// the owner has said nothing for a while. Until then nothing of the agent's own stands between
// the owner and an answer, and nothing of it is paid for in the middle of a conversation.

export type Beat = 'turn' | 'reflect' | 'remember' | 'pulse' | 'wake' | 'wait';
export interface HeartState { look: boolean; pulse: boolean }
export const heartCommand = (line: string): boolean => line.trim() === '/heart';

/** How long after the owner's last word rest begins, unless the owner sets TENERAL_REST_MINUTES. */
export const REST_MINUTES = 10;
/** This many episodes waiting to be remembered are remembered without waiting for rest: memory must not fall behind a long conversation. */
const BACKLOG = 4;
/** Never asked again sooner than this: a time already past that nothing takes up must not spin the body. */
const LOOK_FLOOR_MS = 1000;
/** The agent's own tools for its agenda: a turn that used one has kept its own account. */
const AGENDA_TOOLS = new Set(['work', 'intend', 'done', 'allowed']);

/**
 * Milliseconds until rest begins: 0 when the agent is at rest. The owner's last word is what
 * counts, on whatever channel it came; other people's messages and the agent's own turns do not
 * put rest off, or a busy inbox would mean it never remembers anything.
 */
export function restIn(events: JournalEvent[], now: number, restMs: number): number {
  const last = events.findLast(e => e.type === 'stimulus' && fromOwner(e.source));
  return last === undefined ? 0 : Math.max(0, Date.parse(last.ts) + restMs - now);
}

/**
 * Whether the turn that has just ended is worth settling. Not a turn of the agent's own time,
 * which is told what to do with its agenda already. Not one the owner stopped, one that ended
 * with nothing to say, or one that only talked with someone who is not the owner. And not one in
 * which the agent kept its agenda itself, unless the limit of rounds stopped it mid-way.
 */
export function afterTurn(state: HeartState, events: JournalEvent[], enabled = true, from?: number): void {
  if (!enabled) return;
  // A direct caller supplies the complete turn by default; body/main snapshots its start before
  // running it so late scheduled stimuli cannot change whether that turn asked for a look.
  from ??= events.findLastIndex(e => e.type === 'stimulus');
  // One runTurn can answer a late scheduled stimulus too. Look at the whole turn, not just its
  // last stimulus, and never cancel an already requested look merely because work followed it.
  const recent = events.slice(from);
  const ordinary = recent.findLastIndex(e => e.type === 'stimulus' && e.source !== 'clock' && e.source !== 'work');
  if (ordinary < 0) return;
  if (recent.slice(ordinary + 1).some(e => e.type === 'turn.interrupted')) return;
  const said = recent.findLast(e => e.type === 'assistant');
  if (said?.type !== 'assistant' || said.text.trim() === QUIET_REPLY) return;
  const cut = said.text === ROUND_LIMIT_REPLY;
  const calls = recent.flatMap(e => e.type === 'tool.intent' ? [e.name] : []);
  if (!cut && calls.some(name => AGENDA_TOOLS.has(name))) return;
  const owners = recent.some(e => e.type === 'stimulus' && fromOwner(e.source));
  if (cut || owners || calls.length > 0) state.look = true;
}
/** Something the agent can take up now by itself: a ready step, an idea of its own, or a question not yet put. */
export function pulseNeeded(held: Known, now: number): boolean {
  return held.intentions.some(i => !i.waits && (i.work?.status === 'queued' || i.origin === 'own')) || toAsk(held, now).length > 0;
}
export function agendaFor(events: JournalEvent[], now = Date.now(), reportMs?: number): string {
  const current = standing(events), held = known(current);
  return offered(held, now, idleTicks(current), reportAsk(current, now, reportMs));
}
export function agendaPulse(events: JournalEvent[], now = Date.now(), reportMs?: number): Stimulus {
  return { source: 'clock', text: `${clockText(new Date(now))} ${agendaFor(events, now, reportMs)}` };
}
export interface HeartDeps {
  events: () => JournalEvent[];
  /** No idle work while the individual has not written its first soul and met its owner. */
  born: () => boolean;
  emit: (s: Stimulus) => void;
  /** Settles the turn that has just ended (brain/agenda.ts). */
  settle: () => Promise<unknown>;
  /** One piece of the work of rest: a memory, a wider memory, a look ahead. False when there was none to do. */
  remember: () => Promise<boolean>;
  /** How many episodes wait to be remembered. */
  backlog?: () => number;
  onError: (error: unknown) => void;
  /**
   * Something the agent waits for that has come: an ended job, a time it set to look again, a step
   * ready to resume. The caller journals what it must before answering, so that it is told once;
   * null when nothing has come, or when the owner's interruption holds the agent's own work.
   */
  arrived?: () => Stimulus | null;
  /** Milliseconds until something it waits for may have come; undefined when it waits for nothing with a time. */
  nextLook?: () => number | undefined;
  now?: () => number;
  /** Milliseconds of the owner's silence after which rest begins. */
  restMs?: number;
}

/** Chooses one bounded activity between turns. Incoming work is checked before and after every request. */
export class Heart {
  private state: HeartState = { look: false, pulse: false };
  constructor(private d: HeartDeps) {}
  private now(): number { return this.d.now?.() ?? Date.now(); }
  requestPulse(): void { this.state.pulse = true; }
  completed(events: JournalEvent[], enabled = true, from?: number): void { afterTurn(this.state, events, enabled, from); }
  /** Milliseconds until rest begins, 0 at rest: how long the body may sleep before asking again. */
  restIn(): number { return restIn(standing(this.d.events()), this.now(), this.d.restMs ?? REST_MINUTES * 60_000); }
  /**
   * How long the body may sleep when there is nothing to do, unless something arrives: until rest
   * begins, or until what the agent waits for may have come, whichever is sooner. Undefined: until something arrives.
   */
  waitFor(): number | undefined {
    const rest = this.restIn();
    let look: number | undefined;
    try { look = this.d.nextLook?.(); } catch { look = undefined; }
    const times = [...(rest > 0 ? [rest + 1000] : []), ...(look === undefined ? [] : [Math.max(LOOK_FLOOR_MS, look)])];
    return times.length === 0 ? undefined : Math.min(...times);
  }
  async next(): Promise<Beat> {
    if (needsTurn(standing(this.d.events()))) return 'turn';
    // An empty soul means the birth dialogue is still under way. Do not replace it with
    // reflection, agenda discovery or autonomous work, even when this heart was already asked.
    if (!this.d.born()) { this.state = { look: false, pulse: false }; return 'wait'; }
    if (this.state.pulse) {
      // The owner asked for the agenda by hand: that is not held back for rest.
      this.state.pulse = false;
      this.d.emit(agendaPulse(this.d.events(), this.now()));
      return 'pulse';
    }
    if (this.state.look) {
      this.state.look = false;
      try { await this.d.settle(); } catch (error) { this.d.onError(error); }
      // A step it named is queued, and is told below when its time comes (`arrived`): no tick is made up here.
      return 'reflect';
    }
    // What it waits for has come: it is told now, in conversation or at rest, and the turn that follows is the next beat.
    try {
      const come = this.d.arrived?.() ?? null;
      if (come !== null) { this.d.emit(come); return 'wake'; }
    } catch (error) { this.d.onError(error); }
    if (this.restIn() > 0 && (this.d.backlog?.() ?? 0) < BACKLOG) return 'wait';
    const before = standing(this.d.events());
    const had = pulseNeeded(known(before), this.now()) || followUps(known(before), this.now()).length > 0;
    if (!(await this.d.remember())) return 'wait';
    // A look ahead may have set down something that can be begun: offer it now, not at the next tick.
    const after = standing(this.d.events());
    if (!had && !needsTurn(after) && this.restIn() === 0 && pulseNeeded(known(after), this.now())) this.d.emit(agendaPulse(after, this.now()));
    return 'remember';
  }
}
