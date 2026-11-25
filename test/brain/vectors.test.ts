import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { JournalEvent } from '../../brain/journal';
import { projections, storePast, type Past } from '../../brain/past';
import { fused, FUSE_K } from '../../brain/recall';
import { EPISODE_KIND } from '../../brain/remembered';
import { openStore } from '../../brain/store';
import { modelDir, openVectors, passage, PORTION, TEXT_MAX, vectorsDir } from '../../brain/vectors';
import { library, ray } from './rayforce';

// The model these tests open is test/brain/embed-tiny: an encoder of two layers and eight
// dimensions with a vocabulary of sixteen tokens. It means nothing; it is a model in form, small
// enough to lie in the repository, and what is tested with it is how vectors are kept and asked,
// not what they find. What they find is measured on a real journal with a real model.

/**
 * Whether the library here can do what brain/vectors.ts asks of it: embed text, keep the vectors in a
 * table partitioned by day, and answer a question over that table with `nearest:`. Asked by doing
 * it once, with one document: a build can have the first of these and not the last, and a test
 * that then ran would fail for the build's sake, not the code's.
 */
const capable = library !== null && (() => {
  try {
    const journal = join(mkdtempSync(join(tmpdir(), 'teneral-vectors-probe-')), 'memory', 'journal.jsonl');
    mkdirSync(dirname(journal), { recursive: true });
    cpSync(join(import.meta.dir, 'embed-tiny'), modelDir(journal), { recursive: true });
    const complaints: string[] = [];
    const one = { off: 0, day: 9587, event: { v: 1, id: 'probe', ts: '', gen: 'g', type: 'stimulus', source: 'terminal', text: 'hello world' } as JournalEvent };
    const vectors = openVectors(ray(), journal, (off) => (off < 0 ? [one] : []), (line) => complaints.push(line));
    if (vectors === null || vectors.step() !== 1) return false;
    vectors.persist();
    return vectors.near('hello', 1).length === 1 && complaints.length === 0;
  } catch {
    return false;
  }
})();

let n = 0;
const ev = (body: Record<string, unknown>, day = 1): JournalEvent =>
  ({ v: 1, id: `v${++n}`, ts: new Date(Date.parse(`2026-04-0${day}T00:00:00.000Z`) + n * 1000).toISOString(), gen: 'g1', ...body }) as JournalEvent;
const said = (text: string, day = 1): JournalEvent => ev({ type: 'stimulus', source: 'terminal', text }, day);
const answered = (day = 1): JournalEvent => ev({ type: 'assistant', text: 'hello', toolCalls: [] }, day);

function life(events: JournalEvent[], withModel = true): string {
  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-vectors-')), 'memory', 'journal.jsonl');
  mkdirSync(dirname(journal), { recursive: true });
  writeFileSync(journal, events.map((one) => `${JSON.stringify(one)}\n`).join(''));
  if (withModel) cpSync(join(import.meta.dir, 'embed-tiny'), modelDir(journal), { recursive: true });
  return journal;
}
const served = (journal: string, log: (line: string) => void = () => {}): Past => storePast(journal, ray(), openStore(ray(), journal, undefined, projections()), false, log);

test('two rankings are made one by the places a document has in them', () => {
  // Found by both comes first; then by the place in the one ranking that has it.
  expect(fused([10, 20, 30], [20, 40]).map((one) => one.doc)).toEqual([20, 10, 40, 30]);
  // Of two at the same place, each in one ranking, the later document.
  expect(fused([10], [40]).map((one) => one.doc)).toEqual([40, 10]);
  expect(fused([10, 20, 30], [20, 40])[0]!.score).toBeCloseTo(1 / (FUSE_K + 1) + 1 / FUSE_K, 12);
  expect(fused([], [])).toEqual([]);
  expect(fused([7], []).map((one) => one.doc)).toEqual([7]);
});

test('a document is given to the model as one line, cut, behind the word it was trained to see', () => {
  expect(passage('  two\n lines  ')).toBe('passage: two lines');
  expect(passage('x'.repeat(5000)).length).toBe('passage: '.length + TEXT_MAX);
  expect(passage('')).toBe('passage: ');
});

