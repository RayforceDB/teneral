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

/** A tick every `intervalMs`, so the agent gets time of its own. 0 turns it off. */
export function clock(intervalMs: number): Sensor {
  return (emit) => {
    if (intervalMs <= 0) return () => {};
    const timer = setInterval(() => {
      emit({
        source: 'clock',
        text: `It is ${new Date().toISOString()}. No one is waiting for a reply. If something on your backlog is worth doing now, do it; if not, say so in one line.`,
      });
    }, intervalMs);
    return () => clearInterval(timer);
  };
}
