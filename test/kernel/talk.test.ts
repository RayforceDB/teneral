import { expect, test } from 'bun:test';
import {
  appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, readEvents, type EventBody, type JournalEvent } from '../../kernel/journal';
import { INTERRUPT_SUFFIX } from '../../kernel/owner';
import {
  AT_REST, Follower, recent, render, talk, track, type Turn,
} from '../../kernel/talk';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

/** An event as the journal would hold it, `at` milliseconds into the story. */
function ev(body: EventBody, at = 0): JournalEvent {
  return { ...body, v: 1, id: `e${Math.random()}`, ts: new Date(1_800_000_000_000 + at).toISOString(), gen: A } as JournalEvent;
}
const said = (text: string, at = 0) => ev({ type: 'stimulus', source: 'terminal', text }, at);
const reply = (text: string, at = 0) => ev({ type: 'assistant', text, toolCalls: [] }, at);
const calling = (at = 0) => ev({ type: 'assistant', text: '', toolCalls: [{ id: 'c', name: 'bash', args: {} }] }, at);
const result = (at = 0) => ev({ type: 'tool.result', callId: 'c', ok: true, output: 'ok' }, at);

// --- what an event prints as ---

test('a reply prints as its text, and a reply that only calls tools prints as nothing', () => {
  expect(render(reply('Hello.\nTwo lines.'))).toBe('Hello.\nTwo lines.\n');
  expect(render(calling())).toBeNull();
  expect(render(reply('  \n'))).toBeNull();
  expect(render(ev({ type: 'assistant', text: 'Looking.', toolCalls: [{ id: 'c', name: 'bash', args: {} }] }))).toBe('Looking.\n');
});

test('a tool call prints as one short line: its name and its arguments, clipped', () => {
  expect(render(ev({ type: 'tool.intent', callId: 'c', name: 'bash', args: { command: 'ls -la\n  /tmp' } }))).toBe('  [bash] command: ls -la /tmp');
  const long = render(ev({ type: 'tool.intent', callId: 'c', name: 'write', args: { path: 'a.ts', content: 'x'.repeat(5000) } }))!;
  expect(long.startsWith('  [write] path: a.ts, content: xxx')).toBe(true);
  expect(long).not.toContain('\n');
  expect(long.length).toBeLessThan(140);
  expect(render(ev({ type: 'tool.intent', callId: 'c', name: 'now', args: {} }))).toBe('  [now]');
});

test('each kernel note prints: promoted, rejected with the gate and the end of its output, rolled back with the reason', () => {
  expect(render(ev({ type: 'generation.promoted', commit: B, previous: A }))).toBe('[kernel] promoted bbbbbbbbbbbb (before: aaaaaaaaaaaa)');
  const rejected = render(ev({ type: 'molt.rejected', commit: B, gate: 'tests', output: `${'noise\n'.repeat(1000)}1 fail\nexpected 2` }))!;
  expect(rejected.split('\n')[0]).toBe('[kernel] molt to bbbbbbbbbbbb rejected at gate "tests":');
  expect(rejected.endsWith('    1 fail\n    expected 2')).toBe(true);
  expect(rejected.length).toBeLessThan(3000);
  expect(render(ev({ type: 'molt.rejected', commit: B, gate: 'same', output: '' }))).toBe('[kernel] molt to bbbbbbbbbbbb rejected at gate "same"');
  expect(render(ev({ type: 'generation.rolledback', commit: B, to: A, reason: 'exited with 1 before it was ready' })))
    .toBe('[kernel] rolled back bbbbbbbbbbbb to aaaaaaaaaaaa: exited with 1 before it was ready');
});

test('what woke the agent prints as one line; a typed line as a typed line', () => {
  expect(render(ev({ type: 'stimulus', source: 'agent:alice', text: '(message m1) hello\nsecond line' }))).toBe('[agent:alice] (message m1) hello second line');
  const letter = render(ev({ type: 'stimulus', source: 'birth', text: 'x'.repeat(5000) }))!;
  expect(letter.length).toBeLessThan(220);
  expect(render(said('who are you?'))).toBe('> who are you?');
});

