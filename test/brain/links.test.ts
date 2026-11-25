import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventBody, JournalEvent } from '../../brain/journal';
import { FACT_KIND } from '../../brain/known';
import { LINK_NOTES, OUTDATED_KIND, links, outdatedStretches, tiesOf } from '../../brain/links';
import { WITHDRAW_KIND } from '../../brain/owned';
import { buildMessages } from '../../brain/memory';
import { journalPast, projections, sinceLines, storePast } from '../../brain/past';
import { EPISODE_KIND, MERGE_KIND } from '../../brain/remembered';
import { openStore } from '../../brain/store';
import { library, ray } from './rayforce';

const real = test.skipIf(library === null);

let n = 0;
const ev = (ts: string, body: EventBody): JournalEvent => ({ v: 1, id: `ln${++n}`, ts, gen: 'g1', ...body }) as JournalEvent;
const day = (d: number, minute = 0): string => `2026-11-${String(d).padStart(2, '0')}T10:${String(minute).padStart(2, '0')}:00.000Z`;
const note = (ts: string, kind: string, data: Record<string, unknown>) => ev(ts, { type: 'note', kind, data });

/** A stretch of two events on day `d`, and the memory of it. */
function stretch(d: number, title: string): { events: JournalEvent[]; from: string; memory: JournalEvent } {
  const asked = ev(day(d), { type: 'stimulus', source: 'terminal', text: `what about ${title}` });
  const answered = ev(day(d, 1), { type: 'assistant', text: `${title} is settled`, toolCalls: [] });
  const memory = note(day(d, 2), EPISODE_KIND, { from: asked.id, to: answered.id, start: asked.ts, end: answered.ts, title, text: `I settled ${title}.`, outcome: 'done' });
  return { events: [asked, answered, memory], from: asked.id, memory };
}
const outdates = (d: number, old: string, by: string, why: string) => note(day(d, 5), OUTDATED_KIND, { memory: old, by, why });

test('a memory that a later one made outdated is tied to it, with what was said of it', () => {
  const a = stretch(1, 'the release plan'), b = stretch(2, 'the new release plan');
  const tie = outdates(2, a.from, b.from, 'the release was moved to December');
  const all = links([...a.events, ...b.events, tie]);
  expect(all).toEqual([{ from: b.memory.id, to: a.memory.id, kind: 'outdates', why: 'the release was moved to December' }]);
  expect(tiesOf(all).since(a.memory.id)).toEqual({ direct: [{ id: b.memory.id, why: 'the release was moved to December' }], latest: [b.memory.id] });
  expect(tiesOf(all).since(b.memory.id)).toBeNull();
});

test('only what came later outdates: a tie from an earlier stretch to a later one ties nothing', () => {
  const a = stretch(1, 'one'), b = stretch(2, 'two');
  expect(links([...a.events, ...b.events, outdates(2, b.from, a.from, 'backwards')])).toEqual([]);
  expect(links([...a.events, outdates(2, a.from, a.from, 'itself')])).toEqual([]);
  expect(links([...a.events, outdates(2, a.from, 'nothing', 'no such stretch')])).toEqual([]);
});

test('a line of outdating is followed to what stands at its end', () => {
  const a = stretch(1, 'first'), b = stretch(2, 'second'), c = stretch(3, 'third');
  const events = [...a.events, ...b.events, outdates(2, a.from, b.from, 'changed once'), ...c.events, outdates(3, b.from, c.from, 'changed again')];
  const ties = tiesOf(links(events));
  expect(ties.since(a.memory.id)).toEqual({ direct: [{ id: b.memory.id, why: 'changed once' }], latest: [c.memory.id] });
  expect(outdatedStretches(events)).toEqual(new Map([[a.from, { why: 'changed once', since: day(2) }], [b.from, { why: 'changed again', since: day(3) }]]));
});

test('what the owner withdrew ties nothing: the tie itself, or the memory that made another outdated', () => {
  const a = stretch(1, 'old'), b = stretch(2, 'new');
  const tie = outdates(2, a.from, b.from, 'no longer so');
  const events = [...a.events, ...b.events, tie];
  expect(links([...events, note(day(3), WITHDRAW_KIND, { ids: [tie.id] })])).toEqual([]);
  expect(links([...events, note(day(3), WITHDRAW_KIND, { ids: [b.memory.id] })])).toEqual([]);
});

test('a memory formed again after it was withdrawn is tied as the one that stands now', () => {
  const a = stretch(1, 'old'), b = stretch(2, 'new');
  const again = note(day(4), EPISODE_KIND, { ...(a.memory as { data: Record<string, unknown> }).data, text: 'I settled it, told better.' });
  const events = [...a.events, ...b.events, outdates(2, a.from, b.from, 'no longer so'), note(day(3), WITHDRAW_KIND, { ids: [a.memory.id] }), again];
  expect(links(events).map((link) => link.to)).toEqual([again.id]);
});

