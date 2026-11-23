import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { JournalEvent } from './journal';
import { BACK_KIND, wasSaid } from './owned';
import { eventChars, shownChars } from './episodes';
import { dayName, toRayDay, toRayNs, type Column, type Ray, type Table } from './ray';
import { CURRENT_NOTES, currentMemoryIds, documentOf, postings, type Index, type Kind, type Match } from './recall';

// The store is the journal laid out for asking questions of, in two tables of the database that
// are partitioned by day: one row an event, with the event itself in it, whole, as the line the
// journal holds; and one row for each term of each event that says something, which is what recall
// looks things up in (brain/recall.ts). An event is therefore read from the table, by where its
// line begins in the journal or as one of a stretch, and the file is read only to lay out what it
// has gained. Days that are over lie on disk and are mapped into memory
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
// of columns means a new directory, built from the journal, so no body ever opens a layout it does
// not know. The directories of other layouts are removed when this one is opened: nothing is kept
// for a body that is no longer the one running, and one that is rolled back to builds its own again.

/** The version of the layout below. It is in the directory's name: see `storeDir`. */
export const STORE_VERSION = 3;

/** Where the store of a journal lies: beside it, in a directory of its own. */
export function storeDir(journal: string): string {
  return join(journal, '..', `store-v${STORE_VERSION}`);
}

/** Removes the stores of other layouts beside this journal: what a body before this one, or one rolled back from, laid out. */
export function dropOtherStores(journal: string): void {
  const memory = dirname(journal), mine = basename(storeDir(journal));
  let names: string[] = [];
  try { names = readdirSync(memory); } catch { return; }
  for (const name of names) {
    if (/^store-v\d+$/.test(name) && name !== mine) rmSync(join(memory, name), { recursive: true, force: true });
  }
}

/** The tables: the name of each in the directory, the name it is bound to in the database, and its columns. */
const TABLES = {
  events: { bound: 'mem_events', columns: ['seq', 'id', 'ts', 'type', 'source', 'off', 'next', 'chars', 'shown', 'calls', 'said', 'line'] },
  terms: { bound: 'mem_terms', columns: ['term', 'doc', 'kind', 'w'] },
} as const;
type TableName = keyof typeof TABLES;
const NAMES = Object.keys(TABLES) as TableName[];
const BOUND = TABLES.events.bound;
/** The names rows and a question's terms are handed over under, for one statement. */
const BATCH = 'mem_batch';
/** How a day is written: compressed. An event's whole line is in the table, and text takes a fraction of its length on disk; a column is decoded when it is first read. */
const SAVED = '{compress: true}';
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

/**
 * Something made from the events and kept in tables of its own: what is known, what is remembered,
 * how the journal is cut into episodes. The store hands it every event once, in order, and it
 * says how its tables stand; the store binds them in the database, where every reader asks, and
 * writes them out beside the events. It can always be made again from the first event on, and is
 * whenever its tables cannot be read or do not reach as far as they say.
 */
export interface Projection {
  /** Its name in the store: its tables are bound as `mem_<name>_<table>` and lie under `.derived/<name>/`. */
  name: string;
  /** Changed whenever what it makes of an event, or the columns of its tables, change: tables written under another are made again. */
  version: number;
  /** Starts from nothing. */
  reset(): void;
  /**
   * Whether it is made from the conversation as it stands: without what the owner took back
   * (brain/owned.ts). Such a projection is not handed what was said in a stretch taken back, and
   * is made again from the first event when a conversation is taken back, since that changes what
   * came before.
   */
  standing?: boolean;
  /**
   * Takes one event in; true when its tables may have changed. `seq` is the event's number.
   * `'again'` says it cannot go on from where it is and must be made again from the first event.
   */
  step(e: JournalEvent, seq: number): boolean | 'again';
  /** Its tables as they stand, column by column. The same object for a table that has not changed since it was last asked: the store then does not send it again. */
  tables(): Record<string, Record<string, Column>>;
  /** Its state again, from its tables as they were last written. */
  restore(tables: Record<string, Table>): void;
}

/** The name a projection's table is bound under in the database. */
export const boundAs = (projection: string, table: string): string => `mem_${projection}_${table}`;

