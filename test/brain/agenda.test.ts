import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PASSED_TICKS, REFLECTION_KIND, REFLECT_EVERY, REMIND_DAYS, SETTLE_KIND, STALE_DAYS, followUps, idleTicks, initiative, initiativeText, lookedAt, offered, ownSpend, parseLook, parseSettle, reflectQuestion, reflectionDue, reportAsk, settle, settleQuestion, tickDue, worthATick } from '../../brain/agenda';
import { GAP_MS } from '../../brain/episodes';
import { readEvents, type EventBody, type JournalEvent } from '../../brain/journal';
import { ALLOWED_KIND, DONE_KIND, INTENTION_KIND, WORK_KIND, agenda, known, knownText, ownerSaid } from '../../brain/known';
import type { ChatMessage, Provider, Reply } from '../../brain/provider';
import { EPISODE_KIND } from '../../brain/remembered';
import { sleep } from '../../brain/sleep';

let clock = Date.parse('2026-11-01T00:00:00.000Z');
let n = 0;
function ev(body: EventBody, afterMs = 1000): JournalEvent {
  clock += afterMs;
  n += 1;
  return { ...body, v: 1, id: `e${String(n).padStart(4, '0')}x`, ts: new Date(clock).toISOString(), gen: 'g1' } as JournalEvent;
}
const LONG = GAP_MS + 1000;
const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const DAY = 24 * 3_600_000;
/** `count` episodes that are over, each with its memory, and one going on. */
function life(count: number): JournalEvent[] {
  const stretches = Array.from({ length: count }, (_, i) => [
    ev({ type: 'stimulus', source: 'terminal', text: `please look into the flaky deploy number ${i}, it failed again` }, LONG),
    ev({ type: 'assistant', text: `I restarted deploy ${i} by hand and it went through.`, toolCalls: [] }),
  ]);
  const now = [ev({ type: 'stimulus', source: 'terminal', text: 'thanks' }, LONG), ev({ type: 'assistant', text: 'Any time.', toolCalls: [] })];
  const memories = stretches.map((s) => ev({ type: 'note', kind: EPISODE_KIND, data: { from: s[0]!.id, to: s[1]!.id, start: s[0]!.ts, end: s[1]!.ts, title: 'A flaky deploy', text: 'The deploy failed again and I restarted it by hand.', outcome: 'done' } }, 0));
  return [...stretches.flat(), ...now, ...memories];
}
function setup(events: JournalEvent[], replies: Reply[]) {
  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-agenda-')), 'journal.jsonl');
  writeFileSync(journal, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  const seen: ChatMessage[][] = [];
  const provider: Provider = async (messages) => {
    seen.push(messages);
    const next = replies.shift();
    if (next === undefined) throw new Error('the script ran out of replies');
    return next;
  };
  return { journal, seen, deps: { journal, gen: 'g2', provider, specs: [], system: () => 'SYS' } };
}
const answer = (text: string): Reply => ({ text, toolCalls: [] });
const intention = (text: string, more: Record<string, unknown> = {}) => ev({ type: 'note', kind: INTENTION_KIND, data: { text, ...more } });

test('the agent looks ahead only once enough has been remembered since it last did', () => {
  expect(reflectionDue(life(REFLECT_EVERY - 1))).toBe(false);
  const events = life(REFLECT_EVERY);
  expect(reflectionDue(events)).toBe(true);
  expect(reflectionDue([...events, ev({ type: 'note', kind: REFLECTION_KIND, data: {} })])).toBe(false);
});

test('an idle agenda with no own ideas gets a bounded look ahead, and a fresh look is not repeated', () => {
  const tick = () => ev({ type: 'stimulus', source: 'clock', text: 'Clock tick.' }, LONG);
  const idle = () => [tick(), ev({ type: 'assistant', text: 'Everything waits.', toolCalls: [] })];
  const waiting = intention('Wait for an external answer', { work: { status: 'waiting', next: 'Wait.', attempts: 0, resumeAt: 0 } });
  const events = [...idle(), ...idle(), ...idle(), waiting];
  expect(idleTicks(events)).toBe(PASSED_TICKS);
  expect(reflectionDue(events)).toBe(true);

  const looked = ev({ type: 'note', kind: REFLECTION_KIND, data: {} });
  expect(reflectionDue([...events, looked])).toBe(false);
  // The look is an idle wake; ticks after it must reach the threshold again.
  expect(reflectionDue([...events, looked, ...idle(), ...idle(), ...idle()])).toBe(true);

  // New memories keep the old trigger even when an existing own idea is open. With only waiting
  // commitments there is no own idea to advance, so the idle path remains available.
  expect(reflectionDue([...events, looked, intention('An open own idea', { origin: 'own' })])).toBe(false);
  const remembered = Array.from({ length: REFLECT_EVERY }, () => ev({ type: 'note', kind: EPISODE_KIND, data: { outcome: 'done' } }));
  expect(reflectionDue([...events, looked, ...remembered, intention('An open own idea', { origin: 'own' })])).toBe(true);
});

test('what it sets down when it looks ahead becomes intentions of its own, questions for its owner, and closes what is settled', async () => {
  const taken = intention('Send the owner the weekly deploy report');
  const events = [...life(REFLECT_EVERY), taken];
  const mark = known(events).intentions[0]!.mark;
  const s = setup(events, [answer(`Agenda:\n- [] Find why the deploy fails every time and fix the cause instead of restarting it\n- [2026-12-01] Check the certificate before it runs out\nAsk:\n- May I change the deploy script myself?\nDone:\n- ${mark} the report was sent on Friday`)]);
  expect(await sleep(s.deps)).toBe('reflected');
  expect(s.seen[0]!.at(-1)!.content).toContain('Think ahead, not back');
  const after = readEvents(s.journal);
  const held = known(after);
  expect(held.intentions.map((i) => [i.origin, i.due, i.text.slice(0, 20)])).toEqual([
    ['own', undefined, 'Find why the deploy '],
    ['own', '2026-12-01', 'Check the certificat'],
    ['ask', undefined, 'May I change the dep'],
  ]);
  expect(after.at(-1)).toMatchObject({ kind: REFLECTION_KIND, data: { own: 2, unsure: 0, asks: 1, closed: 1 } });
  // It looked: it is not asked again until more is remembered.
  expect(await sleep(s.deps)).toBe('nothing');
  expect(s.seen).toHaveLength(1);
});

test('"Nothing" is an answer, and one that is not in form is asked for once more and then let be', async () => {
  const nothing = setup(life(REFLECT_EVERY), [answer('Nothing')]);
  expect(await sleep(nothing.deps)).toBe('reflected');
  expect(known(readEvents(nothing.journal)).intentions).toEqual([]);

  const rambling = setup(life(REFLECT_EVERY), [answer('I think things are going well overall.'), answer('Still fine, really.')]);
  expect(await sleep(rambling.deps)).toBe('reflected');
  expect(rambling.seen).toHaveLength(2);
  expect(readEvents(rambling.journal).at(-1)).toMatchObject({ kind: REFLECTION_KIND, data: { failed: true } });
  expect(await sleep(rambling.deps)).toBe('nothing');
});

test('nothing set down is lost: every line in form is kept, and with many open the agent is told to close what no longer matters', async () => {
  expect(parseLook('Agenda:\n- [] one thing to be done\n- [] another thing to do\n- [] a third thing to do\n- [] a fourth thing to do')).toMatchObject({ own: { length: 4 } });
  expect(parseLook('no lists here')).toHaveProperty('problem');
  const many = Array.from({ length: 7 }, (_, i) => intention(`An idea of my own, number ${i}`, { origin: 'own' }));
  const s = setup([...life(REFLECT_EVERY), ...many], [answer('Agenda:\n- [] Yet another idea of my own to do\n- [] An idea of my own, number 3')]);
  expect(await sleep(s.deps)).toBe('reflected');
  expect(s.seen[0]!.at(-1)!.content).toContain('close under Done those that no longer matter');
  // The new one is kept; the one it holds already, word for word, is not set down twice.
  expect(known(readEvents(s.journal)).intentions).toHaveLength(8);
});

test('an idea the agent is not sure it may do waits for its owner: it is put to them, and their own words allow it', async () => {
  const s = setup(life(REFLECT_EVERY), [answer('Unsure:\n- Write to the hosting company about the failing deploys\nAsk:\n- [Ivan, in the deploy chat] Which region does the failing deploy run in?')]);
  expect(await sleep(s.deps)).toBe('reflected');
  let held = known(readEvents(s.journal));
  const idea = held.intentions.find((i) => i.unsure === true)!;
  expect(held.intentions.map((i) => [i.origin, i.waits, i.put, i.to])).toEqual([['own', true, false, undefined], ['ask', true, false, 'Ivan, in the deploy chat']]);
  // It is no part of the agenda, and a tick puts it first.
  expect(agenda(held, '2026-11-10')).toEqual([]);
  const tick = offered(held, NOW);
  expect(tick).toContain('First, what waits for an answer and is to be put now:');
  expect(tick).toContain(`${idea.mark} [an idea, may I? for your owner] [not yet asked] Write to the hosting company`);
  expect(tick).toContain('[for Ivan, in the deploy chat] [not yet asked] Which region');
  expect(tick).toContain('yours to choose');
  expect(knownText(held, '2026-11-10', '[memory]')).toContain(`${idea.mark} [an idea, may I? for your owner] [not yet asked] Write to the hosting company`);

  // Once the agent has said it, with its mark, it is asked; the tick does not ask for it again.
  const asked = ev({ type: 'assistant', text: `A question for you (${idea.mark}): may I write to the hosting company about the deploys?`, toolCalls: [] });
  const events = [...readEvents(s.journal), asked];
  held = known(events);
  expect(held.intentions.find((i) => i.id === idea.id)).toMatchObject({ waits: true, put: true });
  const at = Date.parse(asked.ts);
  expect(offered(held, at + 3_600_000)).not.toContain('Write to the hosting company');
  expect(knownText(held, '2026-11-10', '[memory]')).toContain(`[asked ${asked.ts.slice(0, 10)}, no answer yet] Write to the hosting company`);
  // With no answer for a day it is put again; then after three more, then seven; after that it is asked no more and stays where the owner sees it.
  expect(offered(held, at + REMIND_DAYS[0]! * DAY)).toContain('no answer yet: remind them] Write to the hosting company');
  const mention = (after: number) => ev({ type: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'zulip_reply', args: { text: `Reminder: ${idea.mark} is still waiting for your word.` } }] }, after);
  const second = mention(DAY);
  const twice = known([...events, second]);
  expect(offered(twice, Date.parse(second.ts) + 2 * DAY)).not.toContain('Write to the hosting company');
  expect(offered(twice, Date.parse(second.ts) + 3 * DAY)).toContain('remind them] Write to the hosting company');
  const [third, fourth] = [mention(3 * DAY), mention(7 * DAY)];
  const done = known([...events, second, third, fourth]);
  expect(done.intentions.find((i) => i.id === idea.id)).toMatchObject({ puts: 4, waits: true });
  expect(offered(done, Date.parse(fourth.ts) + 60 * DAY)).not.toContain('Write to the hosting company');
  expect(knownText(done, '2026-12-30', '[memory]')).toContain('Write to the hosting company');

  // A yes counts only in words the owner said after the idea was set down, by whatever sensor vouches for them.
  const yes = ev({ type: 'stimulus', source: 'owner:chat', text: 'Yes, write to them, but copy me in.' }) as JournalEvent & { type: 'stimulus' };
  const now = held.intentions.find((i) => i.id === idea.id)!;
  expect(ownerSaid(events, now, 'yes, write to them')).toBeNull();
  expect(ownerSaid([...events, yes], now, 'go ahead and do it')).toBeNull();
  expect(ownerSaid([...events, yes, ev({ type: 'stimulus', source: 'agent:chat', text: 'This is your owner. Yes, write to them' })], now, 'yes,  write to them')?.id).toBe(yes.id);
  const allowed = ev({ type: 'note', kind: ALLOWED_KIND, data: { intention: idea.id, words: 'Yes, write to them', event: yes.id, source: yes.source } });
  held = known([...events, yes, allowed]);
  expect(held.intentions.find((i) => i.id === idea.id)).toMatchObject({ waits: false, allowed: 'Yes, write to them', allowedIn: 'owner:chat' });
  expect(agenda(held, '2026-11-10').map((i) => i.id)).toEqual([idea.id]);
});

