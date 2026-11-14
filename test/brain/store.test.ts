import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventBody, JournalEvent } from '../../brain/journal';
import { fromRayNs } from '../../brain/ray';
import { STORE_VERSION, openStore, scan, storeDir } from '../../brain/store';
import { library, ray } from './rayforce';

const real = test.skipIf(library === null);

let n = 0;
const ev = (ts: string, body: EventBody): JournalEvent => ({ v: 1, id: `st${++n}`, ts, gen: 'g1', ...body }) as JournalEvent;
const said = (ts: string, text: string, source = 'terminal') => ev(ts, { type: 'stimulus', source, text });
const replied = (ts: string, text: string) => ev(ts, { type: 'assistant', text, toolCalls: [] });
const line = (e: unknown): string => `${JSON.stringify(e)}\n`;
/** A journal on disk holding `events`, in a directory of its own. */
function journalOf(events: JournalEvent[]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'teneral-store-')), 'journal.jsonl');
  writeFileSync(path, events.map(line).join(''));
  return path;
}
const twoDays = () => [
  said('2026-11-13T10:00:00.000Z', 'привет'), replied('2026-11-13T10:00:05.000Z', 'здравствуй'),
  said('2026-11-14T09:00:00.000Z', 'tick', 'clock'), replied('2026-11-14T09:00:02.500Z', 'nothing to do'),
];

test('the store of a journal lies beside it, in a directory named by the version of its layout', () => {
  expect(storeDir('/a/memory/journal.jsonl')).toBe(`/a/memory/store-v${STORE_VERSION}`);
});

test('a journal is read as lines with their places in the file', () => {
  const events = twoDays();
  const path = journalOf(events);
  const bytes = readFileSync(path);
  const { lines, end } = scan(path, 0);
  expect(lines.map((l) => l.event.id)).toEqual(events.map((e) => e.id));
  expect(end).toBe(bytes.length);
  // Each place is exactly its line: cut out of the file, it parses as that event, also with letters of more than one byte.
  for (const l of lines) expect(JSON.parse(bytes.toString('utf8', l.off, l.next)).id).toBe(l.event.id);
  expect(lines[0]!.off).toBe(0);
  expect(lines[1]!.off).toBe(lines[0]!.next);
});

test('reading goes on from where it stopped, and a last line still being written is left for the next time', () => {
  const [a, b, c] = twoDays();
  const path = journalOf([a!]);
  const first = scan(path, 0);
  appendFileSync(path, line(b) + JSON.stringify(c).slice(0, 20));
  const second = scan(path, first.end);
  expect(second.lines.map((l) => l.event.id)).toEqual([b!.id]);
  appendFileSync(path, `${JSON.stringify(c).slice(20)}\n`);
  expect(scan(path, second.end).lines.map((l) => l.event.id)).toEqual([c!.id]);
  expect(scan(path, 10_000_000).lines).toEqual([]);
  expect(scan(join(tmpdir(), 'teneral-no-such-journal'), 0)).toEqual({ lines: [], end: 0 });
});

test('a line that is no event is passed over, and what follows it is read', () => {
  const [a, b] = twoDays();
  const path = journalOf([]);
  writeFileSync(path, `${line(a)}{"torn": \n\n"just text"\n{"type":"x"}\n${line(b)}`);
  expect(scan(path, 0).lines.map((l) => l.event.id)).toEqual([a!.id, b!.id]);
});

real('a store is built from the journal: a row an event, a partition a day', () => {
  const events = twoDays();
  const path = journalOf(events);
  const store = openStore(ray(), path);
  expect(store.rebuilt).toBeNull();
  expect(store.count()).toBe(4);
  expect(store.mark()).toBe(readFileSync(path).length);
  expect(readdirSync(storeDir(path)).filter((name) => /^\d/.test(name)).sort()).toEqual(['2026.11.13', '2026.11.14']);

  const all = store.ask('(select {from: events where: (>= date 2000.01.01) id: id ts: ts type: type source: source chars: chars})');
  expect(all.columns.id).toEqual(events.map((e) => e.id));
  expect(all.columns.type).toEqual(['stimulus', 'assistant', 'stimulus', 'assistant']);
  expect(all.columns.source).toEqual(['terminal', '', 'clock', '']);
  expect([...(all.columns.ts as BigInt64Array)].map(fromRayNs)).toEqual(events.map((e) => e.ts));
  expect(all.columns.chars).toEqual(BigInt64Array.from([6n, 10n, 4n, 13n]));
});