test('nothing prints for the rest', () => {
  expect(render(result())).toBeNull();
  expect(render(ev({ type: 'generation.started', commit: A }))).toBeNull();
  expect(render(ev({ type: 'generation.ready', commit: A }))).toBeNull();
  expect(render(ev({ type: 'molt.requested', commit: B, motive: 'm' }))).toBeNull();
  expect(render({ ...ev({ type: 'generation.ready', commit: A }), type: 'something.new' } as unknown as JournalEvent)).toBeNull();
});

test('a note the body keeps for itself prints nothing, moves no turn, and is not in the history', () => {
  const note = (at = 0) => ev({ type: 'note', kind: 'memory.fact', data: { text: 'not for the screen\u001b[31m', n: 1 } }, at);
  expect(render(note())).toBeNull();
  // At rest it does not start a turn; in a turn it neither ends it nor counts as something that arrived late.
  expect(track(AT_REST, note())).toEqual(AT_REST);
  expect(after(said('hi'), note(100), reply('hello', 900))).toEqual(after(said('hi'), reply('hello', 900)));
  expect(after(said('hi'), calling(900), note(920), result(950), note(960))).toEqual(after(said('hi'), calling(900), result(950)));
  expect(after(said('hi'), reply('hello', 900), note(1000)).busy).toBe(false);
  expect(recent([said('one'), note(), reply('to one'), note()])).toEqual(['> one', 'to one\n']);
  // One of a shape the kernel would not have written is passed over the same way.
  const odd = { ...note(), kind: 7, data: undefined } as unknown as JournalEvent;
  expect(render(odd)).toBeNull();
  expect(track(AT_REST, odd)).toEqual(AT_REST);
});

test('control characters never reach the terminal, and an event of the wrong shape still prints or is skipped without throwing', () => {
  expect(render(reply('red \x1b[31malert\x07 done'))).toBe('red [31malert done\n');
  expect(render(ev({ type: 'tool.intent', callId: 'c', name: 'ba\x1bsh', args: 'not an object' as unknown }))).toBe('  [bash] not an object');
  const odd = [
    { type: 'assistant' }, { type: 'assistant', text: 7, toolCalls: 'x' }, { type: 'tool.intent', args: null },
    { type: 'stimulus' }, { type: 'molt.rejected' }, { type: 'generation.promoted', commit: {} }, { type: 'generation.rolledback', reason: [1] },
  ];
  for (const body of odd) expect(() => render({ ...ev(said('x')), text: undefined, source: undefined, ...body } as unknown as JournalEvent)).not.toThrow();
});

// --- whether a finished reply answers a given line ---

const after = (...events: JournalEvent[]): Turn => events.reduce(track, AT_REST);

test('a line starts a turn and the finished reply ends it, with any number of tool rounds between', () => {
  expect(AT_REST.busy).toBe(false);
  expect(after(said('hi')).busy).toBe(true);
  expect(after(said('hi'), reply('hello', 900)).busy).toBe(false);
  expect(after(said('hi'), calling(900), result(950)).busy).toBe(true);
  expect(after(said('hi'), calling(900), result(950), calling(1800), result(1900), reply('done', 2500)).busy).toBe(false);
});

test('a line that arrives while a reply is being written is not answered by that reply, but by the next', () => {
  // The first request was sent at 0; the second line came at 500, the reply to the first at 900.
  const first = after(said('one', 0), said('two', 500), reply('to one', 900));
  expect(first.busy).toBe(true);
  expect(track(first, reply('to two', 1800)).busy).toBe(false);
});

test('lines journaled together, by one pass of the sensor, are answered together', () => {
  expect(after(said('one', 0), said('two', 8), said('three', 15), reply('to all', 900)).busy).toBe(false);
});

test('a line that arrives while tools run is seen by the request after them', () => {
  expect(after(said('one', 0), calling(900), said('two', 1000), result(1500), reply('to both', 2400)).busy).toBe(false);
  // But one that arrives after the last result is late for that request.
  const t = after(said('one', 0), calling(900), result(1500), said('two', 2000), reply('to one', 2400));
  expect(t.busy).toBe(true);
  expect(track(t, reply('to two', 3000)).busy).toBe(false);
});