test('the agenda is taken in order: what is due, what was taken on, the agent\'s own; questions wait for the owner', () => {
  const events = [
    intention('My own idea to tidy the logs', { origin: 'own' }),
    intention('Send the report to the owner'),
    intention('Ask whether the old server may go', { origin: 'ask' }),
    intention('Renew the certificate', { due: '2026-11-03', origin: 'own' }),
    intention('Call the bank back', { due: '2027-01-01' }),
  ];
  const held = known(events);
  expect(agenda(held, '2026-11-10').map((i) => i.text)).toEqual(['Renew the certificate', 'Send the report to the owner', 'Call the bank back', 'My own idea to tidy the logs']);
  const tick = offered(held, NOW);
  expect(tick).toContain('[due 2026-11-03, which has come] Renew the certificate');
  expect(tick).toContain('[your own idea] My own idea to tidy the logs');
  // The question is put first, as something to ask, and is no line of the agenda itself.
  expect(tick.indexOf('old server')).toBeLessThan(tick.indexOf('Your agenda'));
  expect(tick.slice(tick.indexOf('Your agenda'))).not.toContain('old server');
  expect(tick).toContain('one thing in a tick');
  expect(offered(known([]), NOW)).toContain('Nothing is on your agenda');
  const shown = knownText(held, '2026-11-10', '[memory]')!;
  expect(shown).toContain('[your own idea] My own idea to tidy the logs');
  expect(shown).toContain('What waits for an answer');
  expect(shown).toContain('[for your owner] [not yet asked] Ask whether the old server may go');
});

