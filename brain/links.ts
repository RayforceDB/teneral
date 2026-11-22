import type { JournalEvent } from './journal';
import { FACT_KIND } from './known';
import { WITHDRAW_KIND, withdrawn } from './owned';
import { EPISODE_KIND, MERGE_KIND, QUARANTINE_KIND, remembered, type Remembered } from './remembered';

// A memory is what the agent made of a stretch when it ended, and it stays as it was written. What
// it says was true then. Whether it is true now is another matter: the thing that was open has
// been done since, the plan was changed, the number is another. A memory that is found again,
// weeks later, must not be taken for the present.
//
// So memories are tied to each other, and the ties are a graph. When a memory is formed, the agent
// is shown the earlier memories nearest to it and says which of them the new stretch has made
// outdated, and in what (brain/sleep.ts). That is a note, like every memory, and nothing is
// changed by it: the earlier memory stays, and is found, and is shown with what came of it.
//
//   outdates   a memory, to an earlier one that it made outdated
//   replaces   a fact, to the fact it took the place of (brain/known.ts wrote that down already)
//   covers     a memory of several episodes, to the memory of each of them
//
// The ties are made here, from the notes alone, so the same journal always gives the same graph.
// Where the database answers, it holds them as a table of edges and walks them itself
// (brain/past.ts); without it they are walked here. Both give the same answers.

/** One earlier memory is outdated: `memory` and `by` name two remembered stretches by the ids of their first events, `why` says what no longer holds. */
export const OUTDATED_KIND = 'memory.outdated.v1';
export interface OutdatedData { memory: string; by: string; why: string }

/** The kinds of notes the ties are made from: what has to be read to make them. */
export const LINK_NOTES = [EPISODE_KIND, QUARANTINE_KIND, MERGE_KIND, FACT_KIND, OUTDATED_KIND, WITHDRAW_KIND] as const;

export type LinkKind = 'outdates' | 'replaces' | 'covers';
/** A tie between two notes, named by their ids: `from` is the later one. */
export interface Link { from: string; to: string; kind: LinkKind; why?: string }

/** Characters of what is said about why a memory is outdated. */
export const WHY_CHARS = 200;

/**
 * Every tie in `events`. A tie stands only while both its ends do: what the owner withdrew ties
 * nothing, and a memory that was formed again is tied as the one that stands now.
 */
export function links(events: JournalEvent[], told: Remembered = remembered(events)): Link[] {
  const gone = withdrawn(events);
  const out: Link[] = [];
  const seen = new Set<string>();
  const add = (link: Link): void => {
    const key = `${link.kind} ${link.from} ${link.to}`;
    if (link.from === link.to || seen.has(key)) return;
    seen.add(key);
    out.push(link);
  };
  const facts = new Set(events.flatMap((e) => (e.type === 'note' && e.kind === FACT_KIND && !gone.has(e.id) ? [e.id] : [])));
  for (const e of events) {
    if (e.type !== 'note' || gone.has(e.id) || typeof e.data !== 'object' || e.data === null) continue;
    const d = e.data as Record<string, unknown>;
    if (e.kind === OUTDATED_KIND) {
      const old = typeof d.memory === 'string' ? told.memories.get(d.memory) : undefined;
      const by = typeof d.by === 'string' ? told.memories.get(d.by) : undefined;
      // Only what came later can outdate: a tie the other way would say that the past was changed by what it did not know.
      if (old === undefined || by === undefined || !(by.start > old.start)) continue;
      add({ from: by.id, to: old.id, kind: 'outdates', why: typeof d.why === 'string' ? d.why.trim().slice(0, WHY_CHARS) : '' });
    } else if (e.kind === FACT_KIND && facts.has(e.id) && Array.isArray(d.replaces)) {
      for (const replaced of d.replaces) if (typeof replaced === 'string' && facts.has(replaced)) add({ from: e.id, to: replaced, kind: 'replaces' });
    }
  }
  const place = new Map(told.spans.map((span, i) => [span.from, i]));
  const ends = new Map(told.spans.map((span, i) => [span.to, i]));
  for (const merge of told.merges) {
    const first = place.get(merge.from);
    const last = ends.get(merge.to);
    if (first === undefined || last === undefined) continue;
    for (let i = first; i <= last; i++) {
      const part = told.memories.get(told.spans[i]!.from);
      if (part !== undefined) add({ from: merge.id, to: part.id, kind: 'covers' });
    }
  }
  return out;
}

/** What became of one note since: who says it no longer holds, and what stands at the end of that line. */
export interface Since {
  /** The notes that outdate or replace this one directly, each with what it said of it. */
  direct: { id: string; why: string }[];
  /** The newest of the line: what outdated it, and was itself outdated by nothing. Where `direct` is all there is, the same ids. */
  latest: string[];
  /** For a memory of several episodes: how many of the memories it stands for are outdated, and of how many. */
  parts?: { outdated: number; of: number };
}

/** Asked of a set of ties: what became of a note. */
export interface Ties {
  since(id: string): Since | null;
}

/** How far a line of outdating is followed. Far longer than any that will be written; it only ends a walk that a damaged tie would send in a circle. */
export const LINE_MAX = 32;

/** The ties walked here, with no database. */
export function tiesOf(all: Link[]): Ties {
  const newer = new Map<string, { id: string; why: string }[]>();
  const parts = new Map<string, string[]>();
  for (const link of all) {
    if (link.kind === 'covers') parts.set(link.from, [...(parts.get(link.from) ?? []), link.to]);
    else newer.set(link.to, [...(newer.get(link.to) ?? []), { id: link.from, why: link.why ?? '' }]);
  }
  return {
    since(id) {
      const direct = [...(newer.get(id) ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const covered = parts.get(id);
      const counted = covered === undefined ? undefined : { outdated: covered.filter((part) => newer.has(part)).length, of: covered.length };
      if (direct.length === 0) return counted !== undefined && counted.outdated > 0 ? { direct: [], latest: [], parts: counted } : null;
      const reached = new Set<string>();
      let front = direct.map((one) => one.id);
      for (let depth = 0; depth < LINE_MAX && front.length > 0; depth++) {
        const next: string[] = [];
        for (const one of front) {
          if (reached.has(one)) continue;
          reached.add(one);
          for (const further of newer.get(one) ?? []) next.push(further.id);
        }
        front = next;
      }
      return { direct, latest: [...reached].filter((one) => !newer.has(one)).sort(), ...(counted === undefined ? {} : { parts: counted }) };
    },
  };
}

/** For each remembered stretch that is outdated, by the id of its first event: what the first to outdate it said, and when that one's stretch began. */
export function outdatedStretches(events: JournalEvent[], told: Remembered = remembered(events)): Map<string, { why: string; since: string }> {
  const byNote = new Map([...told.memories.values()].map((memory) => [memory.id, memory]));
  const out = new Map<string, { why: string; since: string }>();
  for (const link of links(events, told)) {
    if (link.kind !== 'outdates') continue;
    const old = byNote.get(link.to);
    const by = byNote.get(link.from);
    if (old === undefined || by === undefined) continue;
    const held = out.get(old.from);
    if (held === undefined || by.start < held.since) out.set(old.from, { why: link.why ?? '', since: by.start });
  }
  return out;
}
