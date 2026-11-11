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
  // The envelope comes last so nothing in the body can overwrite it.
  const event = {
    ...body, v: SCHEMA_VERSION, id: randomUUID(), ts: new Date().toISOString(), gen,
  } as JournalEvent;
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a+');
  try {
    // A crash can leave half a line behind; start on a fresh one so only that line is lost.
    const prefix = endsWithNewline(fd) ? '' : '\n';
    const line = Buffer.from(`${prefix}${JSON.stringify(event)}\n`, 'utf8');
    // writeSync may write fewer bytes than asked without throwing.
    let offset = 0;
    while (offset < line.length) {
      offset += writeSync(fd, line, offset, line.length - offset);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return event;
}

function isEventShaped(value: unknown): value is JournalEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  return typeof e.type === 'string' && typeof e.id === 'string' && typeof e.gen === 'string'
    && typeof e.ts === 'string' && typeof e.v === 'number';
}

export function readEvents(path: string): JournalEvent[] {
  if (!existsSync(path)) return [];
  const events: JournalEvent[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A torn line from a crash mid-write. Nothing after it depends on it.
      continue;
    }
    // Valid JSON that is not an event (a foreign or damaged line) is skipped the same way.
    if (isEventShaped(parsed)) events.push(parsed);
  }
  return events;
}