test('across a molt the agent stays busy until the new generation has replied', () => {
  const story = [
    said('molt please', 0), calling(900), result(1000),
    ev({ type: 'generation.promoted', commit: B, previous: A }, 4000),
    ev({ type: 'generation.started', commit: B }, 4001),
    ev({ type: 'generation.ready', commit: B }, 4300),
  ];
  expect(after(...story).busy).toBe(true);
  expect(after(...story, reply('I am on the new generation', 5000)).busy).toBe(false);
  // A line that was waiting when the new generation came up is taken in before its first request.
  expect(after(...story, said('still there?', 4310), reply('yes, and on the new generation', 5000)).busy).toBe(false);
});

test('a kernel note by itself starts a turn, and a generation starting with nothing owed stays at rest', () => {
  expect(after(ev({ type: 'molt.rejected', commit: B, gate: 'tests', output: '' })).busy).toBe(true);
  expect(after(ev({ type: 'generation.started', commit: A }), ev({ type: 'generation.ready', commit: A }, 300)).busy).toBe(false);
});

// --- following the journal ---

const scratch = () => mkdtempSync(join(tmpdir(), 'teneral-talk-'));

test('the follower gives each new event once, starting from where the journal ended', () => {
  const journal = join(scratch(), 'memory', 'journal.jsonl');
  appendEvent(journal, A, { type: 'stimulus', source: 'terminal', text: 'before' });
  const follower = new Follower(journal);
  expect(follower.poll()).toEqual([]);
  const one = appendEvent(journal, A, { type: 'assistant', text: 'one', toolCalls: [] });
  const two = appendEvent(journal, A, { type: 'assistant', text: 'two', toolCalls: [] });
  expect(follower.poll().map((e) => e.id)).toEqual([one.id, two.id]);
  expect(follower.poll()).toEqual([]);
  const three = appendEvent(journal, A, { type: 'assistant', text: 'three', toolCalls: [] });
  expect(follower.poll().map((e) => e.id)).toEqual([three.id]);
});

test('the follower waits for a journal that does not exist yet', () => {
  const journal = join(scratch(), 'memory', 'journal.jsonl');
  const follower = new Follower(journal);
  expect(follower.poll()).toEqual([]);
  const first = appendEvent(journal, A, { type: 'generation.started', commit: A });
  expect(follower.poll().map((e) => e.id)).toEqual([first.id]);
});

test('an event caught half-written is given whole on a later poll, not lost', () => {
  const journal = join(scratch(), 'journal.jsonl');
  writeFileSync(journal, '');
  const follower = new Follower(journal);
  const line = `${JSON.stringify(reply('split in two'))}\n`;
  appendFileSync(journal, line.slice(0, 30));
  expect(follower.poll()).toEqual([]);
  appendFileSync(journal, line.slice(30));
  expect(follower.poll().map((e) => (e as { text?: string }).text)).toEqual(['split in two']);
  expect(follower.poll()).toEqual([]);
});

test('a journal that was replaced by a shorter one is followed from its end, without throwing', () => {
  const journal = join(scratch(), 'journal.jsonl');
  for (let i = 0; i < 5; i++) appendEvent(journal, A, { type: 'assistant', text: `old ${i}`, toolCalls: [] });
  const follower = new Follower(journal);
  rmSync(journal);
  expect(follower.poll()).toEqual([]);
  appendEvent(journal, A, { type: 'assistant', text: 'new life', toolCalls: [] });
  follower.poll();
  appendEvent(journal, A, { type: 'assistant', text: 'and on', toolCalls: [] });
  expect(follower.poll().map((e) => (e as { text?: string }).text)).toEqual(['and on']);
});

// --- the history shown on attaching ---

