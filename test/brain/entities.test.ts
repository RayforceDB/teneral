import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTACT_NOTE, ENTITY_KIND, keyOf, mentionOf, named, nodeOf } from '../../brain/entities-table';
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
const who = (s: JournalEvent[], name: string, id: string): JournalEvent => ev({ type: 'note', kind: ENTITY_KIND, data: { kind: 'person', name, who: id, episode: s[0]!.id } });

function life() {
  const [a, b, c, d, e, f] = [stretch('fix the parser with Anton'), stretch('review for the other Anton'), stretch('release notes'), stretch('lunch'), stretch('someone called Anton wrote'), stretch('a pull request from ak')];
  const events = [
    // Two people called Anton in one channel, and the first of them in two stretches, the second time under another name.
    ...a, memory(a, 'The parser', 'Anton and I fixed the parser in rayforce.'), who(a, 'Anton', 'zulip:7'), ...names(a, ['repo', 'RayforceDB/rayforce']),
    ...b, memory(b, 'A review', 'I reviewed a change.'), who(b, 'Anton', 'zulip:12'), ...names(b, ['project', 'Teneral']), who(b, 'Anton', 'zulip:12'),
    ...c, memory(c, 'Release notes', 'I wrote the notes for RayforceDB/rayforce and sent them.'), who(c, 'Anton K.', 'zulip:7'), ...names(c, ['project', 'Teneral']),
    ...d, memory(d, 'Lunch', 'Nothing to do with anyone.'),
    // Named by a name alone, by a memory and by a fact: one node of its own, tied to neither Anton.
    ...e, memory(e, 'A letter', 'Somebody wrote.'), ...names(e, ['person', 'anton']),
    // The first Anton again, on another service, under another name: nothing says yet that it is him.
    ...f, memory(f, 'A pull request', 'ak sent a change.'), who(f, 'ak', 'github:ak'),
    ev({ type: 'note', kind: 'memory.fact.v1', data: { text: 'Anton answers for releases', source: 'owner', about: 'Anton', episode: c[0]!.id } }),
    // Not in form: no node is made of these.
    ev({ type: 'note', kind: ENTITY_KIND, data: { kind: 'planet', name: 'Mars', episode: a[0]!.id } }),
    ev({ type: 'note', kind: ENTITY_KIND, data: { kind: 'person', name: '  ', episode: a[0]!.id } }),
  ];
  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-entities-')), 'journal.jsonl');
  writeFileSync(journal, events.map((one) => `${JSON.stringify(one)}\n`).join(''));
  return { journal, a, b, c, d, e, f };
}

/** Asked of the database: over the one runtime the tests share (test/brain/rayforce.ts). */
const served = (journal: string): Past => storePast(journal, ray(), openStore(ray(), journal, undefined, projections()), false);

test('a name is not a person: who someone is to a service makes the node, and a name alone is kept apart', () => {
  expect(keyOf('  Ivan   PETROV ')).toBe('ivan petrov');
  expect(named('Anton (zulip:7)')).toEqual({ name: 'Anton', who: 'zulip:7' });
  expect(named('Anton (the tall one)')).toEqual({ name: 'Anton (the tall one)', who: '' });
  const note = (data: object): JournalEvent => ev({ type: 'note', kind: ENTITY_KIND, data });
  expect(mentionOf(note({ kind: 'person', name: 'Anton', who: 'zulip:7', episode: 'e1' }), 3)).toEqual({ seq: 3, kind: 'person', key: 'zulip:7', name: 'Anton', who: 'zulip:7', episode: 'e1' });
  expect(mentionOf(note({ kind: 'person', name: 'Anton (zulip:12)', episode: 'e1' }), 3)).toMatchObject({ key: 'zulip:12', name: 'Anton', who: 'zulip:12' });
  expect(mentionOf(note({ kind: 'person', name: 'Anton', episode: 'e1' }), 3)).toMatchObject({ key: 'anton', who: '' });
  // Two of one name are two nodes, and neither is the one known by the name alone.
  const node = (data: object) => nodeOf(mentionOf(note({ kind: 'person', episode: 'e1', ...data }), 0)!);
  expect(new Set([node({ name: 'Anton', who: 'zulip:7' }), node({ name: 'Anton', who: 'zulip:12' }), node({ name: 'Anton' })]).size).toBe(3);
  expect(node({ name: 'Anton', who: 'zulip:7' })).toBe(node({ name: 'Somebody else entirely', who: 'zulip:7' }));
  // Only a person is someone to a service; a note not in form names no one.
  expect(mentionOf(note({ kind: 'repo', name: 'a/b', who: 'zulip:7', episode: 'e1' }), 3)).toMatchObject({ key: 'a/b', who: '' });
  expect(mentionOf(note({ kind: 'person', name: 'Ivan' }), 3)).toBeNull();
  expect(mentionOf(ev({ type: 'note', kind: 'memory.fact.v1', data: { text: 'x', source: 'owner', episode: 'e1' } }), 3)).toBeNull();
});