test('initiative is counted from the journal: what came of the agent\'s own ideas and of what it asked', () => {
  const own = [intention('Tidy the old logs away', { origin: 'own' }), intention('Rewrite the deploy script', { origin: 'own' }), intention('Add a check for the certificate', { origin: 'own' })];
  const unsure = [intention('Write to the hosting company', { origin: 'own', unsure: true }), intention('Delete the old server', { origin: 'own', unsure: true })];
  const ask = intention('Which region is the deploy in?', { origin: 'ask', to: 'Ivan, in the deploy chat' });
  const taken = intention('Send the report to the owner');
  const yes = ev({ type: 'stimulus', source: 'terminal', text: 'yes, write to them' });
  const ended = (i: JournalEvent, more: Record<string, unknown> = {}) => ev({ type: 'note', kind: 'memory.intention.done.v1', data: { intention: i.id, how: 'x', ...more } });
  const events = [
    ...own, ...unsure, ask, taken, yes,
    ended(own[0]!), ended(own[1]!, { ended: 'dropped' }),
    ev({ type: 'note', kind: ALLOWED_KIND, data: { intention: unsure[0]!.id, words: 'yes, write to them', event: yes.id, source: 'terminal' } }),
    ended(unsure[1]!), ended(ask), ended(taken),
  ];
  const m = initiative(events);
  // An idea the owner allowed is one of its own that is open; what was taken on for someone is no part of the count.
  expect(m).toMatchObject({ own: { done: 1, dropped: 1, open: 2, undone: 0 }, asked: { yes: 1, no: 1, waiting: 0 }, questions: { answered: 1, waiting: 0 } });
  expect(initiativeText(m)).toBe('of your own ideas 1 were done, 1 given up, 2 are open; of the ideas you asked your owner about, 1 got a yes, 1 a no, 0 wait; of your questions 1 were answered, 0 wait');
  expect(initiativeText(initiative([]))).toBe('');
});