test('the history is the last few exchanges without their tool calls', () => {
  const events = [
    said('one'), reply('to one'),
    said('two'), calling(), ev({ type: 'tool.intent', callId: 'c', name: 'bash', args: { command: 'ls' } }), result(), reply('to two'),
    ev({ type: 'stimulus', source: 'clock', text: 'It is late.' }), reply('nothing to do'),
    said('four'), reply('to four'), ev({ type: 'generation.promoted', commit: B, previous: A }),
  ];
  expect(recent(events)).toEqual([
    '> two', 'to two\n', '[clock] It is late.', 'nothing to do\n', '> four', 'to four\n', '[kernel] promoted bbbbbbbbbbbb (before: aaaaaaaaaaaa)',
  ]);
  expect(recent([])).toEqual([]);
  expect(recent([reply('no stimulus before me')])).toEqual(['no stimulus before me\n']);
});

test('the history stays short whatever the journal holds', () => {
  const huge = recent([said('q'.repeat(50_000)), reply('r'.repeat(50_000))]);
  expect(huge.join('\n').length).toBeLessThan(5000);
  expect(huge[1]).toContain('more characters');
  const chatty = [said('go'), ...Array.from({ length: 500 }, (_, i) => ev({ type: 'assistant', text: `step ${i}`, toolCalls: [{ id: 'c', name: 'bash', args: {} }] }))];
  expect(recent(chatty).length).toBeLessThanOrEqual(40);
  expect(recent(chatty).at(-1)).toBe('step 499\n');
});

// --- the client itself, against a stand-in for the body ---

/** Takes the owner's lines the way the body's sensor does and answers each `delayMs` later. */
function standIn(journal: string, owner: string, delayMs = 30) {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const poll = setInterval(() => {
    if (!existsSync(owner)) return;
    for (const name of readdirSync(owner).filter((n) => !n.startsWith('.')).sort()) {
      const text = readFileSync(join(owner, name), 'utf8').trim();
      appendEvent(journal, A, { type: 'stimulus', source: 'terminal', text });
      rmSync(join(owner, name));
      const timer = setTimeout(() => {
        timers.delete(timer);
        appendEvent(journal, A, { type: 'tool.intent', callId: 'c', name: 'echo', args: { text } });
        appendEvent(journal, A, { type: 'assistant', text: `you said: ${text}`, toolCalls: [] });
      }, delayMs);
      timers.add(timer);
    }
  }, 5);
  return () => { clearInterval(poll); for (const timer of timers) clearTimeout(timer); };
}

async function* from(...lines: string[]) {
  for (const line of lines) yield line;
}

function setup() {
  const dir = scratch();
  const out: string[] = [];
  const notes: string[] = [];
  const journal = join(dir, 'memory', 'journal.jsonl');
  const owner = join(dir, '.teneral', 'owner');
  const base = { journal, owner, write: (t: string) => { out.push(t); }, note: (t: string) => { notes.push(t); }, pollMs: 5 };
  return { journal, owner, out, notes, base };
}

test('piped lines are sent one at a time, each after the reply to the one before, and the exit follows the last reply', async () => {
  const s = setup();
  appendEvent(s.journal, A, { type: 'stimulus', source: 'terminal', text: 'earlier' });
  appendEvent(s.journal, A, { type: 'assistant', text: 'an earlier reply', toolCalls: [] });
  const stop = standIn(s.journal, s.owner);
  try {
    expect(await talk({ ...s.base, lines: from('first', '', '  second  '), interactive: false })).toBe(0);
  } finally {
    stop();
  }
  // Only what happened after the first line, and never the lines themselves.
  expect(s.out.join('')).toBe('  [echo] text: first\nyou said: first\n\n  [echo] text: second\nyou said: second\n\n');
  const order = readEvents(s.journal).slice(2).map((e) => (e.type === 'stimulus' || e.type === 'assistant' ? e.text : null)).filter((t) => t !== null);
  expect(order).toEqual(['first', 'you said: first', 'second', 'you said: second']);
  expect(readdirSync(s.owner)).toEqual([]);
});

