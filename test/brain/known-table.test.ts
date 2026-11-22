import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventBody, JournalEvent } from '../../brain/journal';
import { known, knownOf, knownStart, knownStep } from '../../brain/known';
import { knownFrom, knownProjection } from '../../brain/known-table';
import { openStore } from '../../brain/store';
import { library, ray } from './rayforce';

const real = test.skipIf(library === null);

let n = 0;
const ev = (hour: number, body: EventBody): JournalEvent =>
  ({ v: 1, id: `kt${(++n).toString(36).padStart(6, '0')}`, ts: new Date(Date.parse('2026-11-10T00:00:00.000Z') + hour * 3_600_000 + n).toISOString(), gen: 'g1', ...body }) as JournalEvent;
const note = (hour: number, kind: string, data: Record<string, unknown>) => ev(hour, { type: 'note', kind, data });
const mark = (letter: string, e: JournalEvent): string => `${letter}${e.id.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}`;
const line = (e: JournalEvent): string => `${JSON.stringify(e)}\n`;

/** A life in which facts were replaced, forgotten and withdrawn, and intentions of every kind were asked, allowed, worked on and closed. */
function life(): JournalEvent[] {
  const first = ev(0, { type: 'stimulus', source: 'terminal', text: 'hello' });
  const f1 = note(1, 'memory.fact.v1', { text: 'The office is in Lisbon.', source: 'owner', episode: first.id });
  const f2 = note(2, 'memory.fact.v1', { text: 'The office is in Porto.', source: 'owner', episode: first.id, replaces: [f1.id] });
  const f3 = note(2, 'memory.fact.v1', { text: 'Ivan answers for the release.', source: 'seen', episode: first.id, about: 'Ivan Petrov' });
  const f4 = note(3, 'memory.fact.v1', { text: 'The door code is 4711.', source: 'read', episode: first.id });
  const f5 = note(3, 'memory.fact.v1', { text: 'The lift is out of order.', source: 'inferred', episode: first.id });
  const bad = note(3, 'memory.fact.v1', { text: 'No source, so no fact.', episode: first.id });
  const todo = note(4, 'memory.intention.v1', { text: 'Send the report to the owner.', due: '2026-11-12', episode: first.id });
  const ask = note(4, 'memory.intention.v1', { text: 'Which address should the report go to?', origin: 'ask', to: 'the owner, in the terminal' });
  const idea = note(5, 'memory.intention.v1', { text: 'Tidy the notes directory.', origin: 'own', unsure: true });
  const own = note(5, 'memory.intention.v1', { text: 'Look at the failing test again.', origin: 'own' });
  const refused = note(5, 'memory.intention.v1', { text: 'Rewrite the build in another language.', origin: 'own', unsure: true });
  const queued = note(6, 'memory.intention.v1', { text: 'Publish the notes.', status: 'queued', next: 'write the first page', attempts: 0, resumeAt: 0 });
  return [
    first, f1, f2, f3, f4, f5, bad, todo, ask, idea, own, refused, queued,
    // The question is put twice within half a day, which is one asking, and once more a day later, which is another.
    ev(7, { type: 'assistant', text: `A question for you, ${mark('I', ask)}: which address?`, toolCalls: [] }),
    ev(9, { type: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'say', args: { text: `again ${mark('I', ask)} and ${mark('I', idea)}` } }] }),
    ev(40, { type: 'assistant', text: `Still open: ${mark('I', ask)}.`, toolCalls: [] }),
    ev(41, { type: 'assistant', text: 'Nothing to do with any mark.', toolCalls: [] }),
    note(42, 'memory.intention.allowed.v1', { intention: idea.id, words: 'yes, tidy it', source: 'terminal' }),
    note(43, 'memory.work.v1', { intention: queued.id, status: 'waiting', next: 'the owner reads the draft', attempts: 1, resumeAt: 5, checkAt: 9, outcome: 'a draft exists' }),
    note(44, 'memory.intention.done.v1', { intention: todo.id, how: 'sent' }),
    note(44, 'memory.intention.done.v1', { intention: ask.id, how: 'the work address' }),
    note(45, 'memory.intention.done.v1', { intention: refused.id, how: 'the owner said no' }),
    note(45, 'memory.intention.done.v1', { intention: own.id, how: 'not worth it', ended: 'dropped' }),
    // A note of progress that comes after the end changes nothing.
    note(46, 'memory.work.v1', { intention: todo.id, status: 'queued', next: 'send it again', attempts: 2, resumeAt: 0 }),
    note(47, 'memory.forget.v1', { ids: [f4.id] }),
    note(48, 'memory.withdraw.v1', { ids: [f5.id] }),
    ev(49, { type: 'stimulus', source: 'terminal', text: 'thanks' }),
  ];
}

