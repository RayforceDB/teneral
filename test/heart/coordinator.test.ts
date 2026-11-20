import { expect, test } from 'bun:test';
import { Heart, afterTurn, heartCommand, restIn, type HeartState } from '../../heart/coordinator';
import { appendEvent, readEvents, type EventBody } from '../../brain/journal';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { known } from '../../brain/known';

const setup = () => {
  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-heart-')), 'journal.jsonl');
  appendEvent(journal, 'g', { type: 'stimulus', source: 'birth', text: 'Hello.' });
  appendEvent(journal, 'g', { type: 'assistant', text: 'Here.', toolCalls: [] });
  return journal;
};

test('the heart command is one exact owner line, not an arbitrary message', () => {
  expect(heartCommand(' /heart ')).toBe(true);
  expect(heartCommand('/heart now')).toBe(false);
  expect(heartCommand('please /heart')).toBe(false);
});

test('a turn that did something is settled once; a tick, an interruption, a quiet reply and a turn that kept its own agenda are not', () => {
  const look = (...more: EventBody[]): boolean => {
    const journal = setup();
    const from = readEvents(journal).length;
    for (const e of more) appendEvent(journal, 'g', e);
    const state: HeartState = { look: false, pulse: false };
    afterTurn(state, readEvents(journal), true, from);
    return state.look;
  };
  const asked: EventBody = { type: 'stimulus', source: 'terminal', text: 'do it' };
  const said = (text: string): EventBody => ({ type: 'assistant', text, toolCalls: [] });
  const tool = (name: string): EventBody => ({ type: 'tool.intent', callId: name, name, args: {} });
  // The owner asked: even a turn of words alone may hold a promise.
  expect(look(asked, said('I will.'))).toBe(true);
  expect(look({ type: 'stimulus', source: 'clock', text: 'tick' }, said('Did it.'))).toBe(false);
  expect(look({ type: 'stimulus', source: 'work', text: 'Resume' }, tool('bash'), said('Did it.'))).toBe(false);
  expect(look(asked, { type: 'turn.interrupted' })).toBe(false);
  // Someone else's message that was only answered leaves nothing; one that set work going does.
  expect(look({ type: 'stimulus', source: 'agent:zulip', text: 'hello' }, said('[teneral: no reply]'))).toBe(false);
  expect(look({ type: 'stimulus', source: 'agent:zulip', text: 'hello' }, said('Hello.'))).toBe(false);
  expect(look({ type: 'stimulus', source: 'agent:github', text: 'a commit' }, tool('bash'), said('Fetched it.'))).toBe(true);
  // It recorded the state itself: asking again would only cost a request.
  expect(look(asked, tool('bash'), tool('work'), said('Recorded.'))).toBe(false);
  // Stopped by the limit of rounds, it is asked whatever it recorded.
  expect(look(asked, tool('work'), tool('bash'), said('[round limit reached; waiting for the next stimulus]'))).toBe(true);
});

test('a scheduled work turn preserves an already requested look without starting another', () => {
  const state: HeartState = { look: true, pulse: false };
  const events = setup();
  appendEvent(events, 'g', { type: 'stimulus', source: 'work', text: 'Resume a waiting commitment.' });
  appendEvent(events, 'g', { type: 'assistant', text: 'Checked the dependency.', toolCalls: [] });
  afterTurn(state, readEvents(events));
  expect(state.look).toBe(true);
  const fresh: HeartState = { look: false, pulse: false };
  afterTurn(fresh, readEvents(events));
  expect(fresh.look).toBe(false);
});

const deps = (journal: string, more: Partial<ConstructorParameters<typeof Heart>[0]> = {}) => ({
  born: () => true, events: () => readEvents(journal), emit: (s: { source: string; text: string }) => { appendEvent(journal, 'g', { type: 'stimulus', source: s.source, text: s.text }); },
  settle: async () => {}, remember: async () => false, onError: () => {}, ...more,
});

test('an owner pulse is coalesced and does not call the model by itself', async () => {
  const journal = setup();
  const pulses: string[] = [];
  let remembered = 0;
  const heart = new Heart(deps(journal, { emit: s => { pulses.push(s.text); }, settle: async () => { throw new Error('not requested'); }, remember: async () => { remembered++; return false; } }));
  heart.requestPulse(); heart.requestPulse();
  expect(await heart.next()).toBe('pulse');
  expect(pulses).toHaveLength(1);
  expect(await heart.next()).toBe('wait');
  expect(remembered).toBe(1);
});

test('settling a turn makes up no tick: a step it queued is told when its time comes', async () => {
  const journal = setup();
  appendEvent(journal, 'g', { type: 'stimulus', source: 'terminal', text: 'finish' });
  appendEvent(journal, 'g', { type: 'assistant', text: 'Half of it is done.', toolCalls: [] });
  let settled = 0;
  const heart = new Heart(deps(journal, { restMs: 600_000, settle: async () => {
    settled++;
    appendEvent(journal, 'g', { type: 'note', kind: 'memory.intention.v1', data: { text: 'Finish the other half.', work: { status: 'queued', next: 'Run the second step.', attempts: 0, resumeAt: 0 } } });
  } }));
  heart.completed(readEvents(journal));
  expect(await heart.next()).toBe('reflect');
  expect(settled).toBe(1);
  expect(known(readEvents(journal)).intentions[0]!.work?.status).toBe('queued');
  // Once, and then it waits: no clock stimulus was written, and nothing of rest runs while the owner is near.
  expect(await heart.next()).toBe('wait');
  expect(readEvents(journal).some(e => e.type === 'stimulus' && e.source === 'clock')).toBe(false);
});