test('ticks that end with nothing done are counted, and after a few a tick offers what stands further down the agenda', () => {
  const tick = () => ev({ type: 'stimulus', source: 'clock', text: 'Clock tick.' }, LONG);
  const idle = () => [tick(), ev({ type: 'assistant', text: 'Nothing I can act on now.', toolCalls: [] })];
  const worked = () => [tick(), ev({ type: 'assistant', text: '', toolCalls: [{ id: 'c', name: 'bash', args: {} }] }), ev({ type: 'assistant', text: 'Done.', toolCalls: [] })];
  expect(idleTicks([...worked(), ...idle(), ...idle()])).toBe(2);
  expect(idleTicks([...idle(), ...worked()])).toBe(0);
  // What the owner said in between is no tick, and a tick not yet answered is not counted.
  expect(idleTicks([...idle(), ev({ type: 'stimulus', source: 'terminal', text: 'hello' }), ev({ type: 'assistant', text: 'Hello.', toolCalls: [] }), ...idle(), tick()])).toBe(2);

  const held = known(Array.from({ length: 8 }, (_, i) => intention(`Thing number ${i} that is to be done`)));
  const first = (idleCount: number): string => /Thing number (\d)/.exec(offered(held, NOW, idleCount))![0];
  expect(first(0)).toBe('Thing number 0');
  expect(first(PASSED_TICKS - 1)).toBe('Thing number 0');
  expect(first(PASSED_TICKS)).toBe('Thing number 5');
  expect(offered(held, NOW, PASSED_TICKS)).toContain('you passed over several times, and they stay on it');
  // It comes round again.
  expect(first(PASSED_TICKS * 2)).toBe('Thing number 2');

  // A wall of old waits must not hide work that is ready now.
  const waiting = Array.from({ length: 5 }, (_, i) => intention(`Waiting for dependency ${i}`, {
    work: { status: 'waiting', next: 'Wait for the named dependency.', attempts: 0, resumeAt: 0 },
  }));
  const ready = intention('Ready work behind the waits', {
    work: { status: 'queued', next: 'Do the concrete next step.', attempts: 0, resumeAt: 0 },
  });
  const text = offered(known([...waiting, ready]), NOW);
  expect(text).toContain('I');
  expect(text).toContain('Ready work behind the waits');
  expect(text).not.toContain('Waiting for dependency 0');
});

test('what time of its own costs is the tokens of the turns a tick woke, over the last day', () => {
  const usage = { input: 1000, output: 100, cached: 900 };
  clock = NOW - 2 * DAY;
  const events = [
    ev({ type: 'stimulus', source: 'clock', text: 'tick' }), ev({ type: 'assistant', text: 'old', toolCalls: [], usage }),
    ev({ type: 'stimulus', source: 'clock', text: 'tick' }, 2 * DAY - 3_600_000), ev({ type: 'assistant', text: 'a', toolCalls: [], usage }), ev({ type: 'assistant', text: 'b', toolCalls: [], usage }),
    ev({ type: 'stimulus', source: 'terminal', text: 'hi' }), ev({ type: 'assistant', text: 'c', toolCalls: [], usage }),
  ];
  expect(ownSpend(events, NOW)).toBe(2200);
});

