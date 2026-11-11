import { randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** Bump only with a reader that still understands every older version. */
export const SCHEMA_VERSION = 1;

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export type EventBody =
  | { type: 'stimulus'; source: string; text: string }
  | { type: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { type: 'tool.intent'; callId: string; name: string; args: unknown }
  | { type: 'tool.result'; callId: string; ok: boolean; output: string }
  | { type: 'molt.requested'; commit: string; motive: string }
  | { type: 'molt.rejected'; commit: string; gate: string; output: string }
  | { type: 'generation.started'; commit: string }
  | { type: 'generation.ready'; commit: string }
  | { type: 'generation.promoted'; commit: string; previous: string }
  | { type: 'generation.rolledback'; commit: string; to: string; reason: string };

/** `gen` is the commit of the code that wrote the event. */
export type JournalEvent = EventBody & { v: number; id: string; ts: string; gen: string };

function endsWithNewline(fd: number): boolean {
  const size = fstatSync(fd).size;
  if (size === 0) return true;
  const last = Buffer.alloc(1);
  readSync(fd, last, 0, 1, size - 1);
  return last[0] === 0x0a;
}

export function appendEvent(path: string, gen: string, body: EventBody): JournalEvent {
  const event = {
    v: SCHEMA_VERSION, id: randomUUID(), ts: new Date().toISOString(), gen, ...body,
  } as JournalEvent;
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a+');
  try {
    // A crash can leave half a line behind; start on a fresh one so only that line is lost.
    const prefix = endsWithNewline(fd) ? '' : '\n';
    writeSync(fd, `${prefix}${JSON.stringify(event)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return event;
}

export function readEvents(path: string): JournalEvent[] {
  if (!existsSync(path)) return [];
  const events: JournalEvent[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line === '') continue;
    try {
      events.push(JSON.parse(line) as JournalEvent);
    } catch {
      // A torn line from a crash mid-write. Nothing after it depends on it.
    }
  }
  return events;
}
