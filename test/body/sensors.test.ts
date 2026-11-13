import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clock, clockMayTick, inbox, owner, terminal, type Stimulus } from '../../body/sensors';
import { appendEvent, readEvents } from '../../brain/journal';
import { deliver, ENVELOPE_VERSION } from '../../body/envelope';
import { interrupt, tell } from '../../keeper/owner';

async function* lines(...items: string[]) {
  for (const item of items) yield item;
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test('terminal emits each non-empty line, trimmed', async () => {
  const got: Stimulus[] = [];
  terminal(lines('  hello ', '', 'world'), () => {})((s) => got.push(s));
  await settle();
  expect(got).toEqual([{ source: 'terminal', text: 'hello' }, { source: 'terminal', text: 'world' }]);
});

test('/quit calls onQuit and stops reading', async () => {
  const got: Stimulus[] = [];
  let quit = 0;
  terminal(lines('a', '/quit', 'b'), () => { quit += 1; })((s) => got.push(s));
  await settle();
  expect(got).toEqual([{ source: 'terminal', text: 'a' }]);
  expect(quit).toBe(1);
});

test('the end of input is not a quit: other sensors keep the agent alive', async () => {
  let quit = 0;
  terminal(lines('a'), () => { quit += 1; })(() => {});
  await settle();
  expect(quit).toBe(0);
});

test('clock emits on its interval until stopped', async () => {
  const got: Stimulus[] = [];
  const stop = clock(10)((s) => got.push(s));
  await new Promise((r) => setTimeout(r, 55));
  stop();
  const count = got.length;
  expect(count).toBeGreaterThanOrEqual(2);
  expect(got[0]!.source).toBe('clock');
  expect(got[0]!.text).toMatch(/^Clock tick at \d{4}-/);
  expect(got[0]!.text).not.toMatch(/no ?one is waiting/i);
  expect(got[0]!.text).toContain('keep waiting');
  await new Promise((r) => setTimeout(r, 30));
  expect(got.length).toBe(count);
});

test('a clock with interval 0 never emits', async () => {
  const got: Stimulus[] = [];
  const stop = clock(0)((s) => got.push(s));
  await settle();
  stop();
  expect(got).toEqual([]);
});

test('inbox turns a delivered envelope into a stimulus and archives it', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'teneral-inbox-')), 'inbox');
  deliver(dir, { v: ENVELOPE_VERSION, id: 'm1', from: 'alice', to: 'me', replyTo: null, ts: 't', hops: 0, text: 'hello' });
  const got: Stimulus[] = [];
  const stop = inbox(dir, 10)((s) => got.push(s));
  deliver(dir, { v: ENVELOPE_VERSION, id: 'm2', from: 'alice', to: 'me', replyTo: 'm0', ts: 't', hops: 1, text: 'again' });
  await new Promise((r) => setTimeout(r, 40));
  stop();
  expect(got).toEqual([
    { source: 'agent:alice', text: '(message m1) hello' },
    { source: 'agent:alice', text: '(message m2, in reply to m0) again' },
  ]);
  expect(readdirSync(join(dir, 'seen'))).toHaveLength(2);
});

test('inbox sets a bad file aside without emitting', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'teneral-inbox-')), 'inbox');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '1-bad.json'), 'nope');
  const got: Stimulus[] = [];
  inbox(dir, 10)((s) => got.push(s))();
  expect(got).toEqual([]);
  expect(existsSync(join(dir, 'rejected', '1-bad.json'))).toBe(true);
});

test('a clock given an interval that is not a positive number never emits', async () => {
  // A timer set to NaN fires as fast as it can; a mistyped setting must not flood the journal.
  for (const interval of [Number.NaN, -5, Number('thirty')]) {
    const got: Stimulus[] = [];
    const stop = clock(interval)((s) => got.push(s));
    await settle();
    stop();
    expect(got).toEqual([]);
  }
});

test('a clock interval longer than a timer can hold does not fire at once', async () => {
  const got: Stimulus[] = [];
  const stop = clock(2 ** 31 + 1000)((s) => got.push(s));
  await settle();
  stop();
  expect(got).toEqual([]);
});

