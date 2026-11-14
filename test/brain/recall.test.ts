import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GAP_MS } from '../../brain/episodes';
import type { EventBody, JournalEvent } from '../../brain/journal';
import { journalPast, openPast, shown, timeline, when, type Past } from '../../brain/past';
import { documentOf, postings, queryTerms, recall, scanIndex, words } from '../../brain/recall';
import { EPISODE_KIND } from '../../brain/remembered';
import { TOOLS, type ToolContext } from '../../body/tools';
import { library } from './rayforce';

let n = 0;
let clock = Date.parse('2026-11-11T08:00:00.000Z');
const ev = (body: EventBody, afterMs = 60_000): JournalEvent => {
  clock += afterMs;
  return { v: 1, id: `r${++n}`, ts: new Date(clock).toISOString(), gen: 'g1', ...body } as JournalEvent;
};
const LONG = GAP_MS + 1000;
const said = (text: string, afterMs?: number, source = 'terminal') => ev({ type: 'stimulus', source, text }, afterMs);
const replied = (text: string) => ev({ type: 'assistant', text, toolCalls: [] });
function journalOf(events: JournalEvent[]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'teneral-recall-')), 'journal.jsonl');
  writeFileSync(path, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  return path;
}

/** A small life: mail set up on one day, a deploy that failed on the next, and a memory of the first. */
function life() {
  clock = Date.parse('2026-11-11T08:00:00.000Z');
  const mail = [
    said('Настрой, пожалуйста, почту. Адрес для отчётов: reports@example.org'),
    replied('Почта настроена, тестовое письмо дошло. Я проверила почту дважды и ещё раз проверила почту, почта работает, почта в порядке.'),
  ];
  const deploy = [
    said('deploy the billing service to staging', LONG),
    ev({ type: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'kubectl apply -f billing.yaml' } }] }),
    ev({ type: 'tool.intent', callId: 'c1', name: 'bash', args: { command: 'kubectl apply -f billing.yaml' } }),
    ev({ type: 'tool.result', callId: 'c1', ok: false, output: 'error: quota exceeded in namespace staging' }),
    replied('The deploy failed: the staging namespace is over its quota.'),
  ];
  const memory = ev({ type: 'note', kind: EPISODE_KIND, data: { from: mail[0]!.id, to: mail[1]!.id, start: mail[0]!.ts, end: mail[1]!.ts, title: 'Почта для отчётов', text: 'Владелец попросил настроить почту и назвал адрес reports@example.org. Я настроила.', outcome: 'done' } });
  const now = [said('what next?', LONG)];
  const events = [...mail, ...deploy, memory, ...now];
  return { mail, deploy, memory, events, journal: journalOf(events) };
}

test('words are runs of letters and digits of any script, lower-cased', () => {
  expect(words('Привет, Mica! Deploy v2 → «Почту» настроить; ok')).toEqual(['привет', 'mica', 'deploy', 'v2', 'почту', 'настроить', 'ok']);
  expect(words('a ! ?')).toEqual([]);
});

test('a long word is also looked for by its beginning, so forms of one word find each other', () => {
  expect(queryTerms('почта почту Почтовый')).toEqual(['почта', 'почт~', 'почту', 'почтовый']);
  expect(queryTerms('mail')).toEqual(['mail']);
});

test('a term weighs more the more often it is in its document, less in a long document, and a beginning weighs half', () => {
  const short = Object.fromEntries(postings('billing billing quota').map((p) => [p.term, p.w]));
  expect(short.billing!).toBeGreaterThan(short.quota!);
  expect(short['bill~']!).toBeCloseTo(short.billing! / 2, 10);
  const long = Object.fromEntries(postings(`billing ${'filler words here '.repeat(100)}`).map((p) => [p.term, p.w]));
  expect(long.billing!).toBeLessThan(short.quota!);
});

test('an event is a document when it says something, of a kind by who said it', () => {
  const { mail, deploy, memory } = life();
  expect(documentOf(mail[0]!)).toMatchObject({ kind: 'owner' });
  expect(documentOf(said('ping', 0, 'agent:zulip'))).toMatchObject({ kind: 'heard', text: 'ping' });
  expect(documentOf(mail[1]!)).toMatchObject({ kind: 'reply' });
  expect(documentOf(deploy[2]!)).toEqual({ kind: 'did', text: '{"command":"kubectl apply -f billing.yaml"}' });
  expect(documentOf(deploy[3]!)).toMatchObject({ kind: 'tool' });
  expect(documentOf(memory)).toEqual({ kind: 'memory', text: 'Почта для отчётов\nВладелец попросил настроить почту и назвал адрес reports@example.org. Я настроила.' });
  // A call with no text, a record of the stem, and a stretch in which nothing happened say nothing.
  expect(documentOf(deploy[1]!)).toBeNull();
  expect(documentOf(ev({ type: 'generation.ready', commit: 'c' }))).toBeNull();
  expect(documentOf(ev({ type: 'note', kind: EPISODE_KIND, data: { title: 'A quiet stretch', text: 'Nothing.', outcome: 'quiet' } }))).toBeNull();
});

