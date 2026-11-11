import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Bump only with a parser that still accepts every older version. */
export const ENVELOPE_VERSION = 1;
/** Replies in one exchange before a sender must stop and ask its owner. */
export const MAX_HOPS = 4;
export const MAX_TEXT = 20_000;

export interface Envelope {
  v: number;
  /** Letters, digits and dashes only: it becomes part of a file name. */
  id: string;
  /** Who says they sent it. Not signed in this version. */
  from: string;
  to: string;
  /** Id of the message this answers, or null. */
  replyTo: string | null;
  ts: string;
  /** 0 for a first message, the answered message's hops + 1 for a reply. */
  hops: number;
  text: string;
}

const ID = /^[A-Za-z0-9-]+$/;

export function parseEnvelope(raw: string): Envelope {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('not JSON');
  }
  if (typeof data !== 'object' || data === null) throw new Error('not an object');
  const e = data as Record<string, unknown>;
  if (e.v !== ENVELOPE_VERSION) throw new Error(`unsupported version: ${String(e.v)}`);
  if (typeof e.id !== 'string' || !ID.test(e.id)) throw new Error('id must be letters, digits and dashes');
  for (const key of ['from', 'to', 'ts']) {
    if (typeof e[key] !== 'string' || e[key] === '') throw new Error(`missing ${key}`);
  }
  if (typeof e.text !== 'string') throw new Error('missing text');
  if (e.text.length > MAX_TEXT) throw new Error(`text is longer than ${MAX_TEXT} characters`);
  if (e.replyTo !== null && (typeof e.replyTo !== 'string' || !ID.test(e.replyTo))) throw new Error('replyTo must be an id or null');
  if (typeof e.hops !== 'number' || !Number.isInteger(e.hops) || e.hops < 0) throw new Error('hops must be a non-negative integer');
  return {
    v: ENVELOPE_VERSION, id: e.id, from: e.from as string, to: e.to as string,
    replyTo: e.replyTo as string | null, ts: e.ts as string, hops: e.hops, text: e.text,
  };
}

/** Drop an envelope into an inbox. The rename makes it appear whole or not at all. */
export function deliver(inbox: string, envelope: Envelope): string {
  mkdirSync(inbox, { recursive: true });
  const file = `${Date.now()}-${envelope.id}.json`;
  const tmp = join(inbox, `.tmp-${envelope.id}`);
  writeFileSync(tmp, JSON.stringify(envelope));
  renameSync(tmp, join(inbox, file));
  return file;
}

export interface Arrival {
  file: string;
  /** null when the file is not a valid envelope; `reason` then says why. */
  envelope: Envelope | null;
  reason: string | null;
}

/** Everything waiting in an inbox, oldest first. Files stay put until `archive`. */
export function collect(inbox: string): Arrival[] {
  if (!existsSync(inbox)) return [];
  return readdirSync(inbox)
    .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
    .sort()
    .map((file) => {
      try {
        return { file, envelope: parseEnvelope(readFileSync(join(inbox, file), 'utf8')), reason: null };
      } catch (err) {
        return { file, envelope: null, reason: err instanceof Error ? err.message : String(err) };
      }
    });
}

export function archive(inbox: string, file: string, where: 'seen' | 'rejected'): void {
  mkdirSync(join(inbox, where), { recursive: true });
  renameSync(join(inbox, file), join(inbox, where, file));
}

/**
 * A message this inbox already took in, by the id inside it. Files named the way `deliver`
 * names them are tried first; a sender is free to name its file anything, so the rest follow.
 */
export function findSeen(inbox: string, id: string): Envelope | null {
  const dir = join(inbox, 'seen');
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  const likely = (name: string) => name.endsWith(`-${id}.json`);
  for (const name of [...names.filter(likely), ...names.filter((n) => !likely(n))]) {
    try {
      const envelope = parseEnvelope(readFileSync(join(dir, name), 'utf8'));
      if (envelope.id === id) return envelope;
    } catch {
      // Not ours to judge here: only a file that parses and carries the id is a match.
    }
  }
  return null;
}

/** This individual's id: made on first use, kept in the directory it is given (`.teneral/`), never in git. */
export function identity(dataDir: string): string {
  const path = join(dataDir, 'id');
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  mkdirSync(dataDir, { recursive: true });
  const id = randomUUID();
  writeFileSync(path, `${id}\n`);
  return id;
}
