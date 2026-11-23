import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GAP_MS, episodes } from '../../brain/episodes';
import type { EventBody, JournalEvent } from '../../brain/journal';
import { episodesFrom, memoryProjection, rememberedFrom } from '../../brain/memory-table';
import { counted } from '../../brain/memory';
import { standing } from '../../brain/owned';
import { journalPast, storePast } from '../../brain/past';
import { remembered, type Remembered } from '../../brain/remembered';
import { openStore } from '../../brain/store';
import { library, ray } from './rayforce';

const real = test.skipIf(library === null);

let n = 0;
let clock = Date.parse('2026-11-11T00:00:00.000Z');
function ev(body: EventBody, afterMs = 60_000): JournalEvent {
  clock += afterMs;
  return { v: 1, id: `mt${(++n).toString(36).padStart(5, '0')}`, ts: new Date(clock).toISOString(), gen: 'g1', ...body } as JournalEvent;
}
const LONG = GAP_MS + 1000;
const said = (text: string, afterMs?: number) => ev({ type: 'stimulus', source: 'terminal', text }, afterMs);
const replied = (text: string) => ev({ type: 'assistant', text, toolCalls: [] });
const note = (kind: string, data: Record<string, unknown>) => ev({ type: 'note', kind, data }, 1000);
const memoryOf = (first: JournalEvent, last: JournalEvent, title: string) =>
  note('memory.episode.v1', { from: first.id, to: last.id, start: first.ts, end: last.ts, title, text: `I remember ${title}.`, outcome: 'done' });
const line = (e: JournalEvent): string => `${JSON.stringify(e)}\n`;

/** A life of seven stretches: remembered in order, one given up on and remembered later, one withdrawn and formed again, a wider memory, one recorded out of turn, and one taken back. */
function life(): JournalEvent[] {
  const s = Array.from({ length: 7 }, (_, i) => [said(`matter ${i} ${'m'.repeat(40)}`, LONG), replied(`settled matter ${i}`)] as const);
  const m0 = memoryOf(s[0]![0], s[0]![1], 'matter 0');
  const q1 = note('memory.quarantine.v1', { from: s[1]![0].id, to: s[1]![1].id, start: s[1]![0].ts, end: s[1]![1].ts, reason: 'the form was wrong' });
  const m1 = memoryOf(s[1]![0], s[1]![1], 'matter 1');
  const m2 = memoryOf(s[2]![0], s[2]![1], 'matter 2');
  // Recorded before the stretch in front of it was: it is not next in line, and is passed over for good.
  const m4early = memoryOf(s[4]![0], s[4]![1], 'matter 4, too early');
  const m3 = memoryOf(s[3]![0], s[3]![1], 'matter 3');
  const wide = note('memory.merge.v1', { from: s[0]![0].id, to: s[1]![1].id, start: s[0]![0].ts, end: s[1]![1].ts, title: 'The first two', text: 'Matters 0 and 1.', outcome: 'done', level: 2 });
  const gone = note('memory.withdraw.v1', { ids: [m2.id] });
  const m2again = memoryOf(s[2]![0], s[2]![1], 'matter 2, told again');
  return [
    ...s[0]!, ...s[1]!, m0, q1, ...s[2]!, m1, m2, ...s[3]!, ...s[4]!, m4early, m3, wide, gone, m2again,
    ...s[5]!, note('memory.back.v1', { to: s[5]![0].id }), ...s[6]!, said('and now?', LONG),
  ];
}

const flat = (r: Remembered) => ({ memories: [...r.memories.entries()], quarantined: [...r.quarantined.entries()], spans: r.spans, merges: r.merges });
const bare = <T extends { fromSeq: number; toSeq: number }>(e: T) => { const { fromSeq: _a, toSeq: _b, ...rest } = e; return rest; };

test('what the tables are made of, fed event by event, comes to what the whole journal gives', () => {
  const all = life();
  for (const upTo of [4, 9, 12, 17, 21, 23, all.length]) {
    // As the store hands them over: every event with its number, without what was said in a stretch taken back.
    const events = all.slice(0, upTo);
    const stands = new Set(standing(events));
    const projection = memoryProjection();
    events.forEach((e, seq) => { if (stands.has(e)) projection.step(e, seq); });
    const tables = projection.tables();
    const cut = episodes(standing(events), remembered(standing(events)).spans);
    expect(tables.episodes!.first!.data).toEqual(cut.map((e) => e.first));
    expect(tables.episodes!.why!.data).toEqual(cut.map((e) => e.why));
    expect([...(tables.episodes!.to!.data as BigInt64Array)].map(Number)).toEqual(cut.map((e) => e.to));
  }
  const whole = episodes(standing(all), remembered(standing(all)).spans);
  // A stretch is kept only when it begins exactly where the remembered part ends. The notes written after the first two lie
  // between them and the third, so the third and every later one is not next in line: recorded, but cut by the rules.
  expect(whole.filter((e) => e.why === 'kept')).toHaveLength(2);
  expect(remembered(all).spans).toHaveLength(5);
});

function same(journal: string, events: JournalEvent[], upTo: number): void {
  const stands = standing(events.slice(0, upTo));
  const told = remembered(stands);
  expect(flat(rememberedFrom(ray()))).toEqual(flat(told));
  const placed = episodesFrom(ray());
  expect(placed.map(bare)).toEqual(counted(stands, episodes(stands, told.spans)));
  // The numbers name the same events in the journal as it lies: its lines, counted from the first.
  const all = events.slice(0, upTo);
  for (const e of placed) {
    expect(all[e.fromSeq]!.id).toBe(e.first);
    expect(all[e.toSeq - 1]!.id).toBe(e.last);
  }
  const read = journalPast(journal);
  expect(read.episodes()).toEqual(placed);
  expect(flat(read.remembered())).toEqual(flat(told));
}

real('the tables of the database hold the episodes and what is remembered, as the whole journal gives them', () => {
  const events = life();
  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-memory-')), 'journal.jsonl');
  writeFileSync(journal, events.slice(0, 6).map(line).join(''));
  const store = openStore(ray(), journal, undefined, [memoryProjection()]);
  same(journal, events, 6);
  let had = 6;
  // One event at a time across everything that happens: each memory, the giving up, the withdrawal, the taking back.
  for (let upTo = 7; upTo <= events.length; upTo++) {
    appendFileSync(journal, events.slice(had, upTo).map(line).join(''));
    had = upTo;
    store.sync();
    store.settle();
    same(journal, events, upTo);
  }
  store.persist();
  // Written out and opened again: read back, not made again.
  const again = memoryProjection();
  let stepped = 0;
  openStore(ray(), journal, undefined, [{ ...again, step: (e, seq) => { stepped += 1; return again.step(e, seq); } }]);
  same(journal, events, events.length);
  expect(stepped).toBe(0);
  // The same through the past a body has.
  const served = storePast(journal, ray(), openStore(ray(), journal, undefined, [memoryProjection()]), false);
  expect(served.episodes()).toEqual(journalPast(journal).episodes());
}, 60_000);