export interface Store {
  /** Lays out what the journal has gained since the last call. Returns how many events that was. */
  sync(): number;
  /** Writes the days that have changed to disk. What is not written is only made again after a restart. */
  persist(): void;
  /** Brings the tables made from the events up to date in the database. Asked for by whatever reads them, just before it does: laying out an event does not pay for it. */
  settle(): void;
  /** How many events are laid out, and the byte of the journal up to which they reach. */
  count(): number;
  mark(): number;
  /** A query over the tables, which are `events` and `terms` in `source`. Only source written in this repository may be passed. */
  ask(source: string): Table;
  /** The terms, for brain/recall.ts to look things up in. */
  index: Index;
  /** The event whose line begins at byte `off` of the journal, or null when no event's line begins there. */
  read(off: number): JournalEvent | null;
  /** The events whose lines begin at byte `from` or after it and before byte `to`, in the journal's order. */
  stretch(from: number, to: number): JournalEvent[];
  /** The newest event of this type, and of this source when one is given (for a stimulus where it came from, for a note its kind, for a call of a tool its name); null when there is none. */
  latest(type: string, source?: string): JournalEvent | null;
  /** The notes of these kinds, in the journal's order: `kinds` are names written in this repository, never anything that arrived. */
  noted(kinds: readonly string[]): JournalEvent[];
  /** What was said to the agent from these sources, in the journal's order. A source is whatever a sensor called itself. */
  stimuli(sources: readonly string[]): JournalEvent[];
  /** The byte of the journal just after the newest reply or interruption: where what no turn has settled yet begins. 0 when there is none. */
  settled(): number;
  /** What was said from these sources and the notes of these kinds, together, in the journal's order. */
  picked(sources: readonly string[], kinds: readonly string[]): JournalEvent[];
  /** The same, each with its number. */
  notedAt(kinds: readonly string[]): { event: JournalEvent; seq: number }[];
  /** How many notes of these kinds there are: what changes when there is something new to read of them. */
  notedCount(kinds: readonly string[]): number;
  /** The conversation as it stands from the event numbered `seq` on and before the one numbered `end` (to the last, without it), in order: without what was said in a stretch the owner took back. */
  standingFrom(seq: number, end?: number): JournalEvent[];
  /** The numbers of the events with these ids, of those that stand; the latest when an id was written twice. */
  places(ids: string[]): Map<string, number>;
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
export function openStore(ray: Ray, journal: string, dir = storeDir(journal), projections: Projection[] = []): Store {
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
  let currentCache: { notes: number; offsets: Set<number> } | null = null;
  const noted = (kinds: readonly string[]): JournalEvent[] => {
    if (!mounted || kinds.length === 0) return [];
    return eventsOf(ray.table(`(select {from: ${BOUND} where: ${ofKinds(kinds)} asc: off line: line})`));
  };
  const notedAt = (kinds: readonly string[]): { event: JournalEvent; seq: number }[] => {
    if (!mounted || kinds.length === 0) return [];
    const t = ray.table(`(select {from: ${BOUND} where: ${ofKinds(kinds)} asc: seq seq: seq line: line})`);
    const seqs = t.columns.seq as BigInt64Array | undefined ?? new BigInt64Array(0);
    const out: { event: JournalEvent; seq: number }[] = [];
    (t.columns.line as string[] | undefined ?? []).forEach((cell, i) => {
      try { out.push({ event: JSON.parse(cell) as JournalEvent, seq: Number(seqs[i]) }); } catch { /* a cell that is no event: as a line that is none */ }
    });
    return out;
  };
  const notedCount = (kinds: readonly string[]): number => {
    if (!mounted || kinds.length === 0) return 0;
    const n = ray.query(`(count (select {from: ${BOUND} where: ${ofKinds(kinds)} off: off}))`);
    return typeof n === 'bigint' || typeof n === 'number' ? Number(n) : 0;
  };

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
  if (dir === storeDir(journal)) dropOtherStores(journal);

  // What is made from the events: read back as it was last written, then brought up to the events.
  const derived = (projection: Projection, table: string): string => quoted(join(dir, '.derived', projection.name, table));
  /** Projections whose tables in the database, or on disk, are behind their state. */
  const unbound = new Set<Projection>();
  const unwritten = new Set<Projection>();
  /** What each table was last bound from: a projection that hands back the very same columns for a table has not changed it, and it is not sent again. */
  const boundFrom = new Map<string, Record<string, Column>>();
  const writtenFrom = new Map<string, Record<string, Column>>();
  const bindTables = (projection: Projection): void => {
    for (const [table, columns] of Object.entries(projection.tables())) {
      const name = boundAs(projection.name, table);
      if (boundFrom.get(name) === columns) continue;
      ray.bind(name, columns);
      boundFrom.set(name, columns);
    }
  };
  /** Stretches of the conversation the owner took back, as numbers of events: from the message a note names up to the note. */
  const aside: [number, number][] = [];
  const setAside = (seq: number, e: JournalEvent): boolean => wasSaid(e) && aside.some(([from, to]) => seq >= from && seq < to);
  /** Notes a taking back when `e` is one; true when it set a stretch aside. */
  const takenBack = (e: JournalEvent, seq: number): boolean => {
    if (e.type !== 'note' || e.kind !== BACK_KIND) return false;
    const to = (e.data as { to?: unknown } | null)?.to;
    if (typeof to !== 'string') return false;
    ray.bind(ASKED, { ids: { type: 'str', data: [to] } });
    const found = ray.table(`(select {from: ${BOUND} where: (in id (at ${ASKED} 'ids)) seq: seq})`).columns.seq as BigInt64Array | undefined;
    const from = found === undefined || found.length === 0 ? undefined : Number(found[0]);
    if (from === undefined || from >= seq) return false;
    aside.push([from, seq]);
    return true;
  };
  /** Projections to make again from the first event, once the events at hand are all laid out. */
  const again = new Set<Projection>();
  const stepOne = (projection: Projection, e: JournalEvent, seq: number): void => {
    if (again.has(projection) || (projection.standing === true && setAside(seq, e))) return;
    const changed = projection.step(e, seq);
    if (changed === 'again') again.add(projection);
    else if (changed) { unbound.add(projection); unwritten.add(projection); }
  };
  const stepAll = (e: JournalEvent, seq: number): void => {
    if (takenBack(e, seq)) for (const projection of projections) if (projection.standing === true) again.add(projection);
    for (const projection of projections) stepOne(projection, e, seq);
  };
  const bindChanged = (): void => {
    // At most twice: one made again may ask for it once more only by a fault of its own, which is not looped on.
    for (let round = 0; round < 2 && again.size > 0; round++) {
      const todo = [...again];
      again.clear();
      for (const projection of todo) {
        projection.reset();
        replay(0, (e, seq) => stepOne(projection, e, seq));
        unbound.add(projection);
        unwritten.add(projection);
      }
    }
    again.clear();
    for (const projection of unbound) bindTables(projection);
    unbound.clear();
  };
  /** The events numbered `from` and after, a portion at a time, each with its number. */
  const replay = (from: number, each: (e: JournalEvent, seq: number) => void): void => {
    for (let at = from; at < rows; at += PORTION) {
      const t = ray.table(`(select {from: ${BOUND} where: (and (>= seq ${at}) (< seq ${at + PORTION})) asc: seq seq: seq line: line})`);
      const seqs = t.columns.seq as BigInt64Array | undefined ?? new BigInt64Array(0);
      const lines = t.columns.line as string[] | undefined ?? [];
      for (let i = 0; i < lines.length; i++) {
        try { each(JSON.parse(lines[i]!) as JournalEvent, Number(seqs[i])); } catch { /* a cell that is no event: as a line that is none */ }
      }
    }
  };
  // What was taken back before now: every such note, in order, so that the stretches are known before anything is made from the events.
  if (mounted && projections.some((projection) => projection.standing === true)) {
    const t = ray.table(`(select {from: ${BOUND} where: ${ofKinds([BACK_KIND])} asc: seq seq: seq line: line})`);
    const seqs = t.columns.seq as BigInt64Array | undefined ?? new BigInt64Array(0);
    eventsOf(t).forEach((e, i) => { takenBack(e, Number(seqs[i])); });
  }
  for (const projection of projections) {
    let reaches = 0;
    projection.reset();
    try {
      const names = Object.keys(projection.tables());
      const read: Record<string, Table> = {};
      for (const table of names) read[table] = ray.table(`(select {from: (.db.splayed.get ${derived(projection, table)} ${symbols})})`);
      const mark = ray.table(`(select {from: (.db.splayed.get ${derived(projection, 'mark')} ${symbols})})`);
      const [version, seq] = [Number((mark.columns.version as BigInt64Array)[0]), Number((mark.columns.seq as BigInt64Array)[0])];
      if (version === projection.version && Number.isSafeInteger(seq) && seq >= 0 && seq <= rows) {
        projection.restore(read);
        reaches = seq;
      }
    } catch {
      // Never written, written by another version, or not to be read: made again from the first event.
      projection.reset();
      reaches = 0;
    }
    if (reaches === 0) unwritten.add(projection);
    if (mounted) replay(reaches, (e, seq) => {
      // A taking back among what is new changes what came before it: `stepAll` is not used here, the stretches are known already.
      if (e.type === 'note' && e.kind === BACK_KIND && projection.standing === true && seq >= reaches && reaches > 0) again.add(projection);
      stepOne(projection, e, seq);
    });
    unbound.add(projection);
  }
  bindChanged();

  function persistDays(): void {
    if (!mounted || dirty.size === 0) return;
    for (const day of [...dirty].sort((a, b) => a - b)) {
      for (const name of NAMES) {
        const { bound, columns } = TABLES[name];
        ray.run(
          `(.db.splayed.set ${partition(day, name)} (select {from: ${bound} where: (== date ${dayName(day)}) ${columns.map((c) => `${c}: ${c}`).join(" ")}}) ${symbols} ${SAVED})`,
        );
      }
    }
    dirty.clear();
    // Mounted again, the days just written are read from disk like any other, and the memory they took is given back.
    mount();
  }

  /** Everything that has changed, written out: the days, then what is made from the events. */
  function persist(): void {
    if (!mounted) return;
    persistDays();
    writeDerived();
  }

  /** Writes out what is made from the events, after the events it was made from: a table that reaches further than the events on disk is made again at the next start. */
  function writeDerived(): void {
    bindChanged();
    for (const projection of unwritten) {
      for (const [table, columns] of Object.entries(projection.tables())) {
        // A table that is as it was last written is not written again: most of what is made from the events changes rarely.
        const name = boundAs(projection.name, table);
        if (writtenFrom.get(name) === columns) continue;
        ray.run(`(.db.splayed.set ${derived(projection, table)} ${name} ${symbols})`);
        writtenFrom.set(name, columns);
      }
      ray.bind(BATCH, { version: { type: 'i64', data: BigInt64Array.from([BigInt(projection.version)]) }, seq: { type: 'i64', data: BigInt64Array.from([BigInt(rows)]) } });
      ray.run(`(.db.splayed.set ${derived(projection, 'mark')} ${BATCH} ${symbols})`);
    }
    unbound.clear();
    unwritten.clear();
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
      const made = { events: rowsOf(batch, rows), terms: termsOf(batch) };
      if (!mounted) {
        // The first day there is: empty tables of the right columns are written for it, and they are what is mounted.
        const none = { events: rowsOf([], 0), terms: termsOf([]) };
        for (const name of NAMES) {
          ray.bind(BATCH, none[name]);
          ray.run(`(.db.splayed.set ${partition(day, name)} ${BATCH} ${symbols} ${SAVED})`);
        }
        mount();
      } else if (Number.isFinite(last) && day !== last) {
        // A day that is over is written out before the next one begins, so memory holds one day's rows and no more.
        persistDays();
      }
      for (const name of NAMES) {
        ray.bind(BATCH, made[name]);
        ray.run(`(insert '${TABLES[name].bound} ${dayName(day)} ${BATCH})`);
      }
      dirty.add(day);
      last = day;
      reached = batch.at(-1)!.line.next;
      batch.forEach((b, i) => stepAll(b.line.event, rows + i));
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
    settle: bindChanged,
    persist,
    count: () => rows,
    mark: () => reached,
    ask(source) {
      if (!mounted) return { names: [], rows: 0, columns: {} };
      return ray.table(source.replaceAll(/\b(events|terms)\b/g, (name) => TABLES[name as TableName].bound));
    },
    index: {
      documents: () => documents,
      current() {
        // Which memories and facts stand is decided by notes alone (`CURRENT_NOTES` in brain/recall.ts), so only
        // those are read, from the table, and only when one of them has been written since: the journal
        // itself is not read through for a question, however long it is.
        const notes = notedCount(CURRENT_NOTES);
        if (currentCache?.notes === notes) return currentCache.offsets;
        const ids = [...currentMemoryIds(noted(CURRENT_NOTES))];
        ray.bind(ASKED, { ids: { type: 'str', data: ids } });
        const table = ray.table(`(select {from: ${BOUND} where: (in id (at ${ASKED} 'ids)) off: off})`);
        const offsets = new Set([...(table.columns.off as BigInt64Array | undefined ?? [])].map(Number));
        currentCache = { notes, offsets };
        return offsets;
      },
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
    read(off) {
      if (!mounted || !Number.isSafeInteger(off) || off < 0) return null;
      const [event] = eventsOf(ray.table(`(select {from: ${BOUND} where: (== off ${off}) line: line})`));
      return event ?? null;
    },
    standingFrom(seq, end) {
      const out: JournalEvent[] = [];
      if (!mounted) return out;
      const from = Number.isSafeInteger(seq) && seq > 0 ? seq : 0;
      replay(from, (e, at) => { if ((end === undefined || at < end) && !setAside(at, e)) out.push(e); });
      return out;
    },
    places(ids) {
      const out = new Map<string, number>();
      if (!mounted || ids.length === 0) return out;
      ray.bind(ASKED, { ids: { type: 'str', data: ids } });
      const t = ray.table(`(select {from: ${BOUND} where: (in id (at ${ASKED} 'ids)) asc: seq seq: seq id: id type: type})`);
      const seqs = t.columns.seq as BigInt64Array | undefined ?? new BigInt64Array(0);
      const found = t.columns.id as string[] | undefined ?? [];
      const types = t.columns.type as string[] | undefined ?? [];
      found.forEach((id, i) => { if (!setAside(Number(seqs[i]), { type: types[i] } as JournalEvent)) out.set(id, Number(seqs[i])); });
      return out;
    },
    stretch(from, to) {
      if (!mounted || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from) return [];
      return eventsOf(ray.table(`(select {from: ${BOUND} where: (and (>= off ${from}) (< off ${to})) asc: off line: line})`));
    },
    latest(type, source) {
      if (!mounted) return null;
      // The names go over as a column, never as part of the statement: a source is whatever a sensor called itself.
      ray.bind(ASKED, { w: { type: 'sym', data: [type.slice(0, 64), (source ?? '').slice(0, 64)] } });
      const is = (column: string, at: number): string => `(== ${column} (at (at ${ASKED} 'w) ${at}))`;
      const [event] = eventsOf(ray.table(`(select {from: ${BOUND} where: ${source === undefined ? is('type', 0) : `(and ${is('type', 0)} ${is('source', 1)})`} desc: off take: 1 line: line})`));
      return event ?? null;
    },
    noted,
    notedAt,
    settled() {
      if (!mounted) return 0;
      const next = ray.table(`(select {from: ${BOUND} where: (or (== type 'assistant) (== type 'turn.interrupted)) desc: off take: 1 next: next})`).columns.next as BigInt64Array | undefined;
      return next === undefined || next.length === 0 ? 0 : Number(next[0]);
    },
    picked(sources, kinds) {
      if (!mounted || sources.length + kinds.length === 0) return [];
      // A source and a kind share the column, each under its own type: asked for together, and told apart here.
      ray.bind(ASKED, { w: { type: 'sym', data: [...sources, ...kinds].map((name) => name.slice(0, 64)) } });
      return eventsOf(ray.table(`(select {from: ${BOUND} where: (and (or (== type 'stimulus) (== type 'note)) (in source (at ${ASKED} 'w))) asc: off line: line})`))
        .filter((e) => (e.type === 'stimulus' ? sources.includes(e.source) : e.type === 'note' && kinds.includes(e.kind)));
    },
    stimuli(sources) {
      if (!mounted || sources.length === 0) return [];
      // The names go over as a column, never as part of the statement.
      ray.bind(ASKED, { w: { type: 'sym', data: sources.map((source) => source.slice(0, 64)) } });
      return eventsOf(ray.table(`(select {from: ${BOUND} where: (and (== type 'stimulus) (in source (at ${ASKED} 'w))) asc: off line: line})`));
    },
    notedCount,
    rebuilt,
  };
}

/** The condition that a row is a note of one of these kinds. A note's kind is in `source`, where a stimulus has where it came from. */
function ofKinds(kinds: readonly string[]): string {
  for (const kind of kinds) if (!/^[a-z][a-z0-9.]*$/.test(kind)) throw new Error(`not the name of a kind of note: ${kind}`);
  const one = (kind: string): string => `(== source '${kind})`;
  const any = kinds.slice(1).reduce((all, kind) => `(or ${all} ${one(kind)})`, one(kinds[0]!));
  return `(and (== type 'note) ${any})`;
}

/** The events a table's `line` column holds, in its order. A cell that is not an event is passed over, as a line of the journal that is not one is. */
function eventsOf(table: Table): JournalEvent[] {
  const events: JournalEvent[] = [];
  for (const line of (table.columns.line as string[] | undefined) ?? []) {
    try {
      const parsed = JSON.parse(line) as JournalEvent;
      if (typeof parsed === 'object' && parsed !== null && typeof parsed.type === 'string') events.push(parsed);
    } catch { /* not an event */ }
  }
  return events;
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

/** How many calls of tools a reply made; 0 for anything else. */
function callsOf(e: JournalEvent): number {
  const calls = e.type === 'assistant' ? (e as { toolCalls?: unknown }).toolCalls : undefined;
  return Array.isArray(calls) ? calls.length : 0;
}

/**
 * Rows of the table of events for these lines, column by column. `first` is the number of the
 * first of them: events are numbered from 0 in the journal's order, and every other table names
 * an event by that number, which is found without reading through (an id is a string, and a
 * string is looked for by reading every row).
 */
function rowsOf(batch: { line: Line; ns: bigint }[], first: number): Record<string, Column> {
  return {
    seq: { type: 'i64', data: BigInt64Array.from(batch, (_, i) => BigInt(first + i)) },
    id: { type: 'str', data: batch.map((b) => b.line.event.id) },
    ts: { type: 'timestamp', data: BigInt64Array.from(batch, (b) => b.ns) },
    type: { type: 'sym', data: batch.map((b) => b.line.event.type.slice(0, 64)) },
    source: { type: 'sym', data: batch.map((b) => sourceOf(b.line.event)) },
    off: { type: 'i64', data: BigInt64Array.from(batch, (b) => BigInt(b.line.off)) },
    next: { type: 'i64', data: BigInt64Array.from(batch, (b) => BigInt(b.line.next)) },
    chars: { type: 'i64', data: BigInt64Array.from(batch, (b) => BigInt(eventChars(b.line.event))) },
    // What it counts for once it is old, and how many calls a reply made: what a request's cuts and its call ids are counted by (brain/memory.ts).
    shown: { type: 'i64', data: BigInt64Array.from(batch, (b) => BigInt(shownChars(b.line.event))) },
    calls: { type: 'i64', data: BigInt64Array.from(batch, (b) => BigInt(callsOf(b.line.event))) },
    // 1 for an event that has terms. Their sum is the number of documents, which the table can then say for itself.
    said: { type: 'i64', data: BigInt64Array.from(batch, (b) => (documentOf(b.line.event) === null ? 0n : 1n)) },
    // The event itself, as JSON: what the journal's line says, to be read back without the file.
    line: { type: 'str', data: batch.map((b) => JSON.stringify(b.line.event)) },
  };
}
