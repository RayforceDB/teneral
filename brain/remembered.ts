import type { JournalEvent } from './journal';
import type { Span } from './episodes';

// What the agent has remembered, as it lies in the journal. A memory is a note (see `note` in
// brain/journal.ts): written once by brain/sleep.ts, never changed, and read back here. Everything
// else that is known about the past, in a database or in a request, is built from these notes and
// can be built again.

/** A memory of one episode: what happened in a stretch of the journal, in the agent's own words. */
export const EPISODE_KIND = 'memory.episode.v1';
/** A stretch no memory could be formed of. It is shown as it happened for as long as it fits, then as a line saying so. */
export const QUARANTINE_KIND = 'memory.quarantine.v1';

/**
 * One memory in place of several: of a stretch of several episodes, formed from the memories of
 * its parts when the logbook has outgrown its room (brain/sleep.ts). The memories it stands for
 * stay in the journal and are still found by `recall`; a request shows the wider one instead.
 */
export const MERGE_KIND = 'memory.merge.v1';

/** How an episode ended. `quiet`: nothing happened in it, and no model was asked. */
export const OUTCOMES = ['done', 'failed', 'dropped', 'open', 'quiet'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** What a memory note holds. `from` and `to` are the ids of the first and last events it is about; `start` and `end` their times. */
export interface MemoryData extends Span {
  start: string;
  end: string;
  title: string;
  text: string;
  outcome: Outcome;
}

export interface Memory extends MemoryData {
  /** The id of the note itself, and when it was written. */
  id: string;
  at: string;
}

export interface MergeData extends MemoryData {
  /** 2 for a memory of episodes, 3 for a memory of such memories, and so on. */
  level: number;
  /** True when no model wrote it: it only lists what its parts were called. */
  mechanical?: boolean;
}
export interface Merge extends MergeData {
  id: string;
  at: string;
}

export interface QuarantineData extends Span {
  start: string;
  end: string;
  /** Why no memory was kept, in a line. */
  reason: string;
}

export interface Remembered {
  /** By the id of the first event of the stretch each is about. */
  memories: Map<string, Memory>;
  quarantined: Map<string, QuarantineData>;
  /** Every stretch that has a memory or was given up on, in the order they were written. */
  spans: Span[];
  /** The memories that stand for several episodes each. */
  merges: Merge[];
}

const text = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** The fields every memory note has, when `data` has them. Notes are the body's to write, so nothing about their shape is taken on trust. */
function span(data: unknown): (Span & { start: string; end: string }) | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  return text(d.from) && text(d.to) && text(d.start) && text(d.end) ? { from: d.from, to: d.to, start: d.start, end: d.end } : null;
}

/**
 * Everything remembered in `events`. A stretch has one record: when it was written twice, the
 * later one stands, so a stretch that was given up on can still be remembered afterwards.
 */
export function remembered(events: JournalEvent[]): Remembered {
  const memories = new Map<string, Memory>();
  const quarantined = new Map<string, QuarantineData>();
  const order: string[] = [];
  const seen = new Map<string, Span>();
  const merges: Merge[] = [];
  for (const e of events) {
    if (e.type !== 'note' || (e.kind !== EPISODE_KIND && e.kind !== QUARANTINE_KIND && e.kind !== MERGE_KIND)) continue;
    const at = span(e.data);
    if (at === null) continue;
    const d = e.data as Record<string, unknown>;
    if (e.kind === MERGE_KIND) {
      if (text(d.title) && text(d.text) && OUTCOMES.includes(d.outcome as Outcome) && typeof d.level === 'number' && d.level >= 2) {
        merges.push({ ...at, title: d.title, text: d.text, outcome: d.outcome as Outcome, level: d.level, ...(d.mechanical === true ? { mechanical: true } : {}), id: e.id, at: e.ts });
      }
      continue;
    }
    if (e.kind === EPISODE_KIND) {
      if (!text(d.title) || !text(d.text) || !OUTCOMES.includes(d.outcome as Outcome)) continue;
      memories.set(at.from, { ...at, title: d.title, text: d.text, outcome: d.outcome as Outcome, id: e.id, at: e.ts });
      quarantined.delete(at.from);
    } else {
      if (memories.has(at.from)) continue;
      quarantined.set(at.from, { ...at, reason: text(d.reason) ? d.reason : 'unknown' });
    }
    if (!seen.has(at.from)) order.push(at.from);
    seen.set(at.from, { from: at.from, to: at.to });
  }
  return { memories, quarantined, spans: order.map((from) => seen.get(from)!), merges };
}
