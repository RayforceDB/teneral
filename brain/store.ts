import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { JournalEvent } from './journal';
import { eventChars } from './episodes';
import { dayName, toRayDay, toRayNs, type Column, type Ray, type Table } from './ray';

// The store is the journal laid out for asking questions of: one row an event, in a table of the
// database that is partitioned by day. Days that are over lie on disk and are mapped into memory
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

/** The table's name in the directory and the name it is bound to in the database. */
const TABLE = 'events';
const BOUND = 'mem_events';
/** The name rows are handed over under, for one statement, before they are inserted. */
const BATCH = 'mem_batch';
const COLUMNS = ['id', 'ts', 'type', 'source', 'off', 'next', 'chars'] as const;
/** Rows handed over in one piece. A call into the database holds up everything else, so a long journal is laid out in portions. */
const PORTION = 5000;
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
  /** A query over the table of events, which is bound to `events` in `source`. Only source written in this repository may be passed. */
  ask(source: string): Table;
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
  const partition = (day: number): string => quoted(join(dir, dayName(day), TABLE));
  /** Whether the table is mounted: a directory with no day in it cannot be, and has none until the journal has an event. */
  let mounted = false;
  /** The byte of the journal up to which events are laid out, and the latest day that has rows. */
  let reached = 0;
  let lastDay = Number.NEGATIVE_INFINITY;
  let rows = 0;
  const dirty = new Set<number>();

  const mount = (): void => {
    ray.run(`(set ${BOUND} (.db.parted.get ${root} '${TABLE}))`);
    mounted = true;
  };
  const empty = (): Record<string, Column> => rowsOf([]);
  /** Reads from the table itself how far it reaches. */
  const measure = (): void => {
    rows = Number(ray.query(`(count ${BOUND})`));
    if (rows === 0) {
      reached = 0;
      return;
    }
    const t = ray.table(`(select {from: ${BOUND} m: (max next) d: (max date)})`);
    reached = Number((t.columns.m as BigInt64Array)[0]);
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
    ray.run(`(do (set ${BOUND} null) (set ${BATCH} null) (.sys.gc) null)`);
    rmSync(dir, { recursive: true, force: true });
    mounted = false;
    reached = 0;
    rows = 0;
    lastDay = Number.NEGATIVE_INFINITY;
  }
  mkdirSync(dir, { recursive: true });

  function persist(): void {
    if (!mounted || dirty.size === 0) return;
    for (const day of [...dirty].sort((a, b) => a - b)) {
      ray.run(
        `(.db.splayed.set ${partition(day)} (select {from: ${BOUND} where: (== date ${dayName(day)}) ${COLUMNS.map((c) => `${c}: ${c}`).join(' ')}}) ${symbols})`,
      );
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
      if (!mounted) {
        // The first day there is: an empty table of the right columns is written for it, and that is what is mounted.
        ray.bind(BATCH, empty());
        ray.run(`(.db.splayed.set ${partition(day)} ${BATCH} ${symbols})`);
        mount();
      } else if (Number.isFinite(last) && day !== last) {
        // A day that is over is written out before the next one begins, so memory holds one day's rows and no more.
        persist();
      }
      ray.bind(BATCH, rowsOf(batch));
      ray.run(`(insert '${BOUND} ${dayName(day)} ${BATCH})`);
      dirty.add(day);
      last = day;
      reached = batch.at(-1)!.line.next;
      rows += batch.length;
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
      return ray.table(source.replaceAll(/\bevents\b/g, BOUND));
    },
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

/** Rows of the table for these lines, column by column. */
function rowsOf(batch: { line: Line; ns: bigint }[]): Record<string, Column> {
  return {
    id: { type: 'str', data: batch.map((b) => b.line.event.id) },
    ts: { type: 'timestamp', data: BigInt64Array.from(batch, (b) => b.ns) },
    type: { type: 'sym', data: batch.map((b) => b.line.event.type.slice(0, 64)) },
    source: { type: 'sym', data: batch.map((b) => sourceOf(b.line.event)) },
    off: { type: 'i64', data: BigInt64Array.from(batch, (b) => BigInt(b.line.off)) },
    next: { type: 'i64', data: BigInt64Array.from(batch, (b) => BigInt(b.line.next)) },
    chars: { type: 'i64', data: BigInt64Array.from(batch, (b) => BigInt(eventChars(b.line.event))) },
  };
}