for (const [how, open] of [['read through', (journal: string) => journalPast(journal)], ['asked of the database', served]] as const) {
  test.skipIf(how === 'asked of the database' && library === null)(`whom and what a life is about is a graph, ${how}: people of one name are apart, each with their own stretches and those named beside them`, { timeout: 20_000 }, () => {
    const { journal, a, b, c, e, f } = life();
    const past = open(journal);
    expect(past.by).toBe(how === 'read through' ? 'journal' : 'store');
    // Named twice in one stretch is one tie; someone known by an id is called what they were last called.
    expect(past.entities().map((one) => `${one.kind}|${one.name}|${one.who}|${one.stretches}`).sort()).toEqual([
      'person|anton||2', 'person|Anton K.|zulip:7|2', 'person|Anton|zulip:12|1', 'person|ak|github:ak|1', 'project|Teneral||2', 'repo|RayforceDB/rayforce||1',
    ].sort());
    // Asked by the name: every one of that name, apart, and nothing of one is given to another.
    const antons = past.about('ANTON').found;
    expect(antons.map((one) => one.who).sort()).toEqual(['', 'zulip:12']);
    const all = [...antons, ...past.about('Anton K.').found];
    const by = (id: string) => all.find((one) => one.who === id)!;
    expect([...by('zulip:7').stretches].sort()).toEqual([a[0]!.id, c[0]!.id].sort());
    expect(by('zulip:12').stretches).toEqual([b[0]!.id]);
    expect([...by('').stretches].sort()).toEqual([c[0]!.id, e[0]!.id].sort());
    expect(by('zulip:12').beside.map((one) => one.name)).toEqual(['Teneral']);
    // Asked by who they are: that one alone, whatever they are called.
    const seven = past.about('zulip:7');
    expect(seven.found.map((one) => `${one.name}|${one.who}`)).toEqual(['Anton K.|zulip:7']);
    expect(seven.found[0]!.beside.map((one) => `${one.name}|${one.who}`).sort()).toEqual(['RayforceDB/rayforce|', 'Teneral|', 'anton|']);
    expect(seven.told).toEqual([]);
    // By the name as it is written, found in the words of a memory that did not name it; a stretch that named it is not listed twice.
    const repo = past.about('RayforceDB/rayforce');
    expect(repo.found[0]!.stretches).toEqual([a[0]!.id]);
    expect(repo.told).toEqual([c[0]!.id]);
    expect(past.about('nobody at all')).toEqual({ found: [], told: [] });
    // What is named later is in the graph the next time it is asked.
    appendFileSync(journal, `${JSON.stringify(who(e, 'Anton', 'zulip:12'))}\n`);
    past.sync?.();
    expect([...past.about('zulip:12').found[0]!.stretches].sort()).toEqual([b[0]!.id, e[0]!.id].sort());
    // An account is not a person either: once the owner says the one on GitHub is the Anton of Zulip, the two are one node,
    // found by either account, with the stretches of both.
    appendFileSync(journal, `${JSON.stringify(ev({ type: 'note', kind: CONTACT_NOTE, data: { key: 'zulip:7', same: 'github:ak' } }))}\n`);
    past.sync?.();
    for (const asked of ['github:ak', 'zulip:7']) {
      const one = past.about(asked).found;
      expect(one.map((it) => `${it.who}|${it.also.join(' ')}`)).toEqual(['zulip:7|github:ak']);
      expect([...one[0]!.stretches].sort()).toEqual([a[0]!.id, c[0]!.id, f[0]!.id].sort());
    }
    expect(past.entities().filter((one) => one.kind === 'person').map((one) => `${one.who}|${one.stretches}`).sort()).toEqual(['zulip:12|2', 'zulip:7|3', '|2']);
    past.close();
  });
}

test('a memory names whom and what its stretch was about in a list of its own, a person with who they are', () => {
  const formed = parseMemory('Title: The parser\nOutcome: done\n\nIvan and I fixed the parser. It took the whole afternoon and the tests pass now.\n\nAbout:\n- [person] Ivan Petrov (zulip:7)\n- [person] Ivan Petrov\n- [REPO] RayforceDB/rayforce\n- [planet] Mars\n- [project] x', 600);
  expect('problem' in formed ? formed.problem : formed.about).toEqual([{ kind: 'person', name: 'Ivan Petrov', who: 'zulip:7' }, { kind: 'person', name: 'Ivan Petrov' }, { kind: 'repo', name: 'RayforceDB/rayforce' }]);
});
