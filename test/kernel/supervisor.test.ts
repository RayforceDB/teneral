import { expect, test } from 'bun:test';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { appendEvent, readEvents } from '../../kernel/journal';
import {
  CRASH_LIMIT, REJECTION_LIMIT, init, paths, supervise, type Options,
} from '../../kernel/supervisor';
import { git, runGates, type GateResult } from '../../kernel/gates';
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

  const outcome = await supervise({ root: dir, gates: () => gate, readyTimeoutMs: 5000, restartDelayMs: 0, log: () => {} });
  const state = JSON.parse(readFileSync(p.state, 'utf8')) as { current: string; previous: string | null };
  const types = readEvents(p.journal).map((e) => e.type);
  return { outcome, state, types, seed, next, dir };
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
  await supervise({ root: dir, gates: () => PASS, readyTimeoutMs: 5000, restartDelayMs: 0, log: () => {} });
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
async function seedOnly(body: string, extra: Partial<Options> = {}) {
  const { dir, seed } = makeRepo({ 'body/main.ts': body });
  const p = paths(dir);
  const logs: string[] = [];
  const outcome = await supervise({
    root: dir, gates: () => PASS, readyTimeoutMs: 5000, restartDelayMs: 0, log: (line) => { logs.push(line); }, ...extra,
  });
  return { outcome, seed, dir, logs, events: readEvents(p.journal) };
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

  const outcome = await supervise({ root: dir, gates: () => PASS, readyTimeoutMs: 5000, restartDelayMs: 0, log: () => {} });
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

test('a promoted generation that asks to molt before it is ready is rolled back, and its request is ignored', async () => {
  const { dir, seed } = makeRepo({ 'body/main.ts': V1 });
  init(dir);
  const p = paths(dir);
  writeFiles(p.candidate, { 'body/main.ts': `${HEAD}
appendEvent(journal, gen, { type: 'molt.requested', commit: process.env.TEST_V3, motive: 'not ready yet' });
process.exit(75);
` });
  const v2 = commitAll(p.candidate, 'v2');
  writeFiles(p.candidate, { 'body/main.ts': 'process.exit(0);\n' });
  const v3 = commitAll(p.candidate, 'v3');
  process.env.TEST_NEXT = v2;
  process.env.TEST_V3 = v3;

  const gated: string[] = [];
  const outcome = await supervise({
    root: dir, gates: (_dir, _from, to) => { gated.push(to); return PASS; }, readyTimeoutMs: 5000, restartDelayMs: 0, log: () => {},
  });
  const events = readEvents(p.journal);
  expect(outcome).toBe('stopped');
  expect(gated).toEqual([v2]);
  expect(events.flatMap((e) => (e.type === 'generation.promoted' ? [e.commit] : []))).toEqual([v2]);
  expect(events.filter((e) => e.type === 'generation.rolledback')).toHaveLength(1);
  expect(events.some((e) => e.gen === v3)).toBe(false);
  expect(JSON.parse(readFileSync(p.state, 'utf8'))).toEqual({ current: seed, previous: null });
});

const QUIET = { gates: () => PASS, readyTimeoutMs: 5000, restartDelayMs: 0, log: () => {} };
const started = (events: { type: string }[]) => events.filter((e) => e.type === 'generation.started').length;

// --- state is written ahead and reconciled on start ---

test('each start forces live to the generation the state names, and cleans it', async () => {
  const { dir, seed } = makeRepo({ 'body/main.ts': 'process.exit(0);\n' });
  init(dir);
  const p = paths(dir);
  writeFiles(p.candidate, { 'body/main.ts': 'process.exit(7);\n' });
  const other = commitAll(p.candidate, 'other');
  git(p.live, 'checkout', '-q', '--detach', other);
  writeFiles(p.live, { 'body/main.ts': 'process.exit(9);\n', 'body/stray.ts': 'x\n' });

  expect(await supervise({ root: dir, ...QUIET })).toBe('stopped');
  expect(git(p.live, 'rev-parse', 'HEAD')).toBe(seed);
  expect(git(p.live, 'status', '--porcelain', '--ignored')).toBe('');
});

test('a state file that does not hold a state halts the supervisor and names the file', async () => {
  for (const garbage of ['not json at all', '{"current":"not a commit","previous":null}', `{"current":"${'a'.repeat(40)}","previous":7}`]) {
    const { dir } = makeRepo({ 'body/main.ts': 'process.exit(0);\n' });
    init(dir);
    const p = paths(dir);
    writeFileSync(p.state, garbage);
    const logs: string[] = [];
    expect(await supervise({ root: dir, ...QUIET, log: (line) => { logs.push(line); } })).toBe('halted');
    expect(logs.join('\n')).toContain(p.state);
    expect(readEvents(p.journal)).toEqual([]);
  }
});

test('a state naming a commit git cannot check out halts instead of throwing', async () => {
  const { dir } = makeRepo({ 'body/main.ts': 'process.exit(0);\n' });
  init(dir);
  const p = paths(dir);
  writeFileSync(p.state, JSON.stringify({ current: 'a'.repeat(40), previous: null }));
  const logs: string[] = [];
  expect(await supervise({ root: dir, ...QUIET, log: (line) => { logs.push(line); } })).toBe('halted');
  expect(logs.join('\n')).toContain('a'.repeat(40));
  expect(started(readEvents(p.journal))).toBe(0);
});

test('a promotion saved in the state but missing from the journal is journaled once, before the generation starts', async () => {
  const { dir, seed } = makeRepo({ 'body/main.ts': 'process.exit(0);\n' });
  init(dir);
  const p = paths(dir);
  writeFiles(p.candidate, { 'body/main.ts': 'process.exit(0);\n// v2\n' });
  const next = commitAll(p.candidate, 'v2');
  // What a supervisor killed right after saving the state leaves behind.
  writeFileSync(p.state, JSON.stringify({ current: next, previous: seed }));

  expect(await supervise({ root: dir, ...QUIET })).toBe('stopped');
  expect(await supervise({ root: dir, ...QUIET })).toBe('stopped');
  const events = readEvents(p.journal);
  expect(events.map((e) => e.type)).toEqual(['generation.promoted', 'generation.started', 'generation.started']);
  expect(events[0]).toMatchObject({ commit: next, previous: seed, gen: next });
  expect(git(p.live, 'rev-parse', 'HEAD')).toBe(next);
});

test('a rollback saved in the state but missing from the journal is journaled once', async () => {
  const r = await scenario(`${V1}\n// v2`, PASS);
  expect(r.state).toEqual({ current: r.next, previous: r.seed });
  const p = paths(r.dir);
  writeFileSync(p.state, JSON.stringify({ current: r.seed, previous: null }));

  expect(await supervise({ root: r.dir, ...QUIET })).toBe('stopped');
  expect(await supervise({ root: r.dir, ...QUIET })).toBe('stopped');
  const rollbacks = readEvents(p.journal).filter((e) => e.type === 'generation.rolledback');
  expect(rollbacks).toHaveLength(1);
  expect(rollbacks[0]).toMatchObject({ commit: r.next, to: r.seed, gen: r.seed });
  expect(git(p.live, 'rev-parse', 'HEAD')).toBe(r.seed);
});

// --- init can finish what an earlier init started ---

function expectInstalled(dir: string, seed: string) {
  const p = paths(dir);
  expect(JSON.parse(readFileSync(p.state, 'utf8'))).toEqual({ current: seed, previous: null });
  expect(git(p.live, 'rev-parse', 'HEAD')).toBe(seed);
  expect(git(p.candidate, 'rev-parse', 'HEAD')).toBe(seed);
  expect(git(p.candidate, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('lineage/local');
}

test('init finishes after an init that only got as far as the live worktree', () => {
  const { dir, seed } = makeRepo({ 'body/main.ts': 'process.exit(0);\n' });
  mkdirSync(join(dir, '.teneral'));
  git(dir, 'worktree', 'add', '--detach', paths(dir).live, seed);
  expect(init(dir)).toEqual({ current: seed, previous: null });
  expectInstalled(dir, seed);
});

test('init reuses the lineage branch when it exists without its worktree', () => {
  const { dir, seed } = makeRepo({ 'body/main.ts': 'process.exit(0);\n' });
  git(dir, 'branch', 'lineage/local', seed);
  expect(init(dir)).toEqual({ current: seed, previous: null });
  expectInstalled(dir, seed);
});

test('init puts back a worktree that was deleted after a complete init', () => {
  const { dir, seed } = makeRepo({ 'body/main.ts': 'process.exit(0);\n' });
  init(dir);
  rmSync(paths(dir).live, { recursive: true });
  rmSync(paths(dir).candidate, { recursive: true });
  expect(init(dir)).toEqual({ current: seed, previous: null });
  expectInstalled(dir, seed);
});

// --- signals, stopping and the lock ---

/**
 * Gates that behave as the real ones do when the supervisor is told to stop while they run: the
 * signal arrives, the supervisor aborts the run, and the run ends without a verdict.
 * supervise has its handler installed while this runs, so the signal does not end the test run.
 */
const interruptedBy = (signal: 'SIGTERM' | 'SIGHUP') => async (_dir: string, _from: string, _to: string, stop?: AbortSignal): Promise<GateResult> => {
  process.kill(process.pid, signal);
  await new Promise<void>((resolve) => { stop!.addEventListener('abort', () => resolve(), { once: true }); });
  return { ok: false, gate: 'interrupted', output: 'stopped' };
};

test('a stop signal that arrives while the gates run stops the supervisor before anything else starts', async () => {
  const { dir, seed } = makeRepo({ 'body/main.ts': V1 });
  init(dir);
  const p = paths(dir);
  writeFiles(p.candidate, { 'body/main.ts': `${V1}\n// v2` });
  const next = commitAll(p.candidate, 'v2');
  process.env.TEST_NEXT = next;

  const outcome = await supervise({
    root: dir, ...QUIET,
    gates: interruptedBy('SIGTERM'),
  });
  const events = readEvents(p.journal);
  expect(outcome).toBe('stopped');
  expect(started(events)).toBe(1);
  expect(events.map((e) => e.type)).not.toContain('generation.promoted');
  expect(JSON.parse(readFileSync(p.state, 'utf8'))).toEqual({ current: seed, previous: null });
});

test('a generation that ignores SIGTERM and never becomes ready is still killed', async () => {
  const r = await seedOnly("process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n", { readyTimeoutMs: 400, killGraceMs: 100 });
  expect(r.outcome).toBe('halted');
  expect(started(r.events)).toBe(1);
});

const WAITS_FOR_STIMULUS = `${HEAD}
appendEvent(journal, gen, { type: 'generation.ready', commit: gen });
setInterval(() => { if (readEvents(journal).some((e) => e.type === 'stimulus')) process.exit(0); }, 20);
`;

test('a second supervisor on the same install does not start while the first runs', async () => {
  const { dir } = makeRepo({ 'body/main.ts': WAITS_FOR_STIMULUS });
  const p = paths(dir);
  const lock = join(dir, '.teneral', 'lock');
  const first = supervise({ root: dir, ...QUIET });
  for (let i = 0; i < 400 && !readEvents(p.journal).some((e) => e.type === 'generation.ready'); i++) await Bun.sleep(10);
  expect(existsSync(lock)).toBe(true);

  const logs: string[] = [];
  expect(await supervise({ root: dir, ...QUIET, log: (line) => { logs.push(line); } })).toBe('halted');
  expect(logs.join('\n')).toContain('another supervisor');
  expect(started(readEvents(p.journal))).toBe(1);
  // The refused supervisor must not have taken the first one's lock away with it.
  expect(existsSync(lock)).toBe(true);

  appendEvent(p.journal, 'test', { type: 'stimulus', source: 'test', text: 'stop' });
  expect(await first).toBe('stopped');
  expect(existsSync(lock)).toBe(false);
});

test('a lock left by a supervisor that is no longer alive is taken over', async () => {
  const { dir } = makeRepo({ 'body/main.ts': 'process.exit(0);\n' });
  const lock = join(dir, '.teneral', 'lock');
  mkdirSync(join(dir, '.teneral'));
  const dead = Bun.spawnSync(['true']).pid;
  writeFileSync(lock, `${dead}\n`);

  expect(await supervise({ root: dir, ...QUIET })).toBe('stopped');
  expect(started(readEvents(paths(dir).journal))).toBe(1);
  expect(existsSync(lock)).toBe(false);
});

// --- restart pacing ---

test('a generation that replies and then crashes every time is given up on when its restart budget is spent', async () => {
  const r = await seedOnly(`${HEAD}
appendEvent(journal, gen, { type: 'generation.ready', commit: gen });
appendEvent(journal, gen, { type: 'assistant', text: 'hello', toolCalls: [] });
process.exit(1);
`, { restartBudget: 4 });
  expect(r.outcome).toBe('halted');
  // The first start plus four restarts.
  expect(started(r.events)).toBe(5);
});

test('restarts wait longer each time', async () => {
  const t = Date.now();
  const r = await seedOnly(readyThenExit(1), { restartDelayMs: 60 });
  expect(r.outcome).toBe('halted');
  // CRASH_LIMIT starts means two restarts: 60 ms after the first crash, 120 ms after the second.
  expect(started(r.events)).toBe(CRASH_LIMIT);
  expect(Date.now() - t).toBeGreaterThanOrEqual(180);
});

// --- rejected molts ---

test('a generation that keeps asking for the same rejected commit is paced, then halted, never rolled back, reply or not', async () => {
  const { dir, seed } = makeRepo({ 'body/main.ts': V1 });
  init(dir);
  const p = paths(dir);
  // v2 becomes ready, speaks, and asks for v3 on every start, whatever the kernel answered. The reply is
  // there because a real molt request always sits inside one, so a reply must not reset the count.
  writeFiles(p.candidate, { 'body/main.ts': `${HEAD}
appendEvent(journal, gen, { type: 'generation.ready', commit: gen });
appendEvent(journal, gen, { type: 'assistant', text: 'molting', toolCalls: [] });
appendEvent(journal, gen, { type: 'molt.requested', commit: process.env.TEST_V3, motive: 'again' });
process.exit(75);
` });
  const v2 = commitAll(p.candidate, 'v2');
  writeFiles(p.candidate, { 'body/main.ts': 'process.exit(0);\n' });
  const v3 = commitAll(p.candidate, 'v3');
  process.env.TEST_NEXT = v2;
  process.env.TEST_V3 = v3;

  const logs: string[] = [];
  const t = Date.now();
  const outcome = await supervise({
    root: dir, ...QUIET, restartDelayMs: 40, log: (line) => { logs.push(line); },
    gates: (_dir, _from, to) => (to === v2 ? PASS : { ok: false, gate: 'tests-body', output: 'boom' }),
  });
  const events = readEvents(p.journal);
  expect(outcome).toBe('halted');
  expect(logs.join('\n')).toContain('the same commit keeps being requested and rejected');
  // Every rejection is journaled, the one that reaches the limit included.
  expect(events.filter((e) => e.type === 'molt.rejected')).toHaveLength(REJECTION_LIMIT);
  expect(events.filter((e) => e.type === 'generation.started' && e.gen === v2)).toHaveLength(REJECTION_LIMIT);
  expect(events.map((e) => e.type)).not.toContain('generation.rolledback');
  expect(JSON.parse(readFileSync(p.state, 'utf8'))).toEqual({ current: v2, previous: seed });
  // Waits of 40 and 80 ms follow the first two rejections; the third ends it.
  expect(REJECTION_LIMIT).toBe(3);
  expect(Date.now() - t).toBeGreaterThanOrEqual(120);
});

/** Asks for a molt that will be rejected, `rounds` times, then stops by itself. `commit` is an expression over `rejected`, the count so far. */
const asksFor = (commit: string, rounds: number) => `${HEAD}
const rejected = readEvents(journal).filter((e) => e.type === 'molt.rejected').length;
appendEvent(journal, gen, { type: 'generation.ready', commit: gen });
if (rejected >= ${rounds}) process.exit(0);
appendEvent(journal, gen, { type: 'molt.requested', commit: ${commit}, motive: 'attempt ' + rejected });
process.exit(75);
`;
const REJECT = { gates: () => ({ ok: false, gate: 'tests-body', output: 'boom' }), restartBudget: 2, restartDelayMs: 30 };

test('a generation whose every rejected molt names a new commit is iterating, and is never halted or slowed for it', async () => {
  const rounds = 6;
  expect(rounds).toBeGreaterThan(REJECTION_LIMIT);
  expect(rounds).toBeGreaterThan(REJECT.restartBudget);
  const r = await seedOnly(asksFor("rejected.toString(16).padStart(40, 'c')", rounds), REJECT);
  expect(r.outcome).toBe('stopped');
  expect(r.events.filter((e) => e.type === 'molt.rejected')).toHaveLength(rounds);
  expect(started(r.events)).toBe(rounds + 1);
  // Each wait is one unit: the count starts again with every new commit.
  const waits = r.logs.filter((line) => line.includes('rejected at gate'));
  expect(waits).toHaveLength(rounds);
  for (const line of waits) expect(line).toContain('restarting in 30 ms');
});

test('alternating between two rejected commits is never halted', async () => {
  const rounds = 8;
  const r = await seedOnly(asksFor("(rejected % 2 === 0 ? 'a' : 'b').repeat(40)", rounds), REJECT);
  expect(r.outcome).toBe('stopped');
  expect(r.events.flatMap((e) => (e.type === 'molt.rejected' ? [e.commit[0]] : []))).toEqual(['a', 'b', 'a', 'b', 'a', 'b', 'a', 'b']);
  for (const line of r.logs.filter((l) => l.includes('rejected at gate'))) expect(line).toContain('restarting in 30 ms');
});

test('asking again and again for the commit already running is limited the same way', async () => {
  const gated: string[] = [];
  const r = await seedOnly(`${HEAD}
appendEvent(journal, gen, { type: 'generation.ready', commit: gen });
appendEvent(journal, gen, { type: 'molt.requested', commit: gen, motive: 'nothing changed' });
process.exit(75);
`, { gates: (_dir, _from, to) => { gated.push(to); return PASS; } });
  expect(r.outcome).toBe('halted');
  expect(gated).toEqual([]);
  expect(r.logs.join('\n')).toContain('the same commit keeps being requested and rejected');
  expect(r.events.flatMap((e) => (e.type === 'molt.rejected' ? [e.gate] : []))).toEqual(Array(REJECTION_LIMIT).fill('same'));
  expect(started(r.events)).toBe(REJECTION_LIMIT);
});

test('a molt to the commit that is already running is refused without running the gates', async () => {
  const gated: string[] = [];
  const r = await seedOnly(`${HEAD}
const before = readEvents(journal);
appendEvent(journal, gen, { type: 'generation.ready', commit: gen });
if (before.some((e) => e.type === 'molt.rejected')) process.exit(0);
appendEvent(journal, gen, { type: 'molt.requested', commit: gen, motive: 'nothing changed' });
process.exit(75);
`, { gates: (_dir, _from, to) => { gated.push(to); return PASS; } });
  expect(r.outcome).toBe('stopped');
  expect(gated).toEqual([]);
  const rejected = r.events.filter((e) => e.type === 'molt.rejected');
  expect(rejected).toHaveLength(1);
  expect(rejected[0]).toMatchObject({ commit: r.seed, gate: 'same' });
  expect(r.events.map((e) => e.type)).not.toContain('generation.promoted');
  expect(JSON.parse(readFileSync(paths(r.dir).state, 'utf8'))).toEqual({ current: r.seed, previous: null });
});

// --- what an earlier supervisor left behind ---

test('a body left running by a supervisor that died is stopped before a new one starts', async () => {
  // The new body exits 0 only if the old one is gone by the time it starts.
  const { dir } = makeRepo({ 'body/main.ts': `
try { process.kill(Number(process.env.TEST_ORPHAN), 0); process.exit(9); } catch { process.exit(0); }
` });
  const state = init(dir);
  const p = paths(dir);
  const cmd = ['sleep', '300'];
  const orphan = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  const logs: string[] = [];
  try {
    writeFileSync(p.child, JSON.stringify({ pid: orphan.pid, gen: state.current, cmd }));
    process.env.TEST_ORPHAN = String(orphan.pid);
    expect(await supervise({ root: dir, ...QUIET, killGraceMs: 200, log: (line) => { logs.push(line); } })).toBe('stopped');
    expect(logs.join('\n')).toContain(String(orphan.pid));
    expect(orphan.killed || orphan.exitCode !== null || orphan.signalCode !== null).toBe(true);
    expect(existsSync(p.child)).toBe(false);
  } finally {
    orphan.kill('SIGKILL');
  }
});

test('a recorded child whose pid now belongs to some other program is left alone', async () => {
  const { dir } = makeRepo({ 'body/main.ts': 'process.exit(0);\n' });
  const state = init(dir);
  const p = paths(dir);
  const other = Bun.spawn(['sleep', '300'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  try {
    writeFileSync(p.child, JSON.stringify({ pid: other.pid, gen: state.current, cmd: ['bun', 'body/main.ts'] }));
    expect(await supervise({ root: dir, ...QUIET, killGraceMs: 200 })).toBe('stopped');
    expect(() => process.kill(other.pid, 0)).not.toThrow();
    expect(other.exitCode).toBeNull();
    expect(existsSync(p.child)).toBe(false);
  } finally {
    other.kill('SIGKILL');
  }
});

test('the record of the running child exists while it runs and is gone when it has exited', async () => {
  const { dir } = makeRepo({ 'body/main.ts': WAITS_FOR_STIMULUS });
  const p = paths(dir);
  const first = supervise({ root: dir, ...QUIET });
  for (let i = 0; i < 400 && !readEvents(p.journal).some((e) => e.type === 'generation.ready'); i++) await Bun.sleep(10);
  const record = JSON.parse(readFileSync(p.child, 'utf8')) as { pid: number; gen: string; cmd: string[] };
  expect(() => process.kill(record.pid, 0)).not.toThrow();
  expect(record.cmd).toEqual(['bun', 'body/main.ts']);
  // The check that guards against pid reuse must recognise a real body.
  if (existsSync(`/proc/${record.pid}/cmdline`)) {
    expect(readFileSync(`/proc/${record.pid}/cmdline`, 'utf8').split('\0').filter(Boolean)).toEqual(record.cmd);
  }
  appendEvent(p.journal, 'test', { type: 'stimulus', source: 'test', text: 'stop' });
  expect(await first).toBe('stopped');
  expect(existsSync(p.child)).toBe(false);
});

test('gate checkouts left by a gate run that was killed are removed before anything starts', async () => {
  // The body exits 0 only if no gate checkout is left next to its own worktree.
  const { dir, seed } = makeRepo({ 'body/main.ts': `
import { readdirSync } from 'node:fs';
process.exit(readdirSync('..').some((name) => name.startsWith('gate-')) ? 9 : 0);
` });
  init(dir);
  git(dir, 'worktree', 'add', '--detach', join(dir, '.teneral', 'gate-0123456789ab'), seed);
  mkdirSync(join(dir, '.teneral', 'gate-not-even-a-worktree'));

  expect(await supervise({ root: dir, ...QUIET })).toBe('stopped');
  const worktrees = git(dir, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '));
  expect(worktrees).toHaveLength(3);
});

// --- living in the background ---

test('SIGHUP, which a closing terminal sends, stops a running generation like SIGTERM does', async () => {
  const { dir } = makeRepo({ 'body/main.ts': `${HEAD}
appendEvent(journal, gen, { type: 'generation.ready', commit: gen });
setInterval(() => {}, 1000);
` });
  const p = paths(dir);
  const running = supervise({ root: dir, ...QUIET });
  for (let i = 0; i < 400 && !readEvents(p.journal).some((e) => e.type === 'generation.ready'); i++) await Bun.sleep(10);
  const { pid } = JSON.parse(readFileSync(p.child, 'utf8')) as { pid: number };
  // supervise has its handler installed while it runs, so the signal does not end the test run.
  process.kill(process.pid, 'SIGHUP');
  expect(await running).toBe('stopped');
  expect(() => process.kill(pid, 0)).toThrow();
  expect(started(readEvents(p.journal))).toBe(1);
  expect(existsSync(p.lock)).toBe(false);
});

test('SIGHUP that arrives while the gates run stops the supervisor before anything else starts', async () => {
  const { dir, seed } = makeRepo({ 'body/main.ts': V1 });
  init(dir);
  const p = paths(dir);
  writeFiles(p.candidate, { 'body/main.ts': `${V1}\n// v2` });
  process.env.TEST_NEXT = commitAll(p.candidate, 'v2');
  const outcome = await supervise({ root: dir, ...QUIET, gates: interruptedBy('SIGHUP') });
  expect(outcome).toBe('stopped');
  expect(JSON.parse(readFileSync(p.state, 'utf8'))).toEqual({ current: seed, previous: null });
});

test('the body is told where its owner leaves lines, beside the kernel\'s other files', async () => {
  const { dir } = makeRepo({ 'body/main.ts': `${HEAD}
appendEvent(journal, gen, { type: 'stimulus', source: 'test', text: String(process.env.TENERAL_OWNER) });
process.exit(0);
` });
  const p = paths(dir);
  expect(p.owner).toBe(join(dir, '.teneral', 'owner'));
  expect(await supervise({ root: dir, ...QUIET })).toBe('stopped');
  expect(readEvents(p.journal).find((e) => e.type === 'stimulus')).toMatchObject({ text: p.owner });
});

test('the body is told which provider is configured and where sign-ins are kept, and gets no token of the kernel\'s making', async () => {
  const { dir } = makeRepo({ 'body/main.ts': `${HEAD}
const names = Object.keys(process.env).filter((name) => name.startsWith('TENERAL_')).sort().join(' ');
appendEvent(journal, gen, { type: 'stimulus', source: 'test', text: [process.env.TENERAL_PROVIDER, process.env.TENERAL_AUTH, names].join('|') });
process.exit(0);
` });
  const p = paths(dir);
  expect(p.auth).toBe(join(dir, '.teneral', 'auth'));
  const before = process.env.TENERAL_PROVIDER;
  process.env.TENERAL_PROVIDER = 'chatgpt';
  try {
    expect(await supervise({ root: dir, ...QUIET })).toBe('stopped');
  } finally {
    if (before === undefined) delete process.env.TENERAL_PROVIDER; else process.env.TENERAL_PROVIDER = before;
  }
  const [provider, auth, names] = (readEvents(p.journal).find((e) => e.type === 'stimulus') as { text: string }).text.split('|');
  expect(provider).toBe('chatgpt');
  expect(auth).toBe(p.auth);
  // The whole list of what the kernel itself sets: one place, bodyEnv, decides it.
  expect(names!.split(' ').filter((name) => !['TENERAL_API_KEY', 'TENERAL_BASE_URL', 'TENERAL_MODEL', 'TENERAL_HEARTBEAT_MINUTES', 'TENERAL_CONTEXT_CHARS'].includes(name))).toEqual([
    'TENERAL_AUTH', 'TENERAL_GEN', 'TENERAL_ID', 'TENERAL_INBOX', 'TENERAL_JOURNAL', 'TENERAL_OWNER', 'TENERAL_PEERS', 'TENERAL_PROVIDER',
    'TENERAL_SOUL', 'TENERAL_WORKSPACE',
  ]);
});

test('init tells git never to forget worktrees during gc, once however often it runs', () => {
  const { dir } = makeRepo({ 'body/main.ts': 'process.exit(0);\n' });
  init(dir);
  expect(git(dir, 'config', '--local', '--get-all', 'gc.worktreePruneExpire')).toBe('never');
  init(dir);
  expect(git(dir, 'config', '--local', '--get-all', 'gc.worktreePruneExpire')).toBe('never');
  // gc then leaves alone a worktree whose directory it cannot see, as on the host of a container,
  // however long ago it was made. Without the setting, one older than three months is forgotten.
  const p = paths(dir);
  rmSync(p.live, { recursive: true });
  const record = join(dir, '.git', 'worktrees', 'live');
  const longAgo = new Date(Date.now() - 365 * 24 * 3600 * 1000);
  for (const name of readdirSync(record)) utimesSync(join(record, name), longAgo, longAgo);
  git(dir, 'gc', '--quiet');
  expect(git(dir, 'worktree', 'list', '--porcelain')).toContain(p.live);
});

// --- a molt always gets an answer ---

const interruptions = (events: ReturnType<typeof readEvents>) => events.flatMap((e) => (e.type === 'molt.rejected' && e.gate === 'interrupted' ? [e] : []));

test('a molt request the kernel never answered is answered at the next start, once', async () => {
  const { dir, seed } = makeRepo({ 'body/main.ts': 'process.exit(0);\n' });
  const p = paths(dir);
  const asked = 'd'.repeat(40);
  // What a supervisor killed in the middle of a gate run leaves behind.
  appendEvent(p.journal, seed, { type: 'generation.ready', commit: seed });
  appendEvent(p.journal, seed, { type: 'molt.requested', commit: asked, motive: 'before the kill' });

  expect(await supervise({ root: dir, ...QUIET })).toBe('stopped');
  expect(await supervise({ root: dir, ...QUIET })).toBe('stopped');
  const events = readEvents(p.journal);
  expect(interruptions(events)).toHaveLength(1);
  expect(interruptions(events)[0]).toMatchObject({ commit: asked, gen: seed });
  expect(interruptions(events)[0]!.output).toContain('molt again');
  // The answer is there before the generation starts, so it finds it.
  expect(events.findIndex((e) => e.type === 'molt.rejected')).toBeLessThan(events.findIndex((e) => e.type === 'generation.started'));
});

test('a molt request that was already answered is left alone at start', async () => {
  const r = await scenario('process.exit(1);\n', { ok: false, gate: 'tests', output: 'boom' });
  expect(await supervise({ root: r.dir, ...QUIET })).toBe('stopped');
  expect(readEvents(paths(r.dir).journal).filter((e) => e.type === 'molt.rejected')).toHaveLength(1);
});

test('a body that dies between asking for a molt and exiting with 75 has its request answered', async () => {
  const r = await seedOnly(`${HEAD}
const before = readEvents(journal);
appendEvent(journal, gen, { type: 'generation.ready', commit: gen });
if (before.some((e) => e.type === 'molt.rejected')) process.exit(0);
appendEvent(journal, gen, { type: 'molt.requested', commit: '${'e'.repeat(40)}', motive: 'then it died' });
process.exit(1);
`);
  expect(r.outcome).toBe('stopped');
  expect(interruptions(r.events)).toHaveLength(1);
  expect(interruptions(r.events)[0]).toMatchObject({ commit: 'e'.repeat(40) });
  expect(started(r.events)).toBe(2);
});

test('a stop signal during a long check returns at once, kills the check, leaves no gate checkout, and the molt is answered at the next start', async () => {
  const { dir, seed } = makeRepo({ 'body/main.ts': V1 });
  init(dir);
  const p = paths(dir);
  writeFiles(p.candidate, { 'body/main.ts': `${V1}\n// v2` });
  const next = commitAll(p.candidate, 'v2');
  process.env.TEST_NEXT = next;
  const pidFile = join(dir, '.teneral', 'child-of-the-check.pid');
  let signalled = 0;

  const outcome = await supervise({
    root: dir, ...QUIET, killGraceMs: 200,
    // The real gates, with one check that would run for minutes.
    gates: (candidate, from, to, stop) => {
      // supervise has its handler installed while the gates run, so the signal does not end the test run.
      setTimeout(() => { signalled = Date.now(); process.kill(process.pid, 'SIGTERM'); }, 500);
      return runGates(candidate, from, to, [
        { gate: 'slow', cmd: ['bash', '-c', `sleep 300 & echo $! > ${JSON.stringify(pidFile)}; wait`] },
      ], { signal: stop, killGraceMs: 200 });
    },
  });
  expect(outcome).toBe('stopped');
  expect(Date.now() - signalled).toBeLessThan(1500);
  const checkChild = Number(readFileSync(pidFile, 'utf8'));
  for (let i = 0; i < 100 && existsSync(`/proc/${checkChild}`); i++) await Bun.sleep(20);
  expect(() => process.kill(checkChild, 0)).toThrow();
  expect(readdirSync(join(dir, '.teneral')).filter((name) => name.startsWith('gate-'))).toEqual([]);
  expect(readEvents(p.journal).map((e) => e.type)).not.toContain('molt.rejected');
  expect(JSON.parse(readFileSync(p.state, 'utf8'))).toEqual({ current: seed, previous: null });

  // The next start tells the agent what became of its request; V1 exits cleanly once it has an answer.
  expect(await supervise({ root: dir, ...QUIET })).toBe('stopped');
  const answers = interruptions(readEvents(p.journal));
  expect(answers).toHaveLength(1);
  expect(answers[0]).toMatchObject({ commit: next });
});

// --- a generation that is alive but useless ---

const READY_THEN = (rest: string) => `${HEAD}
appendEvent(journal, gen, { type: 'generation.ready', commit: gen });
${rest}
`;

test('a newly promoted generation that starts but never replies is killed and rolled back, saying so', async () => {
  for (const useless of ['for (;;) { /* spins */ }', 'setInterval(() => {}, 1000);']) {
    const { dir, seed } = makeRepo({ 'body/main.ts': V1 });
    init(dir);
    const p = paths(dir);
    writeFiles(p.candidate, { 'body/main.ts': READY_THEN(useless) });
    const next = commitAll(p.candidate, 'v2');
    process.env.TEST_NEXT = next;

    expect(await supervise({ root: dir, ...QUIET, probationMs: 400, killGraceMs: 200 })).toBe('stopped');
    const rollbacks = readEvents(p.journal).flatMap((e) => (e.type === 'generation.rolledback' ? [e] : []));
    expect(rollbacks).toHaveLength(1);
    expect(rollbacks[0]).toMatchObject({ commit: next, to: seed });
    expect(rollbacks[0]!.reason).toContain('started but did not reply');
    expect(JSON.parse(readFileSync(p.state, 'utf8'))).toEqual({ current: seed, previous: null });
  }
});

test('a generation with nothing before it is not on probation', async () => {
  const r = await seedOnly(READY_THEN('setTimeout(() => process.exit(0), 500);'), { probationMs: 100 });
  expect(r.outcome).toBe('stopped');
  expect(started(r.events)).toBe(1);
});

test('a promoted generation that has replied once is established: later silence does not roll it back', async () => {
  const { dir, seed } = makeRepo({ 'body/main.ts': V1 });
  init(dir);
  const p = paths(dir);
  // First run: replies, then crashes. Second run: silent for longer than the probation, then exits cleanly.
  writeFiles(p.candidate, { 'body/main.ts': `${HEAD}
const mine = readEvents(journal).filter((e) => e.type === 'generation.ready' && e.gen === gen).length;
appendEvent(journal, gen, { type: 'generation.ready', commit: gen });
if (mine === 0) {
  appendEvent(journal, gen, { type: 'assistant', text: 'here', toolCalls: [] });
  process.exit(1);
}
setTimeout(() => process.exit(0), 500);
` });
  const next = commitAll(p.candidate, 'v2');
  process.env.TEST_NEXT = next;

  expect(await supervise({ root: dir, ...QUIET, probationMs: 150 })).toBe('stopped');
  expect(readEvents(p.journal).map((e) => e.type)).not.toContain('generation.rolledback');
  expect(JSON.parse(readFileSync(p.state, 'utf8'))).toEqual({ current: next, previous: seed });
});

test('probation is remembered across a restart of the supervisor: a promoted generation that has not replied yet is still on it', async () => {
  const { dir, seed } = makeRepo({ 'body/main.ts': 'process.exit(0);\n' });
  init(dir);
  const p = paths(dir);
  writeFiles(p.candidate, { 'body/main.ts': READY_THEN('setInterval(() => {}, 1000);') });
  const next = commitAll(p.candidate, 'v2');
  // A supervisor stopped right after promoting: the state and the journal both say so, and nothing was said since.
  writeFileSync(p.state, JSON.stringify({ current: next, previous: seed }));
  appendEvent(p.journal, next, { type: 'generation.promoted', commit: next, previous: seed });

  expect(await supervise({ root: dir, ...QUIET, probationMs: 300, killGraceMs: 200 })).toBe('stopped');
  expect(readEvents(p.journal).map((e) => e.type)).toContain('generation.rolledback');
  expect(JSON.parse(readFileSync(p.state, 'utf8'))).toEqual({ current: seed, previous: null });
});

// --- a rollback says why ---

test('a rollback note and the log carry the end of what the failed generation wrote to stderr, which is still shown live', async () => {
  const { dir } = makeRepo({ 'body/main.ts': V1 });
  init(dir);
  const p = paths(dir);
  writeFiles(p.candidate, { 'body/main.ts': "console.error('x'.repeat(10000));\nconsole.error('RECOGNISABLE-LAST-WORDS-42');\nprocess.exit(1);\n" });
  process.env.TEST_NEXT = commitAll(p.candidate, 'v2');

  const logs: string[] = [];
  let shown = '';
  const outcome = await supervise({
    root: dir, ...QUIET, log: (line) => { logs.push(line); }, stderr: (chunk) => { shown += Buffer.from(chunk).toString(); },
  });
  expect(outcome).toBe('stopped');
  const rollback = readEvents(p.journal).flatMap((e) => (e.type === 'generation.rolledback' ? [e] : []))[0]!;
  expect(rollback.reason).toContain('exited with 1 before it was ready');
  expect(rollback.reason).toContain('RECOGNISABLE-LAST-WORDS-42');
  // The tail, not all of it.
  expect(rollback.reason.length).toBeLessThan(5000);
  expect(logs.join('\n')).toContain('RECOGNISABLE-LAST-WORDS-42');
  // Nothing was dropped on the way to the terminal.
  expect(shown).toContain('x'.repeat(10000));
  expect(shown).toContain('RECOGNISABLE-LAST-WORDS-42');
});

// --- the restart budget is for a generation that keeps failing, not for one that ran long ---

test('a run that lasted long enough before it crashed gives the generation its restart budget back', async () => {
  const rounds = 6;
  // Replies (so the crash limit never applies), stays up a while, crashes; stops by itself after `rounds` starts.
  const r = await seedOnly(`${HEAD}
const starts = readEvents(journal).filter((e) => e.type === 'generation.started').length;
appendEvent(journal, gen, { type: 'generation.ready', commit: gen });
appendEvent(journal, gen, { type: 'assistant', text: 'working', toolCalls: [] });
setTimeout(() => process.exit(starts >= ${rounds} ? 0 : 1), 150);
`, { restartBudget: 2, stableRunMs: 100 });
  expect(r.outcome).toBe('stopped');
  expect(started(r.events)).toBe(rounds);
});

test('short runs do not give the budget back', async () => {
  const r = await seedOnly(`${HEAD}
appendEvent(journal, gen, { type: 'generation.ready', commit: gen });
appendEvent(journal, gen, { type: 'assistant', text: 'working', toolCalls: [] });
process.exit(1);
`, { restartBudget: 2, stableRunMs: 60_000 });
  expect(r.outcome).toBe('halted');
  expect(started(r.events)).toBe(3);
});

// --- the lock names a supervisor, not just a pid ---

test('a lock whose pid now belongs to some other program is taken over, and that program is left alone', async () => {
  if (!existsSync('/proc/self/cmdline')) return;
  const { dir } = makeRepo({ 'body/main.ts': 'process.exit(0);\n' });
  const p = paths(dir);
  mkdirSync(join(dir, '.teneral'));
  const other = Bun.spawn(['sleep', '300'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  try {
    // As after a reboot: the lock names a supervisor, and its pid has since been given to something else.
    writeFileSync(p.lock, `${other.pid}\n${JSON.stringify(['bun', 'kernel/main.ts'])}\n`);
    expect(await supervise({ root: dir, ...QUIET })).toBe('stopped');
    expect(started(readEvents(p.journal))).toBe(1);
    expect(other.exitCode).toBeNull();
  } finally {
    other.kill('SIGKILL');
  }
});

test('a lock whose pid is alive and is the program the lock names still keeps a second supervisor out', async () => {
  const { dir } = makeRepo({ 'body/main.ts': 'process.exit(0);\n' });
  const p = paths(dir);
  mkdirSync(join(dir, '.teneral'));
  const holder = Bun.spawn(['sleep', '300'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  try {
    for (const lock of [`${holder.pid}\n${JSON.stringify(['sleep', '300'])}\n`, `${holder.pid}\n`]) {
      writeFileSync(p.lock, lock);
      expect(await supervise({ root: dir, ...QUIET })).toBe('halted');
      expect(started(readEvents(p.journal))).toBe(0);
    }
  } finally {
    holder.kill('SIGKILL');
  }
});

// --- an install that was moved ---

test('an install moved to another directory starts again there', async () => {
  // The body exits 0 only if its dependencies are reachable from where it runs.
  const made = makeRepo({ 'body/main.ts': "process.exit(require('node:fs').existsSync('node_modules/marker') ? 0 : 9);\n" });
  writeFiles(made.dir, { 'node_modules/marker': 'x\n' });
  expect(await supervise({ root: made.dir, ...QUIET })).toBe('stopped');
  writeFiles(paths(made.dir).candidate, { 'body/notes.ts': '// work in progress, not committed\n' });

  const moved = `${made.dir}-moved`;
  renameSync(made.dir, moved);
  const p = paths(moved);
  const logs: string[] = [];
  expect(await supervise({ root: moved, ...QUIET, log: (line) => { logs.push(line); } })).toBe('stopped');
  expect(logs).toEqual([]);
  expect(started(readEvents(p.journal))).toBe(2);
  expect(git(p.live, 'rev-parse', 'HEAD')).toBe(made.seed);
  expect(git(p.candidate, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('lineage/local');
  // The agent's uncommitted work came along.
  expect(git(p.candidate, 'status', '--porcelain')).toContain('body/notes.ts');
  for (const tree of [p.live, p.candidate]) {
    expect(realpathSync(join(tree, 'node_modules'))).toBe(realpathSync(join(moved, 'node_modules')));
  }
  expect(git(moved, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '))).toHaveLength(3);
});