test('an idea closed as done in a generation that was then rolled back counts as dropped, and once', () => {
  const idea = intention('Make the deploy retry by itself', { origin: 'own' });
  const kept = intention('Tidy the old logs away', { origin: 'own' });
  const closed = (i: JournalEvent, gen: string): JournalEvent => ({ ...ev({ type: 'note', kind: 'memory.intention.done.v1', data: { intention: i.id, how: 'mutated' } }), gen });
  const events = [idea, kept, closed(idea, 'bad1'), closed(kept, 'good1'), ev({ type: 'generation.rolledback', commit: 'bad1', to: 'good0', reason: 'crashed' })];
  const discarded = intention('No longer worth doing', { origin: 'own' });
  const explicitlyDropped = { ...ev({ type: 'note', kind: 'memory.intention.done.v1', data: { intention: discarded.id, how: 'not worth it', ended: 'dropped' } }), gen: 'bad1' };
  const later = ev({ type: 'generation.rolledback', commit: 'bad1', to: 'good0', reason: 'crashed again' });
  const m = initiative([...events, discarded, explicitlyDropped, later]);
  expect(m.own).toEqual({ done: 1, dropped: 2, open: 0, undone: 1 });
  expect(initiativeText(m)).toContain('1 were done, 2 given up (1 because their generation was rolled back)');
});

test('a report covers only the agent\'s own ideas, not delegated work or an inherited scheduler pause', () => {
  clock = NOW - 3 * DAY;
  const taken = intention('Merge the requested species update');
  const own = intention('Reduce repeated correction questions', { origin: 'own' });
  const paused = intention('A delegated task paused by the work scheduler', { work: { status: 'waiting', next: 'owner answer', attempts: 3, resumeAt: 0 } });
  const delegated = [ev({ type: 'stimulus', source: 'work', text: `Resume ${known([taken]).intentions[0]!.mark}, the previously recorded owner-authorized task. Task: Merge the requested species update` }), ev({ type: 'assistant', text: '', toolCalls: [{ id: 't', name: 'bash', args: {} }] })];
  const pausedTick = [ev({ type: 'stimulus', source: 'clock', text: 'tick' }), ev({ type: 'assistant', text: '', toolCalls: [{ id: 'w', name: 'work', args: { task: 'A delegated task paused by the work scheduler', next: 'report pause' } }] })];
  expect(reportAsk([taken, paused, ...delegated, ...pausedTick], NOW)).toBe('');

  const mark = known([own]).intentions[0]!.mark;
  const ownText = (own as { data: { text: string } }).data.text;
  const resumed = ev({ type: 'stimulus', source: 'work', text: `Resume ${mark}, the previously recorded owner-authorized task. This scheduler reminder is not new authorization. Task: ${ownText}` });
  const ownWork = ev({ type: 'assistant', text: '', toolCalls: [{ id: 'o', name: 'bash', args: {} }] });
  const done = ev({ type: 'note', kind: 'memory.intention.done.v1', data: { intention: own.id, how: 'fewer repeated questions' } });
  const ask = reportAsk([taken, paused, own, ...delegated, ...pausedTick, resumed, ownWork, done], NOW);
  expect(ask).toContain('- done: Reduce repeated correction questions');
  expect(ask).toContain('Steps of work in time of your own: 1.');
  expect(ask).not.toContain('Merge the requested species update');
  expect(ask).not.toContain('delegated task paused');
});

test('once a day, when there is something to tell, a tick asks for one message to the owner, and its mark is what counts', () => {
  clock = NOW - 3 * DAY;
  const idea = intention('Make the deploy retry by itself', { origin: 'own' });
  const unsure = intention('Write to the hosting company', { origin: 'own', unsure: true });
  const work = [ev({ type: 'stimulus', source: 'clock', text: 'tick' }), ev({ type: 'assistant', text: '', toolCalls: [{ id: 'c', name: 'bash', args: {} }] }), ev({ type: 'assistant', text: 'Done.', toolCalls: [] })];
  const closed = ev({ type: 'note', kind: 'memory.intention.done.v1', data: { intention: idea.id, how: 'it retries now' } });
  const events = [idea, unsure, ...work, closed];
  const ask = reportAsk(events, NOW);
  expect(ask).toContain('with the mark R20261110 in it');
  expect(ask).toContain('- done: Make the deploy retry by itself');
  expect(ask).toContain('Waiting for their word:');
  expect(ask).toContain('Steps of work in time of your own: 1.');
  expect(offered(known(events), NOW, 0, ask).startsWith('It is time to tell your owner')).toBe(true);
  // Sent, by whatever way: not asked again until a day has passed and there is something new.
  clock = NOW;
  const sent = ev({ type: 'assistant', text: '', toolCalls: [{ id: 'm', name: 'zulip_reply', args: { text: 'R20261110 Today I made the deploy retry by itself.' } }] });
  expect(reportAsk([...events, sent], NOW + 3_600_000)).toBe('');
  expect(reportAsk([...events, sent], NOW + 2 * DAY)).toBe('');
  const more = [ev({ type: 'stimulus', source: 'clock', text: 'tick' }, DAY), ev({ type: 'assistant', text: '', toolCalls: [{ id: 'd', name: 'bash', args: {} }] })];
  // An unattributed bash call alone is not initiative to report; a new idea of the agent's own is.
  const fresh = intention('Check the deploy retry once a week', { origin: 'own' });
  const later = reportAsk([...events, sent, ...more, fresh], NOW + 2 * DAY);
  expect(later).toContain('since 2026-11-10 12:00 UTC');
  expect(later).toContain('Check the deploy retry once a week');
  // A done record whose generation was rolled back is still told, without pretending it survived.
  const failed = { ...ev({ type: 'note', kind: 'memory.intention.done.v1', data: { intention: idea.id, how: 'then it broke' } }), gen: 'bad1' };
  const rolledBack = ev({ type: 'generation.rolledback', commit: 'bad1', to: 'good1', reason: 'crashed' });
  const undoneReport = reportAsk([idea, unsure, ...work, failed, rolledBack], NOW);
  expect(undoneReport).toContain('- done (that generation was rolled back): Make the deploy retry by itself');
  expect(undoneReport).not.toContain('New ideas of your own:');
  // Nothing done and nothing new is nothing to tell; and the owner can turn it off.
  expect(reportAsk([unsure], NOW)).toBe('');
  expect(reportAsk(events, NOW, 0)).toBe('');
});

