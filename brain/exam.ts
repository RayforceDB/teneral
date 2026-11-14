import { existsSync, readFileSync } from 'node:fs';
import type { JournalEvent } from './journal';
import { journalPast, openPast, type Past } from './past';
import { libraryAt } from './ray';
import { documentOf, words } from './recall';
import { scan } from './store';

// The exam is how a memory is measured. A question comes with the events that answer it, and the
// memory passes it when it finds one of them among the first few. The same questions are put to
// the plainest thing that could work: looking for the question's words as they stand, anywhere in
// the journal. A way of remembering that does not beat that on the agent's own life is not worth
// its code, and a change to memory that scores lower than what it replaces is a step back, however
// good its reasons. Without this, the memory has nothing to evolve against.
//
//   bun brain/exam.ts [journal] [questions.jsonl]
//
// Questions are lines of JSON, `{ "question": "...", "events": ["<event id>", ...] }`, and notes
// of kind `memory.exam.v1` with the same data in the journal itself. With none of either, the
// agent's own life is turned into questions: see `cloze`.

export const EXAM_KIND = 'memory.exam.v1';
/** A question is passed when an answering event is among this many finds. */
export const TOP = 5;

export interface Question {
  question: string;
  /** Ids of the events any of which answers it. */
  events: string[];
}

export interface Score {
  questions: number;
  /** How many were passed: an answering event among the first TOP finds. */
  passed: number;
  /** The mean of 1/rank of the first answering event, 0 when there was none: how near the top the answers are. */
  nearness: number;
}

/** Whatever answers a question with event ids, the best first. */
export type Finder = (question: string, limit: number) => string[];

/** Puts `questions` to `find` and counts. */
export function examine(find: Finder, questions: Question[]): Score {
  let passed = 0;
  let nearness = 0;
  for (const q of questions) {
    const rank = find(q.question, TOP).findIndex((id) => q.events.includes(id));
    if (rank !== -1) {
      passed += 1;
      nearness += 1 / (rank + 1);
    }
  }
  return { questions: questions.length, passed, nearness: questions.length === 0 ? 0 : nearness / questions.length };
}

/** A memory as a finder: what `recall` would return, with what the agent is answering right now left in, since an exam is not a turn. */
export const byMemory = (past: Past): Finder => (question, limit) => past.find(question, { limit }).map((hit) => hit.event.id);

/**
 * The plainest finder: an event scores by how many of the question's words it holds as they
 * stand, later events first among equals. No weights, no forms of words, no rarity.
 */
export function bySubstring(events: JournalEvent[]): Finder {
  const texts = events.flatMap((event) => {
    const document = documentOf(event);
    return document === null ? [] : [{ id: event.id, text: document.text.toLowerCase() }];
  });
  return (question, limit) => {
    const asked = [...new Set(words(question))];
    return texts
      .map(({ id, text }, at) => ({ id, at, held: asked.reduce((n, word) => n + (text.includes(word) ? 1 : 0), 0) }))
      .filter((scored) => scored.held > 0)
      .sort((a, b) => b.held - a.held || b.at - a.at)
      .slice(0, limit)
      .map((scored) => scored.id);
  };
}

/** The questions a journal holds as notes, and those of a file of JSON lines. Lines and notes that are not questions are passed over. */
export function questionsOf(events: JournalEvent[], file?: string): Question[] {
  const out: Question[] = [];
  const take = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return;
    const q = value as { question?: unknown; events?: unknown };
    if (typeof q.question === 'string' && q.question.trim() !== '' && Array.isArray(q.events) && q.events.length > 0 && q.events.every((id) => typeof id === 'string')) {
      out.push({ question: q.question, events: q.events as string[] });
    }
  };
  for (const e of events) if (e.type === 'note' && e.kind === EXAM_KIND) take(e.data);
  if (file !== undefined && existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      try {
        take(JSON.parse(line));
      } catch {
        // Not a line of JSON.
      }
    }
  }
  return out;
}

/** The fewest words something said must have to be asked about, and how many of them make the question. */
const CLOZE_WORDS = 6;
const CLOZE_ASKED = 3;

/**
 * Questions made from the journal itself, for a journal nobody has written questions for: of each
 * thing the owner said that is long enough, the few words that are rarest in the whole journal,
 * with that event as the answer. It asks only whether what was said can be found by its own
 * telling words, which every finder should manage; it says nothing of questions put in other
 * words than the answer's. Those have to be written by someone who read the journal.
 */
export function cloze(events: JournalEvent[], most = 200): Question[] {
  const said = events.flatMap((event) => {
    const document = documentOf(event);
    return document === null ? [] : [{ event, kind: document.kind, words: [...new Set(words(document.text))] }];
  });
  const holders = new Map<string, number>();
  for (const d of said) for (const word of d.words) holders.set(word, (holders.get(word) ?? 0) + 1);
  const asked = said.filter((d) => d.kind === 'owner' && d.words.length >= CLOZE_WORDS);
  // Spread over the whole life, not its first days.
  const every = Math.max(1, Math.ceil(asked.length / most));
  return asked.filter((_, i) => i % every === 0).map((d) => ({
    question: [...d.words].sort((a, b) => holders.get(a)! - holders.get(b)! || a.localeCompare(b)).slice(0, CLOZE_ASKED).join(' '),
    events: [d.event.id],
  }));
}

const percent = (score: Score): string => (score.questions === 0 ? '-' : `${Math.round((score.passed / score.questions) * 100)}%`);

/** The exam's result as lines of plain text. */
export function report(memory: Score, plain: Score, by: Past['by'], made: boolean): string[] {
  const row = (name: string, s: Score): string => `${name.padEnd(28)}${String(s.passed).padStart(5)} of ${String(s.questions).padEnd(5)} ${percent(s).padStart(5)}   ${s.nearness.toFixed(3)}`;
  return [
    `${memory.questions} questions${made ? ', made from what the owner said (see `cloze` in brain/exam.ts)' : ''}. Passed: an answering event among the first ${TOP} finds.`,
    `${''.padEnd(28)}${'passed'.padStart(14)} ${''.padStart(5)}   nearness`,
    row(`recall (asked of the ${by})`, memory),
    row('the words as they stand', plain),
  ];
}

if (import.meta.main) {
  const journal = process.argv[2] ?? process.env.TENERAL_JOURNAL ?? '';
  if (journal === '' || !existsSync(journal)) {
    console.error('usage: bun brain/exam.ts [journal] [questions.jsonl]   (the journal defaults to TENERAL_JOURNAL)');
    process.exit(2);
  }
  const events = scan(journal, 0).lines.map((line) => line.event);
  const written = questionsOf(events, process.argv[3]);
  const questions = written.length > 0 ? written : cloze(events);
  const organs = process.env.TENERAL_ORGANS ?? '';
  // An exam must not change the agent's store while the agent runs: it asks the journal unless told to use the database.
  const past = process.env.TENERAL_EXAM_STORE === '1' && organs !== '' ? openPast(journal, libraryAt(organs)) : journalPast(journal);
  for (const line of report(examine(byMemory(past), questions), examine(bySubstring(events), questions), past.by, written.length === 0)) console.log(line);
  past.close();
}
