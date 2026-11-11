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
