import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventBody, JournalEvent } from '../../brain/journal';
import { journalPast, storePast, type Past } from '../../brain/past';
import { openStore } from '../../brain/store';
import { library, ray } from './rayforce';

const real = test.skipIf(library === null);

let n = 0;
const ev = (minute: number, body: EventBody): JournalEvent => ({ v: 1, id: `la${++n}`, ts: `2026-11-1${Math.floor(minute / 60)}T10:${String(minute % 60).padStart(2, '0')}:00.000Z`, gen: 'g1', ...body }) as JournalEvent;
const line = (e: JournalEvent): string => `${JSON.stringify(e)}\n`;

/** Events of several types and sources over two days, with a conversation the owner took back in the middle. */
function journalOf(): { path: string; events: JournalEvent[] } {
  const events: JournalEvent[] = [
    ev(0, { type: 'stimulus', source: 'terminal', text: 'hello' }),
    ev(1, { type: 'assistant', text: 'hi', toolCalls: [] }),
    ev(2, { type: 'stimulus', source: 'clock', text: 'tick' }),
    ev(3, { type: 'note', kind: 'github.cursor.v1', data: { repository: 'a/b', at: 1 } }),
    ev(4, { type: 'stimulus', source: 'owner:zulip', text: 'from the chat' }),
    ev(5, { type: 'assistant', text: 'answered', toolCalls: [{ id: 'c1', name: 'bash', args: {} }] }),
    ev(6, { type: 'tool.intent', callId: 'c1', name: 'bash', args: {} }),
    ev(7, { type: 'tool.result', callId: 'c1', ok: true, output: 'done' }),
    ev(61, { type: 'note', kind: 'github.cursor.v1', data: { repository: 'c/d', at: 2 } }),
    ev(62, { type: 'stimulus', source: 'clock', text: 'tick again' }),
    ev(63, { type: 'stimulus', source: 'terminal', text: 'take this back' }),
    ev(64, { type: 'assistant', text: 'said in what was taken back', toolCalls: [] }),
  ];
  events.push(ev(65, { type: 'note', kind: 'memory.back.v1', data: { to: events[10]!.id } }));
  const path = join(mkdtempSync(join(tmpdir(), 'teneral-latest-')), 'journal.jsonl');
  writeFileSync(path, events.map(line).join(''));
  return { path, events };
}

const ASKED: [string, string?][] = [
  ['stimulus'], ['stimulus', 'clock'], ['stimulus', 'terminal'], ['stimulus', 'owner:zulip'], ['stimulus', 'nobody'],
  ['assistant'], ['note', 'github.cursor.v1'], ['note', 'memory.back.v1'], ['note', 'no.such.kind'], ['tool.intent', 'bash'], ['tool.result'], ['generation.ready'],
];
const named = (e: JournalEvent): unknown => (e.type === 'stimulus' ? e.source : e.type === 'tool.intent' ? e.name : e.type === 'note' ? e.kind : '');
/** What the journal itself says: the last such event of all it holds, whatever became of the conversation it was in. */
const expected = (events: JournalEvent[], type: string, source?: string): JournalEvent | null =>
  events.findLast((e) => e.type === type && (source === undefined || named(e) === source)) ?? null;

function same(past: Past, path: string, events: JournalEvent[]): void {
  for (const [type, source] of ASKED) expect(past.latest(type, source)).toEqual(expected(events, type, source));
  expect(past.notes(['github.cursor.v1']).map((e) => e.id)).toEqual(events.filter((e) => e.type === 'note' && e.kind === 'github.cursor.v1').map((e) => e.id));
  expect(past.notes(['no.such.kind'])).toEqual([]);
  // What is appended afterwards is seen at the next question, with nothing opened again.
  const more = [ev(70, { type: 'stimulus', source: 'clock', text: 'a later tick' }), ev(71, { type: 'note', kind: 'github.cursor.v1', data: { repository: 'a/b', at: 3 } })];
  appendFileSync(path, more.map(line).join(''));
  expect(past.latest('stimulus', 'clock')).toEqual(more[0]!);
  expect(past.latest('stimulus')).toEqual(more[0]!);
  expect(past.notes(['github.cursor.v1']).at(-1)).toEqual(more[1]!);
}

test('the newest event of a type and a source, asked of the journal read through', () => {
  const { path, events } = journalOf();
  same(journalPast(path), path, events);
});

real('the same answers from the database', () => {
  const { path, events } = journalOf();
  same(storePast(path, ray(), openStore(ray(), path), false), path, events);
});
