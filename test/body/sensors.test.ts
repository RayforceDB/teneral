import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clock, inbox, terminal, type Stimulus } from '../../body/sensors';
import { deliver, ENVELOPE_VERSION } from '../../kernel/envelope';

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
  expect(got[0]!.text).toContain('No one is waiting');
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
