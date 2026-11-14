import { fromOwner } from './owned';
import type { JournalEvent } from './journal';
import { FACT_KIND } from './known';
import { EPISODE_KIND, MERGE_KIND } from './remembered';
import { asText } from './stemnote';

// Recall is finding again what the journal holds: by words, with no model asked. Every event that
// says something is a document; its words are its terms; a question is answered by the documents
// that share the question's rarest words, weighed by who said them.
//
// Two things are particular to an agent's own past.
//   Most of what a journal holds, by volume, is the agent's own words and the output of its
//   tools. Left to count, they bury what it was told. So a document's kind has a weight: what the
//   owner said and what the agent chose to remember count for more than what it said itself.
//   Text here is in any language. Words are told apart by the letters of every script, and a word
//   is also indexed by its beginning, so that forms of one word (as Russian has many of) find
//   each other without a dictionary.
//
// Where the terms are kept is not decided here. `Index` is the question asked of whatever keeps
// them: the database (brain/store.ts) or, when there is none, the journal read through.

/** What kind of text a document is. It decides how much a match in it counts. */
export type Kind = 'owner' | 'heard' | 'memory' | 'reply' | 'did' | 'tool';

/** How much a match counts by the kind of its document. The agent's own words are the many and the least. */
export const KIND_WEIGHT: Record<Kind, number> = { memory: 1.3, owner: 1, heard: 0.9, tool: 0.6, did: 0.6, reply: 0.5 };

/** A word shorter than this says too little to look for. */
const WORD_MIN = 2;
/** A longer word is also indexed by this many of its first letters, marked so it cannot be taken for a word. */
const STEM_CHARS = 4;
const STEM_MARK = '~';
/** A match on a word's beginning counts for this share of a match on the word. */
const STEM_WEIGHT = 0.5;
/** The most text of one document that is read for terms, and the most terms it gives. A tool's output can be endless. */
const TEXT_CHARS = 8000;
const TERMS_MAX = 400;
/** How a term's count in a document turns into a weight (BM25). A fixed "usual length" keeps a weight the same for good once it is written. */
const K1 = 1.2;
const B = 0.75;
const USUAL_TERMS = 120;

/** The words of `text`, lower-cased: runs of letters and digits of any script. */
export function words(text: string): string[] {
  return (text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length >= WORD_MIN && word.length <= 64);
}

/** The terms a word is found by: itself and, when it is long enough, its beginning. */
function termsOf(word: string): [string] | [string, string] {
  const letters = [...word];
  return letters.length > STEM_CHARS ? [word, `${letters.slice(0, STEM_CHARS).join('')}${STEM_MARK}`] : [word];
}

/** The terms of a question, each once. */
export function queryTerms(text: string): string[] {
  return [...new Set(words(text).flatMap(termsOf))];
}

export interface Posting {
  term: string;
  /** How much this term says about its document: higher when the term is frequent in it and the document is short. */
  w: number;
}

/** The terms of a document with their weights: what is written into an index for it. */
export function postings(text: string): Posting[] {
  const counts = new Map<string, number>();
  const all = words(text.slice(0, TEXT_CHARS));
  for (const word of all) for (const term of termsOf(word)) counts.set(term, (counts.get(term) ?? 0) + 1);
  const length = all.length;
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TERMS_MAX)
    .map(([term, tf]) => ({
      term,
      w: ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * length) / USUAL_TERMS))) * (term.endsWith(STEM_MARK) ? STEM_WEIGHT : 1),
    }));
}

