import { existsSync, statSync } from 'node:fs';
import { readEvents, type JournalEvent } from './journal';
import { episodes, type Episode } from './episodes';
import { BACK_KIND, standing, wasSaid, fromOwner } from './owned';
import { libraryAt, openRay, type Ray } from './ray';
import { serverAt, startRayServer, type RayServer } from './rayserver';
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
  /** The database itself, when it answers: for other tables made from the journal (body/community.ts). A process has one runtime. */
  ray?: Ray;
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

/** How many of the best memories lend weight to the events of their stretches, and how much of their own score they lend. */
const LENDERS = 3;
// Measured on the first life that wrote its own questions (15 of them, each put in other words than its answer): with nothing lent, the
// answering event was among the first five finds for 3; with 0.3 for 6; with 0.6 to 1 for 7; past 1, questions that name the answer's own
// words began to lose it. The exam is how this number is to be changed (brain/exam.ts).
export const LENT = 0.8;
/** How many finds are looked through before the selected memories' own stretches add their matches. */
const LOOKED = 80;
/** How much the best memory lends to its closing reply, beyond the ordinary lending to every event. */
const CLOSING = 0.4;

/**
 * Finding in two steps. A question put in other words than the answer shares few words with the
 * message that answers it, but many with the memory of that stretch, which the agent wrote in the
 * words it thinks in. So the memories are found first, and the best of them lend part of their
 * score to every find that lies in their stretch: the answer rises because its episode was
 * recognised, not because its own words matched. Matches inside those stretches are included even
 * when they fall below LOOKED globally. The closing reply of the best stretch gets a further lift:
 * after a complaint and the work, it is usually where the outcome is stated. `offsetsOf` says where
 * the lines of events lie; `closingReply` finds the last nonempty assistant reply in a stretch.
 */
function finder(
  index: Index,
  read: (off: number) => JournalEvent | null,
  offsetsOf: (ids: string[]) => Map<string, number>,
  closingReply: (from: number, to: number) => number | null,
): Past['find'] {
  return (question, options) => {
    const limit = options?.limit ?? 10;
    const withEvent = (hits: Hit[]): Found[] => hits.flatMap((hit) => {
      const event = read(hit.doc);
      return event === null ? [] : [{ ...hit, event }];
    });
    const memories = withEvent(recall(index, question, { kinds: ['memory'], limit: LENDERS }));
    const stretches = memories.flatMap((m) => {
      const d = (m.event as { data?: { from?: unknown; to?: unknown } }).data;
      return typeof d?.from === 'string' && typeof d?.to === 'string' ? [{ from: d.from, to: d.to, score: m.score }] : [];
    });
    if (stretches.length === 0 || LENT <= 0) return withEvent(recall(index, question, options));
    const at = offsetsOf(stretches.flatMap((st) => [st.from, st.to]));
    const spans = stretches.flatMap((st) => {
      const [from, to] = [at.get(st.from), at.get(st.to)];
      return from === undefined || to === undefined ? [] : [{ from, to, score: st.score }];
    });
    if (spans.length === 0) return withEvent(recall(index, question, options));
    // Recall has already scored every matching document. Keep the ordinary global pool, then add
    // matches from the selected stretches without another index scan or a local rarity calculation.
    const all = recall(index, question, { ...options, limit: Number.MAX_SAFE_INTEGER });
    const inside = all.filter((hit) => hit.kind !== 'memory' && spans.some((sp) => hit.doc >= sp.from && hit.doc <= sp.to));
    const candidates = [...new Map([...all.slice(0, LOOKED + limit), ...inside].map((hit) => [hit.doc, hit])).values()];
    const closing = closingReply(spans[0]!.from, spans[0]!.to);
    const lifted = candidates.map((hit) => {
      // A memory is not lifted by a memory: only what happened is.
      const lent = hit.kind === 'memory' ? 0 : Math.max(0, ...spans.filter((sp) => hit.doc >= sp.from && hit.doc <= sp.to).map((sp) => sp.score));
      const close = hit.kind !== 'memory' && hit.doc === closing ? CLOSING * spans[0]!.score : 0;
      return lent === 0 && close === 0 ? hit : { ...hit, score: hit.score + LENT * lent + close };
    });
    return withEvent(lifted.sort((a, b) => b.score - a.score || b.doc - a.doc).slice(0, limit));
  };
}

