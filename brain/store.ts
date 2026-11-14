import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { JournalEvent } from './journal';
import { eventChars } from './episodes';
import { dayName, toRayDay, toRayNs, type Column, type Ray, type Table } from './ray';
import { documentOf, postings, type Index, type Kind, type Match } from './recall';

// The store is the journal laid out for asking questions of, in two tables of the database that
// are partitioned by day: one row an event, and one row for each term of each event that says
// something, which is what recall looks things up in (brain/recall.ts). Days that are over lie on disk and are mapped into memory
// when the store is opened, which takes the same short time however long the agent has lived;
// the day that is going on is held in memory and written out now and then.
//
// Nothing here is the truth. The journal is, and every row is made from one line of it, so the
// store can be thrown away and built again, and is whenever it cannot be read or does not agree
// with the journal. That is also why it needs no log of its own: after a crash the rows that were
// not written out yet are made again from the lines they came from. How far the journal has been
// laid out is not kept in a file that could disagree with the table; it is read from the table,
// which holds for every row where its line ends.
//
// The directory is named by the version of its layout (see "Notes" in brain/prompt.md). A change
// of columns means a new directory, built from the journal, and the old one left as it is, so a
// generation that is rolled back to finds a store it understands.

/** The version of the layout below. It is in the directory's name: see `storeDir`. */
export const STORE_VERSION = 1;

/** Where the store of a journal lies: beside it, in a directory of its own. */
export function storeDir(journal: string): string {
  return join(journal, '..', `store-v${STORE_VERSION}`);
}

/** The tables: the name of each in the directory, the name it is bound to in the database, and its columns. */
const TABLES = {
  events: { bound: 'mem_events', columns: ['id', 'ts', 'type', 'source', 'off', 'next', 'chars', 'said'] },
  terms: { bound: 'mem_terms', columns: ['term', 'doc', 'kind', 'w'] },
} as const;
type TableName = keyof typeof TABLES;
const NAMES = Object.keys(TABLES) as TableName[];
const BOUND = TABLES.events.bound;
/** The names rows and a question's terms are handed over under, for one statement. */
const BATCH = 'mem_batch';
const ASKED = 'mem_asked';
/** Events handed over in one piece. A call into the database holds up everything else, and an event has a hundred terms, so a long journal is laid out in portions. */
const PORTION = 1000;
/** The most rows of terms one question brings back: the best of them, when a word is in nearly everything. */
const MATCHES_MAX = 50_000;
/** A partition's directory: a day as the database writes it. */
const DAY_DIR = /^\d{4}\.\d{2}\.\d{2}$/;

/** One line of the journal that holds an event, and where it lies in the file. */
export interface Line {
  event: JournalEvent;
  /** The byte at which the line begins, and the byte after its end. */
  off: number;
  next: number;
}

/**
 * The events from byte `from` of the journal on, each with its place in the file, and the byte
 * up to which the file was read as whole lines. A last line that has no end yet is being written
 * and is left for the next time. A line that is not an event (torn by a crash, or foreign) is
 * passed over, as `readEvents` passes it over.
 */
export function scan(journal: string, from: number): { lines: Line[]; end: number } {
  if (!existsSync(journal)) return { lines: [], end: 0 };
  const fd = openSync(journal, 'r');
  try {
    const size = fstatSync(fd).size;
    if (from >= size) return { lines: [], end: Math.min(from, size) };
    const bytes = Buffer.alloc(size - from);
    let filled = 0;
    while (filled < bytes.length) {
      const n = readSync(fd, bytes, filled, bytes.length - filled, from + filled);
      if (n === 0) break;
      filled += n;
    }
    const lines: Line[] = [];
    let at = 0;
    for (;;) {
      const newline = bytes.indexOf(0x0a, at);
      if (newline === -1 || newline >= filled) break;
      if (newline > at) {
        try {
          const parsed = JSON.parse(bytes.toString('utf8', at, newline)) as Record<string, unknown> | null;
          if (typeof parsed === 'object' && parsed !== null && typeof parsed.type === 'string' && typeof parsed.id === 'string' && typeof parsed.ts === 'string') {
            lines.push({ event: parsed as unknown as JournalEvent, off: from + at, next: from + newline + 1 });
          }
        } catch {
          // Not JSON: half a line left by a crash. Nothing after it depends on it.
        }
      }
      at = newline + 1;
    }
    return { lines, end: from + at };
  } finally {
    closeSync(fd);
  }
}

