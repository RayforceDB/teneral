import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GAP_MS } from '../../brain/episodes';
import { readEvents, type EventBody, type JournalEvent } from '../../brain/journal';
import { buildMessages } from '../../brain/memory';
import { journalPast, when } from '../../brain/past';
import type { ChatMessage, Provider, Reply } from '../../brain/provider';
import { EPISODE_KIND, MERGE_KIND, remembered } from '../../brain/remembered';
import { MERGE_COUNT, sleep } from '../../brain/sleep';

let n = 0;
let clock = 0;
const ev = (body: EventBody, afterMs = 60_000): JournalEvent => {
  clock += afterMs;
  return { v: 1, id: `m${++n}`, ts: new Date(clock).toISOString(), gen: 'g1', ...body } as JournalEvent;
};
const LONG = GAP_MS + 1000;

/** A life of `count` episodes that are over, each with a memory of about `chars`, and one going on. */
function life(count: number, chars = 300, asked = '') {
  clock = Date.parse('2026-11-01T00:00:00.000Z');
  const stretches = Array.from({ length: count }, (_, i) => [
    ev({ type: 'stimulus', source: 'terminal', text: `please do thing number ${i}, the one called task${i}${asked}` }, LONG),
    ev({ type: 'assistant', text: `thing number ${i} is done`, toolCalls: [] }),
  ]);
  const notes = stretches.map((s, i) => ev({
    type: 'note', kind: EPISODE_KIND,
    data: { from: s[0]!.id, to: s[1]!.id, start: s[0]!.ts, end: s[1]!.ts, title: `Thing ${i}`, text: `I did thing ${i}. ${'d'.repeat(chars)}`, outcome: 'done' },
  }));
  const events = [...stretches.flat(), ...notes, ev({ type: 'stimulus', source: 'terminal', text: 'and now?' }, LONG)];
  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-merge-')), 'journal.jsonl');
  writeFileSync(journal, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  return { stretches, journal };
}
function asleep(journal: string, replies: Reply[], logbookChars: number) {
  const seen: ChatMessage[][] = [];
  const provider: Provider = async (messages) => { seen.push(messages); return replies.shift() ?? { text: 'no', toolCalls: [] }; };
  return { seen, deps: { journal, gen: 'g2', provider, specs: [], system: () => 'SYS', logbookChars } };
}
const WIDE = 'Title: The first six things\nOutcome: done\n\nOver these days my owner asked for six things in a row and I did each of them as asked.';
const said = (text: string): Reply => ({ text, toolCalls: [] });

test('while the memories fit their room, nothing is made into one', async () => {
  const { journal } = life(8);
  const s = asleep(journal, [], 100_000);
  expect(await sleep(s.deps)).toBe('nothing');
  expect(s.seen).toHaveLength(0);
});

test('when they have outgrown it, the oldest few become one memory of the whole stretch', async () => {
  const { journal, stretches } = life(8);
  const s = asleep(journal, [said(WIDE)], 1500);

  expect(await sleep(s.deps)).toBe('merged');

  expect(readEvents(journal).at(-1)).toMatchObject({
    type: 'note', kind: MERGE_KIND,
    data: {
      from: stretches[0]![0]!.id, to: stretches[MERGE_COUNT - 1]![1]!.id, start: stretches[0]![0]!.ts, end: stretches[MERGE_COUNT - 1]![1]!.ts,
      level: 2, title: 'The first six things', outcome: 'done',
    },
  });
  // The request holds the stretch itself, as it happened, and not the memories of it: a wider memory is formed one step deeper.
  const sent = s.seen[0]!;
  expect(sent[0]).toEqual({ role: 'system', content: 'SYS' });
  expect(sent.filter((m) => m.role === 'user').slice(0, 6).map((m) => m.content)).toEqual(stretches.slice(0, 6).map((st) => (st[0] as { text: string }).text));
  expect(sent.filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual(['thing number 0 is done', 'thing number 1 is done', 'thing number 2 is done', 'thing number 3 is done', 'thing number 4 is done', 'thing number 5 is done']);
  expect(sent.at(-1)!.content).toContain('Above stands a stretch of your life as it happened');
  expect(sent.at(-1)!.content).toContain('You hold 6 memories of it');
  expect(JSON.stringify(sent)).not.toContain('I did thing');
  // Whose words the stretch was made of is counted from the journal, not taken from the telling.
  expect((readEvents(journal).at(-1) as { data: { voices: unknown } }).data.voices).toEqual({ owner: 6 * 46, others: 0, tools: 0, own: 6 * 22 });
});

test('when the stretch itself does not fit a request, the wider memory is formed from the memories it stands for', async () => {
  // Six episodes of 3000 characters each, said by the owner, which no cutting of tools' output shortens.
  const { journal } = life(8, 300, ` ${'w'.repeat(3000)}`);
  const s = asleep(journal, [said(WIDE)], 1500);
  expect(await sleep({ ...s.deps, budgetChars: 6000 })).toBe('merged');
  const sent = s.seen[0]!;
  expect(sent.filter((m) => m.role === 'assistant').map((m) => m.content!.split('\n')[0])).toEqual(['Thing 0', 'Thing 1', 'Thing 2', 'Thing 3', 'Thing 4', 'Thing 5']);
  expect(sent.at(-1)!.content).toContain('Above stand 6 memories of yours');
  expect(JSON.stringify(sent)).not.toContain('wwww');
});

test('read again for a wider memory, what tools returned is cut short and the records nobody is shown are left out', async () => {
  clock = Date.parse('2026-11-01T00:00:00.000Z');
  const stretches = Array.from({ length: 6 }, (_, i) => [
    ev({ type: 'stimulus', source: 'terminal', text: `run job ${i}` }, LONG),
    ev({ type: 'assistant', text: '', toolCalls: [{ id: `c${i}`, name: 'bash', args: { command: `job ${i} ${'a'.repeat(3000)}` } }] }),
    ev({ type: 'tool.intent', callId: `c${i}`, name: 'bash', args: { command: `job ${i}` } }),
    ev({ type: 'tool.result', callId: `c${i}`, ok: true, output: `start ${'o'.repeat(40_000)} end` }),
    ev({ type: 'note', kind: 'budget.sent.v1', data: { secret: 'never shown to the model' } }),
    ev({ type: 'assistant', text: `job ${i} finished`, toolCalls: [] }),
  ]);
  const notes = stretches.map((st, i) => ev({ type: 'note', kind: EPISODE_KIND, data: { from: st[0]!.id, to: st[5]!.id, start: st[0]!.ts, end: st[5]!.ts, title: `Job ${i}`, text: `I ran job ${i}. ${'d'.repeat(400)}`, outcome: 'done' } }));
  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-merge-')), 'journal.jsonl');
  writeFileSync(journal, [...stretches.flat(), ...notes, ev({ type: 'stimulus', source: 'terminal', text: 'next' }, LONG)].map((e) => `${JSON.stringify(e)}\n`).join(''));
  const s = asleep(journal, [said(WIDE)], 1500);
  expect(await sleep({ ...s.deps, budgetChars: 30_000 })).toBe('merged');
  const sent = JSON.stringify(s.seen[0]);
  expect(sent.length).toBeLessThan(30_000);
  expect(sent).toContain('characters dropped here');
  expect(sent).toContain('job 3 finished');
  expect(sent).not.toContain('never shown to the model');
  // The tools' output was most of the stretch, and the count says so.
  expect((readEvents(journal).at(-1) as { data: { voices: { tools: number; owner: number } } }).data.voices.tools).toBeGreaterThan(240_000);
});

test('a memory of wider memories is formed from the memories of the single episodes beneath them', async () => {
  const { journal } = life(40);
  const seen: ChatMessage[][] = [];
  let i = 0;
  const provider: Provider = async (messages) => { seen.push(messages); return said(WIDE.replace('The first six things', `Wide ${i++}`)); };
  const deps = { journal, gen: 'g2', provider, specs: [], system: () => 'SYS', logbookChars: 2500, budgetChars: 100_000 };
  while (await sleep(deps) !== 'nothing' && seen.length < 30);
  const third = remembered(readEvents(journal)).merges.find((m) => m.level === 3)!;
  expect(third).toBeDefined();
  const asked = seen.find((messages) => messages.at(-1)!.content!.includes('Above stand') && messages.filter((m) => m.role === 'assistant').length === 36)!;
  // Thirty-six single episodes' memories, not the six wider ones.
  expect(asked.filter((m) => m.role === 'assistant').map((m) => m.content!.split('\n')[0]).slice(0, 3)).toEqual(['Thing 0', 'Thing 1', 'Thing 2']);
  expect(JSON.stringify(asked)).not.toContain('Wide 0');
});

test('a request then shows the wider memory in place of the six, and the later ones each on its own', async () => {
  const { journal, stretches } = life(8);
  await sleep(asleep(journal, [said(WIDE)], 1500).deps);
  const shown = buildMessages(readEvents(journal), 'S', 100_000, undefined, { tailChars: 0 }).map((m) => m.content!.split('\n')[0]);
  expect(shown.filter((line) => !line!.startsWith('[memory]'))).toEqual(['S', 'The first six things', 'Thing 6', 'Thing 7', 'and now?']);
  expect(shown[1]).toBe(`[memory] ${when(stretches[0]![0]!.ts)} to ${when(stretches[5]![1]!.ts)}. What do you remember of it?`);
});

test('the memories that were made into one are still found', async () => {
  const { journal, stretches } = life(8);
  await sleep(asleep(journal, [said(WIDE)], 1500).deps);
  const found = journalPast(journal).find('task3', { kinds: ['owner'] });
  expect(found[0]!.event.id).toBe(stretches[3]![0]!.id);
  expect(journalPast(journal).find('six things row', { kinds: ['memory'] })[0]!.event.type).toBe('note');
});

test('an episode still shown as it happened is not also told in a wider memory', async () => {
  const { journal } = life(8);
  await sleep(asleep(journal, [said(WIDE)], 1500).deps);
  // Room for everything: nothing is swapped, so the wider memory is not shown either.
  const shown = buildMessages(readEvents(journal), 'S', 100_000, undefined, { tailChars: 100_000 }).map((m) => m.content);
  expect(shown.join('\n')).not.toContain('The first six things');
});

test('a wider memory that will not come in form is made without a model, as a list of what its parts were called', async () => {
  const { journal, stretches } = life(8);
  const s = asleep(journal, [said('no'), said('still no')], 1500);
  expect(await sleep(s.deps)).toBe('merged');
  expect(s.seen).toHaveLength(2);
  expect(readEvents(journal).at(-1)).toMatchObject({
    kind: MERGE_KIND,
    data: { level: 2, mechanical: true, title: `6 stretches, ${when(stretches[0]![0]!.ts)} to ${when(stretches[5]![1]!.ts)}`, text: '- Thing 0\n- Thing 1\n- Thing 2\n- Thing 3\n- Thing 4\n- Thing 5' },
  });
});

test('sleeping goes on until the logbook fits, and wider memories are themselves made into wider ones', async () => {
  const { journal } = life(40);
  const s = asleep(journal, Array.from({ length: 20 }, (_, i) => said(WIDE.replace('The first six things', `Wide ${i}`))), 2500);
  const did: string[] = [];
  for (let i = 0; i < 20; i++) {
    const slept = await sleep(s.deps);
    did.push(slept);
    if (slept === 'nothing') break;
  }
  expect(did.at(-1)).toBe('nothing');
  const levels = remembered(readEvents(journal)).merges.map((m) => m.level);
  expect(levels.filter((l) => l === 2).length).toBeGreaterThanOrEqual(6);
  expect(levels).toContain(3);
  // The whole life is still in view: one request shows it from its first day, the old part briefly.
  const shown = buildMessages(readEvents(journal), 'S', 100_000, undefined, { tailChars: 0, logbookChars: 2500 }).map((m) => m.content);
  expect(shown[1]).toStartWith('[memory] 2026-11-01 00:30 UTC to ');
  expect(shown.join('\n')).not.toContain('earlier memories are not shown');
});

test('something that arrives while the model is asked wakes the agent, and nothing is written', async () => {
  const { journal } = life(8);
  const stop = new AbortController();
  const before = readEvents(journal).length;
  const provider: Provider = async () => { stop.abort(); return said(WIDE); };
  expect(await sleep({ journal, gen: 'g2', provider, specs: [], system: () => 'SYS', logbookChars: 1500, signal: stop.signal })).toBe('woken');
  expect(readEvents(journal)).toHaveLength(before);
});

test('a note that is not a whole wider memory is not one', () => {
  const bad = [
    ev({ type: 'note', kind: MERGE_KIND, data: { from: 'a', to: 'b', start: 's', end: 'e', title: 'T', text: 'x', outcome: 'done' } }),
    ev({ type: 'note', kind: MERGE_KIND, data: { from: 'a', to: 'b', start: 's', end: 'e', title: 'T', text: 'x', outcome: 'done', level: 1 } }),
  ];
  expect(remembered(bad).merges).toEqual([]);
});