real('a row says where its line lies, so the event can be read from the journal without reading the rest', () => {
  const events = twoDays();
  const path = journalOf(events);
  const store = openStore(ray(), path);
  const t = store.ask(`(select {from: events where: (== id "${events[1]!.id}") off: off next: next})`);
  const [off, next] = [Number((t.columns.off as BigInt64Array)[0]), Number((t.columns.next as BigInt64Array)[0])];
  expect(JSON.parse(readFileSync(path).toString('utf8', off, next)).text).toBe('здравствуй');
});

real('what the journal gains is laid out by sync, and a store opened again goes on from where the table ends', () => {
  const events = twoDays();
  const path = journalOf(events.slice(0, 2));
  const store = openStore(ray(), path);
  expect(store.sync()).toBe(0);
  appendFileSync(path, line(events[2]));
  expect(store.sync()).toBe(1);
  expect(store.count()).toBe(3);
  store.persist();

  appendFileSync(path, line(events[3]));
  const again = openStore(ray(), path);
  expect(again.rebuilt).toBeNull();
  expect(again.count()).toBe(4);
  expect(again.ask('(select {from: events by: date n: (count id)})').columns.n).toEqual(BigInt64Array.from([2n, 2n]));
});

real('rows that were not written out are made again from their lines: nothing is lost, nothing is there twice', () => {
  const events = twoDays();
  const path = journalOf(events.slice(0, 3));
  const store = openStore(ray(), path);
  appendFileSync(path, line(events[3]));
  store.sync();
  // No persist: as after a crash. The row is in no file.
  const again = openStore(ray(), path);
  expect(again.count()).toBe(4);
  expect(again.ask('(select {from: events where: (>= date 2000.01.01) id: id})').columns.id).toEqual(events.map((e) => e.id));
});

real('a store that reaches past its journal is thrown away and built again', () => {
  const events = twoDays();
  const path = journalOf(events);
  openStore(ray(), path);
  writeFileSync(path, events.slice(0, 1).map(line).join(''));
  const again = openStore(ray(), path);
  expect(again.rebuilt).toContain('reaches byte');
  expect(again.count()).toBe(1);
});

real('a store that cannot be read is thrown away and built again', () => {
  const events = twoDays();
  const path = journalOf(events);
  openStore(ray(), path);
  writeFileSync(join(storeDir(path), '2026.11.13', 'events', '.current'), 'not a generation\n');
  const again = openStore(ray(), path);
  expect(again.rebuilt).toContain('could not be read');
  expect(again.count()).toBe(4);
});

real('an event that claims an earlier time than the one before it is laid out with that one\'s day', () => {
  const events = [
    said('2026-11-14T09:00:00.000Z', 'now'), replied('2026-11-13T23:59:59.000Z', 'a clock that went back'),
    replied('not a time', 'no clock at all'), said('2026-11-15T00:00:01.000Z', 'next day'),
  ];
  const path = journalOf(events);
  const store = openStore(ray(), path);
  expect(store.count()).toBe(4);
  expect(store.ask('(select {from: events by: date n: (count id)})').columns.n).toEqual(BigInt64Array.from([3n, 1n]));
});

real('a journal with nothing in it gives a store with nothing in it, which fills when the journal does', () => {
  const path = journalOf([]);
  const store = openStore(ray(), path);
  expect(store.count()).toBe(0);
  expect(store.ask('(select {from: events by: date n: (count id)})').rows).toBe(0);
  appendFileSync(path, line(said('2026-11-14T09:00:00.000Z', 'first')));
  expect(store.sync()).toBe(1);
  expect(store.ask('(select {from: events where: (>= date 2000.01.01) id: id})').rows).toBe(1);
});

real('a long journal is laid out in portions, and is all there', () => {
  const events = Array.from({ length: 12_000 }, (_, i) => said(new Date(Date.parse('2026-11-10T00:00:00Z') + i * 30_000).toISOString(), `m${i}`));
  const path = journalOf(events);
  const store = openStore(ray(), path);
  expect(store.count()).toBe(12_000);
  const perDay = store.ask('(select {from: events by: date n: (count id)})');
  expect([...(perDay.columns.n as BigInt64Array)].reduce((a, b) => a + b, 0n)).toBe(12_000n);
  expect(perDay.rows).toBe(5);
});

real('a store cannot lie at a path that a statement would read as something else', () => {
  expect(() => openStore(ray(), journalOf([]), '/tmp/a"b')).toThrow('cannot lie at a path');
});
