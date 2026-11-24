import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOLS, type ToolContext } from '../../body/tools';
import { GAP_MS } from '../../brain/episodes';
import { EXAM_KIND, listed, questionsOf } from '../../brain/exam';
import { readEvents, type EventBody, type JournalEvent } from '../../brain/journal';
import { OUTDATED_KIND, links, outdatedStretches } from '../../brain/links';
import { buildMessages } from '../../brain/memory';
import { journalPast, sinceLines } from '../../brain/past';
import { remembered } from '../../brain/remembered';

let n = 0;
let clock = Date.parse('2026-11-11T00:00:00.000Z');
const ev = (body: EventBody, afterMs = 60_000): JournalEvent => ({ v: 1, id: `so${(++n).toString(36).padStart(4, '0')}`, ts: new Date(clock += afterMs).toISOString(), gen: 'g1', ...body }) as JournalEvent;
const LONG = GAP_MS + 1000;

/** Three stretches, each with its memory, and something said now. */
function life() {
  const stretches = ['the deploy key lives in the vault', 'the staging host is alpha', 'the report goes out on Fridays'].map((what) => [
    ev({ type: 'stimulus', source: 'terminal', text: `remember that ${what}` }, LONG), ev({ type: 'assistant', text: `Noted: ${what}.`, toolCalls: [] }),
  ]);
  const notes = stretches.map((s, i) => ev({ type: 'note', kind: 'memory.episode.v1', data: { from: s[0]!.id, to: s[1]!.id, start: s[0]!.ts, end: s[1]!.ts, title: `Thing ${i}`, text: `I was told thing ${i}.`, outcome: 'done' } }));
  return { stretches, notes, events: [...stretches.flat(), ...notes, ev({ type: 'stimulus', source: 'terminal', text: 'and now?' }, LONG)] };
}
function context(events: JournalEvent[]): ToolContext {
  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-said-')), 'journal.jsonl');
  writeFileSync(journal, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  return { workspace: '/tmp', journal, gen: 'g1', mutationCommit: null, id: 'me', inbox: '/tmp/unused-inbox', peers: '/tmp/unused-peers.json', soul: '/tmp' };
}
const outdated = TOOLS.find((t) => t.spec.name === 'outdated')!;

test('the agent can say at any time that a memory no longer holds: it is kept, and shown as outdated from then on', async () => {
  const { stretches, notes, events } = life();
  const ctx = context(events);
  // By the event its stretch begins at, as a found memory names it.
  expect(await outdated.run({ memory: stretches[1]![0]!.id, why: 'the staging host is beta since the move' }, ctx)).toBe('Marked as outdated: "Thing 1". It is kept, and shown as outdated from now on.');
  await expect(outdated.run({ memory: 'nothing-of-mine', why: 'it changed since then' }, ctx)).rejects.toThrow('no memory of yours');
  await expect(outdated.run({ memory: stretches[0]![0]!.id, why: 'no' }, ctx)).rejects.toThrow('what no longer holds');
  const now = readEvents(ctx.journal);
  const note = now.at(-1)!;
  expect(note).toMatchObject({ type: 'note', kind: OUTDATED_KIND, data: { memory: stretches[1]![0]!.id, why: 'the staging host is beta since the move' } });
  // The tie runs from the agent's own word to the memory, and holds from when it was said: no later memory is needed for it.
  expect(links(now).filter((l) => l.kind === 'outdates')).toEqual([{ from: note.id, to: notes[1]!.id, kind: 'outdates', why: 'the staging host is beta since the move', since: note.ts }]);
  expect([...outdatedStretches(now)]).toEqual([[stretches[1]![0]!.id, { why: 'the staging host is beta since the move', since: note.ts }]]);
  // Where the memory is found, it says so; and in a request it stands with the same words.
  expect(sinceLines(journalPast(ctx.journal), notes[1]!).join('\n')).toContain('the staging host is beta since the move (you said so yourself)');
  const request = buildMessages(now, 'S', 100_000, undefined, { tailChars: 0 }).map((m) => m.content).join('\n');
  expect(request).toContain('the staging host is beta since the move');
  // Nothing was taken away: the memory is still told.
  expect(request).toContain('I was told thing 1.');
  expect(remembered(now).memories.size).toBe(3);
  // By its own id, too.
  expect(await outdated.run({ memory: notes[2]!.id, why: 'the report goes out on Mondays now' }, ctx)).toContain('Thing 2');
});

test('the exam asks whether the request itself leads to what a question asks: by a memory shown, a line of the contents, or the stretch as it happened', () => {
  const { stretches, notes, events } = life();
  const asks = stretches.map((s, i) => ev({ type: 'note', kind: EXAM_KIND, data: { question: `what about thing ${i}?`, events: [s[1]!.id], episode: s[0]!.id } }));
  const all = [...events, ...asks];
  const told = remembered(all);
  const own = questionsOf(all);
  expect(own).toHaveLength(3);
  const at = (e: JournalEvent): number => all.indexOf(e);
  // Everything swapped for memories that name their stretches: all three are led to.
  const whole = buildMessages(all, 'S', 100_000, undefined, { tailChars: 0 }).map((m) => m.content).join('\n');
  expect(listed(all, told, own, { text: whole, tailFrom: at(stretches[2]![1]!) + 1 })).toMatchObject({ questions: 3, passed: 3 });
  // A request that names nothing leads only to what it still shows as it happened.
  expect(listed(all, told, own, { text: '', tailFrom: at(stretches[2]![0]!) })).toMatchObject({ passed: 1 });
  expect(listed(all, told, own, { text: `only ${notes.length} words and event ${stretches[0]![0]!.id}`, tailFrom: all.length })).toMatchObject({ passed: 1 });
  expect(listed(all, told, [], { text: whole, tailFrom: 0 })).toMatchObject({ questions: 0, passed: 0 });
});
