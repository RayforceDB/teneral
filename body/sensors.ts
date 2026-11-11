import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { archive, collect, type Arrival } from '../kernel/envelope';
import type { JournalEvent } from '../kernel/journal';

export interface Stimulus {
  /** Which sensor produced it. 'terminal' is shown to the model as plain user text. */
  source: string;
  text: string;
}

/** Start sensing; call `emit` for each stimulus; return a function that stops it. */
export type Sensor = (emit: (s: Stimulus) => void) => () => void;

/** Lines typed by the person at the terminal the agent was started in, when there is one. `/quit` ends the agent; the end of input does not. */
export function terminal(lines: AsyncIterable<string>, onQuit: () => void): Sensor {
  return (emit) => {
    let stopped = false;
    void (async () => {
      for await (const line of lines) {
        if (stopped) return;
        const text = line.trim();
        if (text === '/quit') return onQuit();
        if (text !== '') emit({ source: 'terminal', text });
      }
    })();
    return () => { stopped = true; };
  };
}

/** The longest delay a timer holds; a longer one fires at once. About 24 days. */
const TIMER_MAX_MS = 2 ** 31 - 1;

/**
 * Whether a tick may be given now. Not before the soul holds a file: until then the agent is in the
 * middle of being born and is waiting for its owner, not for time of its own. And not while the
 * newest stimulus is a tick it has not finished answering: a night without the provider leaves one
 * tick to answer, not one for every interval.
 */
export function clockMayTick(events: JournalEvent[], soulDir: string): boolean {
  if (!existsSync(soulDir) || !readdirSync(soulDir).some((name) => name.endsWith('.md'))) return false;
  const newest = events.findLastIndex((e) => e.type === 'stimulus');
  const e = events[newest];
  if (e?.type !== 'stimulus' || e.source !== 'clock') return true;
  // A reply with tool calls is work in progress; one without is the answer.
  return events.slice(newest + 1).some((later) => later.type === 'assistant' && !(later.toolCalls?.length > 0));
}

/**
 * A tick every `intervalMs`, so the agent gets time of its own. 0, or anything that is not a positive number, turns it off.
 * `mayTick` is asked before each one; body/main.ts passes `clockMayTick` over the journal and the soul.
 */
export function clock(intervalMs: number, mayTick: () => boolean = () => true): Sensor {
  return (emit) => {
    // Not `<= 0`: NaN, from a mistyped setting, must also mean off. A timer given NaN fires without pause.
    if (!(intervalMs > 0)) return () => {};
    const timer = setInterval(() => {
      // This runs in a timer, where anything thrown ends the process. No answer means no tick.
      try {
        if (!mayTick()) return;
      } catch {
        return;
      }
      emit({
        source: 'clock',
        text: `Clock tick at ${new Date().toISOString()}. Your owner has not written since their last message. ` +
          'If you are waiting for an answer from them, keep waiting and say so in one line; do not start something instead. ' +
          'Otherwise, if something on your backlog is worth doing now, do it; if not, say so in one line.',
      });
    }, Math.min(intervalMs, TIMER_MAX_MS));
    return () => clearInterval(timer);
  };
}

/** Messages other agents and programs dropped into this agent's inbox directory. */
export function inbox(dir: string, intervalMs = 2000): Sensor {
  return (emit) => {
    const say = (err: unknown): string => (err instanceof Error ? err.message : String(err));
    // Files that failed in this process. Without this, one that was journaled but cannot be moved would be emitted on every poll.
    const failed = new Set<string>();
    let listing = '';
    const take = (arrival: Arrival): void => {
      const e = arrival.envelope;
      if (e === null) {
        console.error(`[inbox] set aside ${arrival.file}: ${arrival.reason}`);
        archive(dir, arrival.file, 'rejected');
        return;
      }
      const reply = e.replyTo === null ? '' : `, in reply to ${e.replyTo}`;
      // Journal first, archive second: a crash in between repeats the message rather than losing it.
      emit({ source: `agent:${e.from}`, text: `(message ${e.id}${reply}) ${e.text}` });
      archive(dir, arrival.file, 'seen');
    };
    // This runs in a timer, where anything thrown ends the process: a file that vanished between
    // listing and moving, or one that may not be moved, must cost one line of log and nothing more.
    const poll = () => {
      try {
        for (const arrival of collect(dir)) {
          if (failed.has(arrival.file)) continue;
          try {
            take(arrival);
          } catch (err) {
            failed.add(arrival.file);
            console.error(`[inbox] could not handle ${arrival.file}; leaving it until the next start: ${say(err)}`);
          }
        }
        listing = '';
      } catch (err) {
        // Said once per kind of failure, not every poll.
        if (say(err) !== listing) console.error(`[inbox] could not read ${dir}: ${say(err)}`);
        listing = say(err);
      }
    };
    poll();
    const timer = setInterval(poll, intervalMs);
    return () => clearInterval(timer);
  };
}

/**
 * Lines the owner typed somewhere else: `./box talk` leaves each as a plain-text file in `dir`
 * (see kernel/owner.ts). They are the owner's words exactly as typed lines are, so the source is
 * 'terminal'. A name starting with a dot is a line still being written.
 */
export function owner(dir: string, intervalMs = 250): Sensor {
  return (emit) => {
    const say = (err: unknown): string => (err instanceof Error ? err.message : String(err));
    // Files that failed in this process. Without this, a line that was journaled but cannot be removed would be said on every poll.
    const failed = new Set<string>();
    let listing = '';
    // This runs in a timer, where anything thrown ends the process.
    const poll = () => {
      try {
        if (!existsSync(dir)) return;
        for (const file of readdirSync(dir).filter((name) => !name.startsWith('.')).sort()) {
          if (failed.has(file)) continue;
          try {
            const text = readFileSync(join(dir, file), 'utf8').trim();
            // Journal first, remove second: a crash in between repeats the line rather than losing it.
            if (text !== '') emit({ source: 'terminal', text });
            rmSync(join(dir, file));
          } catch (err) {
            failed.add(file);
            console.error(`[owner] could not handle ${file}; leaving it until the next start: ${say(err)}`);
          }
        }
        listing = '';
      } catch (err) {
        // Said once per kind of failure, not every poll.
        if (say(err) !== listing) console.error(`[owner] could not read ${dir}: ${say(err)}`);
        listing = say(err);
      }
    };
    poll();
    const timer = setInterval(poll, intervalMs);
    return () => clearInterval(timer);
  };
}