test('a body that journals notes around its replies changes nothing a piped client prints or waits for', async () => {
  const s = setup();
  appendEvent(s.journal, A, { type: 'note', kind: 'memory.fact', data: { n: 0 } });
  // The stand-in's replies, with a note before and after each.
  const stop = standIn(s.journal, s.owner);
  let last = 0;
  const noting = setInterval(() => {
    const replies = readEvents(s.journal).filter((e) => e.type === 'assistant').length;
    if (replies !== last) { last = replies; appendEvent(s.journal, A, { type: 'note', kind: 'memory.fact', data: { n: replies } }); }
  }, 3);
  try {
    expect(await talk({ ...s.base, lines: from('first', 'second'), interactive: false })).toBe(0);
  } finally {
    clearInterval(noting);
    stop();
  }
  expect(s.out.join('')).toBe('  [echo] text: first\nyou said: first\n\n  [echo] text: second\nyou said: second\n\n');
});

test('a piped line waits for an agent in the middle of a turn to come to rest before it is sent', async () => {
  const s = setup();
  appendEvent(s.journal, A, { type: 'stimulus', source: 'clock', text: 'tick' });
  const stop = standIn(s.journal, s.owner);
  const done = talk({ ...s.base, lines: from('hello'), interactive: false });
  await Bun.sleep(60);
  expect(existsSync(s.owner)).toBe(false);
  appendEvent(s.journal, A, { type: 'assistant', text: 'nothing to do', toolCalls: [] });
  try {
    expect(await done).toBe(0);
  } finally {
    stop();
  }
  expect(s.out.join('')).toBe('nothing to do\n\n  [echo] text: hello\nyou said: hello\n\n');
});

test('piped input with no lines in it shows where things stand and ends at once', async () => {
  const s = setup();
  appendEvent(s.journal, A, { type: 'stimulus', source: 'terminal', text: 'earlier' });
  appendEvent(s.journal, A, { type: 'assistant', text: 'an earlier reply', toolCalls: [] });
  expect(await talk({ ...s.base, lines: from(), interactive: false })).toBe(0);
  expect(s.out.join('')).toBe('> earlier\nan earlier reply\n\n');
  expect(existsSync(s.owner)).toBe(false);
});

test('with no journal and nobody answering, a piped line gives up after the wait, with status 1 and a reason', async () => {
  const s = setup();
  expect(await talk({ ...s.base, lines: from('anyone?'), interactive: false, waitMs: 80 })).toBe(1);
  expect(s.out).toEqual([]);
  expect(s.notes.join('\n')).toContain('giving up');
  // The line stays where the agent will find it when it starts.
  expect(readdirSync(s.owner)).toHaveLength(1);
});

test('/quit ends the client at once and is never sent', async () => {
  const s = setup();
  expect(await talk({ ...s.base, lines: from('/quit', 'never sent'), interactive: false })).toBe(0);
  expect(await talk({ ...s.base, lines: from(' /quit '), interactive: true })).toBe(0);
  expect(existsSync(s.owner)).toBe(false);
  expect(readEvents(s.journal)).toEqual([]);
});

test('a person attaching sees the last exchanges, then replies as they come, and not the lines typed here', async () => {
  const s = setup();
  appendEvent(s.journal, A, { type: 'stimulus', source: 'terminal', text: 'earlier' });
  appendEvent(s.journal, A, { type: 'assistant', text: 'an earlier reply', toolCalls: [] });
  const stop = standIn(s.journal, s.owner);
  // A keyboard: one line now, another from someone else's terminal meanwhile, then Ctrl-D.
  async function* typing() {
    yield 'hello';
    await Bun.sleep(40);
    appendEvent(s.journal, A, { type: 'stimulus', source: 'terminal', text: 'typed elsewhere' });
    appendEvent(s.journal, A, { type: 'stimulus', source: 'agent:alice', text: '(message m1) hi' });
    await Bun.sleep(250);
  }
  try {
    expect(await talk({ ...s.base, lines: typing(), interactive: true })).toBe(0);
  } finally {
    stop();
  }
  const text = s.out.join('');
  expect(text.startsWith('> earlier\nan earlier reply\n\n')).toBe(true);
  expect(text).toContain('you said: hello\n');
  expect(text).not.toContain('> hello');
  expect(text.split('> typed elsewhere\n')).toHaveLength(2);
  expect(text).toContain('[agent:alice] (message m1) hi\n');
  expect(s.notes.join('\n')).toContain('attached');
});

