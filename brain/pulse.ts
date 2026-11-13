import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// The pulse: one small file that says what the brain is doing with the model right now, while a
// request is under way. The journal holds only what is finished, and a request to a model can
// take minutes; without this the owner's terminal could not tell thought from a hang.
//
// The stem names the file in TENERAL_PULSE. It is written over, never appended to, holds nothing
// that is not also journaled when the reply is whole, and is removed when the request ends. It is
// no part of the agent's memory: nothing reads it but the owner's terminal (keeper/tui/).

/** Where the request stands. */
export type Step =
  /** Sent, and nothing has come back yet. */
  | 'asked'
  /** Bytes are arriving that say nothing this code knows how to show. */
  | 'receiving'
  /** A summary of the model's reasoning is arriving; `tail` is its end. */
  | 'reasoning'
  /** The reply's text is arriving; `tail` is its end. */
  | 'writing'
  /** The arguments of a tool call are arriving. */
  | 'calling';

export interface Pulse {
  /** When this was written. */
  at: string;
  /** When the request was sent. */
  asked: string;
  step: Step;
  /** Characters of the answer received so far. */
  received: number;
  /** The end of what is arriving, on one line. */
  tail?: string;
}

/** Characters of `tail` kept. */
export const TAIL_CHARS = 160;
/** A pulse is written at most this often, and always when the step changes. */
const EVERY_MS = 400;

let last = 0;
let lastStep: Step | null = null;

/** Write the pulse, where the stem named a file for it. Never throws: a turn is not worth less for a pulse that could not be written. */
export function beat(pulse: Omit<Pulse, 'at'>, file = process.env.TENERAL_PULSE, now = Date.now()): void {
  if (!file) return;
  if (pulse.step === lastStep && now - last < EVERY_MS) return;
  last = now;
  lastStep = pulse.step;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tail = pulse.tail === undefined ? undefined : pulse.tail.replace(/\s+/g, ' ').slice(-TAIL_CHARS);
    writeFileSync(`${file}.tmp`, JSON.stringify({ ...pulse, ...(tail === undefined ? {} : { tail }), at: new Date(now).toISOString() }));
    renameSync(`${file}.tmp`, file);
  } catch { /* no pulse */ }
}

/** The request is over, whichever way: there is nothing under way to speak of. */
export function rest(file = process.env.TENERAL_PULSE): void {
  last = 0;
  lastStep = null;
  if (!file) return;
  try { rmSync(file, { force: true }); } catch { /* it stays, and is read as stale */ }
}

/**
 * Follows a provider's event stream as it arrives and says where it stands. `feed` takes each
 * piece of text; what it cannot read as an event it still counts. The event names are those of the
 * Responses API; a provider that sends others is shown as `receiving`, with the count.
 */
export function follower(asked: string, say: (pulse: Omit<Pulse, 'at'>) => void): (piece: string) => void {
  let received = 0;
  let rest = '';
  let step: Step = 'receiving';
  let tail = '';
  return (piece) => {
    received += piece.length;
    rest += piece;
    const lines = rest.split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      let event: { type?: unknown; delta?: unknown } | null = null;
      try { event = JSON.parse(line.slice(5)) as { type?: unknown; delta?: unknown }; } catch { continue; }
      const type = typeof event?.type === 'string' ? event.type : '';
      const delta = typeof event?.delta === 'string' ? event.delta : '';
      const next: Step | null = type.startsWith('response.reasoning') ? 'reasoning' : type === 'response.output_text.delta' ? 'writing'
        : type === 'response.function_call_arguments.delta' ? 'calling' : null;
      if (next === null) continue;
      if (next !== step) tail = '';
      step = next;
      if (next !== 'calling') tail = (tail + delta).slice(-TAIL_CHARS * 2);
    }
    say({ asked, step, received, ...(tail === '' ? {} : { tail }) });
  };
}
