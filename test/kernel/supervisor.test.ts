import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEvents } from '../../kernel/journal';
import { init, paths, supervise } from '../../kernel/supervisor';
import type { GateResult } from '../../kernel/gates';
import { commitAll, makeRepo, writeFiles } from './helpers';

const JOURNAL_MODULE = join(import.meta.dir, '../../kernel/journal.ts');

const V1 = `
import { appendEvent, readEvents } from ${JSON.stringify(JOURNAL_MODULE)};
const journal = process.env.TENERAL_JOURNAL;
const gen = process.env.TENERAL_GEN;
const before = readEvents(journal);
appendEvent(journal, gen, { type: 'generation.ready', commit: gen });
const answered = ['generation.promoted', 'generation.rolledback', 'molt.rejected'];
if (before.some((e) => answered.includes(e.type))) process.exit(0);
appendEvent(journal, gen, { type: 'molt.requested', commit: process.env.TEST_NEXT, motive: 'test' });
process.exit(75);
`;

const PASS: GateResult = { ok: true, gate: 'all', output: '' };

async function scenario(v2: string, gate: GateResult) {
  const { dir, seed } = makeRepo({ 'body/main.ts': V1 });
  init(dir);
  const p = paths(dir);
  writeFiles(p.candidate, { 'body/main.ts': v2 });
  const next = commitAll(p.candidate, 'v2');
  process.env.TEST_NEXT = next;

  const outcome = await supervise({ root: dir, gates: () => gate, readyTimeoutMs: 5000, log: () => {} });
  const state = JSON.parse(readFileSync(p.state, 'utf8')) as { current: string; previous: string | null };
  const types = readEvents(p.journal).map((e) => e.type);
  return { outcome, state, types, seed, next };
}

test('a healthy candidate is promoted and stays', async () => {
  const r = await scenario(`${V1}\n// v2`, PASS);
  expect(r.outcome).toBe('stopped');
  expect(r.state).toEqual({ current: r.next, previous: r.seed });
  expect(r.types).toContain('generation.promoted');
  expect(r.types).not.toContain('generation.rolledback');
});

test('a candidate that dies before it is ready is rolled back', async () => {
  const r = await scenario('process.exit(1);\n', PASS);
  expect(r.outcome).toBe('stopped');
  expect(r.state).toEqual({ current: r.seed, previous: null });
  expect(r.types.indexOf('generation.promoted')).toBeGreaterThan(-1);
  expect(r.types.indexOf('generation.rolledback')).toBeGreaterThan(r.types.indexOf('generation.promoted'));
});

test('a candidate that hangs before it is ready is killed and rolled back', async () => {
  const { dir } = makeRepo({ 'body/main.ts': V1 });
  init(dir);
  const p = paths(dir);
  writeFiles(p.candidate, { 'body/main.ts': 'await new Promise(() => {});\n' });
  process.env.TEST_NEXT = commitAll(p.candidate, 'hang');
  const outcome = await supervise({ root: dir, gates: () => PASS, readyTimeoutMs: 300, log: () => {} });
  expect(outcome).toBe('stopped');
  expect(readEvents(p.journal).map((e) => e.type)).toContain('generation.rolledback');
});

test('a candidate that fails the gates never runs', async () => {
  const r = await scenario('process.exit(1);\n', { ok: false, gate: 'tests', output: 'boom' });
  expect(r.outcome).toBe('stopped');
  expect(r.state).toEqual({ current: r.seed, previous: null });
  expect(r.types).toContain('molt.rejected');
  expect(r.types).not.toContain('generation.promoted');
});

test('every event carries the generation that was running', async () => {
  const { dir, seed } = makeRepo({ 'body/main.ts': V1 });
  init(dir);
  const p = paths(dir);
  writeFiles(p.candidate, { 'body/main.ts': `${V1}\n// v2` });
  const next = commitAll(p.candidate, 'v2');
  process.env.TEST_NEXT = next;
  await supervise({ root: dir, gates: () => PASS, readyTimeoutMs: 5000, log: () => {} });
  const ready = readEvents(p.journal).filter((e) => e.type === 'generation.ready').map((e) => e.gen);
  expect(ready).toEqual([seed, next]);
});