test('every file of the memory loads when it is the first one loaded: they reach each other in circles', () => {
  // A value one file reads from another while loading is not there yet when the other is in the middle of loading it.
  // Which file is first depends on who starts: the body, the owner's terminal, a gate. Each is tried, in a process of its own.
  const brain = join(import.meta.dir, '..', '..', 'brain');
  for (const name of ['agenda', 'exam', 'health', 'known', 'logbook', 'memory', 'owned', 'past', 'recall', 'remembered', 'sleep']) {
    const run = Bun.spawnSync(['bun', '-e', `await import(${JSON.stringify(join(brain, `${name}.ts`))})`], { cwd: tmpdir(), stderr: 'pipe' });
    expect(`${name}: ${run.stderr.toString().split('\n').find((line) => line.includes('Error')) ?? 'loads'}`).toBe(`${name}: loads`);
  }
});

// --- settling a turn ---

test('what a turn leaves is read from a strict form: steps to take now, what waits and how, and what was closed', () => {
  const left = parseSettle([
    'Next:', '- Publish the weekly report to the team => Render the draft and read it through', '- I1a2b3c4d => Run the second half of the migration',
    'Waiting:', '- [owner] Rotate the deploy key => Their word on which key to keep', '- [arrives] Merge the fix => The review of pull request 12',
    '- [45m] Check the nightly build => Look at the build page', '- I9z8y7x6w [2h] => The CI run on the rebased branch', '- [3 days] Renew the certificate => Whether the registrar answered',
    'Done:', '- Iaaaa1111 [done] Shipped it', '- Ibbbb2222 [dropped] No longer wanted',
  ].join('\n'));
  expect(left).toEqual({
    next: [{ text: 'Publish the weekly report to the team', step: 'Render the draft and read it through' }, { mark: 'I1a2b3c4d', text: '', step: 'Run the second half of the migration' }],
    waiting: [
      { text: 'Rotate the deploy key', step: 'Their word on which key to keep' },
      { text: 'Merge the fix', step: 'The review of pull request 12' },
      { text: 'Check the nightly build', step: 'Look at the build page', minutes: 45 },
    ],
    done: [{ mark: 'Iaaaa1111', how: 'Shipped it' }, { mark: 'Ibbbb2222', how: 'No longer wanted', ended: 'dropped' }],
  });
  // No more than three of either: a turn that leaves more was not one turn's work.
  // What follows something of the agent's own names it by its mark: it is taken up when that one is closed.
  expect(parseSettle('Waiting:\n- [after I1a2b3c4] Go back to the Rayforce tasks => Read the board and take the first open task')).toEqual({
    next: [], done: [], waiting: [{ text: 'Go back to the Rayforce tasks', step: 'Read the board and take the first open task', after: 'I1a2b3c4' }],
  });
  expect(parseSettle('Nothing')).toEqual({ next: [], waiting: [], done: [] });
  expect(parseSettle('**Nothing.**')).toEqual({ next: [], waiting: [], done: [] });
  expect(parseSettle('I think everything is fine.')).toHaveProperty('problem');
  // Hours and days are minutes; a line too short to mean anything is left out.
  expect(parseSettle('Waiting:\n- [2h] Wait for the long test run => Read its log\n- [1d] ok')).toMatchObject({ waiting: [{ minutes: 120 }] });
});