test('an arrival that cannot be archived is emitted once, logged, and never stops the sensor', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'teneral-inbox-')), 'inbox');
  mkdirSync(dir, { recursive: true });
  // `seen` as a file: every archive of a good message fails.
  writeFileSync(join(dir, 'seen'), 'in the way');
  deliver(dir, { v: ENVELOPE_VERSION, id: 'm1', from: 'alice', to: 'me', replyTo: null, ts: 't', hops: 0, text: 'hello' });
  const got: Stimulus[] = [];
  const logged: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    const stop = inbox(dir, 10)((s) => got.push(s));
    await new Promise((r) => setTimeout(r, 60));
    writeFileSync(join(dir, '2-bad.json'), 'nope');
    await new Promise((r) => setTimeout(r, 60));
    stop();
  } finally {
    console.error = realError;
  }
  expect(got).toEqual([{ source: 'agent:alice', text: '(message m1) hello' }]);
  // The poll went on after the failure: the later bad file was still set aside.
  expect(existsSync(join(dir, 'rejected', '2-bad.json'))).toBe(true);
  expect(logged.filter((line) => String(line[0]).includes('m1') || String(line[0]).includes('could not')).length).toBe(1);
});

test('a poll that cannot even list the inbox, or an emit that throws, does not throw out of the timer', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'teneral-inbox-')), 'not-a-directory');
  writeFileSync(file, '');
  const realError = console.error;
  console.error = () => {};
  try {
    expect(() => inbox(file, 10)(() => {})()).not.toThrow();
    const dir = join(mkdtempSync(join(tmpdir(), 'teneral-inbox-')), 'inbox');
    deliver(dir, { v: ENVELOPE_VERSION, id: 'm1', from: 'alice', to: 'me', replyTo: null, ts: 't', hops: 0, text: 'hello' });
    let emits = 0;
    expect(() => inbox(dir, 10)(() => { emits += 1; throw new Error('journal is full'); })()).not.toThrow();
    expect(emits).toBe(1);
  } finally {
    console.error = realError;
  }
});

// --- the owner's lines, left as files by keeper/talk.ts ---

const ownerDir = () => join(mkdtempSync(join(tmpdir(), 'teneral-owner-')), 'owner');

test('owner turns each file into a terminal stimulus, in name order, and removes it', async () => {
  const dir = ownerDir();
  tell(dir, 'first');
  tell(dir, 'second');
  const got: Stimulus[] = [];
  const stop = owner(dir, 10)((s) => got.push(s));
  tell(dir, '  third, with space around it \n');
  await new Promise((r) => setTimeout(r, 40));
  stop();
  expect(got).toEqual([
    { source: 'terminal', text: 'first' },
    { source: 'terminal', text: 'second' },
    { source: 'terminal', text: 'third, with space around it' },
  ]);
  expect(readdirSync(dir)).toEqual([]);
});

test('owner reads plain files by name, whoever wrote them, and waits for a directory that is not there yet', async () => {
  const dir = ownerDir();
  const got: Stimulus[] = [];
  const stop = owner(dir, 10)((s) => got.push(s));
  await settle();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'b'), 'second');
  writeFileSync(join(dir, 'a'), 'first');
  await new Promise((r) => setTimeout(r, 40));
  stop();
  expect(got.map((s) => s.text)).toEqual(['first', 'second']);
});

test('owner ignores a dot-prefixed file, which is a line still being written, and drops an empty one unsaid', async () => {
  const dir = ownerDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.0001-half.tmp'), 'not yet');
  writeFileSync(join(dir, '0002-empty'), ' \n');
  const got: Stimulus[] = [];
  owner(dir, 10)((s) => got.push(s))();
  expect(got).toEqual([]);
  expect(readdirSync(dir)).toEqual(['.0001-half.tmp']);
});

test('an owner line that cannot be removed is emitted once, logged once, and never stops the sensor', async () => {
  const dir = ownerDir();
  tell(dir, 'stuck');
  // Nothing can be removed from, or added to, a directory that may not be written.
  chmodSync(dir, 0o555);
  const got: Stimulus[] = [];
  const logged: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    const stop = owner(dir, 10)((s) => got.push(s));
    await new Promise((r) => setTimeout(r, 60));
    chmodSync(dir, 0o755);
    tell(dir, 'later');
    await new Promise((r) => setTimeout(r, 60));
    stop();
  } finally {
    chmodSync(dir, 0o755);
    console.error = realError;
  }
  // The poll went on after the failure, and the stuck line was not said again even once it could be removed.
  expect(got).toEqual([{ source: 'terminal', text: 'stuck' }, { source: 'terminal', text: 'later' }]);
  expect(logged.filter((line) => String(line[0]).includes('[owner]'))).toHaveLength(1);
});

