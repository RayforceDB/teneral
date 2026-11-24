import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENTITY_KIND, keyOf, mentionOf } from '../../brain/entities-table';
import type { JournalEvent } from '../../brain/journal';
import { journalPast, projections, storePast, type Past } from '../../brain/past';
import { openStore } from '../../brain/store';
import { library, ray } from './rayforce';
import { EPISODE_KIND } from '../../brain/remembered';
import { parseMemory } from '../../brain/sleep';

let n = 0;
const ev = (body: Record<string, unknown>): JournalEvent => ({ v: 1, id: `n${++n}`, ts: new Date(Date.parse('2026-04-01T00:00:00.000Z') + n * 3_600_000).toISOString(), gen: 'g1', ...body }) as JournalEvent;
const stretch = (said: string): JournalEvent[] => [ev({ type: 'stimulus', source: 'terminal', text: said }), ev({ type: 'assistant', text: 'Done.', toolCalls: [] })];
const memory = (s: JournalEvent[], title: string, text: string): JournalEvent =>
  ev({ type: 'note', kind: EPISODE_KIND, data: { from: s[0]!.id, to: s[1]!.id, start: s[0]!.ts, end: s[1]!.ts, title, text, outcome: 'done' } });
const names = (s: JournalEvent[], ...list: [string, string][]): JournalEvent[] => list.map(([kind, name]) => ev({ type: 'note', kind: ENTITY_KIND, data: { kind, name, episode: s[0]!.id } }));

function life() {
  const [a, b, c, d] = [stretch('fix the parser with Ivan'), stretch('review for Ivan'), stretch('release notes'), stretch('lunch')];
  const events = [
    ...a, memory(a, 'The parser', 'Ivan Petrov and I fixed the parser in rayforce.'), ...names(a, ['person', 'Ivan Petrov'], ['repo', 'RayforceDB/rayforce']),
    ...b, memory(b, 'A review', 'I reviewed a change.'), ...names(b, ['person', 'ivan  petrov'], ['project', 'Teneral'], ['person', 'Ivan Petrov']),
    ...c, memory(c, 'Release notes', 'I wrote the notes for RayforceDB/rayforce and sent them.'), ...names(c, ['project', 'Teneral']),
    ...d, memory(d, 'Lunch', 'Nothing to do with anyone.'),
    // A fact about a person names them too, in the stretch it was learned in.
    ev({ type: 'note', kind: 'memory.fact.v1', data: { text: 'Olga answers for releases', source: 'owner', about: 'Olga', episode: c[0]!.id } }),
    // Not in form: no node is made of these.
    ev({ type: 'note', kind: ENTITY_KIND, data: { kind: 'planet', name: 'Mars', episode: a[0]!.id } }),
    ev({ type: 'note', kind: ENTITY_KIND, data: { kind: 'person', name: '  ', episode: a[0]!.id } }),
  ];
  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-entities-')), 'journal.jsonl');
  writeFileSync(journal, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  return { journal, a, b, c, d };
}

/** Asked of the database: over the one runtime the tests share (test/brain/rayforce.ts). */
const served = (journal: string): Past => storePast(journal, ray(), openStore(ray(), journal, undefined, projections()), false);

test('a name is known by its letters, and a note not in form names no one', () => {
  expect(keyOf('  Ivan   PETROV ')).toBe('ivan petrov');
  expect(mentionOf(ev({ type: 'note', kind: ENTITY_KIND, data: { kind: 'person', name: 'Ivan', episode: 'e1' } }), 3)).toEqual({ seq: 3, kind: 'person', key: 'ivan', name: 'Ivan', episode: 'e1' });
  expect(mentionOf(ev({ type: 'note', kind: ENTITY_KIND, data: { kind: 'person', name: 'Ivan' } }), 3)).toBeNull();
  expect(mentionOf(ev({ type: 'note', kind: 'memory.fact.v1', data: { text: 'x', source: 'owner', episode: 'e1' } }), 3)).toBeNull();
});

for (const [how, open] of [['read through', (journal: string) => journalPast(journal)], ['asked of the database', served]] as const) {
  test.skipIf(how === 'asked of the database' && library === null)(`whom and what a life is about is a graph, ${how}: each one named with its stretches, who was named beside it, and the memories that only have the name in their words`, () => {
    const { journal, a, b, c } = life();
    const past = open(journal);
    expect(past.by).toBe(how === 'read through' ? 'journal' : 'store');
    // Named twice in one stretch is one tie; the name is as it was first written.
    expect(past.entities().map((one) => `${one.kind} ${one.name} ${one.stretches}`).sort()).toEqual([
      'person Ivan Petrov 2', 'person Olga 1', 'project Teneral 2', 'repo RayforceDB/rayforce 1',
    ]);
    expect(past.entities().map((one) => one.stretches)).toEqual([2, 2, 1, 1]);
    const ivan = past.about('ivan petrov');
    expect(ivan.named).toEqual([{ kind: 'person', name: 'Ivan Petrov' }]);
    expect(ivan.stretches.sort()).toEqual([a[0]!.id, b[0]!.id].sort());
    expect(ivan.beside.map((one) => one.name).sort()).toEqual(['RayforceDB/rayforce', 'Teneral']);
    // By the name as it is written, found in the words of a memory that did not name it; a stretch that named it is not listed twice.
    const repo = past.about('RayforceDB/rayforce');
    expect(repo.stretches).toEqual([a[0]!.id]);
    expect(repo.told).toEqual([c[0]!.id]);
    expect(past.about('Ivan Petrov').told).toEqual([]);
    // Two steps and no more: Olga was named beside Teneral, not beside Ivan.
    expect(past.about('Olga').beside).toEqual([{ kind: 'project', name: 'Teneral' }]);
    expect(past.about('nobody at all')).toEqual({ named: [], stretches: [], beside: [], told: [] });
    // What is named later is in the graph the next time it is asked.
    appendFileSync(journal, `${JSON.stringify(ev({ type: 'note', kind: ENTITY_KIND, data: { kind: 'person', name: 'Olga', episode: a[0]!.id } }))}\n`);
    past.sync?.();
    expect(past.about('Olga').stretches.sort()).toEqual([a[0]!.id, c[0]!.id].sort());
    expect(past.about('Ivan Petrov').beside.map((one) => one.name).sort()).toEqual(['Olga', 'RayforceDB/rayforce', 'Teneral']);
    past.close();
  });
}

test('a memory names whom and what its stretch was about in a list of its own', () => {
  const formed = parseMemory('Title: The parser\nOutcome: done\n\nIvan and I fixed the parser. It took the whole afternoon and the tests pass now.\n\nAbout:\n- [person] Ivan Petrov\n- [REPO] RayforceDB/rayforce\n- [planet] Mars\n- [project] x', 600);
  expect('problem' in formed ? formed.problem : formed.about).toEqual([{ kind: 'person', name: 'Ivan Petrov' }, { kind: 'repo', name: 'RayforceDB/rayforce' }]);
});