/** Every way of asking the past that can be tested here: always the journal read through, and the store when there is a library. */
const ways: [string, (journal: string) => Past][] = [['the journal read through', journalPast]];
// One runtime a process: the store's way shares the one the other tests use, through openPast's own opening when none is open yet.
if (library !== null) ways.push(['the store', (journal) => openPastShared(journal)]);
function openPastShared(journal: string): Past {
  // brain/past.ts opens a runtime of its own; the tests have one already, so the store is opened over that.
  const { ray } = require('./rayforce') as typeof import('./rayforce');
  const { openStore } = require('../../brain/store') as typeof import('../../brain/store');
  const store = openStore(ray(), journal);
  const real = journalPast(journal);
  return {
    ...real, by: 'store',
    asked: () => real.asked(),
    find(question, options) {
      store.sync();
      return recall(store.index, question, options).flatMap((hit) => { const event = store.read(hit.doc); return event === null ? [] : [{ ...hit, event }]; });
    },
  };
}

for (const [name, open] of ways) {
  test(`${name}: with the same words in both, what the owner said comes before what the agent said, and a memory before either`, () => {
    const { mail, deploy, memory, journal } = life();
    const past = open(journal);
    // Both hold "deploy" and "staging" once; the owner's sentence is the one that counts for more.
    expect(past.find('deploy staging', { kinds: ['owner', 'reply'] }).map((f) => [f.event.id, f.kind])).toEqual([[deploy[0]!.id, 'owner'], [deploy[4]!.id, 'reply']]);
    const found = past.find('почта');
    expect(found[0]!.event.id).toBe(memory.id);
    expect(found.map((f) => f.event.id).sort()).toEqual([mail[0]!.id, mail[1]!.id, memory.id].sort());
  });

  test(`${name}: another form of the word finds it too`, () => {
    const { mail, journal } = life();
    expect(open(journal).find('почтовый ящик', { kinds: ['owner'] }).map((f) => f.event.id)).toEqual([mail[0]!.id]);
  });

  test(`${name}: the rare word decides, and a search can be narrowed to a kind`, () => {
    const { deploy, journal } = life();
    const past = open(journal);
    expect(past.find('quota staging')[0]!.event.id).toBe(deploy[3]!.id);
    expect(past.find('billing', { kinds: ['did'] }).map((f) => f.event.id)).toEqual([deploy[2]!.id]);
    expect(past.find('billing', { limit: 1 })).toHaveLength(1);
    expect(past.find('nothing-like-this-anywhere')).toEqual([]);
    expect(past.find('!!!')).toEqual([]);
  });
}

test('the database and the journal read through give the same answers in the same order', () => {
  if (library === null) return;
  const { journal } = life();
  const [a, b] = [journalPast(journal), openPastShared(journal)];
  for (const question of ['почта', 'quota staging billing', 'deploy', 'адрес для отчётов', 'what next']) {
    expect(b.find(question).map((f) => [f.event.id, f.score.toFixed(9)])).toEqual(a.find(question).map((f) => [f.event.id, f.score.toFixed(9)]));
  }
});

test('an index over lines reads them again only when there are more', () => {
  let calls = 0;
  const { events } = life();
  const lines = events.map((event, i) => ({ event, off: i * 100 }));
  const index = scanIndex(() => { calls += 1; return lines; });
  recall(index, 'почта');
  recall(index, 'quota');
  expect(calls).toBeGreaterThan(0);
  expect(index.documents()).toBe(8);
});

test('the events around one are given in order, with where it stands among them', () => {
  const { deploy, journal, events } = life();
  const past = journalPast(journal);
  const around = past.around(deploy[3]!.id, 2, 1)!;
  expect(around.events.map((e) => e.id)).toEqual([deploy[1]!.id, deploy[2]!.id, deploy[3]!.id, deploy[4]!.id]);
  expect(around.at).toBe(2);
  expect(past.around(events[0]!.id, 5, 0)).toEqual({ events: [events[0]!], at: 0 });
  expect(past.around('no-such-id', 1, 1)).toBeNull();
});