/** What an event is about, in a word: where a stimulus came from, which tool was called, what kind a note is. */
function sourceOf(e: JournalEvent): string {
  const r = e as { source?: unknown; name?: unknown; kind?: unknown };
  const named = e.type === 'stimulus' ? r.source : e.type === 'tool.intent' ? r.name : e.type === 'note' ? r.kind : '';
  return typeof named === 'string' ? named.slice(0, 64) : '';
}

export interface Store {
  /** Lays out what the journal has gained since the last call. Returns how many events that was. */
  sync(): number;
  /** Writes the days that have changed to disk. What is not written is only made again after a restart. */
  persist(): void;
  /** How many events are laid out, and the byte of the journal up to which they reach. */
  count(): number;
  mark(): number;
  /** A query over the tables, which are `events` and `terms` in `source`. Only source written in this repository may be passed. */
  ask(source: string): Table;
  /** The terms, for brain/recall.ts to look things up in. */
  index: Index;
  /** The event whose line begins at byte `off` of the journal, or null when no event's line begins there. */
  read(off: number): JournalEvent | null;
  /** Whether the store was thrown away and built again when it was opened, and why. */
  rebuilt: string | null;
}

/** A path as it is written into a statement. The paths are this side's own, never anything that arrived; one that Rayfall would read otherwise is refused all the same. */
function quoted(path: string): string {
  if (/["\\\n\r\0]/.test(path)) throw new Error(`a store cannot lie at a path with a quote, a backslash or a line break in it: ${path}`);
  return `"${path}"`;
}

/**
 * Opens the store of `journal` in `dir`, building it when it is not there, and again from nothing
 * when it cannot be read or reaches past the journal. On return it holds every whole line the
 * journal has.
 */
export function openStore(ray: Ray, journal: string, dir = storeDir(journal)): Store {
  const root = quoted(dir);
  const symbols = quoted(join(dir, '.sym'));
  const partition = (day: number, table: TableName): string => quoted(join(dir, dayName(day), table));
  /** Whether the table is mounted: a directory with no day in it cannot be, and has none until the journal has an event. */
  let mounted = false;
  /** The byte of the journal up to which events are laid out, and the latest day that has rows. */
  let reached = 0;
  let lastDay = Number.NEGATIVE_INFINITY;
  let rows = 0;
  /** How many of the events say something, and so have terms: the number of documents recall counts with. */
  let documents = 0;
  const dirty = new Set<number>();

  const mount = (): void => {
    for (const name of NAMES) ray.run(`(set ${TABLES[name].bound} (.db.parted.get ${root} '${name}))`);
    mounted = true;
  };
  /** Reads from the table itself how far it reaches. */
  const measure = (): void => {
    rows = Number(ray.query(`(count ${BOUND})`));
    if (rows === 0) {
      reached = 0;
      documents = 0;
      return;
    }
    const t = ray.table(`(select {from: ${BOUND} m: (max next) d: (max date) s: (sum said)})`);
    reached = Number((t.columns.m as BigInt64Array)[0]);
    documents = Number((t.columns.s as BigInt64Array)[0]);
    lastDay = (t.columns.d as Int32Array)[0]!;
  };
  const days = (): string[] => (existsSync(dir) ? readdirSync(dir).filter((name) => DAY_DIR.test(name)).sort() : []);

  /** The store as it lies on disk, or the reason it has to be built again. */
  const load = (): string | null => {
    const found = days();
    if (found.length === 0) return null;
    try {
      mount();
      measure();
    } catch (err) {
      return `it could not be read (${err instanceof Error ? err.message : String(err)})`;
    }
    const size = existsSync(journal) ? statSync(journal).size : 0;
    if (reached > size) return `it reaches byte ${reached} of a journal that has ${size}`;
    // The day directories were made in order; the last one holds the latest rows, also when it holds none yet.
    lastDay = Math.max(lastDay, toRayDay(`${found.at(-1)!.replaceAll('.', '-')}T00:00:00Z`));
    return null;
  };

  let rebuilt = load();
  if (rebuilt !== null) {
    // The database may still hold the files of what it mounted; it lets go of them before they are removed.
    ray.run(`(do ${NAMES.map((name) => `(set ${TABLES[name].bound} null)`).join(' ')} (set ${BATCH} null) (.sys.gc) null)`);
    rmSync(dir, { recursive: true, force: true });
    mounted = false;
    reached = 0;
    rows = 0;
    documents = 0;
    lastDay = Number.NEGATIVE_INFINITY;
  }
  mkdirSync(dir, { recursive: true });

  function persist(): void {
    if (!mounted || dirty.size === 0) return;
    for (const day of [...dirty].sort((a, b) => a - b)) {
      for (const name of NAMES) {
        const { bound, columns } = TABLES[name];
        ray.run(
          `(.db.splayed.set ${partition(day, name)} (select {from: ${bound} where: (== date ${dayName(day)}) ${columns.map((c) => `${c}: ${c}`).join(' ')}}) ${symbols})`,
        );
      }
    }
    dirty.clear();
    // Mounted again, the days just written are read from disk like any other, and the memory they took is given back.
    mount();
  }

  function sync(): number {
    const { lines } = scan(journal, reached);
    if (lines.length === 0) return 0;
    let last = Number.isFinite(lastDay) ? lastDay : Number.NEGATIVE_INFINITY;
    let lastNs = 0n;
    for (let from = 0; from < lines.length;) {
      // One day at a time, and never an earlier day than the one before: the past is closed (see `.db.parted.*`),
      // and an event that claims an earlier time than the line before it is laid out with that line's day.
      const stamped = stamp(lines[from]!.event, lastNs);
      const day = Math.max(last, stamped.day);
      let to = from;
      const batch: { line: Line; ns: bigint }[] = [];
      while (to < lines.length && batch.length < PORTION) {
        const next = stamp(lines[to]!.event, lastNs);
        if (Math.max(last, next.day) !== day) break;
        lastNs = next.ns;
        batch.push({ line: lines[to]!, ns: next.ns });
        to += 1;
      }
      const made = { events: rowsOf(batch), terms: termsOf(batch) };
      if (!mounted) {
        // The first day there is: empty tables of the right columns are written for it, and they are what is mounted.
        const none = { events: rowsOf([]), terms: termsOf([]) };
        for (const name of NAMES) {
          ray.bind(BATCH, none[name]);
          ray.run(`(.db.splayed.set ${partition(day, name)} ${BATCH} ${symbols})`);
        }
        mount();
      } else if (Number.isFinite(last) && day !== last) {
        // A day that is over is written out before the next one begins, so memory holds one day's rows and no more.
        persist();
      }
      for (const name of NAMES) {
        ray.bind(BATCH, made[name]);
        ray.run(`(insert '${TABLES[name].bound} ${dayName(day)} ${BATCH})`);
      }
      dirty.add(day);
      last = day;
      reached = batch.at(-1)!.line.next;
      rows += batch.length;
      documents += batch.reduce((sum, b) => sum + (documentOf(b.line.event) === null ? 0 : 1), 0);
      from = to;
    }
    lastDay = last;
    return lines.length;
  }

  sync();
  if (rebuilt !== null || dirty.size > 0) persist();

  return {
    sync,
    persist,
    count: () => rows,
    mark: () => reached,
    ask(source) {
      if (!mounted) return { names: [], rows: 0, columns: {} };
      return ray.table(source.replaceAll(/\b(events|terms)\b/g, (name) => TABLES[name as TableName].bound));
    },
    index: {
      documents: () => documents,
      matches(asked) {
        if (!mounted || asked.length === 0) return [];
        // The terms go over as a column, never as part of the statement: they are words somebody typed.
        // Its column has a name no table here has: inside a select, a quoted name of one of the table's own columns means that column.
        ray.bind(ASKED, { asked: { type: 'sym', data: asked } });
        const t = ray.table(
          `(select {from: ${TABLES.terms.bound} where: (in term (at ${ASKED} 'asked)) desc: w take: ${MATCHES_MAX} term: term doc: doc kind: kind w: w})`,
        );
        const term = t.columns.term as string[];
        const doc = t.columns.doc as BigInt64Array;
        const kind = t.columns.kind as string[];
        const w = t.columns.w as Float64Array;
        const out = new Array<Match>(t.rows);
        for (let i = 0; i < t.rows; i++) out[i] = { term: term[i]!, doc: Number(doc[i]), kind: kind[i] as Kind, w: w[i]! };
        return out;
      },
    },
    read: (off) => readLine(journal, off),
    rebuilt,
  };
}

/** The time of an event as the database counts it, and its day. A time that cannot be read is the time of the event before. */
function stamp(e: JournalEvent, before: bigint): { ns: bigint; day: number } {
  try {
    return { ns: toRayNs(e.ts), day: toRayDay(e.ts) };
  } catch {
    return { ns: before, day: Number(before / 86_400_000_000_000n) };
  }
}

/** The event whose line begins at byte `off` of `journal`: read from there to the end of that line and no further. */
export function readLine(journal: string, off: number): JournalEvent | null {
  if (!Number.isSafeInteger(off) || off < 0 || !existsSync(journal)) return null;
  const fd = openSync(journal, 'r');
  try {
    const size = fstatSync(fd).size;
    const parts: Buffer[] = [];
    for (let at = off; at < size;) {
      const chunk = Buffer.alloc(Math.min(65_536, size - at));
      const n = readSync(fd, chunk, 0, chunk.length, at);
      if (n === 0) break;
      const newline = chunk.indexOf(0x0a);
      if (newline !== -1 && newline < n) {
        parts.push(chunk.subarray(0, newline));
        const parsed = JSON.parse(Buffer.concat(parts).toString('utf8')) as JournalEvent;
        return typeof parsed === 'object' && parsed !== null && typeof parsed.type === 'string' ? parsed : null;
      }
      parts.push(chunk.subarray(0, n));
      at += n;
    }
    return null;
  } catch {
    // Not the beginning of a line, or not a line that holds an event.
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Rows of the table of terms for these lines: one for each term of each event that says something. The event is named by where its line begins. */
function termsOf(batch: { line: Line; ns: bigint }[]): Record<string, Column> {
  const term: string[] = [];
  const doc: bigint[] = [];
  const kind: string[] = [];
  const w: number[] = [];
  for (const { line } of batch) {
    const document = documentOf(line.event);
    if (document === null) continue;
    for (const p of postings(document.text)) {
      term.push(p.term);
      doc.push(BigInt(line.off));
      kind.push(document.kind);
      w.push(p.w);
    }
  }
  return { term: { type: 'sym', data: term }, doc: { type: 'i64', data: BigInt64Array.from(doc) }, kind: { type: 'sym', data: kind }, w: { type: 'f64', data: Float64Array.from(w) } };
}

/** Rows of the table of events for these lines, column by column. */
function rowsOf(batch: { line: Line; ns: bigint }[]): Record<string, Column> {
  return {
    id: { type: 'str', data: batch.map((b) => b.line.event.id) },
    ts: { type: 'timestamp', data: BigInt64Array.from(batch, (b) => b.ns) },
    type: { type: 'sym', data: batch.map((b) => b.line.event.type.slice(0, 64)) },
    source: { type: 'sym', data: batch.map((b) => sourceOf(b.line.event)) },
    off: { type: 'i64', data: BigInt64Array.from(batch, (b) => BigInt(b.line.off)) },
    next: { type: 'i64', data: BigInt64Array.from(batch, (b) => BigInt(b.line.next)) },
    chars: { type: 'i64', data: BigInt64Array.from(batch, (b) => BigInt(eventChars(b.line.event))) },
    // 1 for an event that has terms. Their sum is the number of documents, which the table can then say for itself.
    said: { type: 'i64', data: BigInt64Array.from(batch, (b) => (documentOf(b.line.event) === null ? 0n : 1n)) },
  };
}
