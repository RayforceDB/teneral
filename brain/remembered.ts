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

/**
 * Whose words a stretch was made of, in characters: the owner's, other people's and agents', what
 * tools returned, and the agent's own. A memory is the agent's telling of a stretch; this is the
 * count of what it had to tell from, taken from the journal and not from the telling.
 */
export interface Voices {
  owner: number;
  others: number;
  tools: number;
  own: number;
}

/** What a memory note holds. `from` and `to` are the ids of the first and last events it is about; `start` and `end` their times. */
export interface MemoryData extends Span {
  start: string;
  end: string;
  title: string;
  text: string;
  outcome: Outcome;
  /** Whose words the stretch was made of. Memories from before this was counted have none. */
  voices?: Voices;
}

/** Whose words these events are, counted. */
export function voicesOf(events: JournalEvent[]): Voices {
  const v: Voices = { owner: 0, others: 0, tools: 0, own: 0 };
  const size = (value: unknown): number => (typeof value === 'string' ? value.length : value === undefined ? 0 : (JSON.stringify(value) ?? '').length);
  for (const e of events) {
    const r = e as { text?: unknown; source?: unknown; output?: unknown; toolCalls?: unknown };
    if (e.type === 'stimulus') v[r.source === 'terminal' ? 'owner' : 'others'] += size(r.text);
    else if (e.type === 'assistant') v.own += size(r.text) + (Array.isArray(r.toolCalls) && r.toolCalls.length > 0 ? size(r.toolCalls) : 0);
    else if (e.type === 'tool.result') v.tools += size(r.output);
  }
  return v;
}

/** The voices in `data`, when it holds a whole count of them. */
function voicesIn(data: Record<string, unknown>): { voices?: Voices } {
  const v = data.voices as Record<string, unknown> | undefined;
  const whole = typeof v === 'object' && v !== null && (['owner', 'others', 'tools', 'own'] as const).every((k) => typeof v[k] === 'number' && (v[k] as number) >= 0);
  return whole ? { voices: { owner: v.owner as number, others: v.others as number, tools: v.tools as number, own: v.own as number } } : {};
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
        merges.push({ ...at, title: d.title, text: d.text, outcome: d.outcome as Outcome, level: d.level, ...voicesIn(d), ...(d.mechanical === true ? { mechanical: true } : {}), id: e.id, at: e.ts });
      }
      continue;
    }
    if (e.kind === EPISODE_KIND) {
      if (!text(d.title) || !text(d.text) || !OUTCOMES.includes(d.outcome as Outcome)) continue;
      memories.set(at.from, { ...at, title: d.title, text: d.text, outcome: d.outcome as Outcome, ...voicesIn(d), id: e.id, at: e.ts });
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