test('without a library, or with one that is not there, the past is asked of the journal', () => {
  const { journal } = life();
  const said: string[] = [];
  expect(openPast(journal, null).by).toBe('journal');
  expect(openPast(journal, '/no/such/librayforce.so', (line) => said.push(line)).by).toBe('journal');
  expect(said).toEqual([]);
});

test('an event is shown with its time, who it was, its id, and its text cut to size', () => {
  const { mail, deploy, memory } = life();
  expect(shown(mail[0]!, 100)).toBe(`[${when(mail[0]!.ts)}] your owner (event ${mail[0]!.id}):\nНастрой, пожалуйста, почту. Адрес для отчётов: reports@example.org`);
  expect(shown(deploy[1]!, 100)).toBe(`[${when(deploy[1]!.ts)}] you (and called bash) (event ${deploy[1]!.id})`);
  expect(shown(deploy[3]!, 100)).toStartWith(`[${when(deploy[3]!.ts)}] the tool failed (event `);
  expect(shown(memory, 100)).toStartWith(`[${when(memory.ts)}] your memory (event `);
  expect(shown(said('x'.repeat(5000)), 200).length).toBeLessThan(400);
});

test('the timeline lists episodes in order with what is remembered of each, and can be cut to a stretch of time', () => {
  const { mail, deploy, journal } = life();
  const all = timeline(journal);
  expect(all.map((t) => [t.episode.first, t.title, t.outcome, t.episode.closed])).toEqual([
    [mail[0]!.id, 'Почта для отчётов', 'done', true],
    [deploy[0]!.id, null, null, true],
    [all[2]!.episode.first, null, null, false],
  ]);
  expect(timeline(journal, deploy[0]!.ts, deploy[4]!.ts).map((t) => t.episode.first)).toEqual([deploy[0]!.id]);
  expect(() => timeline(journal, 'last tuesday')).toThrow('must be times');
});

const tool = (name: string) => TOOLS.find((t) => t.spec.name === name)!;
const context = (journal: string): ToolContext => ({ workspace: '/tmp', journal, gen: 'g', mutationCommit: null, id: 'me', inbox: '/tmp/none', peers: '/tmp/none.json' });

test('the recall tool gives what it found as events with their ids, and says so when it found nothing', async () => {
  const { mail, memory, journal } = life();
  const ctx = context(journal);
  const out = await tool('recall').run({ query: 'адрес для отчётов' }, ctx);
  expect(out).toContain(`your owner (event ${mail[0]!.id})`);
  expect(out).toContain('reports@example.org');
  expect(await tool('recall').run({ query: 'почта', in: 'memories', limit: '5' }, ctx)).toStartWith(`[${when(memory.ts)}] your memory`);
  expect(await tool('recall').run({ query: 'zzzzqqqq' }, ctx)).toContain('Nothing in your journal holds these words');
  await expect(tool('recall').run({ query: 'x', in: 'dreams' }, ctx)).rejects.toThrow('in must be one of');
  await expect(tool('recall').run({ query: 'x', limit: 'many' }, ctx)).rejects.toThrow('whole number');
});

test('what the agent is answering right now is not given back to it as a find', async () => {
  const { journal } = life();
  // "what next?" is the latest thing said; it holds the very words asked for.
  expect(journalPast(journal).find('what next').map((f) => f.kind)).toEqual(['owner']);
  expect(await tool('recall').run({ query: 'what next' }, context(journal))).toContain('Nothing in your journal holds these words');
});

test('the open tool shows the journal word for word around an event and marks the one asked for', async () => {
  const { deploy, journal } = life();
  const out = await tool('open').run({ event: deploy[3]!.id, before: '1', after: '1' }, context(journal));
  const parts = out.split('\n\n');
  expect(parts).toHaveLength(3);
  expect(parts[1]).toStartWith(`>> [${when(deploy[3]!.ts)}] the tool failed`);
  expect(parts[1]).toContain('quota exceeded');
  expect(parts[0]).toContain('you called bash');
  await expect(tool('open').run({ event: 'nope' }, context(journal))).rejects.toThrow('no event in your journal has the id nope');
});

test('the timeline tool lists episodes a line each', async () => {
  const { mail, deploy, journal } = life();
  const lines = (await tool('timeline').run({}, context(journal))).split('\n');
  expect(lines[0]).toBe(`${when(mail[0]!.ts)} to ${when(mail[1]!.ts)}  done: Почта для отчётов  (event ${mail[0]!.id})`);
  expect(lines[1]).toMatch(new RegExp(`not remembered yet, \\d+ characters  \\(event ${deploy[0]!.id}\\)$`));
  expect(lines[2]).toContain('going on now');
  expect(await tool('timeline').run({ from: '2030-01-01' }, context(journal))).toBe('No episode of yours falls in that time.');
});
