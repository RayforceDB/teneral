import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { archive, collect, type Arrival } from './envelope';
import { peerName, readPeers } from './peers';
import type { JournalEvent } from '../brain/journal';
import { fromOwner } from '../brain/owned';
import { INTERRUPT_SUFFIX, MEMORY_SUFFIX } from '../keeper/owner';

/** What the name of a pairing code ends with (keeper/owner.ts). Said here as well, so that a body can run under a keeper from before pairing. */
const PAIRING_SUFFIX = '.pairing';
import { QUIET_REPLY } from '../brain/quiet';

export interface Stimulus {
  /**
   * Which sensor produced it, and with that whose word it is. 'terminal' is the owner, shown to the model as plain user text.
   * A sensor of any other channel names its source `owner:<channel>` only after authenticating the configured owner there.
   * Everything else gets its own source and remains someone else's word however it is signed. See `fromOwner` in brain/owned.ts.
   */
  source: string;
  text: string;
  /**
   * Set for talk that addressed nobody: the lines alone, without what the agent is told about them.
   * Such a stimulus may be glanced at before it becomes a turn (heart/glance.ts).
   */
  overheard?: string;
}

/** Only a source the body itself established as the owner's may hurry a failed-turn retry. */
export function ownerStimulus(s: Stimulus): boolean {
  return fromOwner(s.source);
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
export const TIMER_MAX_MS = 2 ** 31 - 1;

/**
 * Whether a tick may be given now. Not before the soul holds a file: until then the agent is in the
 * middle of being born and is waiting for its owner, not for time of its own. And not while the
 * newest stimulus is a tick it has not finished answering: a night without the provider leaves one
 * tick to answer, not one for every interval.
 */
/** What a tick says when nothing tells it the agenda. */
const NO_AGENDA = 'Otherwise, if something is worth doing now, do it; if not, say so in one line.';

export function clockMayTick(events: JournalEvent[], soulDir: string): boolean {
  if (!existsSync(soulDir) || !readdirSync(soulDir).some((name) => name.endsWith('.md'))) return false;
  const newest = events.findLastIndex((e) => e.type === 'stimulus');
  const e = events[newest];
  if (e?.type !== 'stimulus' || e.source !== 'clock') return true;
  // A reply with tool calls is work in progress; one without is the answer. A turn the owner stopped is over as well.
  return events.slice(newest + 1).some((later) => later.type === 'turn.interrupted' || (later.type === 'assistant' && !(later.toolCalls?.length > 0)));
}

export function clockText(date: Date): string {
  return `Clock tick at ${date.toISOString()}. This is time of your own, and what it holds follows. ` +
    'Do what it names and no more; something that waits is not looked at before its time, and nothing is to be found to do. ' +
    `When there is nothing to say, answer exactly ${QUIET_REPLY}: it settles the tick without a visible reply.`;
}

/** A tick of the clock, by its opening words: this generation's or an older one's, whatever agenda follows them. */
export function routineClock(text: string): boolean {
  const timestamp = /^Clock tick at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\. /.exec(text)?.[1];
  return timestamp !== undefined && !Number.isNaN(new Date(timestamp).getTime());
}

/**
 * When the next tick of the clock is due: `intervalMs` after the last one, or after this body
 * started when it has given none. Undefined when there is no clock: 0, or anything that is not a
 * positive number (NaN, from a mistyped setting, must also mean off).
 */
export function tickAt(startedAt: number, lastTick: number | undefined, intervalMs: number): number | undefined {
  if (!(intervalMs > 0)) return undefined;
  return Math.max(startedAt, lastTick ?? 0) + intervalMs;
}

/**
 * A tick of the clock, so the agent gets time of its own; null when none is due at `now` or
 * `mayTick` says no. It is the heart that asks, at rest (heart/coordinator.ts): no timer gives
 * ticks by itself. body/main.ts passes `clockMayTick` over the journal and the soul. `agenda` says
 * what the agent means to do, in order (brain/agenda.ts): a tick offers it, and that is where the
 * agent's initiative comes from. A check that throws means no tick.
 */
export function clockTick(now: number, at: number | undefined, mayTick: () => boolean = () => true, agenda: () => string = () => NO_AGENDA): Stimulus | null {
  if (at === undefined || now < at) return null;
  let todo = NO_AGENDA;
  try {
    if (!mayTick()) return null;
    todo = agenda();
  } catch {
    return null;
  }
  return { source: 'clock', text: `${clockText(new Date(now))} ${todo}` };
}

/** Messages other agents and programs dropped into this agent's inbox directory. */
export function inbox(dir: string, id: string, intervalMs = 2000, peersFile?: string): Sensor {
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
      if (e.to !== id) {
        console.error(`[inbox] set aside ${arrival.file}: addressed to ${e.to}, not ${id}`);
        archive(dir, arrival.file, 'rejected');
        return;
      }
      const reply = e.replyTo === null ? '' : `, in reply to ${e.replyTo}`;
      // The name is display metadata, never sender authentication. A legacy peer named exactly
      // like the id remains supported; an unmapped sender is visibly unknown. Preserve the raw id
      // because replyTo is checked against the archived envelope, not against this label.
      let name: string | undefined;
      try { name = peersFile === undefined ? undefined : peerName(readPeers(peersFile), e.from); }
      catch (err) { console.error(`[inbox] peer names unavailable: ${say(err)}`); }
      const label = name ?? e.from;
      const identity = peersFile === undefined ? '' : name !== undefined ? `, from ${e.from}` : ', from unknown sender';
      // Journal first, archive second: a crash in between repeats the message rather than losing it.
      emit({ source: `agent:${label}`, text: `(message ${e.id}${identity}${reply}) ${e.text}` });
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
 * Lines the owner typed somewhere else: `./one talk` leaves each as a plain-text file in `dir`
 * (see keeper/owner.ts). They are the owner's words exactly as typed lines are, so the source is
 * 'terminal'. A name starting with a dot is a line still being written.
 *
 * A file whose name ends in `.interrupt` is not a line: the owner asks for the turn in progress to
 * be stopped, and `onInterrupt` is called. Only the name decides that, never what a file holds, and
 * only this directory is looked at: nothing that arrives any other way can interrupt. An interrupt
 * names no turn; it is for what was running when it was sent. So one that is already there when
 * this starts was meant for a process that is gone, and is dropped.
 *
 * A file whose name starts with a dot and ends in `.memory` is the owner's word about the agent's
 * memory, and `onWord` gets what it holds (brain/owned.ts decides what it means). One that ends in
 * `.pairing` is a pairing code, and `onPairing` gets what it holds (body/pairing.ts); it is not journaled.
 */
export function owner(dir: string, intervalMs = 250, onInterrupt: () => void = () => {}, onWord: (text: string) => void = () => {}, onPairing: (text: string) => void = () => {}): Sensor {
  return (emit) => {
    const say = (err: unknown): string => (err instanceof Error ? err.message : String(err));
    // Files that failed in this process. Without this, a line that was journaled but cannot be removed would be said on every poll.
    const failed = new Set<string>();
    let listing = '';
    let starting = true;
    // This runs in a timer, where anything thrown ends the process.
    const poll = () => {
      const first = starting;
      starting = false;
      try {
        if (!existsSync(dir)) return;
        // The owner's words about memory (keeper/owner.ts): named with a dot in front, so that no reader takes one for a line, and handed over as they are.
        for (const file of readdirSync(dir).filter((name) => name.startsWith('.') && (name.endsWith(MEMORY_SUFFIX) || name.endsWith(PAIRING_SUFFIX))).sort()) {
          if (failed.has(file)) continue;
          try {
            // Acted on first, removed second: a crash in between repeats the word, and a word said twice changes nothing.
            (file.endsWith(PAIRING_SUFFIX) ? onPairing : onWord)(readFileSync(join(dir, file), 'utf8'));
            rmSync(join(dir, file));
          } catch (err) {
            failed.add(file);
            console.error(`[owner] could not handle ${file}; leaving it until the next start: ${say(err)}`);
          }
        }
        for (const file of readdirSync(dir).filter((name) => !name.startsWith('.')).sort()) {
          if (failed.has(file)) continue;
          try {
            if (file.endsWith(INTERRUPT_SUFFIX)) {
              // Removed first: an interrupt that failed half-way is not one to act on again later.
              rmSync(join(dir, file));
              if (!first) onInterrupt();
              continue;
            }
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
