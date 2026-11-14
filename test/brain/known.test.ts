import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GAP_MS } from '../../brain/episodes';
import { readEvents, type EventBody, type JournalEvent } from '../../brain/journal';
import { DONE_KIND, FACT_KIND, FORGET_KIND, INTENTION_KIND, KNOWN_CHARS, byMark, known, knownText } from '../../brain/known';
import { buildMessages } from '../../brain/memory';
import { journalPast } from '../../brain/past';
import type { ChatMessage, Provider, Reply } from '../../brain/provider';
import { parseMemory, sleep } from '../../brain/sleep';
import { TOOLS, type ToolContext } from '../../body/tools';

let n = 0;
let clock = Date.parse('2026-11-11T08:00:00.000Z');
const ev = (body: EventBody, afterMs = 60_000): JournalEvent => {
  clock += afterMs;
  n += 1;
  // Ids as the journal makes them: the mark is cut from their first characters.
  return { v: 1, id: `${String(n).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`, ts: new Date(clock).toISOString(), gen: 'g1', ...body } as JournalEvent;
};
const LONG = GAP_MS + 1000;
const said = (text: string, afterMs?: number) => ev({ type: 'stimulus', source: 'terminal', text }, afterMs);
const replied = (text: string) => ev({ type: 'assistant', text, toolCalls: [] });
const fact = (text: string, source = 'owner', replaces?: string[]) => ev({ type: 'note', kind: FACT_KIND, data: { text, source, episode: 'e0', ...(replaces ? { replaces } : {}) } });
const intention = (text: string, due?: string) => ev({ type: 'note', kind: INTENTION_KIND, data: { text, ...(due ? { due } : {}) } });
function journalOf(events: JournalEvent[]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'teneral-known-')), 'journal.jsonl');
  writeFileSync(path, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  return path;
}

test('a fact holds until another names it as replaced, and what was replaced is not shown as holding', () => {
  const old = fact('Reports go to old@example.org');
  const other = fact('The owner prefers short answers');
  const now = fact('Reports go to new@example.org', 'owner', [old.id]);
  const held = known([old, other, now]);
  expect(held.facts.map((f) => f.text)).toEqual(['The owner prefers short answers', 'Reports go to new@example.org']);
  expect(held.facts[1]).toMatchObject({ source: 'owner', replaces: [old.id], mark: `F${now.id.slice(0, 8)}` });
  // Before the replacement was written, the old one held: what was believed then can be read back.
  expect(known([old, other]).facts.map((f) => f.text)).toContain('Reports go to old@example.org');
});

test('an intention is open until a record says it was done, and a fact held until one says to forget it', () => {
  const a = intention('Send the weekly report to the owner', '2026-11-20');
  const b = intention('Ask about the staging quota');
  const f = fact('The staging cluster is in Frankfurt', 'seen');
  const events = [a, b, f, ev({ type: 'note', kind: DONE_KIND, data: { intention: a.id, how: 'sent' } }), ev({ type: 'note', kind: FORGET_KIND, data: { ids: [f.id], why: 'wrong' } })];
  expect(known(events)).toEqual({ facts: [], intentions: [expect.objectContaining({ text: 'Ask about the staging quota', mark: `I${b.id.slice(0, 8)}` })] });
  expect(known([a]).intentions[0]).toMatchObject({ due: '2026-11-20' });
});

test('a note that is not a whole fact or intention is not one', () => {
  const bad = [
    ev({ type: 'note', kind: FACT_KIND, data: { text: 'x', source: 'rumour', episode: 'e' } }),
    ev({ type: 'note', kind: FACT_KIND, data: { text: '', source: 'owner', episode: 'e' } }),
    ev({ type: 'note', kind: FACT_KIND, data: { text: 'no episode', source: 'owner' } }),
    ev({ type: 'note', kind: INTENTION_KIND, data: { text: 7 } }),
    ev({ type: 'note', kind: FACT_KIND, data: 'a fact' }),
  ];
  expect(known(bad)).toEqual({ facts: [], intentions: [] });
  expect(known([ev({ type: 'note', kind: INTENTION_KIND, data: { text: 'do it some day', due: 'soon' } })]).intentions[0]!.due).toBeUndefined();
});

test('a mark names one thing that holds, and nothing else', () => {
  const f = fact('The owner is in Lisbon');
  const i = intention('Check the mail tomorrow');
  const held = known([f, i]);
  expect(byMark(held, held.facts[0]!.mark)?.id).toBe(f.id);
  expect(byMark(held, ` ${held.intentions[0]!.mark} `)?.id).toBe(i.id);
  expect(byMark(held, f.id)?.id).toBe(f.id);
  expect(byMark(held, 'F00000000')).toBeNull();
});