test('nothing of its own runs while the owner is in conversation; at rest it remembers', async () => {
  const journal = setup();
  appendEvent(journal, 'g', { type: 'stimulus', source: 'terminal', text: 'a question' });
  appendEvent(journal, 'g', { type: 'assistant', text: 'An answer.', toolCalls: [] });
  const said = Date.parse(readEvents(journal).findLast(e => e.type === 'stimulus')!.ts);
  let remembered = 0, now = said + 60_000, backlog = 0;
  const heart = new Heart(deps(journal, { restMs: 600_000, now: () => now, backlog: () => backlog, remember: async () => { remembered++; return remembered === 1; } }));
  expect(heart.restIn()).toBe(540_000);
  expect(await heart.next()).toBe('wait');
  expect(remembered).toBe(0);
  // Other people's messages do not put rest off, and the agent's own turns do not either.
  appendEvent(journal, 'g', { type: 'stimulus', source: 'agent:zulip', text: 'chatter' });
  appendEvent(journal, 'g', { type: 'assistant', text: '[teneral: no reply]', toolCalls: [] });
  expect(restIn(readEvents(journal), said + 600_000, 600_000)).toBe(0);
  // A long conversation must not leave memory behind: a backlog is worked off without rest.
  backlog = 4;
  expect(await heart.next()).toBe('remember');
  backlog = 0;
  expect(await heart.next()).toBe('wait');
  now = said + 600_001;
  expect(heart.restIn()).toBe(0);
  expect(await heart.next()).toBe('wait');
  expect(remembered).toBe(2);
});

test('a look ahead at rest that sets down something to begin is offered at once, not at the next tick', async () => {
  const journal = setup();
  const heart = new Heart(deps(journal, { restMs: 0, remember: async () => {
    appendEvent(journal, 'g', { type: 'note', kind: 'memory.intention.v1', data: { text: 'Do the next safe step.', origin: 'own', episode: 'fixture' } });
    return true;
  } }));
  expect(await heart.next()).toBe('remember');
  const pulse = readEvents(journal).findLast(e => e.type === 'stimulus');
  expect(pulse?.type === 'stimulus' && pulse.source === 'clock' && pulse.text.includes('Do the next safe step.')).toBe(true);
  expect(await heart.next()).toBe('turn');
});

test('a fresh individual waits for its first dialogue instead of starting idle work', async () => {
  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-birth-heart-')), 'journal.jsonl');
  let reflected = 0;
  const heart = new Heart({ events: () => readEvents(journal), born: () => false, emit: () => { throw new Error('no agenda before birth'); }, settle: async () => { reflected++; }, remember: async () => { throw new Error('no memory work before birth'); }, onError: () => {} });
  appendEvent(journal, 'g', { type: 'stimulus', source: 'birth', text: 'Hello.' });
  heart.requestPulse(); heart.completed(readEvents(journal));
  expect(await heart.next()).toBe('turn');
  appendEvent(journal, 'g', { type: 'assistant', text: 'Hello. What may I call you?', toolCalls: [] });
  expect(await heart.next()).toBe('wait');
  expect(reflected).toBe(0);
});

test('what the agent waits for is told when it has come: after the turn is settled, before rest, in conversation as at rest, and once', async () => {
  const journal = setup();
  // The owner has just spoken: not at rest.
  appendEvent(journal, 'g', { type: 'stimulus', source: 'terminal', text: 'run the tests' });
  appendEvent(journal, 'g', { type: 'assistant', text: 'They are running.', toolCalls: [] });
  const order: string[] = [];
  let come: { source: string; text: string } | null = null;
  const heart = new Heart(deps(journal, {
    restMs: 600_000,
    settle: async () => { order.push('settle'); },
    remember: async () => { order.push('remember'); return false; },
    arrived: () => { order.push('ask'); const s = come; come = null; return s; },
  }));
  heart.completed(readEvents(journal));
  expect(await heart.next()).toBe('reflect');
  // Nothing has come, and it is not rest: it waits, having asked.
  expect(await heart.next()).toBe('wait');
  expect(order).toEqual(['settle', 'ask']);
  come = { source: 'work', text: 'The background job suite that you left running has ended.' };
  expect(await heart.next()).toBe('wake');
  expect(readEvents(journal).at(-1)).toMatchObject({ type: 'stimulus', source: 'work', text: 'The background job suite that you left running has ended.' });
  // The turn it owes now comes first; nothing is asked or remembered over it.
  expect(await heart.next()).toBe('turn');
  expect(order).toEqual(['settle', 'ask', 'ask']);
});

