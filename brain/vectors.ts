import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { JournalEvent } from './journal';
import { dayName, type Ray } from './ray';
import { documentOf, type Kind } from './recall';

// What the agent's documents mean, as vectors the database makes and keeps.
//
// Words find a document that shares words with the question (brain/recall.ts). A memory that says
// the same in other words is not found that way, and of the questions an agent asks of its own past
// that is a good part: measured on a real journal, the answer lay among the first five found for
// 30 of 100 questions by words alone and for 35 with vectors beside them, among the first two
// hundred for 64 and 78.
//
// Nothing here computes a vector. The database does (`.emb.encode`, with a model it opens from a
// directory as its publisher ships it), and it keeps them the way it keeps the events: a table
// partitioned by day, `vectors` with a row for a document (`doc`, the byte its line begins at in
// the journal; `kind`; `vec`), the current day in memory and written out like any other. A
// question is one query: `select ... nearest:` over that table.
//
// All of it is a help and never a condition. Without the model's directory, or with a database
// that has no `.emb.encode` (a build from before it), there are no vectors and recall is what it
// was. When a statement fails, vectors are left alone until the next start.
//
// Documents are embedded in portions, the oldest first, a little at a time (`step`): a portion is
// about a second of the database's work, and a journal of years is caught up over hours of the
// agent's ordinary life. Until then what has no vector yet is found by its words only.

/** Changed with the columns below or with what is embedded: an older directory is then left where it is and a new one begun. */
export const VECTORS_VERSION = 1;
/** Where an agent's embedding model lies, when it has one: beside its journal. */
export const modelDir = (journal: string): string => join(dirname(journal), 'models', 'embed');
export const vectorsDir = (journal: string): string => join(dirname(journal), `vectors-v${VECTORS_VERSION}`);

/** Documents embedded in one statement. */
export const PORTION = 32;
/** Events looked at for one portion: most events are no documents. */
const LOOK = 256;
/** The characters of a document that are embedded, and the tokens the model is given of them. */
export const TEXT_MAX = 1600;
const TOKENS = 256;
/** What the model was trained to see before a document and before a question. */
const PASSAGE = 'passage: ', QUERY = 'query: ';

const MODEL = 'mem_vec_model', TABLE = 'mem_vectors', BATCH = 'mem_vec_batch', ASKED = 'mem_vec_asked';

/** An event the database holds, with the byte its line begins at and its day. */
export interface Held { off: number; day: number; event: JournalEvent }

export interface Vectors {
  /** How many documents have a vector. */
  covered(): number;
  /** Embeds the next portion of what has none yet. Returns how many events it went past: 0 when there is nothing left. */
  step(): number;
  /** The documents nearest to the question in meaning, the nearest first. */
  near(question: string, limit: number, kinds?: Kind[]): { doc: number; kind: Kind }[];
  /** Writes the days that have gained vectors. What is not written is embedded again after a restart. */
  persist(): void;
}

/** The text of a document as the model is given it. */
export function passage(text: string): string {
  return PASSAGE + text.replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX).trim();
}