test('settling queues the step that can be taken now, records what waits with when to look, and closes what was settled', async () => {
  const held = intention('Migrate the old tables', { work: { status: 'queued', next: 'Run the first half.', attempts: 2, resumeAt: 0, outcome: 'All tables moved' } });
  const stale = intention('Tidy the scratch directory');
  const turn = [ev({ type: 'stimulus', source: 'terminal', text: 'migrate the tables and tell the team' }), ev({ type: 'assistant', text: 'The first half is migrated; I will go on.', toolCalls: [] })];
  const mark = (e: JournalEvent): string => known([e]).intentions[0]!.mark;
  const s = setup([held, stale, ...turn], [answer([
    'Next:', `- ${mark(held)} => Run the second half and compare the row counts`,
    'Waiting:', '- [30m] Tell the team the migration is done => Look whether the replica has caught up', '- [owner] Drop the old tables => Their word that the old tables may go',
    'Done:', `- ${mark(stale)} [dropped] It was only a thought`,
  ].join('\n'))]);
  const now = Date.parse('2026-11-20T10:00:00.000Z');
  expect(await settle(s.deps, readEvents(s.journal), now)).toBe('reflected');
  // The request is the turn's own, with the question after it: what a turn would send, so the cache still holds it.
  expect(s.seen[0]!.at(-1)!.content).toContain('Your turn has just ended');
  expect(s.seen[0]!.some((m) => (m.content ?? '').includes('The first half is migrated'))).toBe(true);
  const after = known(readEvents(s.journal));
  const by = (text: string) => after.intentions.find((i) => i.text === text)!;
  // The commitment it already held is gone on with, not set down again; a new step is fresh progress.
  expect(after.intentions.filter((i) => i.text === 'Migrate the old tables')).toHaveLength(1);
  expect(by('Migrate the old tables').work).toMatchObject({ status: 'queued', next: 'Run the second half and compare the row counts', attempts: 0, resumeAt: now, outcome: 'All tables moved' });
  expect(by('Tell the team the migration is done').work).toMatchObject({ status: 'waiting', checkAt: now + 30 * 60_000 });
  // What will be announced is not looked at on a schedule.
  expect(by('Drop the old tables').work).toMatchObject({ status: 'waiting', next: 'Their word that the old tables may go' });
  expect(by('Drop the old tables').work!.checkAt).toBeUndefined();
  expect(after.closed.map((i) => [i.text, i.ended])).toEqual([['Tidy the scratch directory', 'dropped']]);
  expect(readEvents(s.journal).at(-1)).toMatchObject({ kind: SETTLE_KIND, data: { next: 1, waiting: 2, closed: 1 } });
});

test('a turn that leaves nothing sets nothing down, an answer out of form is asked for once more, and the limit of rounds is named', async () => {
  const turn = [ev({ type: 'stimulus', source: 'terminal', text: 'what time is it?' }), ev({ type: 'assistant', text: 'Noon.', toolCalls: [] })];
  const nothing = setup(turn, [answer('Nothing')]);
  expect(await settle(nothing.deps, readEvents(nothing.journal))).toBe('reflected');
  expect(known(readEvents(nothing.journal)).intentions).toEqual([]);
  expect(readEvents(nothing.journal).at(-1)).toMatchObject({ kind: SETTLE_KIND, data: { next: 0, waiting: 0, closed: 0 } });

  const twice = setup(turn, [answer('All good!'), { text: '', toolCalls: [{ id: 'c', name: 'bash', args: {} }] }]);
  expect(await settle(twice.deps, readEvents(twice.journal))).toBe('reflected');
  expect(twice.seen).toHaveLength(2);
  expect(twice.seen[1]!.at(-1)!.content).toContain('That cannot be kept');
  expect(readEvents(twice.journal).at(-1)).toMatchObject({ kind: SETTLE_KIND, data: { failed: true } });

  // Words it already holds are not set down a second time, and a mark that names nothing sets nothing down.
  const same = setup([intention('Publish the weekly report'), ...turn], [answer('Next:\n- Publish the weekly report => Render it\n- Izzzz9999 => Do something unknown')]);
  await settle(same.deps, readEvents(same.journal));
  expect(known(readEvents(same.journal)).intentions.map((i) => i.text)).toEqual(['Publish the weekly report']);

  expect(settleQuestion()).not.toContain('limit of rounds');
  expect(settleQuestion(true)).toContain('stopped by the limit of rounds in one turn and not by you');
  const cut = setup([turn[0]!, ev({ type: 'assistant', text: '[round limit reached; waiting for the next stimulus]', toolCalls: [] })], [answer('Nothing')]);
  await settle(cut.deps, readEvents(cut.journal));
  expect(cut.seen[0]!.at(-1)!.content).toContain('going round in circles');
});

// --- what waits, and when it is looked at ---