test('nothing is looked for before birth, and a failure to look is reported and waits', async () => {
  const journal = setup();
  const unborn = new Heart(deps(journal, { born: () => false, arrived: () => { throw new Error('not before birth'); } }));
  expect(await unborn.next()).toBe('wait');
  const errors: unknown[] = [];
  const heart = new Heart(deps(journal, { restMs: 600_000, arrived: () => { throw new Error('unreadable'); }, onError: (e) => errors.push(e) }));
  appendEvent(journal, 'g', { type: 'stimulus', source: 'terminal', text: 'hello' });
  appendEvent(journal, 'g', { type: 'assistant', text: 'Hello.', toolCalls: [] });
  expect(await heart.next()).toBe('wait');
  expect(errors).toHaveLength(1);
});

test('the body sleeps until rest or until what it waits for may have come, whichever is sooner, and never spins on a time already past', () => {
  const journal = setup();
  let now = Date.parse('2026-11-20T12:00:00Z');
  let look: number | undefined;
  const heart = new Heart(deps(journal, { restMs: 600_000, now: () => now, nextLook: () => look }));
  // At rest with nothing awaited: until something arrives.
  expect(heart.waitFor()).toBeUndefined();
  look = 2000;
  expect(heart.waitFor()).toBe(2000);
  look = -5000;
  expect(heart.waitFor()).toBe(1000);
  // The owner spoke a minute ago: rest is nine minutes off, and a look in three is sooner.
  appendEvent(journal, 'g', { type: 'stimulus', source: 'terminal', text: 'hello' });
  appendEvent(journal, 'g', { type: 'assistant', text: 'Hello.', toolCalls: [] });
  now = Date.parse(readEvents(journal).at(-2)!.ts) + 60_000;
  look = 180_000;
  expect(heart.waitFor()).toBe(180_000);
  look = undefined;
  expect(heart.waitFor()).toBe(540_000 + 1000);
});

test('a tick of the clock is the heart\'s to give: at rest, when one is due, before the work of memory; never in conversation', async () => {
  const journal = setup();
  let now = Date.parse(readEvents(journal).at(-1)!.ts) + 1000;
  const order: string[] = [];
  let due = false;
  const heart = new Heart(deps(journal, {
    restMs: 600_000, now: () => now,
    remember: async () => { order.push('remember'); return false; },
    tick: () => { order.push('tick?'); return due ? { source: 'clock', text: 'Clock tick. Your agenda: one thing.' } : null; },
  }));
  // At rest (the owner never spoke after birth), none due: memory's turn.
  expect(await heart.next()).toBe('wait');
  expect(order).toEqual(['tick?', 'remember']);
  due = true;
  expect(await heart.next()).toBe('pulse');
  expect(readEvents(journal).at(-1)).toMatchObject({ type: 'stimulus', source: 'clock' });
  expect(order).toEqual(['tick?', 'remember', 'tick?']);
  // The owner is in conversation: nothing of the agent's own is asked for.
  appendEvent(journal, 'g', { type: 'assistant', text: '[teneral: no reply]', toolCalls: [] });
  appendEvent(journal, 'g', { type: 'stimulus', source: 'terminal', text: 'hello' });
  appendEvent(journal, 'g', { type: 'assistant', text: 'Hello.', toolCalls: [] });
  now = Date.parse(readEvents(journal).at(-1)!.ts) + 1000;
  expect(await heart.next()).toBe('wait');
  expect(order).toEqual(['tick?', 'remember', 'tick?']);
});

test('the sleep reaches to the next tick, and a tick that is overdue and not given is asked for again in a while, not at once', () => {
  const journal = setup();
  let tick: number | undefined = 90_000;
  const heart = new Heart(deps(journal, { nextTick: () => tick, nextLook: () => 300_000 }));
  expect(heart.waitFor()).toBe(90_000);
  tick = -4000;
  expect(heart.waitFor()).toBe(60_000);
  tick = undefined;
  expect(heart.waitFor()).toBe(300_000);
});

test('while the heart does its own work it goes on looking: what the agent waits for and comes meanwhile is told then, not after', async () => {
  const journal = setup();
  const order: string[] = [];
  let asks = 0;
  const heart = new Heart(deps(journal, {
    restMs: 0, lookFloorMs: 5, nextLook: () => 10,
    arrived: () => { asks += 1; return asks === 3 ? { source: 'work', text: 'The background job suite that you left running has ended.' } : null; },
    emit: (s) => { order.push('told'); appendEvent(journal, 'g', { type: 'stimulus', source: s.source, text: s.text }); },
    // A memory being formed: a request that takes a while.
    remember: async () => { order.push('remembering'); await Bun.sleep(120); order.push('remembered'); return true; },
  }));
  // The first ask is the beat's own, before the work begins; the others come while it runs.
  expect(await heart.next()).toBe('remember');
  expect(order).toEqual(['remembering', 'told', 'remembered']);
  // Once one has come nothing more is looked for in that piece of work, and none after it is over.
  const asked = asks;
  expect(asked).toBe(3);
  await Bun.sleep(40);
  expect(asks).toBe(asked);
  expect(await heart.next()).toBe('turn');
});