function quoted(path: string): string {
  if (/["\\\n\r\0]/.test(path)) throw new Error(`vectors cannot lie at a path with a quote, a backslash or a line break in it: ${path}`);
  return `"${path}"`;
}

/**
 * The vectors of `journal`'s documents, kept by `ray`, or null when there are to be none: no model
 * beside the journal, or a database that cannot open it. `after(off, take)` gives the events whose
 * lines begin after byte `off`, in order, at most `take`: the store has them.
 */
export function openVectors(
  ray: Ray, journal: string, after: (off: number, take: number) => Held[], log: (line: string) => void = () => {},
  dir = vectorsDir(journal), model = modelDir(journal),
): Vectors | null {
  if (!existsSync(join(model, 'config.json'))) return null;
  const root = quoted(dir), symbols = quoted(join(dir, '.sym'));
  const partition = (day: number): string => quoted(join(dir, dayName(day), 'vectors'));
  try {
    ray.run(`(set ${MODEL} (.emb.model.get ${quoted(model)}))`);
  } catch (err) {
    log(`[memory] no vectors: the database could not open the model at ${model}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  let mounted = false;
  /** The day the newest vector is of, and the byte up to which the journal's events were gone past. */
  let lastDay = Number.NEGATIVE_INFINITY, reached = -1, count = 0;   // -1: the first line begins at byte 0, and is after it
  const dirty = new Set<number>();
  let broken = false;
  const failed = (what: string, err: unknown): void => {
    broken = true;
    log(`[memory] vectors are left alone until the next start: ${what}: ${err instanceof Error ? err.message : String(err)}`);
  };

  const mount = (): void => {
    const days = existsSync(dir) ? readdirSync(dir).filter((name) => /^\d{4}\.\d\d\.\d\d$/.test(name)) : [];
    if (days.length === 0) return;
    ray.run(`(set ${TABLE} (.db.parted.get ${root} 'vectors))`);
    mounted = true;
  };
  const measure = (): void => {
    if (!mounted) return;
    const t = ray.table(`(select {from: ${TABLE} n: (count doc) last: (max doc) day: (max date)})`);
    count = Number((t.columns.n as BigInt64Array | undefined)?.[0] ?? 0n);
    if (count > 0) {
      reached = Number((t.columns.last as BigInt64Array)[0]);
      lastDay = Number((t.columns.day as Int32Array)[0]);
    }
  };
  try {
    mount();
    measure();
  } catch (err) {
    failed('what is on disk could not be read', err);
  }

  const persist = (): void => {
    if (broken || !mounted || dirty.size === 0) return;
    try {
      for (const day of [...dirty].sort((a, b) => a - b)) {
        ray.run(`(.db.splayed.set ${partition(day)} (select {from: ${TABLE} where: (== date ${dayName(day)}) doc: doc kind: kind vec: vec}) ${symbols})`);
      }
      dirty.clear();
      // Mounted again, the days just written are read from disk, and the memory they took is given back.
      mount();
    } catch (err) {
      failed('a day could not be written', err);
    }
  };

  return {
    covered: () => count,
    persist,
    step() {
      if (broken) return 0;
      try {
        const rows = after(reached, LOOK);
        if (rows.length === 0) return 0;
        const docs: { off: number; day: number; kind: Kind; text: string }[] = [];
        let looked = 0;
        for (const row of rows) {
          looked += 1;
          const d = documentOf(row.event);
          // A question of the exam is found among questions, by its words: it is no document of what happened.
          if (d !== null && d.kind !== 'key') docs.push({ off: row.off, day: row.day, kind: d.kind, text: passage(d.text) });
          if (docs.length === PORTION) break;
        }
        for (let from = 0; from < docs.length;) {
          // One day at a time, and never an earlier one: the past is closed, as in the store.
          const day = Math.max(lastDay, docs[from]!.day);
          let to = from;
          while (to < docs.length && Math.max(lastDay, docs[to]!.day) === day) to += 1;
          const part = docs.slice(from, to);
          ray.bind(BATCH, {
            doc: { type: 'i64', data: BigInt64Array.from(part, (d) => BigInt(d.off)) },
            kind: { type: 'sym', data: part.map((d) => d.kind) },
            text: { type: 'str', data: part.map((d) => d.text) },
          });
          const made = `(select {from: ${BATCH} doc: doc kind: kind vec: (.emb.encode ${MODEL} text ${TOKENS})})`;
          if (!mounted) {
            // The first day there is: written as it is made, and that is what is mounted.
            ray.run(`(.db.splayed.set ${partition(day)} ${made} ${symbols})`);
            mount();
          } else {
            // A day that is over is written out before the next one begins, so memory holds one day's vectors and no more.
            if (Number.isFinite(lastDay) && day !== lastDay) persist();
            ray.run(`(insert '${TABLE} ${dayName(day)} ${made})`);
            dirty.add(day);
          }
          lastDay = day;
          count += part.length;
          from = to;
        }
        reached = rows[looked - 1]!.off;
        return looked;
      } catch (err) {
        failed('documents could not be embedded', err);
        return 0;
      }
    },
    near(question, limit, kinds) {
      if (broken || !mounted || count === 0 || question.trim() === '') return [];
      try {
        // The question and the kinds go over as columns, never as part of the statement.
        ray.bind(ASKED, { q: { type: 'str', data: [QUERY + question.replace(/\s+/g, ' ').trim()] } });
        const where = kinds === undefined ? '' : `where: (in kind (at ${ASKED}_kinds 'k)) `;
        if (kinds !== undefined) ray.bind(`${ASKED}_kinds`, { k: { type: 'sym', data: kinds } });
        const t = ray.table(
          `(select {from: ${TABLE} ${where}nearest: (.emb.knn vec (.emb.encode ${MODEL} (at (at ${ASKED} 'q) 0) ${TOKENS}) 'ip) take: ${Math.max(1, Math.floor(limit))} doc: doc kind: kind})`,
        );
        const docs = t.columns.doc as BigInt64Array | undefined ?? new BigInt64Array(0);
        const ks = t.columns.kind as string[] | undefined ?? [];
        return [...docs].map((doc, i) => ({ doc: Number(doc), kind: ks[i] as Kind }));
      } catch (err) {
        failed('a question could not be asked', err);
        return [];
      }
    },
  };
}