test('what is known is shown with marks and sources, and an intention whose day has come is said to be due', () => {
  const held = known([fact('The owner is in Lisbon'), fact('The API answers slowly at night', 'seen'), intention('Send the report', '2026-11-12'), intention('Renew the token', '2026-12-01'), intention('Tidy the notes')]);
  expect(knownText(held, '2026-11-12', '[memory]')!.split('\n')).toEqual([
    '[memory] What you mean to do, each with its mark:',
    `${held.intentions[0]!.mark} [due 2026-11-12, which has come] Send the report`,
    `${held.intentions[1]!.mark} [due 2026-12-01] Renew the token`,
    `${held.intentions[2]!.mark} Tidy the notes`,
    '[memory] What you know, each with its mark and where it comes from:',
    `${held.facts[0]!.mark} [owner] The owner is in Lisbon`,
    `${held.facts[1]!.mark} [seen] The API answers slowly at night`,
  ]);
  expect(knownText({ facts: [], intentions: [] }, '2026-11-12', '[memory]')).toBeNull();
});

test('when the facts outgrow their room, the newest are shown and a line says how many are not', () => {
  const held = known(Array.from({ length: 200 }, (_, i) => fact(`Fact number ${i}: ${'x'.repeat(80)}`)));
  const text = knownText(held, '2026-11-12', '[memory]')!;
  expect(text.length).toBeLessThan(KNOWN_CHARS + 200);
  expect(text).toMatch(/\(\d+ older ones are not shown; `recall` finds them\)/);
  expect(text).toContain('Fact number 199:');
  expect(text).not.toContain('Fact number 0:');
});

test('every request shows what is known, also while nothing has been swapped for a memory', () => {
  const events = [said('hello'), fact('The owner is in Lisbon'), replied('hi'), said('where am I?')];
  const shown = buildMessages(events, 'S').map((m) => m.content);
  expect(shown[1]).toStartWith('[memory] What you know');
  expect(shown.slice(2)).toEqual(['hello', 'hi', 'where am I?']);
  // With nothing known, a request is as it always was.
  expect(buildMessages([events[0]!, events[2]!, events[3]!], 'S').map((m) => m.content)).toEqual(['S', 'hello', 'hi', 'where am I?']);
});

test('a fact is found by recall like a memory', () => {
  const f = fact('Отчёты слать на reports@example.org');
  const found = journalPast(journalOf([said('привет'), f])).find('отчёты');
  expect(found.map((x) => [x.event.id, x.kind])).toEqual([[f.id, 'memory']]);
});

const MEMORY = 'Title: The reports\nOutcome: done\n\nMy owner told me where reports go and asked for one every Friday. I noted both.';

test('the two lists after a memory are read line by line, and a line that is not in form is left out', () => {
  const formed = parseMemory(`${MEMORY}\n\nFacts:\n- [owner] Reports go to reports@example.org\n- [OWNER] (replaces F1a2b3c4, Fdeadbeef) The owner wants answers in Russian\n- [gossip] The moon is cheese\n- no brackets here\n- [seen] short\n\n**Intentions:**\n- [2026-11-20] Send the weekly report\n- [] Ask about the staging quota\n- [friday] Something with a day that is not a day\n`, 600);
  expect(formed).toEqual({
    title: 'The reports', outcome: 'done',
    text: 'My owner told me where reports go and asked for one every Friday. I noted both.',
    facts: [
      { source: 'owner', text: 'Reports go to reports@example.org', replaces: [] },
      { source: 'owner', text: 'The owner wants answers in Russian', replaces: ['F1a2b3c4', 'Fdeadbeef'] },
    ],
    intentions: [{ text: 'Send the weekly report', due: '2026-11-20' }, { text: 'Ask about the staging quota' }],
  });
});

test('lists with nothing in form leave the memory as it is, and no list is no error', () => {
  expect(parseMemory(`${MEMORY}\n\nFacts:\nnone\nIntentions:\nnone`, 600)).toMatchObject({ facts: [], intentions: [], text: expect.stringContaining('I noted both.') });
  expect(parseMemory(MEMORY, 600)).toMatchObject({ facts: [], intentions: [] });
});

/** A journal with one episode that is over, and a provider answering from `replies`. */
function asleep(before: JournalEvent[], replies: Reply[]) {
  const first = [said('reports go to new@example.org from now on, and send me one every Friday'), replied('Noted both.')];
  const journal = journalOf([...before, ...first, said('thanks', LONG)]);
  const seen: ChatMessage[][] = [];
  const provider: Provider = async (messages) => { seen.push(messages); return replies.shift()!; };
  return { journal, first, seen, deps: { journal, gen: 'g2', provider, specs: [], system: () => 'SYS' } };
}

