import { existsSync, statSync } from 'node:fs';
import { readEvents, type JournalEvent } from './journal';
import { episodes, type Episode } from './episodes';
import { BACK_KIND, standing, wasSaid } from './owned';
import { openRay, type Ray } from './ray';
import { documentOf, recall, scanIndex, type Hit, type Index, type Kind } from './recall';
import { remembered } from './remembered';
import { openStore, readLine, scan, type Line, type Store } from './store';
import { clip } from '../body/text';

// The past as the agent can ask for it: found by words, opened where something happened, and
// laid out as a line of episodes. It is what the tools `recall`, `open` and `timeline` stand on.
//
// It works in two ways and answers the same in both. With the database's library at hand, the
// journal is laid out in a store (brain/store.ts) and a question costs about a millisecond
// however long the agent has lived. Without it, the journal is read through for every question,
// which is right but grows slower with every day.

export interface Past {
  /** `store` when the database answers, `journal` when the journal is read through. */
  by: 'store' | 'journal';
  /** The events that answer `question` best, each with the event itself. */
  find(question: string, options?: { kinds?: Kind[]; limit?: number }): Found[];
  /** Where the line of the latest thing said to the agent begins: what it is answering now, which is no find of its own past. Null when nothing was said yet. */
  asked(): number | null;
  /** The event with this id and the ones around it, in order; null when the journal has no such event. */
  around(id: string, before: number, after: number): { events: JournalEvent[]; at: number } | null;
  /** Brings the store up to the journal's end, and writes it out. Both are nothing to do when the journal is read through. */
  sync(): void;
  persist(): void;
  close(): void;
}

export interface Found extends Hit {
  event: JournalEvent;
}

/** The journal read through, and read again only when it has grown. */
function reader(journal: string): () => Line[] {
  let all: Line[] = [];
  let lines: Line[] = [];
  let end = 0;
  return () => {
    if (existsSync(journal) && statSync(journal).size < end) {
      // Shorter than what was read: another file than before. Start over.
      all = [];
      lines = [];
      end = 0;
    }
    const more = scan(journal, end);
    if (more.lines.length > 0) {
      all = [...all, ...more.lines];
      // Without what the owner took back (brain/owned.ts): it is in the journal and is not found.
      const stands = all.some((line) => line.event.type === 'note' && line.event.kind === BACK_KIND) ? new Set(standing(all.map((line) => line.event))) : null;
      lines = stands === null ? all : all.filter((line) => stands.has(line.event));
    }
    end = more.end;
    return lines;
  };
}

function finder(index: Index, read: (off: number) => JournalEvent | null): Past['find'] {
  return (question, options) => recall(index, question, options).flatMap((hit) => {
    const event = read(hit.doc);
    return event === null ? [] : [{ ...hit, event }];
  });
}

/** The past of `journal`, asked of the journal itself. */
export function journalPast(journal: string): Past {
  const lines = reader(journal);
  return {
    by: 'journal',
    find: finder(scanIndex(lines), (off) => readLine(journal, off)),
    asked: () => lines().findLast((line) => line.event.type === 'stimulus')?.off ?? null,
    around(id, before, after) {
      const all = lines();
      const at = all.findIndex((line) => line.event.id === id);
      if (at === -1) return null;
      const from = Math.max(0, at - before);
      return { events: all.slice(from, at + after + 1).map((line) => line.event), at: at - from };
    },
    sync() {},
    persist() {},
    close() {},
  };
}

