import { archive, collect } from '../kernel/envelope';

export interface Stimulus {
  /** Which sensor produced it. 'terminal' is shown to the model as plain user text. */
  source: string;
  text: string;
}

/** Start sensing; call `emit` for each stimulus; return a function that stops it. */
export type Sensor = (emit: (s: Stimulus) => void) => () => void;

/** Lines typed by the person at the terminal. `/quit` ends the agent; the end of input does not. */
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

/** A tick every `intervalMs`, so the agent gets time of its own. 0, or anything that is not a positive number, turns it off. */
export function clock(intervalMs: number): Sensor {
  return (emit) => {
    // Not `<= 0`: NaN, from a mistyped setting, must also mean off. A timer given NaN fires without pause.
    if (!(intervalMs > 0)) return () => {};
    const timer = setInterval(() => {
      emit({
        source: 'clock',
        text: `It is ${new Date().toISOString()}. No one is waiting for a reply. If something on your backlog is worth doing now, do it; if not, say so in one line.`,
      });
    }, Math.min(intervalMs, TIMER_MAX_MS));
    return () => clearInterval(timer);
  };
}

/** Messages other agents and programs dropped into this agent's inbox directory. */
export function inbox(dir: string, intervalMs = 2000): Sensor {
  return (emit) => {
    const poll = () => {
      for (const arrival of collect(dir)) {
        const e = arrival.envelope;
        if (e === null) {
          console.error(`[inbox] set aside ${arrival.file}: ${arrival.reason}`);
          archive(dir, arrival.file, 'rejected');
          continue;
        }
        const reply = e.replyTo === null ? '' : `, in reply to ${e.replyTo}`;
        // Journal first, archive second: a crash in between repeats the message rather than losing it.
        emit({ source: `agent:${e.from}`, text: `(message ${e.id}${reply}) ${e.text}` });
        archive(dir, arrival.file, 'seen');
      }
    };
    poll();
    const timer = setInterval(poll, intervalMs);
    return () => clearInterval(timer);
  };
}