/** The past of `journal`, asked of the journal itself. */
export function journalPast(journal: string): Past {
  const lines = reader(journal);
  return {
    by: 'journal',
    find: finder(scanIndex(lines), (off) => readLine(journal, off), (ids) => {
      const wanted = new Set(ids);
      return new Map(lines().filter((line) => wanted.has(line.event.id)).map((line) => [line.event.id, line.off]));
    }, (from, to) => lines().filter((line) => line.off >= from && line.off <= to).findLast((line) => {
      const text = (line.event as { text?: unknown }).text;
      return line.event.type === 'assistant' && typeof text === 'string' && text.trim() !== '';
    })?.off ?? null),
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
export function storePast(journal: string, ray: Ray, store: Store, owned: boolean): Past {
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
  /** Where the lines of the events with these ids begin. The ids go over as a column: they come out of notes, which are the body's own, and are still never part of a statement. */
  const offsetsOf = (ids: string[]): Map<string, number> => {
    if (ids.length === 0) return new Map();
    ray.bind('mem_wanted', { wanted: { type: 'str', data: ids } });
    const t = store.ask("(select {from: events where: (in id (at mem_wanted 'wanted)) id: id off: off})");
    return new Map((t.columns.id as string[] | undefined ?? []).map((id, i) => [id, Number((t.columns.off as BigInt64Array)[i])]));
  };
  /** The last assistant event with text in this stretch, or null when it has none. */
  const closingReply = (from: number, to: number): number | null => {
    const candidates = offsets(`(select {from: events where: (and (>= off ${from}) (and (<= off ${to}) (== type 'assistant))) desc: off off: off})`);
    for (const off of candidates) {
      const event = store.read(off) as { text?: unknown } | null;
      if (typeof event?.text === 'string' && event.text.trim() !== '') return off;
    }
    return null;
  };
  /** Whether the event at `off` still stands: records and notes always do, what was said in a stretch taken back does not. */
  const stands = (ranges: [number, number][], off: number, e: JournalEvent): boolean =>
    !wasSaid(e) || !ranges.some(([from, to]) => off >= from && off < to);
  return {
    ray,
    by: 'store',
    find(question, options) {
      store.sync();
      const ranges = aside();
      const found = finder(store.index, store.read, offsetsOf, closingReply)(question, ranges.length === 0 ? options : { ...options, limit: (options?.limit ?? 10) + 50 });
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

/**
 * The past as a running agent has it: asked of the database in a process of its own
 * (brain/rayserver.ts), which this starts, with the journal read through whenever that cannot be
 * had. `organsDir` is where the pinned build lies: its library, to be the client with, and its
 * program, to be the server.
 *
 * The database is a help and never a condition. When its process dies, or answers with something
 * that is not an answer, what was asked is asked of the journal instead, and so is everything
 * after it for as long as this body runs: the next body starts the database afresh, and the store
 * is brought up to the journal then. Nothing is lost by that; it is only slower.
 */
export async function openServedPast(journal: string, organsDir: string | null, log: (line: string) => void = () => {}): Promise<Past> {
  if (organsDir === null || !existsSync(libraryAt(organsDir)) || !existsSync(serverAt(organsDir))) return journalPast(journal);
  let server: RayServer | null = null;
  try {
    server = await startRayServer(serverAt(organsDir), journal, { log });
    const ray = openRay({ library: libraryAt(organsDir), server: { port: server.port } });
    try {
      const store = openStore(ray, journal);
      if (store.rebuilt !== null) log(`[memory] the store was built again from the journal: ${store.rebuilt}`);
      return guarded(storePast(journal, ray, store, true), server, journal, log);
    } catch (err) {
      ray.close();
      throw err;
    }
  } catch (err) {
    server?.stop();
    log(`[memory] the database could not be used, the journal is read through instead: ${err instanceof Error ? err.message : String(err)}`);
    return journalPast(journal);
  }
}

/** `served`, with the journal read through in its place from the first time it fails. See `openServedPast`. */
function guarded(served: Past, server: RayServer, journal: string, log: (line: string) => void): Past {
  let now: Past = served;
  let fell = false;
  const fall = (err: unknown): Past => {
    if (!fell) {
      fell = true;
      log(`[memory] the database ${server.alive() ? 'failed' : 'is gone'}, the journal is read through from here on: ${err instanceof Error ? err.message : String(err)}`);
      try { served.close(); } catch { /* it was the one that failed */ }
      server.stop();
      now = journalPast(journal);
    }
    return now;
  };
  const through = <T>(asked: (past: Past) => T): T => {
    if (fell) return asked(now);
    try { return asked(now); } catch (err) { return asked(fall(err)); }
  };
  return {
    get by() { return now.by; },
    get ray() { return fell ? undefined : served.ray; },
    find: (question, options) => through((past) => past.find(question, options)),
    asked: () => through((past) => past.asked()),
    around: (id, before, after) => through((past) => past.around(id, before, after)),
    sync: () => through((past) => past.sync()),
    persist: () => through((past) => past.persist()),
    close: () => { try { now.close(); } finally { server.stop(); } },
  };
}

/** A journal time to the minute, in UTC, as the agent reads times everywhere. */
export const when = (ts: string): string => `${ts.slice(0, 16).replace('T', ' ')} UTC`;

/** Who or what an event is, in a word, for a line that shows it. */
function speaker(e: JournalEvent): string {
  const r = e as { source?: unknown; name?: unknown; ok?: unknown };
  switch (e.type) {
    case 'stimulus': return r.source === 'terminal' ? 'your owner' : fromOwner(r.source) ? `your owner [${String(r.source)}]` : `[${String(r.source)}]`;
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
  // A memory is of a stretch: the id given is where that stretch begins, which is what `open` should be asked for, not the note the memory lies in.
  const about = e.type === 'note' ? (e.data as { from?: unknown } | null)?.from : undefined;
  const head = `[${when(e.ts)}] ${document?.kind === 'memory' ? 'your memory' : speaker(e)}${called} (${typeof about === 'string' ? `of the stretch that begins at event ${about}` : `event ${e.id}`})`;
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
