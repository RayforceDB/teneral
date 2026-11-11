import { expect, test } from 'bun:test';
import { clock, terminal, type Stimulus } from '../../body/sensors';

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