/** The past of `journal`, asked of a store in the database `ray`. `owned` says the runtime was opened for this and is closed with it. */
function storePast(journal: string, ray: Ray, store: Store, owned: boolean): Past {
  const offsets = (source: string): number[] => [...(store.ask(source).columns.off as BigInt64Array | undefined ?? [])].map(Number);
  /**
   * The stretches of the journal the owner took back, as bytes from and to: from the line of the
   * message a note names up to the note's own line. The store holds every line; what stands is
   * decided here, so that taking a conversation back needs no row changed.
   */
  const aside = (): [number, number][] => {
    const ranges: [number, number][] = [];
    for (const off of offsets(`(select {from: events where: (== source '${BACK_KIND}) off: off})`)) {
      const to = (store.read(off) as { data?: { to?: unknown } } | null)?.data?.to;
      if (typeof to !== 'string') continue;
      ray.bind('mem_wanted', { wanted: { type: 'str', data: [to] } });
      const [from] = offsets("(select {from: events where: (in id (at mem_wanted 'wanted)) off: off})");
      if (from !== undefined && from < off) ranges.push([from, off]);
    }
    return ranges;
  };
  /** Whether the event at `off` still stands: records and notes always do, what was said in a stretch taken back does not. */
  const stands = (ranges: [number, number][], off: number, e: JournalEvent): boolean =>
    !wasSaid(e) || !ranges.some(([from, to]) => off >= from && off < to);
  return {
    by: 'store',
    find(question, options) {
      store.sync();
      const ranges = aside();
      const found = finder(store.index, store.read)(question, ranges.length === 0 ? options : { ...options, limit: (options?.limit ?? 10) + 50 });
      return ranges.length === 0 ? found : found.filter((hit) => stands(ranges, hit.doc, hit.event)).slice(0, options?.limit ?? 10);
    },
    asked() {
      store.sync();
      return offsets("(select {from: events where: (== type 'stimulus) desc: off take: 1 off: off})")[0] ?? null;
    },
    around(id, before, after) {
      store.sync();
      // The id is something a model typed: it goes over as a column, and never into the statement.
      ray.bind('mem_wanted', { wanted: { type: 'str', data: [id] } });
      const [off] = offsets("(select {from: events where: (in id (at mem_wanted 'wanted)) off: off})");
      if (off === undefined) return null;
      const earlier = before <= 0 ? [] : offsets(`(select {from: events where: (< off ${off}) desc: off take: ${Math.floor(before)} off: off})`).reverse();
      const later = offsets(`(select {from: events where: (>= off ${off}) asc: off take: ${Math.floor(after) + 1} off: off})`);
      const ranges = aside();
      const read = (offs: number[]): JournalEvent[] => offs.flatMap((at) => {
        const e = store.read(at);
        // The event asked for is shown whatever became of it; around it, only what still stands.
        return e !== null && (at === off || stands(ranges, at, e)) ? [e] : [];
      });
      const shownBefore = read(earlier);
      return { events: [...shownBefore, ...read(later)], at: shownBefore.length };
    },
    sync: () => { store.sync(); },
    persist: () => store.persist(),
    close() {
      store.persist();
      if (owned) ray.close();
    },
  };
}

/**
 * The past of `journal`: of a store when `library` names the database's library and it can be
 * loaded, of the journal itself otherwise. A library that is named and cannot be used is said so
 * through `log`, and is no reason not to remember.
 */
export function openPast(journal: string, library: string | null, log: (line: string) => void = () => {}): Past {
  if (library !== null && existsSync(library)) {
    try {
      const ray = openRay({ library });
      try {
        const store = openStore(ray, journal);
        if (store.rebuilt !== null) log(`[memory] the store was built again from the journal: ${store.rebuilt}`);
        return storePast(journal, ray, store, true);
      } catch (err) {
        ray.close();
        throw err;
      }
    } catch (err) {
      log(`[memory] the database could not be used, the journal is read through instead: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return journalPast(journal);
}

/** A journal time to the minute, in UTC, as the agent reads times everywhere. */
export const when = (ts: string): string => `${ts.slice(0, 16).replace('T', ' ')} UTC`;

/** Who or what an event is, in a word, for a line that shows it. */
function speaker(e: JournalEvent): string {
  const r = e as { source?: unknown; name?: unknown; ok?: unknown };
  switch (e.type) {
    case 'stimulus': return r.source === 'terminal' ? 'your owner' : `[${String(r.source)}]`;
    case 'assistant': return 'you';
    case 'tool.intent': return `you called ${String(r.name)}`;
    case 'tool.result': return r.ok === false ? 'the tool failed' : 'the tool returned';
    default: return e.type;
  }
}

/** An event as text: when, who, and what, cut to `chars`. Events that say nothing are named and no more. */
export function shown(e: JournalEvent, chars: number): string {
  const document = documentOf(e);
  const calls = e.type === 'assistant' ? (e as { toolCalls?: { name?: unknown }[] }).toolCalls ?? [] : [];
  const called = calls.length > 0 ? ` (and called ${calls.map((call) => String(call.name)).join(', ')})` : '';
  const head = `[${when(e.ts)}] ${document?.kind === 'memory' ? 'your memory' : speaker(e)}${called} (event ${e.id})`;
  return document === null ? head : `${head}:\n${clip(document.text, chars)}`;
}

export interface TimelineEntry {
  episode: Episode;
  /** What is remembered of it, when anything is. */
  title: string | null;
  outcome: string | null;
}

/** The episodes of `journal` whose time overlaps `from`..`to` (ISO times, either may be left out), in order, with what is remembered of each. */
export function timeline(journal: string, from?: string, to?: string): TimelineEntry[] {
  const events = standing(readEvents(journal));
  const { memories, quarantined, spans } = remembered(events);
  const lo = from === undefined ? Number.NEGATIVE_INFINITY : Date.parse(from);
  const hi = to === undefined ? Number.POSITIVE_INFINITY : Date.parse(to);
  if (Number.isNaN(lo) || Number.isNaN(hi)) throw new Error('`from` and `to` must be times such as 2026-11-14 or 2026-11-14T09:30:00Z');
  return episodes(events, spans)
    .filter((e) => Date.parse(e.end) >= lo && Date.parse(e.start) <= hi)
    .map((episode) => {
      const memory = memories.get(episode.first);
      return {
        episode,
        title: memory?.title ?? null,
        outcome: memory?.outcome ?? (quarantined.has(episode.first) ? 'no memory could be formed' : null),
      };
    });
}
