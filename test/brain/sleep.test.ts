import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GAP_MS } from '../../brain/episodes';
import { readEvents, type EventBody, type JournalEvent } from '../../brain/journal';
import { ProviderError, type ChatMessage, type Provider, type Reply } from '../../brain/provider';
import { OUTDATED_KIND, outdatedStretches } from '../../brain/links';
import { journalPast } from '../../brain/past';
import { EPISODE_KIND, QUARANTINE_KIND, remembered } from '../../brain/remembered';
import { memoryHealth, parseMemory, question, sleep, targetChars, waiting } from '../../brain/sleep';

let n = 0;
let clock = Date.parse('2026-11-11T00:00:00.000Z');
function ev(body: EventBody, afterMs = 1000): JournalEvent {
  n += 1;
  clock += afterMs;
  return { v: 1, id: `s${n}`, ts: new Date(clock).toISOString(), gen: 'g1', ...body } as JournalEvent;
}
const LONG = GAP_MS + 1000;
const said = (text: string, afterMs?: number, source = 'terminal') => ev({ type: 'stimulus', source, text }, afterMs);
const replied = (text: string) => ev({ type: 'assistant', text, toolCalls: [] });

/** A journal on disk holding `events`, a provider that answers from `replies`, and what it was sent. */
function setup(events: JournalEvent[], replies: (Reply | Error)[]) {
  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-sleep-')), 'journal.jsonl');
  writeFileSync(journal, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  const seen: ChatMessage[][] = [];
  const provider: Provider = async (messages) => {
    seen.push(messages);
    const next = replies.shift();
    if (next === undefined) throw new Error('the script ran out of replies');
    if (next instanceof Error) throw next;
    return next;
  };
  return { journal, seen, deps: { journal, gen: 'g2', provider, specs: [], system: () => 'SYS' } };
}

const MEMORY = 'Title: Setting up the mail\nOutcome: done\n\nMy owner asked me to set up the mail and said "use the work address". I did, and it works.';
const answer = (text: string): Reply => ({ text, toolCalls: [] });
/** Two episodes, the first one over, with something really said in it. */
const twoEpisodes = () => {
  const first = [said('please set up the mail, use the work address'), replied('It is set up and a test message arrived.')];
  const second = [said('thanks, now the calendar', LONG), replied('On it.')];
  return { first, second, events: [...first, ...second] };
};

test('nothing waits while the only episode is still going on', async () => {
  const s = setup([said('hi'), replied('hello')], []);
  expect(await sleep(s.deps)).toBe('nothing');
  expect(s.seen).toHaveLength(0);
});

test('an episode that is over is remembered: the reply is journaled as a note about exactly that stretch', async () => {
  const { first, events } = twoEpisodes();
  const s = setup(events, [answer(MEMORY)]);

  expect(await sleep(s.deps)).toBe('remembered');

  const note = readEvents(s.journal).at(-1)!;
  expect(note).toMatchObject({
    type: 'note', kind: EPISODE_KIND, gen: 'g2',
    data: {
      from: first[0]!.id, to: first[1]!.id, start: first[0]!.ts, end: first[1]!.ts,
      title: 'Setting up the mail', outcome: 'done',
      text: 'My owner asked me to set up the mail and said "use the work address". I did, and it works.',
      // Whose words the stretch was made of: counted from the journal.
      voices: { owner: 44, others: 0, tools: 0, own: 40 },
    },
  });
  expect(await sleep(s.deps)).toBe('nothing');
});

test('the memory is formed as of the end of the episode: nothing that came later is in the request', async () => {
  const { events } = twoEpisodes();
  const s = setup(events, [answer(MEMORY)]);
  await sleep(s.deps);

  const sent = JSON.stringify(s.seen[0]);
  expect(sent).toContain('use the work address');
  expect(sent).not.toContain('now the calendar');
  // The request ends with the question, which says where the stretch begins.
  const last = s.seen[0]!.at(-1)!;
  expect(last.role).toBe('user');
  expect(last.content).toContain('begins with the message that starts "please set up the mail');
});

test('what was remembered before is sent as memories, and only the episode itself as it happened', async () => {
  const a = [said('first thing to do, please'), replied('Done the first thing as asked.')];
  const b = [said('second thing to do, please', LONG), replied('Done the second thing as asked.')];
  const s = setup([...a, ...b, said('third', LONG)], [answer(MEMORY), answer(MEMORY.replace('the mail', 'the second'))]);
  await sleep(s.deps);
  await sleep(s.deps);

  const second = s.seen[1]!.map((m) => m.content);
  expect(second[0]).toBe('SYS');
  expect(second[1]).toStartWith('[memory] ');
  expect(second[2]).toStartWith('Setting up the mail\n\n');
  expect(second[3]).toBe('[memory] What follows is shown as it happened.');
  expect(second.slice(4, 6)).toEqual(['second thing to do, please', 'Done the second thing as asked.']);
  // The first episode is paid for once, when it is remembered, and not again with every later memory.
  expect(second.join('')).not.toContain('first thing to do');
  expect(second).toHaveLength(7);
});

test('usage the provider reported is kept with the memory', async () => {
  const s = setup(twoEpisodes().events, [{ ...answer(MEMORY), usage: { input: 100, output: 20, cached: 90 } }]);
  await sleep(s.deps);
  expect((readEvents(s.journal).at(-1) as { data: { usage: unknown } }).data.usage).toEqual({ input: 100, output: 20, cached: 90 });
});

test('an answer that is not in the form asked for is asked for once more, with the reason', async () => {
  const s = setup(twoEpisodes().events, [answer('I would rather not.'), answer(MEMORY)]);
  expect(await sleep(s.deps)).toBe('remembered');
  expect(s.seen).toHaveLength(2);
  expect(s.seen[1]!.at(-2)).toEqual({ role: 'assistant', content: 'I would rather not.' });
  expect(s.seen[1]!.at(-1)!.content).toContain('the first line was not "Title: ..."');
});

test('a tool call is not a memory', async () => {
  const s = setup(twoEpisodes().events, [{ text: '', toolCalls: [{ id: 'c', name: 'bash', args: {} }] }, answer(MEMORY)]);
  expect(await sleep(s.deps)).toBe('remembered');
  expect(s.seen[1]!.at(-1)!.content).toContain('a tool was called');
});

test('after two answers that cannot be kept, the stretch is recorded as one no memory could be formed of', async () => {
  const { first, events } = twoEpisodes();
  const s = setup(events, [answer('no'), answer('still no')]);

  expect(await sleep(s.deps)).toBe('quarantined');

  expect(readEvents(s.journal).at(-1)).toMatchObject({
    type: 'note', kind: QUARANTINE_KIND, data: { from: first[0]!.id, to: first[1]!.id, reason: 'the first line was not "Title: ..."' },
  });
  // It is not asked about again.
  expect(await sleep(s.deps)).toBe('nothing');
  expect(memoryHealth(readEvents(s.journal))).toMatchObject({ remembered: 0, waiting: 0, quarantined: 1 });
});

test('a failed request writes nothing and the episode waits on', async () => {
  const s = setup(twoEpisodes().events, [new ProviderError('provider could not be reached', null)]);
  await expect(sleep(s.deps)).rejects.toThrow('could not be reached');
  expect(readEvents(s.journal)).toHaveLength(4);
  expect(waiting(readEvents(s.journal))).toHaveLength(1);
});

test('a request the provider finds too long is made once more with half the room', async () => {
  const s = setup(twoEpisodes().events, [new ProviderError('context length exceeded', 400, 'context_length_exceeded'), answer(MEMORY)]);
  expect(await sleep({ ...s.deps, budgetChars: 10_000 })).toBe('remembered');
  expect(s.seen).toHaveLength(2);
});

test('something that arrives while the model is asked wakes the agent: nothing is written', async () => {
  const { events } = twoEpisodes();
  const stop = new AbortController();
  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-sleep-')), 'journal.jsonl');
  writeFileSync(journal, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  const provider: Provider = async () => {
    stop.abort();
    return answer(MEMORY);
  };
  expect(await sleep({ journal, gen: 'g2', provider, specs: [], system: () => 'SYS', signal: stop.signal })).toBe('woken');
  expect(readEvents(journal)).toHaveLength(4);
});

test('an episode in which nothing happened is recorded as quiet without asking the model', async () => {
  const quiet = [said('Clock tick.', 1000, 'clock'), replied('Nothing to do.')];
  const s = setup([...quiet, said('hello', LONG), replied('hi')], []);

  expect(await sleep(s.deps)).toBe('quiet');

  expect(s.seen).toHaveLength(0);
  expect(readEvents(s.journal).at(-1)).toMatchObject({ kind: EPISODE_KIND, data: { outcome: 'quiet', from: quiet[0]!.id, to: quiet[1]!.id } });
});

test('episodes are remembered oldest first, one a call', async () => {
  const a = [said('first thing to do, please'), replied('Done the first thing as asked.')];
  const b = [said('second thing to do, please', LONG), replied('Done the second thing as asked.')];
  const c = [said('third', LONG)];
  const s = setup([...a, ...b, ...c], [answer(MEMORY), answer(MEMORY.replace('the mail', 'the second'))]);

  expect(await sleep(s.deps)).toBe('remembered');
  expect(memoryHealth(readEvents(s.journal))).toMatchObject({ remembered: 1, waiting: 1, oldest: b[1]!.ts });
  expect(await sleep(s.deps)).toBe('remembered');
  expect(await sleep(s.deps)).toBe('nothing');

  expect([...remembered(readEvents(s.journal)).memories.keys()]).toEqual([a[0]!.id, b[0]!.id]);
});

test('a memory is asked to be a small share of its episode, within bounds', () => {
  expect(targetChars(1000)).toBe(600);
  expect(targetChars(50_000)).toBe(2000);
  expect(targetChars(5_000_000)).toBe(4000);
});

test('the question names the times and what to keep', () => {
  const events = [said('  build\n the   thing  '), replied('ok')];
  const text = question({ id: 'x', from: 0, to: 2, first: 'a', last: 'b', start: '2026-11-11T10:00:05.000Z', end: '2026-11-11T10:20:00.000Z', chars: 10, why: 'start', closed: true }, events, 600);
  expect(text).toContain('from 2026-11-11 10:00 UTC to 2026-11-11 10:20 UTC');
  expect(text).toContain('starts "build the thing"');
  expect(text).toContain('about 600 characters');
});

test('a memory is read from the form asked for, with or without marks around the labels', () => {
  expect(parseMemory(MEMORY, 600)).toEqual({
    title: 'Setting up the mail', outcome: 'done',
    text: 'My owner asked me to set up the mail and said "use the work address". I did, and it works.',
    facts: [], intentions: [], done: [], questions: [], outdated: [], confirmed: [],
  });
  expect(parseMemory(`\n**Title:** A\n**Outcome:** Failed\n\n${'x'.repeat(50)}`, 600)).toMatchObject({ title: 'A', outcome: 'failed' });
});

test('what is not in that form is not a memory, and the reason is said', () => {
  const body = 'y'.repeat(60);
  expect(parseMemory(`Outcome: done\n\n${body}`, 600)).toEqual({ problem: 'the first line was not "Title: ..."' });
  expect(parseMemory(`Title: A\n\n${body}`, 600)).toMatchObject({ problem: expect.stringContaining('second line') });
  expect(parseMemory(`Title: A\nOutcome: quiet\n\n${body}`, 600)).toMatchObject({ problem: expect.stringContaining('second line') });
  expect(parseMemory('Title: A\nOutcome: done\n\nshort', 600)).toEqual({ problem: 'there was no memory after the two lines' });
  expect(parseMemory(`Title: A\nOutcome: done\n\n${'z'.repeat(2000)}`, 600)).toMatchObject({ problem: expect.stringContaining('far more than the 600') });
});

test('the earlier memories nearest to a stretch are shown when its memory is formed, and the one it names is recorded as outdated', async () => {
  const a = [said('please plan the release for November, the date is the 20th'), replied('The release is planned for November 20th.')];
  const b = [said('move the release to December, the date is now the 4th', LONG), replied('The release is moved to December 4th.')];
  const s = setup([...a, ...b, said('thanks', LONG)], [answer('Title: The release in November\nOutcome: done\n\nMy owner asked for the release on November 20th and I planned it so.')]);
  const deps = { ...s.deps, past: journalPast(s.journal) };
  await sleep(deps);
  const first = remembered(readEvents(s.journal)).memories.get(a[0]!.id)!;
  const mark = `M${first.id.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}`;

  const seen: ChatMessage[][] = [];
  await sleep({ ...deps, provider: async (messages) => {
    seen.push(messages);
    return answer(`Title: The release moved\nOutcome: done\n\nMy owner moved the release to December 4th.\n\nOutdated:\n- ${mark} the release is on December 4th, not November 20th\n- Mnosuch99 this names nothing that was shown`);
  } });

  const asked = seen[0]!.at(-1)!.content!;
  expect(asked).toContain(`${mark} (`);
  expect(asked).toContain('The release in November: My owner asked for the release on November 20th');
  const notes = readEvents(s.journal).filter((e) => e.type === 'note' && e.kind === OUTDATED_KIND);
  expect(notes.map((e) => (e as { data: unknown }).data)).toEqual([{ memory: a[0]!.id, by: b[0]!.id, why: 'the release is on December 4th, not November 20th' }]);
  expect(outdatedStretches(readEvents(s.journal)).get(a[0]!.id)).toEqual({ why: 'the release is on December 4th, not November 20th', since: b[0]!.ts });
});

test('with no past to look in, or no earlier memory near, nothing about outdating is asked', async () => {
  const { events } = twoEpisodes();
  const s = setup([...events, said('more', LONG)], [answer(MEMORY)]);
  await sleep({ ...s.deps, past: journalPast(s.journal) });
  expect(s.seen[0]!.at(-1)!.content).not.toContain('Outdated:');
  expect(parseMemory(`${MEMORY}\n\nOutdated:\n- Mabcd1234 something that no longer holds`, 400)).toMatchObject({ outdated: [{ mark: 'Mabcd1234', why: 'something that no longer holds' }] });
});

test('a forming memory may say that a fact it was shown still holds: that is journaled, and nothing is made of a mark that names no fact', async () => {
  const told = said('the staging host is alpha, remember it', LONG);
  const noted = replied('Noted.');
  const fact = ev({ type: 'note', kind: 'memory.fact.v1', data: { text: 'The staging host is alpha', source: 'owner', episode: told.id } });
  const first = ev({ type: 'note', kind: EPISODE_KIND, data: { from: told.id, to: noted.id, start: told.ts, end: noted.ts, title: 'The staging host', text: 'I was told the staging host.', outcome: 'done' } });
  const again = said('deploy to staging please', LONG);
  const did = replied('Deployed to alpha, as before.');
  const now = said('thanks', LONG);
  const mark = `F${fact.id.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}`;
  const s = setup([told, noted, fact, first, again, did, now], [answer(`${MEMORY}\n\nFacts:\n- [seen] (confirms ${mark})\n- [seen] (confirms Fnothing0)\n- [seen] The deploy takes four minutes on alpha`)]);
  expect(await sleep(s.deps)).toBe('remembered');
  const notes = readEvents(s.journal).filter((e) => e.type === 'note');
  expect(notes.filter((e) => e.type === 'note' && e.kind === 'memory.fact.confirmed.v1').map((e) => (e as { data: unknown }).data)).toEqual([{ fact: fact.id, episode: fact.id }]);
  // (The stretch being remembered begins with the notes written before it: they go with what follows them.)
  // The line that confirms is no fact of its own; the one beside it is.
  expect(notes.filter((e) => e.type === 'note' && e.kind === 'memory.fact.v1')).toHaveLength(2);
  // And the memory's own note holds nothing of the list.
  expect(JSON.stringify(notes.find((e) => e.type === 'note' && e.kind === EPISODE_KIND && (e.data as { from?: unknown }).from === fact.id))).not.toContain('confirmed');
});