test('without a model beside the journal there are no vectors', () => {
  const journal = life([said('hello world')], false);
  expect(openVectors({ run() { throw new Error('nothing is asked of the database'); } } as never, journal, () => [])).toBeNull();
});

test('a database that cannot open the model is said so once, and there are no vectors', () => {
  const journal = life([said('hello world')]);
  const logs: string[] = [];
  expect(openVectors({ run() { throw new Error('rayforce: name: .emb.model.get'); } } as never, journal, () => [], (line) => logs.push(line))).toBeNull();
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain('no vectors');
});

test.skipIf(!capable)('the database embeds the documents a portion at a time, by day, and keeps them on disk', { timeout: 60_000 }, () => {
  // Three days, more documents than a portion holds, and events that are no documents among them.
  const events: JournalEvent[] = [];
  for (let i = 0; i < PORTION + 9; i++) events.push(said(i % 2 === 0 ? 'hello world' : 'a cat', 1), ev({ type: 'note', kind: 'body.clock.v1', data: {} }, 1));
  for (let i = 0; i < 5; i++) events.push(said('a cat, hello!', 2), answered(2));
  events.push(said('hello', 3));
  const documents = PORTION + 9 + 10 + 1;
  const journal = life(events);
  const past = served(journal);
  expect(past.by).toBe('store');
  // A little at a time: one call with no time to spare does one portion, and says how far it has come.
  expect(past.embed(0)).toBe(PORTION);
  let covered = 0;
  for (let i = 0; i < 20 && covered < documents; i++) covered = past.embed(0);
  expect(covered).toBe(documents);
  expect(past.embed(0)).toBe(documents);
  past.persist();
  // Each day lies on disk as a table of its own, beside the store.
  const t = ray().table(`(select {from: (.db.parted.get "${vectorsDir(journal)}/" 'vectors) by: date n: (count doc)})`);
  expect([...(t.columns.n as BigInt64Array)].map(Number)).toEqual([PORTION + 9, 10, 1]);
  past.close();
  // Opened again, nothing is embedded twice.
  const again = served(journal);
  expect(again.embed(0)).toBe(documents);
  again.close();
});

test.skipIf(!capable)('what shares no word with a question is found by its meaning, among what may be found at all', { timeout: 60_000 }, () => {
  const s = [said('a cat'), answered()];
  const kept = ev({ type: 'note', kind: EPISODE_KIND, data: { from: s[0]!.id, to: s[1]!.id, start: s[0]!.ts, end: s[1]!.ts, title: 'a cat', text: 'a cat, a cat', outcome: 'done' } });
  const journal = life([...s, kept, said('a cat, a cat!'), answered()]);
  const past = served(journal);
  // Before anything is embedded, and whenever only words are asked for, nothing is found: no word is shared.
  expect(past.find('world')).toEqual([]);
  expect(past.embed(0)).toBe(5);
  expect(past.find('world', { words: true })).toEqual([]);
  const found = past.find('world', { limit: 10 });
  expect(found.map((hit) => hit.event.id).sort()).toEqual([s[0]!.id, s[1]!.id, kept.id, 'v' + (Number(kept.id.slice(1)) + 1), 'v' + (Number(kept.id.slice(1)) + 2)].sort());
  // Found by meaning alone, a document holds none of the question's words, and comes with its event like any other.
  expect(found.every((hit) => hit.terms.length === 0 && hit.cover === 0 && hit.score > 0)).toBe(true);
  // The best first.
  expect(found.map((hit) => hit.score)).toEqual([...found.map((hit) => hit.score)].sort((a, b) => b - a));
  // Only the kinds asked for.
  expect(past.find('world', { kinds: ['memory'] }).map((hit) => hit.event.id)).toEqual([kept.id]);
  expect(past.find('world', { kinds: ['owner'] }).map((hit) => hit.kind)).toEqual(['owner', 'owner']);
  // A document that shares words with the question and is near it too comes before one that is only near.
  const cats = past.find('cat', { limit: 10 });
  expect(cats.length).toBe(5);
  expect(cats[0]!.terms).toContain('cat');
  expect(cats.at(-1)!.terms).toEqual([]);
  // The questions of the exam are found among themselves by their words, as they were.
  expect(past.find('world', { kinds: ['key'] })).toEqual([]);
  past.close();
});