test('a fact is tied to the fact it replaced, and a wider memory to the memories it stands for', () => {
  const a = stretch(1, 'one'), b = stretch(2, 'two'), c = stretch(3, 'three');
  const f1 = note(day(1, 3), FACT_KIND, { text: 'The office is in Lisbon.', source: 'owner', episode: a.from });
  const f2 = note(day(3, 3), FACT_KIND, { text: 'The office is in Porto.', source: 'owner', episode: c.from, replaces: [f1.id] });
  const wide = note(day(3, 4), MERGE_KIND, { from: a.from, to: (b.memory as { data: { to: string } }).data.to, start: day(1), end: day(2, 1), title: 'Two days', text: 'One, then two.', outcome: 'done', level: 2 });
  const events = [...a.events, f1, ...b.events, ...c.events, f2, wide, outdates(3, a.from, c.from, 'three undid one')];
  const ties = tiesOf(links(events));
  expect(ties.since(f1.id)).toEqual({ direct: [{ id: f2.id, why: '' }], latest: [f2.id] });
  // The wider memory is outdated by nothing itself; one of the two it stands for is.
  expect(ties.since(wide.id)).toEqual({ direct: [], latest: [], parts: { outdated: 1, of: 2 } });
  expect(ties.since(b.memory.id)).toBeNull();
});

test('the ties are made from notes alone: the same from the whole journal and from its notes of those kinds', () => {
  const a = stretch(1, 'one'), b = stretch(2, 'two');
  const events = [...a.events, ...b.events, outdates(2, a.from, b.from, 'moved')];
  const kinds: readonly string[] = LINK_NOTES;
  expect(links(events.filter((e) => e.type === 'note' && kinds.includes(e.kind)))).toEqual(links(events));
});

/** A journal with lines of outdating of several lengths, facts that replace facts, a wider memory and a withdrawal. */
function tangled(): JournalEvent[] {
  const parts = Array.from({ length: 9 }, (_, i) => stretch(i + 1, `matter ${i + 1}`));
  const events = parts.flatMap((part) => part.events);
  const facts = [1, 2, 3].map((i) => note(day(i, 3), FACT_KIND, { text: `The count is ${i} of them.`, source: 'seen', episode: parts[i]!.from }));
  facts.push(note(day(5, 3), FACT_KIND, { text: 'The count is five of them.', source: 'seen', episode: parts[5]!.from, replaces: [facts[0]!.id, facts[1]!.id] }));
  const to = (part: { memory: JournalEvent }): string => (part.memory as { data: { to: string } }).data.to;
  const wide = note(day(9, 6), MERGE_KIND, { from: parts[0]!.from, to: to(parts[3]!), start: day(1), end: day(4, 1), title: 'The first four', text: 'Four matters.', outcome: 'done', level: 2 });
  const ties = [[0, 2, 'a'], [2, 4, 'b'], [4, 8, 'c'], [1, 8, 'd'], [0, 5, 'e'], [6, 7, 'f']].map(([old, by, why]) => outdates(9, parts[old as number]!.from, parts[by as number]!.from, `reason ${why}`));
  return [...events, ...facts, wide, ...ties, note(day(9, 9), WITHDRAW_KIND, { ids: [ties[5]!.id] })];
}

real('the database walks the same ties to the same answers as the journal read through', { timeout: 20_000 }, () => {
  // Keep the ordering of the ten stretches, but share a storage partition: this
  // tests graph traversal and late writes, not the cost of creating daily shards.
  const oneDay = (e: JournalEvent): JournalEvent => ({ ...e, ts: e.ts.replace(/2026-11-(\d\d)T10:/, "2026-11-01T$1:") });
  const events = tangled().map(oneDay);
  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-links-')), 'journal.jsonl');
  writeFileSync(journal, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  const read = journalPast(journal);
  const store = openStore(ray(), journal, undefined, projections());
  const served = storePast(journal, ray(), store, false);
  let tied = 0;
  for (const e of events) {
    const expected = read.since(e.id);
    expect(served.since(e.id)).toEqual(expected);
    if (expected !== null) tied += 1;
  }
  // Four memories are outdated (a fifth tie was withdrawn), two facts were replaced, one wider memory holds outdated parts.
  expect(tied).toBe(4 + 2 + 1);

  // A tie written later is seen by both without anything being opened again.
  const late = oneDay(outdates(10, events[21]!.id, events[24]!.id, 'reason late'));
  writeFileSync(journal, [...events, late].map((e) => `${JSON.stringify(e)}\n`).join(''));
  expect(served.since(events[23]!.id)).toEqual(read.since(events[23]!.id));
  expect(served.since(events[23]!.id)?.direct.map((one) => one.why)).toEqual(['reason late']);
});

test('a memory that was made outdated says so where a request shows it, and where recall finds it', () => {
  const a = stretch(1, 'the release plan'), b = stretch(2, 'the moved release');
  const tie = outdates(2, a.from, b.from, 'the release is in December now');
  const now = ev(day(3), { type: 'stimulus', source: 'terminal', text: 'when is the release?' });
  const events = [...a.events, ...b.events, tie, now];

  const request = buildMessages(events, 'SYS', 100_000, undefined, { tailChars: 0 }).map((m) => m.content ?? '');
  const told = request.find((text) => text.startsWith('[memory] 2026-11-01'))!;
  expect(told).toContain('Something in it no longer holds since 2026-11-02 10:00 UTC, as you said then: the release is in December now.');
  // The later memory is outdated by nothing and says nothing of the kind.
  expect(request.filter((text) => text.includes('no longer holds'))).toEqual([told]);

  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-links-')), 'journal.jsonl');
  writeFileSync(journal, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  const past = journalPast(journal);
  expect(sinceLines(past, a.memory)).toEqual([
    `[outdated since 2026-11-02 10:00 UTC: the release is in December now (your memory "the moved release", of the stretch that begins at event ${b.from})]`,
  ]);
  expect(sinceLines(past, b.memory)).toEqual([]);
  expect(sinceLines(past, now)).toEqual([]);
});