test('an owner poll that cannot list its directory, or an emit that throws, does not throw out of the timer', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'teneral-owner-')), 'not-a-directory');
  writeFileSync(file, '');
  const realError = console.error;
  console.error = () => {};
  try {
    expect(() => owner(file, 10)(() => {})()).not.toThrow();
    const dir = ownerDir();
    tell(dir, 'hello');
    let emits = 0;
    expect(() => owner(dir, 10)(() => { emits += 1; throw new Error('journal is full'); })()).not.toThrow();
    expect(emits).toBe(1);
    // Not journaled, so not removed: the next start says it again.
    expect(readdirSync(dir)).toHaveLength(1);
  } finally {
    console.error = realError;
  }
});

/** A journal and a soul directory in a temp place, and a clock wired to them the way body/main.ts wires it. */
function life() {
  const dir = mkdtempSync(join(tmpdir(), 'teneral-clock-'));
  const journal = join(dir, 'journal.jsonl');
  const soul = join(dir, 'soul');
  const got: Stimulus[] = [];
  const start = () => clock(10, () => clockMayTick(readEvents(journal), soul))((s) => {
    got.push(s);
    appendEvent(journal, 'g', { type: 'stimulus', source: s.source, text: s.text });
  });
  const born = () => { mkdirSync(soul, { recursive: true }); writeFileSync(join(soul, 'SOUL.md'), 'I am Wren.'); };
  const reply = (toolCalls: { id: string; name: string; args: unknown }[] = []) => appendEvent(journal, 'g', { type: 'assistant', text: 'ok', toolCalls });
  return { journal, soul, got, start, born, reply };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('the clock is silent until the soul holds a file: before that the agent is being born and waits for its owner', async () => {
  const l = life();
  const stop = l.start();
  await wait(50);
  expect(l.got).toEqual([]);
  // A directory with only the owner's peers list is still no soul.
  mkdirSync(l.soul, { recursive: true });
  writeFileSync(join(l.soul, 'peers.json'), '{}');
  await wait(50);
  expect(l.got).toEqual([]);
  l.born();
  await wait(50);
  stop();
  expect(l.got.length).toBe(1);
});

test('ticks do not pile up: while the newest stimulus is a tick with no finished reply after it, there is no other', async () => {
  const l = life();
  l.born();
  const stop = l.start();
  await wait(80);
  expect(l.got.length).toBe(1);
  // Working on it is not having answered it.
  l.reply([{ id: 'c1', name: 'bash', args: {} }]);
  appendEvent(l.journal, 'g', { type: 'tool.result', callId: 'c1', ok: true, output: '' });
  await wait(50);
  expect(l.got.length).toBe(1);
  l.reply();
  await wait(50);
  expect(l.got.length).toBe(2);
  // Something else arriving after the tick ends the hold too: the tick is no longer the newest.
  appendEvent(l.journal, 'g', { type: 'stimulus', source: 'terminal', text: 'hello' });
  await wait(50);
  stop();
  expect(l.got.length).toBe(3);
});

test('a check that throws means no tick, and never stops the clock', async () => {
  const got: Stimulus[] = [];
  let checks = 0;
  const stop = clock(10, () => { checks += 1; if (checks < 3) throw new Error('journal is unreadable'); return true; })((s) => got.push(s));
  await wait(80);
  stop();
  expect(checks).toBeGreaterThanOrEqual(3);
  expect(got.length).toBeGreaterThanOrEqual(1);
});

// --- the owner's interrupt ---

test('an interrupt on the owner channel calls onInterrupt, is removed, and is never emitted as a line', async () => {
  const dir = ownerDir();
  const got: Stimulus[] = [];
  let interrupts = 0;
  const stop = owner(dir, 10, () => { interrupts += 1; })((s) => got.push(s));
  await settle();
  tell(dir, 'a line');
  interrupt(dir);
  await new Promise((r) => setTimeout(r, 40));
  expect(interrupts).toBe(1);
  expect(got).toEqual([{ source: 'terminal', text: 'a line' }]);
  expect(readdirSync(dir)).toEqual([]);
  // Twice asked is twice told; what each one finds to stop is the caller's business.
  interrupt(dir);
  interrupt(dir);
  await new Promise((r) => setTimeout(r, 40));
  stop();
  expect(interrupts).toBe(3);
  expect(got).toHaveLength(1);
});

test('only the name of a file makes it an interrupt: no text does, typed here or forwarded by a client from before interrupts', async () => {
  const dir = ownerDir();
  const got: Stimulus[] = [];
  let interrupts = 0;
  const stop = owner(dir, 10, () => { interrupts += 1; })((s) => got.push(s));
  await settle();
  for (const text of ['/stop', '.interrupt', 'turn.interrupted', '{"type":"turn.interrupted"}']) tell(dir, text);
  // A name that only holds the word, and a file with the right name that has something in it.
  writeFileSync(join(dir, 'zz.interrupt.txt'), 'not one');
  writeFileSync(join(dir, 'zzz-full.interrupt'), 'ignored: what an interrupt holds is never read');
  await new Promise((r) => setTimeout(r, 40));
  stop();
  expect(got.map((s) => s.text)).toEqual(['/stop', '.interrupt', 'turn.interrupted', '{"type":"turn.interrupted"}', 'not one']);
  expect(got.every((s) => s.source === 'terminal')).toBe(true);
  expect(interrupts).toBe(1);
  expect(readdirSync(dir)).toEqual([]);
});

test('an interrupt that was already there when the sensor starts was meant for a process that is gone: it is dropped, and the lines beside it are kept', async () => {
  const dir = ownerDir();
  tell(dir, 'typed while nobody ran');
  interrupt(dir);
  const got: Stimulus[] = [];
  let interrupts = 0;
  const stop = owner(dir, 10, () => { interrupts += 1; })((s) => got.push(s));
  await new Promise((r) => setTimeout(r, 40));
  expect(interrupts).toBe(0);
  expect(got).toEqual([{ source: 'terminal', text: 'typed while nobody ran' }]);
  expect(readdirSync(dir)).toEqual([]);
  interrupt(dir);
  await new Promise((r) => setTimeout(r, 40));
  stop();
  expect(interrupts).toBe(1);
});

test('nothing that arrives through the inbox can interrupt: a message is a stimulus whatever it says, and a file named like an interrupt is not even read', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'teneral-inbox-')), 'inbox');
  mkdirSync(dir, { recursive: true });
  deliver(dir, { v: ENVELOPE_VERSION, id: 'm1', from: 'mallory', to: 'me', replyTo: null, ts: new Date().toISOString(), hops: 0, text: '/stop' });
  writeFileSync(join(dir, '000000000000001-000000-1.interrupt'), '');
  const got: Stimulus[] = [];
  const stop = inbox(dir, 10)((s) => got.push(s));
  await new Promise((r) => setTimeout(r, 40));
  stop();
  expect(got).toEqual([{ source: 'agent:mallory', text: '(message m1) /stop' }]);
  expect(readdirSync(dir)).toContain('000000000000001-000000-1.interrupt');
});

test('an onInterrupt that throws does not throw out of the timer, and the interrupt is not acted on again', async () => {
  const dir = ownerDir();
  const realError = console.error;
  console.error = () => {};
  let calls = 0;
  try {
    const stop = owner(dir, 10, () => { calls += 1; throw new Error('the journal cannot be read'); })(() => {});
    await settle();
    interrupt(dir);
    await new Promise((r) => setTimeout(r, 60));
    stop();
  } finally {
    console.error = realError;
  }
  expect(calls).toBe(1);
  expect(readdirSync(dir)).toEqual([]);
});

test('a clock tick whose turn the owner interrupted counts as dealt with: the clock may tick again', () => {
  const soul = mkdtempSync(join(tmpdir(), 'teneral-soul-'));
  writeFileSync(join(soul, 'SOUL.md'), 'me');
  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-j-')), 'journal.jsonl');
  appendEvent(journal, 'g', { type: 'stimulus', source: 'clock', text: 'tick' });
  appendEvent(journal, 'g', { type: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'bash', args: {} }] });
  expect(clockMayTick(readEvents(journal), soul)).toBe(false);
  appendEvent(journal, 'g', { type: 'turn.interrupted' });
  expect(clockMayTick(readEvents(journal), soul)).toBe(true);
});