test('the step taken event by event gives what the journal read whole gives', () => {
  const events = life();
  const state = knownStart();
  const changed = events.map((e) => knownStep(state, e));
  expect(knownOf(state)).toEqual(known(events));
  const held = known(events);
  expect(held.facts.map((f) => f.text)).toEqual(['The office is in Porto.', 'Ivan answers for the release.']);
  expect(held.intentions.map((i) => i.text)).toEqual(['Tidy the notes directory.', 'Publish the notes.']);
  expect(held.closed.map((i) => i.ended)).toEqual(['done', 'answered', 'dropped', 'refused']);
  // Something said to the agent changes nothing; a reply does only when it names what waits.
  expect(changed[0]).toBe(false);
  expect(changed.at(-1)).toBe(false);
  expect(events.map((e, i) => (e.type === 'assistant' ? changed[i] : null)).filter((c) => c !== null)).toEqual([true, true, true, false]);
});

real('the tables of the database hold what is known, as the journal read whole gives it', () => {
  const events = life();
  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-known-')), 'journal.jsonl');
  writeFileSync(journal, events.slice(0, 14).map(line).join(''));
  const store = openStore(ray(), journal, undefined, [knownProjection()]);
  expect(knownFrom(ray())).toEqual(known(events.slice(0, 14)));
  // As the journal grows the tables follow, one portion or one event at a time.
  let had = 14;
  for (const upTo of [15, 16, 18, 19, 24, events.length]) {
    appendFileSync(journal, events.slice(had, upTo).map(line).join(''));
    had = upTo;
    store.sync();
    store.settle();
    expect(knownFrom(ray())).toEqual(known(events.slice(0, upTo)));
  }
  // What can be asked of the columns: the facts about one person that stand, and what waits for the owner.
  const about = ray().table("(select {from: mem_known_facts where: (and standing (== about \"Ivan Petrov\")) text: text})");
  expect(about.columns.text).toEqual(['Ivan answers for the release.']);
  store.persist();

  // Written out and opened again, they are read back and not made again; what the journal gained meanwhile is taken in.
  const later = note(50, 'memory.fact.v1', { text: 'The kitchen is on the second floor.', source: 'seen', episode: events[0]!.id });
  appendFileSync(journal, line(later));
  const again = knownProjection();
  let stepped = 0;
  const counting = { ...again, step: (e: JournalEvent, seq: number) => { stepped += 1; return again.step(e, seq); } };
  openStore(ray(), journal, undefined, [counting]);
  expect(knownFrom(ray())).toEqual(known([...events, later]));
  // Only the one new event was taken in: the rest came back from the tables as they were written.
  expect(stepped).toBe(1);
}, 30_000);

real('laying out an event does not pay for the tables made from it: they are made when read, and written only when they changed', () => {
  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-known-')), 'journal.jsonl');
  const first = ev(0, { type: 'stimulus', source: 'terminal', text: 'hello' });
  writeFileSync(journal, line(first));
  const inner = knownProjection();
  let made = 0;
  const counting = { ...inner, tables: () => { made += 1; return inner.tables(); } };
  const store = openStore(ray(), journal, undefined, [counting]);
  const afterOpen = made;
  for (let i = 0; i < 5; i++) {
    appendFileSync(journal, line(ev(1, { type: 'stimulus', source: 'terminal', text: `more ${i}` })));
    store.sync();
  }
  // Five events laid out, and nothing was asked of the tables.
  expect(made).toBe(afterOpen);
  appendFileSync(journal, line(note(2, 'memory.fact.v1', { text: 'The office is in Lisbon.', source: 'owner', episode: first.id })));
  store.sync();
  expect(made).toBe(afterOpen);
  store.settle();
  expect(knownFrom(ray()).facts.map((f) => f.text)).toEqual(['The office is in Lisbon.']);
  // The very same columns until something changes: that is how the store knows not to send or write them again.
  expect(inner.tables().facts).toBe(inner.tables().facts);
  const before = inner.tables().facts;
  appendFileSync(journal, line(ev(3, { type: 'stimulus', source: 'terminal', text: 'nothing that is known changes' })));
  store.sync();
  store.settle();
  expect(inner.tables().facts).toBe(before);
}, 30_000);
