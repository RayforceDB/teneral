import { randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** Bump only with a reader that still understands every older version. */
export const SCHEMA_VERSION = 1;

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

/** What a provider said one request cost, in tokens. `cached` is the part of `input` it had kept from an earlier request. */
export interface Usage {
  input: number;
  output: number;
  cached?: number;
}

export type EventBody =
  | { type: 'stimulus'; source: string; text: string }
  // `usage` and `reasoning` (a summary of the model's reasoning, for the owner to read) came later
  // and are optional: every journal written before them, and any reply without them, reads as before.
  | { type: 'assistant'; text: string; toolCalls: ToolCall[]; usage?: Usage; reasoning?: string }
  | { type: 'tool.intent'; callId: string; name: string; args: unknown }
  | { type: 'tool.result'; callId: string; ok: boolean; output: string }
  // The owner stopped the turn in progress (kernel/owner.ts). It ends that turn: nothing is owed after it.
  // It came later too: a journal without one reads as before, and a reader from before it passes it by.
  | { type: 'turn.interrupted' }
  | { type: 'molt.requested'; commit: string; motive: string }
  | { type: 'molt.rejected'; commit: string; gate: string; output: string }
  | { type: 'generation.started'; commit: string }
  | { type: 'generation.ready'; commit: string }
  | { type: 'generation.promoted'; commit: string; previous: string }
  | { type: 'generation.rolledback'; commit: string; to: string; reason: string }
  // The body's own record, for whatever it keeps outside the journal and must be able to build again
  // from it. The kernel stores a note and never reads one; `noteProblem` says what it takes. It came
  // later: no older journal holds one, and a reader that does not know the type passes it over.
  | { type: 'note'; kind: string; data: unknown }
  // What this individual sent out to the species (kernel/offer.ts): a commit offered as a pull request,
  // and a witness report posted on somebody's. A record for the owner; neither wakes the body nor is a reply.
  | { type: 'offer.published'; commit: string; branch: string; url: string }
  | { type: 'offer.witnessed'; commit: string; pr: number; ok: boolean; url: string };

/** What a note's `kind` may be: a short name the body chooses, such as `memory.fact` or `lesson.v2`. */
const NOTE_KIND = /^[a-z0-9._-]{1,64}$/;
/** Bytes of a note's `data` once it is JSON. A note is a record, not a store; larger things go in files it names. */
export const NOTE_DATA_LIMIT = 64 * 1024;

/** Why a note with this `kind` and `data` is not journaled, or null when it is. */
export function noteProblem(kind: unknown, data: unknown): string | null {
  if (typeof kind !== 'string' || !NOTE_KIND.test(kind)) {
    return 'a note\'s kind must be 1 to 64 characters of a-z, 0-9, ".", "_" and "-"';
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(data);
  } catch (err) {
    return `a note's data must be JSON: ${err instanceof Error ? err.message : String(err)}`;
  }
  // undefined, a function, a symbol: JSON has no way to write them, and the line would come back without `data`.
  if (json === undefined) return 'a note\'s data must be JSON, and this value has no JSON form';
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > NOTE_DATA_LIMIT) return `a note's data is ${bytes} bytes as JSON; the limit is ${NOTE_DATA_LIMIT}`;
  return null;
}

/** `gen` is the commit of the code that wrote the event. */
export type JournalEvent = EventBody & { v: number; id: string; ts: string; gen: string };

function endsWithNewline(fd: number): boolean {
  const size = fstatSync(fd).size;
  if (size === 0) return true;
  const last = Buffer.alloc(1);
  readSync(fd, last, 0, 1, size - 1);
  return last[0] === 0x0a;
}

/** Throws, with nothing written, for a note that `noteProblem` refuses. */
export function appendEvent(path: string, gen: string, body: EventBody): JournalEvent {
  if (body.type === 'note') {
    const problem = noteProblem(body.kind, body.data);
    if (problem !== null) throw new Error(problem);
  }
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

function parseLines(text: string): JournalEvent[] {
  const events: JournalEvent[] = [];
  for (const line of text.split('\n')) {
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

export function readEvents(path: string): JournalEvent[] {
  if (!existsSync(path)) return [];
  return parseLines(readFileSync(path, 'utf8'));
}

/** Bytes in the journal now: the offset at which the next event will start. 0 when there is no journal. */
export function journalSize(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

/**
 * The events appended at or after `byteOffset`, without reading what came before.
 * An offset inside a line skips the rest of that line: only whole lines are parsed.
 */
export function readEventsFrom(path: string, byteOffset: number): JournalEvent[] {
  if (!existsSync(path)) return [];
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, Math.floor(byteOffset));
    if (start >= size) return [];
    // One byte earlier than asked, to see whether the offset is the start of a line.
    const from = Math.max(0, start - 1);
    const bytes = Buffer.alloc(size - from);
    let filled = 0;
    while (filled < bytes.length) {
      const n = readSync(fd, bytes, filled, bytes.length - filled, from + filled);
      if (n === 0) break;
      filled += n;
    }
    let begin = start - from;
    if (start > 0 && bytes[0] !== 0x0a) {
      const newline = bytes.indexOf(0x0a, begin);
      if (newline === -1) return [];
      begin = newline + 1;
    }
    return parseLines(bytes.toString('utf8', begin, filled));
  } finally {
    closeSync(fd);
  }
}