/** The text of an event that is worth finding again, and what kind it is; null for an event that says nothing. */
export function documentOf(e: JournalEvent): { kind: Kind; text: string } | null {
  const r = e as { text?: unknown; source?: unknown; output?: unknown; args?: unknown; kind?: unknown; data?: unknown };
  let found: { kind: Kind; text: string } | null = null;
  if (e.type === 'stimulus') found = { kind: fromOwner(r.source) ? 'owner' : 'heard', text: asText(r.text) };
  else if (e.type === 'assistant') found = { kind: 'reply', text: asText(r.text) };
  else if (e.type === 'tool.intent') found = { kind: 'did', text: asText(r.args) };
  else if (e.type === 'tool.result') found = { kind: 'tool', text: asText(r.output) };
  else if (e.type === 'note' && (r.kind === EPISODE_KIND || r.kind === MERGE_KIND) && typeof r.data === 'object' && r.data !== null) {
    const d = r.data as { title?: unknown; text?: unknown; outcome?: unknown };
    // A stretch in which nothing happened is not worth finding.
    if (d.outcome !== 'quiet') found = { kind: 'memory', text: `${asText(d.title)}\n${asText(d.text)}` };
  }
  // A fact is found like a memory: it is something the agent chose to keep.
  else if (e.type === 'note' && r.kind === FACT_KIND && typeof r.data === 'object' && r.data !== null) {
    found = { kind: 'memory', text: asText((r.data as { text?: unknown }).text) };
  }
  return found !== null && found.text.trim() !== '' ? found : null;
}

/** One term found in one document. `doc` is the byte at which the document's line begins in the journal: its name, and where to read it. */
export interface Match {
  term: string;
  doc: number;
  kind: Kind;
  w: number;
}

/** Whatever keeps the terms: asked which documents hold any of these, and how many documents there are in all. */
export interface Index {
  matches(terms: string[]): Match[];
  documents(): number;
}

export interface Hit {
  doc: number;
  kind: Kind;
  score: number;
  /** The question's terms this document holds. */
  terms: string[];
}

export interface RecallOptions {
  /** Only documents of these kinds. */
  kinds?: Kind[];
  limit?: number;
}

/**
 * The documents that answer `question` best, the best first. A term counts the more the fewer
 * documents hold it, so the words that tell one day from another decide, not the ones that are
 * everywhere. Documents that tie are given the later one first.
 */
export function recall(index: Index, question: string, options: RecallOptions = {}): Hit[] {
  const terms = queryTerms(question);
  if (terms.length === 0) return [];
  const found = index.matches(terms);
  const total = Math.max(1, index.documents());
  const holders = new Map<string, Set<number>>();
  for (const m of found) {
    if (!holders.has(m.term)) holders.set(m.term, new Set());
    holders.get(m.term)!.add(m.doc);
  }
  const rarity = (term: string): number => {
    const n = holders.get(term)?.size ?? 0;
    return Math.log(1 + (total - n + 0.5) / (n + 0.5));
  };
  const hits = new Map<number, Hit>();
  for (const m of found) {
    if (options.kinds !== undefined && !options.kinds.includes(m.kind)) continue;
    let hit = hits.get(m.doc);
    if (hit === undefined) hits.set(m.doc, hit = { doc: m.doc, kind: m.kind, score: 0, terms: [] });
    hit.score += m.w * rarity(m.term) * (KIND_WEIGHT[m.kind] ?? KIND_WEIGHT.reply);
    hit.terms.push(m.term);
  }
  return [...hits.values()].sort((a, b) => b.score - a.score || b.doc - a.doc).slice(0, options.limit ?? 10);
}

/**
 * An index that keeps nothing: the lines it is given are read through for every question. It is
 * what recall falls back on when there is no database, and what the database's answers are
 * checked against.
 */
export function scanIndex(lines: () => { event: JournalEvent; off: number }[]): Index {
  let read: { doc: number; kind: Kind; terms: Map<string, number> }[] | null = null;
  let seen = -1;
  const load = (): NonNullable<typeof read> => {
    const now = lines();
    // Read again only when the journal has grown.
    if (read === null || now.length !== seen) {
      seen = now.length;
      read = [];
      for (const { event, off } of now) {
        const document = documentOf(event);
        if (document !== null) read.push({ doc: off, kind: document.kind, terms: new Map(postings(document.text).map((p) => [p.term, p.w])) });
      }
    }
    return read;
  };
  return {
    documents: () => load().length,
    matches(terms) {
      const out: Match[] = [];
      for (const d of load()) for (const term of terms) {
        const w = d.terms.get(term);
        if (w !== undefined) out.push({ term, doc: d.doc, kind: d.kind, w });
      }
      return out;
    },
  };
}