test('two clients at once both see the reply, and each sees the other\'s line once', async () => {
  const s = setup();
  const other = { out: [] as string[] };
  const stop = standIn(s.journal, s.owner, 40);
  async function* slow(line: string) {
    yield line;
    await Bun.sleep(400);
  }
  try {
    const [a, b] = await Promise.all([
      talk({ ...s.base, lines: slow('from a'), interactive: true }),
      talk({ ...s.base, write: (t) => { other.out.push(t); }, lines: slow('from b'), interactive: true }),
    ]);
    expect([a, b]).toEqual([0, 0]);
  } finally {
    stop();
  }
  const a = s.out.join('');
  const b = other.out.join('');
  for (const seen of [a, b]) {
    expect(seen.split('you said: from a\n')).toHaveLength(2);
    expect(seen.split('you said: from b\n')).toHaveLength(2);
  }
  expect(a).not.toContain('> from a');
  expect(a.split('> from b\n')).toHaveLength(2);
  expect(b).not.toContain('> from b');
  expect(b.split('> from a\n')).toHaveLength(2);
});

test('attaching to an agent that has never run says so and waits', async () => {
  const s = setup();
  async function* idle() { await Bun.sleep(30); }
  expect(await talk({ ...s.base, lines: idle(), interactive: true })).toBe(0);
  expect(s.out).toEqual([]);
  expect(s.notes.join('\n')).toContain('journal is empty');
});

test('a banner is said once, first, to a person who is typing, and never to a script', async () => {
  const s = setup();
  expect(await talk({ ...s.base, lines: from('/quit'), interactive: true, banner: 'Using ChatGPT plan. Manage usage: https://chatgpt.com/settings/usage' })).toBe(0);
  expect(s.notes[0]).toBe('Using ChatGPT plan. Manage usage: https://chatgpt.com/settings/usage');
  expect(s.notes.filter((note) => note.includes('ChatGPT'))).toHaveLength(1);
  const piped = setup();
  expect(await talk({ ...piped.base, lines: from('/quit'), interactive: false, banner: 'Using ChatGPT plan.' })).toBe(0);
  expect(await talk({ ...piped.base, lines: from('/quit'), interactive: true, banner: null })).toBe(0);
  expect(piped.notes.join('\n')).not.toContain('ChatGPT');
});

// --- /stop: the owner interrupts ---

const stopped = (at = 0) => ev({ type: 'turn.interrupted' }, at);

test('a turn the owner interrupted prints as one line, and leaves the agent at rest until something else arrives', () => {
  expect(render(stopped())).toBe('[interrupted by the owner]');
  expect([said('go', 0), calling(10), stopped(20)].reduce(track, AT_REST)).toEqual(AT_REST);
  expect([said('go', 0), said('more', 500), stopped(600)].reduce(track, AT_REST)).toEqual(AT_REST);
  expect([said('go', 0), stopped(20), said('again', 1000)].reduce(track, AT_REST).busy).toBe(true);
  expect(recent([said('go'), calling(), stopped()])).toEqual(['> go', '[interrupted by the owner]']);
});

/** Takes lines and interrupts the way the body does: a line starts a turn that never ends by itself, an interrupt ends it. */
function stoppable(journal: string, owner: string) {
  const poll = setInterval(() => {
    if (!existsSync(owner)) return;
    for (const name of readdirSync(owner).filter((n) => !n.startsWith('.')).sort()) {
      const interrupt = name.endsWith(INTERRUPT_SUFFIX);
      const text = readFileSync(join(owner, name), 'utf8').trim();
      rmSync(join(owner, name));
      if (interrupt) appendEvent(journal, A, { type: 'turn.interrupted' });
      else appendEvent(journal, A, { type: 'stimulus', source: 'terminal', text });
    }
  }, 5);
  return () => clearInterval(poll);
}

