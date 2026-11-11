import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEvents } from '../../kernel/journal';
import { CRASH_LIMIT, init, paths, supervise } from '../../kernel/supervisor';
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

const HEAD = `
import { appendEvent, readEvents } from ${JSON.stringify(JOURNAL_MODULE)};
const journal = process.env.TENERAL_JOURNAL;
const gen = process.env.TENERAL_GEN;
`;
/** Becomes ready, then exits with the given code, every time. */
const readyThenExit = (code: number) => `${HEAD}
appendEvent(journal, gen, { type: 'generation.ready', commit: gen });
process.exit(${code});
`;

/** Runs a seed-only repo (no previous generation) to the end. */
async function seedOnly(body: string) {
  const { dir, seed } = makeRepo({ 'body/main.ts': body });
  const p = paths(dir);
  const outcome = await supervise({ root: dir, gates: () => PASS, readyTimeoutMs: 5000, log: () => {} });
  return { outcome, seed, events: readEvents(p.journal) };
}

test('a ready generation that crashes once is restarted, not rolled back', async () => {
  const r = await seedOnly(`${HEAD}
const before = readEvents(journal);
appendEvent(journal, gen, { type: 'generation.ready', commit: gen });
process.exit(before.some((e) => e.type === 'generation.ready') ? 0 : 1);
`);
  const types = r.events.map((e) => e.type);
  expect(r.outcome).toBe('stopped');
  expect(types.filter((t) => t === 'generation.started')).toHaveLength(2);
  expect(types).not.toContain('generation.rolledback');
});

test('a promoted generation that keeps crashing after it is ready is rolled back at the crash limit', async () => {
  const { dir, seed } = makeRepo({ 'body/main.ts': V1 });
  init(dir);
  const p = paths(dir);
  writeFiles(p.candidate, { 'body/main.ts': readyThenExit(1) });
  const next = commitAll(p.candidate, 'v2');
  process.env.TEST_NEXT = next;

  const outcome = await supervise({ root: dir, gates: () => PASS, readyTimeoutMs: 5000, log: () => {} });
  const events = readEvents(p.journal);
  expect(outcome).toBe('stopped');
  expect(events.filter((e) => e.type === 'generation.started' && e.gen === next)).toHaveLength(CRASH_LIMIT);
  const rollbacks = events.filter((e) => e.type === 'generation.rolledback');
  expect(rollbacks).toHaveLength(1);
  expect(rollbacks[0]).toMatchObject({ commit: next, to: seed, gen: seed });
  expect((rollbacks[0] as { reason: string }).reason).toContain(`crashed ${CRASH_LIMIT} times`);
  // The seed runs once before the molt and once more after the rollback, where it exits cleanly.
  expect(events.filter((e) => e.type === 'generation.started' && e.gen === seed)).toHaveLength(2);
  expect(JSON.parse(readFileSync(p.state, 'utf8'))).toEqual({ current: seed, previous: null });
});

test('with no previous generation, a ready one that keeps crashing halts the supervisor at the crash limit', async () => {
  const r = await seedOnly(readyThenExit(1));
  expect(r.outcome).toBe('halted');
  expect(r.events.filter((e) => e.type === 'generation.started')).toHaveLength(CRASH_LIMIT);
  expect(r.events.map((e) => e.type)).not.toContain('generation.rolledback');
});

// Exit 75 without a molt.requested is handled as a crash (as if the code were 1).
// This body journals nothing, so it is never ready, and a generation that is not
// ready is given up on at once: with no previous generation that is a halt after
// ONE start, not CRASH_LIMIT. The crash limit only applies to ready generations.
test('exit 75 with no request from a generation that never became ready halts after one start', async () => {
  const r = await seedOnly('process.exit(75);\n');
  expect(r.outcome).toBe('halted');
  expect(r.events.map((e) => e.type)).toEqual(['generation.started']);
});

test('exit 75 with no request from a ready generation is counted as a crash and halts at the crash limit', async () => {
  const r = await seedOnly(readyThenExit(75));
  expect(r.outcome).toBe('halted');
  expect(r.events.filter((e) => e.type === 'generation.started')).toHaveLength(CRASH_LIMIT);
});