test('a memory sets down its facts and intentions as notes of their own, each naming its episode', async () => {
  const s = asleep([], [{ text: `${MEMORY}\n\nFacts:\n- [owner] Reports go to new@example.org\n\nIntentions:\n- [2026-11-13] Send the weekly report`, toolCalls: [] }]);
  expect(await sleep(s.deps)).toBe('remembered');
  const held = known(readEvents(s.journal));
  expect(held.facts).toEqual([expect.objectContaining({ text: 'Reports go to new@example.org', source: 'owner', episode: s.first[0]!.id })]);
  expect(held.intentions).toEqual([expect.objectContaining({ text: 'Send the weekly report', due: '2026-11-13', episode: s.first[0]!.id })]);
  // The memory itself is kept without the lists.
  const memory = readEvents(s.journal).find((e) => e.type === 'note' && e.kind === 'memory.episode.v1') as { data: Record<string, unknown> };
  expect(memory.data.text).toBe('My owner told me where reports go and asked for one every Friday. I noted both.');
  expect(memory.data).not.toHaveProperty('facts');
});

test('the request shows the facts already held with their marks, and a new fact can replace one by its mark', async () => {
  const old = fact('Reports go to old@example.org');
  const mark = known([old]).facts[0]!.mark;
  const s = asleep([old], [{ text: `${MEMORY}\n\nFacts:\n- [owner] (replaces ${mark}, Fnothing0) Reports go to new@example.org`, toolCalls: [] }]);
  await sleep(s.deps);
  expect(s.seen[0]!.map((m) => m.content).join('\n')).toContain(`${mark} [owner] Reports go to old@example.org`);
  const held = known(readEvents(s.journal));
  expect(held.facts.map((f) => f.text)).toEqual(['Reports go to new@example.org']);
  // The mark that named nothing replaced nothing.
  expect(held.facts[0]!.replaces).toEqual([old.id]);
});

test('what the agent took on itself in a later turn is not part of what it knew when an earlier episode ended', async () => {
  const s = asleep([], [{ text: MEMORY, toolCalls: [] }]);
  writeFileSync(s.journal, `${JSON.stringify(intention('Something promised only yesterday'))}\n`, { flag: 'a' });
  await sleep(s.deps);
  expect(s.seen[0]!.map((m) => m.content).join('\n')).not.toContain('Something promised only yesterday');
});

const tool = (name: string) => TOOLS.find((t) => t.spec.name === name)!;
const context = (journal: string): ToolContext => ({ workspace: '/tmp', journal, gen: 'g', mutationCommit: null, id: 'me', inbox: '/tmp/none', peers: '/tmp/none.json' });

test('intend takes something on, done closes it by its mark', async () => {
  const ctx = context(journalOf([said('remind me')]));
  const out = await tool('intend').run({ text: 'Send the weekly report to the owner', due: '2026-11-20' }, ctx);
  const [open] = known(readEvents(ctx.journal)).intentions;
  expect(out).toBe(`Taken on as ${open!.mark}, due 2026-11-20. It stays in front of you until you call done for it.`);
  expect(buildMessages(readEvents(ctx.journal), 'S')[1]!.content).toContain(`${open!.mark} [due 2026-11-20] Send the weekly report to the owner`);

  await expect(tool('done').run({ intention: 'I00000000', how: 'x' }, ctx)).rejects.toThrow(`Open: ${open!.mark}`);
  expect(await tool('done').run({ intention: open!.mark, how: 'sent it' }, ctx)).toBe(`Closed ${open!.mark}: Send the weekly report to the owner`);
  expect(known(readEvents(ctx.journal)).intentions).toEqual([]);
  await expect(tool('intend').run({ text: 'soon' }, ctx)).rejects.toThrow('understood on its own');
  await expect(tool('intend').run({ text: 'Send the weekly report', due: 'friday' }, ctx)).rejects.toThrow('YYYY-MM-DD');
});

test('forget stops holding a fact, and only a fact', async () => {
  const f = fact('The owner is in Lisbon');
  const i = intention('Check the mail tomorrow');
  const ctx = context(journalOf([f, i]));
  const held = known([f, i]);
  await expect(tool('forget').run({ fact: held.intentions[0]!.mark, why: 'x' }, ctx)).rejects.toThrow('no fact you hold');
  expect(await tool('forget').run({ fact: held.facts[0]!.mark, why: 'they moved' }, ctx)).toBe('No longer held: The owner is in Lisbon');
  expect(known(readEvents(ctx.journal))).toMatchObject({ facts: [], intentions: [{ text: 'Check the mail tomorrow' }] });
});