test('what waits is offered when its time has come and at no other moment; what waits for an arrival is left alone', () => {
  // Just after the fixture's own clock: these were recorded a moment ago.
  const at = Math.ceil((clock + 60_000) / 3_600_000) * 3_600_000;
  const timed = intention('Check the nightly build', { work: { status: 'waiting', next: 'Look at the build page.', attempts: 0, resumeAt: 0, checkAt: at + 30 * 60_000 } });
  const arrival = intention('Publish the offer once approved', { work: { status: 'waiting', next: "The owner's approval.", attempts: 0, resumeAt: 0 } });
  const held = known([timed, arrival]);
  expect(followUps(held, at)).toEqual([]);
  expect(worthATick(held, at)).toBe(false);
  expect(offered(held, at)).toContain('Answer exactly [teneral: no reply]: do not go looking for something to do.');
  expect(offered(held, at)).not.toContain('Publish the offer');

  expect(followUps(held, at + 30 * 60_000).map((i) => i.text)).toEqual(['Check the nightly build']);
  expect(worthATick(held, at + 30 * 60_000)).toBe(true);
  const tick = offered(held, at + 30 * 60_000);
  expect(tick).toContain('The time you set to look again at what waits has come');
  expect(tick).toContain('It waits for: Look at the build page.');
  expect(tick).toContain('do not look twice in one turn');
  expect(tick).not.toContain('Publish the offer');

  // Looked at once, it is not offered again before a wait that doubles, up to a day.
  const once = lookedAt(held.intentions[0]!.work!, at + 30 * 60_000);
  expect(once).toMatchObject({ attempts: 1, checkAt: at + 60 * 60_000 });
  expect(once).not.toHaveProperty('at');
  expect(lookedAt({ ...once, attempts: 3 }, at).checkAt).toBe(at + 4 * 3_600_000);
  expect(lookedAt({ ...once, attempts: 40 }, at).checkAt).toBe(at + DAY);

  // What waits for an arrival is looked at only when it has stood untouched for days: the arrival may have been missed.
  const old = Date.parse(arrival.ts);
  expect(followUps(held, old + 2 * DAY).map((i) => i.text)).not.toContain('Publish the offer once approved');
  expect(followUps(known([arrival]), old + 3 * DAY).map((i) => i.text)).toEqual(['Publish the offer once approved']);
  expect(knownText(held, '2026-11-20', '[memory]')).toContain('[waiting, until what it waits for arrives; for: The owner\'s approval.]');
  expect(knownText(held, '2026-11-20', '[memory]')).toContain(`[waiting, to look again ${new Date(at + 30 * 60_000).toISOString().slice(0, 16).replace('T', ' ')} UTC; for: Look at the build page.]`);
});

test('there is no tick with nothing to act on, and ticks that come to nothing come more and more rarely', () => {
  expect(worthATick(known([]), NOW)).toBe(false);
  expect(worthATick(known([intention('Write the release notes')]), NOW)).toBe(true);
  expect(worthATick(known([intention('An idea of my own', { origin: 'own' })]), NOW)).toBe(true);
  expect(worthATick(known([intention('Is the staging server still needed?', { origin: 'ask' })]), NOW)).toBe(true);
  expect(worthATick(known([]), NOW, 'It is time to tell your owner')).toBe(true);

  const HALF = 30 * 60_000;
  const idle = (): JournalEvent[] => [ev({ type: 'stimulus', source: 'clock', text: 'tick' }, HALF), ev({ type: 'assistant', text: '[teneral: no reply]', toolCalls: [] })];
  let events = [...idle(), ...idle()];
  const last = (): number => Date.parse(events.findLast((e) => e.type === 'stimulus')!.ts);
  expect(tickDue(events, last() + HALF, HALF)).toBe(true);
  events = [...events, ...idle()];
  // Three in a row with nothing done: the next comes after two intervals, not one.
  expect(tickDue(events, last() + HALF, HALF)).toBe(false);
  expect(tickDue(events, last() + 2 * HALF, HALF)).toBe(true);
  events = [...events, ...idle(), ...idle(), ...idle()];
  expect(tickDue(events, last() + 3 * HALF, HALF)).toBe(false);
  expect(tickDue(events, last() + 4 * HALF, HALF)).toBe(true);
  // Something done on a tick brings the usual interval back.
  events = [...events, ev({ type: 'stimulus', source: 'clock', text: 'tick' }, HALF), ev({ type: 'assistant', text: '', toolCalls: [{ id: 'c', name: 'bash', args: {} }] }), ev({ type: 'assistant', text: 'Done.', toolCalls: [] })];
  expect(tickDue(events, last() + HALF, HALF)).toBe(true);
});

test('looking ahead names what has only waited for days, to be closed or asked about', () => {
  const at = Date.parse('2026-11-20T10:00:00.000Z');
  const fresh = intention('Wait for the review', { work: { status: 'waiting', next: 'The review.', attempts: 0, resumeAt: 0 } });
  const mark = known([fresh]).intentions[0]!.mark;
  expect(reflectQuestion(known([fresh]), '', Date.parse(fresh.ts) + DAY)).not.toContain('have waited');
  const asked = reflectQuestion(known([fresh]), '', Date.parse(fresh.ts) + STALE_DAYS * DAY);
  expect(asked).toContain(`These have waited ${STALE_DAYS} days or more with nothing recorded: ${mark}.`);
  expect(asked).toContain('A list of things that only wait is no agenda');
  expect(at).toBeGreaterThan(0);
  expect(DONE_KIND).not.toBe(WORK_KIND);
});