test('/stop typed while the agent works goes out as an interrupt, never as a line; typed while it rests it sends nothing and says so', async () => {
  const s = setup();
  const sent: string[][] = [];
  const names = () => (existsSync(s.owner) ? readdirSync(s.owner).filter((n) => !n.startsWith('.')).sort() : []);
  async function* typing() {
    yield '/stop';
    await Bun.sleep(30);
    sent.push(names());
    yield 'work on this';
    await Bun.sleep(60);
    yield ' /stop ';
    sent.push(names());
    await Bun.sleep(120);
  }
  // Nobody takes the first files, so that what was written can be seen.
  const done = talk({ ...s.base, lines: typing(), interactive: true });
  await Bun.sleep(60);
  appendEvent(s.journal, A, { type: 'stimulus', source: 'terminal', text: 'work on this' });
  expect(await done).toBe(0);
  expect(sent[0]).toEqual([]);
  expect(sent[1]!.map((name) => name.slice(name.lastIndexOf('.')))).toEqual(['.txt', INTERRUPT_SUFFIX]);
  expect(readdirSync(s.owner).sort().map((name) => readFileSync(join(s.owner, name), 'utf8'))).toEqual(['work on this', '']);
  expect(s.notes.filter((note) => note.includes('interrupt'))).toEqual([
    expect.stringContaining('/stop interrupts what the agent is doing'),
    '(the agent is not in the middle of a turn: nothing to interrupt)',
    '(interrupt sent)',
  ]);
});

test('a person who types /stop sees the turn end in the journal', async () => {
  const s = setup();
  const stop = stoppable(s.journal, s.owner);
  async function* typing() {
    yield 'work on this';
    await Bun.sleep(60);
    yield '/stop';
    await Bun.sleep(120);
  }
  try {
    expect(await talk({ ...s.base, lines: typing(), interactive: true })).toBe(0);
  } finally {
    stop();
  }
  expect(s.out.join('')).toBe('[interrupted by the owner]\n');
  expect(readEvents(s.journal).map((e) => e.type)).toEqual(['stimulus', 'turn.interrupted']);
});

test('piped /stop interrupts the turn the agent is in when its place among the lines comes, and the next line waits for the agent to be at rest', async () => {
  const s = setup();
  appendEvent(s.journal, A, { type: 'stimulus', source: 'clock', text: 'tick' });
  appendEvent(s.journal, A, { type: 'assistant', text: '', toolCalls: [{ id: 'c', name: 'bash', args: { command: 'sleep 999' } }] });
  const stop = stoppable(s.journal, s.owner);
  const done = talk({ ...s.base, lines: from('/stop', 'now this'), interactive: false, waitMs: 2000 });
  await Bun.sleep(150);
  // The line after it went out only once the interruption was journaled, and is still unanswered.
  expect(readEvents(s.journal).slice(2).map((e) => (e.type === 'stimulus' ? e.text : e.type))).toEqual(['turn.interrupted', 'now this']);
  appendEvent(s.journal, A, { type: 'assistant', text: 'this, then', toolCalls: [] });
  try {
    expect(await done).toBe(0);
  } finally {
    stop();
  }
  expect(s.out.join('')).toBe('[interrupted by the owner]\nthis, then\n\n');
  expect(s.notes).toEqual(['(interrupt sent)']);
});

test('piped /stop with the agent at rest sends nothing, says so, and the lines after it go on as ever', async () => {
  const s = setup();
  appendEvent(s.journal, A, { type: 'stimulus', source: 'terminal', text: 'earlier' });
  appendEvent(s.journal, A, { type: 'assistant', text: 'an earlier reply', toolCalls: [] });
  const stop = standIn(s.journal, s.owner);
  try {
    expect(await talk({ ...s.base, lines: from('/stop', 'hello'), interactive: false })).toBe(0);
  } finally {
    stop();
  }
  expect(s.notes).toEqual(['(the agent is not in the middle of a turn: nothing to interrupt)']);
  expect(s.out.join('')).toBe('  [echo] text: hello\nyou said: hello\n\n');
  expect(readEvents(s.journal).map((e) => e.type)).not.toContain('turn.interrupted');
});
