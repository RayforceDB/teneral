import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendEvent, readEvents } from '../../kernel/journal';
import {
  CRASH_LIMIT, REJECTION_LIMIT, init, paths, supervise, type Options,
} from '../../kernel/supervisor';
import { git, type GateResult } from '../../kernel/gates';
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

test('a stop signal that arrives while the gates run stops the supervisor before anything else starts', async () => {
  const { dir, seed } = makeRepo({ 'body/main.ts': V1 });
  init(dir);
  const p = paths(dir);
  writeFiles(p.candidate, { 'body/main.ts': `${V1}\n// v2` });
  const next = commitAll(p.candidate, 'v2');
  process.env.TEST_NEXT = next;

  const outcome = await supervise({
    root: dir, ...QUIET,
    // supervise has its handler installed while this runs, so the signal does not end the test run.
    gates: () => { process.kill(process.pid, 'SIGTERM'); return PASS; },
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

test('a generation that re-requests a rejected molt on every start without a reply is paced, then halted, never rolled back', async () => {
  const { dir, seed } = makeRepo({ 'body/main.ts': V1 });
  init(dir);
  const p = paths(dir);
  // v2 becomes ready and asks for v3 on every start, whatever the kernel answered.
  writeFiles(p.candidate, { 'body/main.ts': `${HEAD}
appendEvent(journal, gen, { type: 'generation.ready', commit: gen });
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
  expect(logs.join('\n')).toContain('keeps requesting molts the gates reject without a reply in between');
  // Every rejection is journaled, the one that reaches the limit included.
  expect(events.filter((e) => e.type === 'molt.rejected')).toHaveLength(REJECTION_LIMIT);
  expect(events.filter((e) => e.type === 'generation.started' && e.gen === v2)).toHaveLength(REJECTION_LIMIT);
  expect(events.map((e) => e.type)).not.toContain('generation.rolledback');
  expect(JSON.parse(readFileSync(p.state, 'utf8'))).toEqual({ current: v2, previous: seed });
  // Waits of 40 and 80 ms follow the first two rejections; the third ends it.
  expect(REJECTION_LIMIT).toBe(3);
  expect(Date.now() - t).toBeGreaterThanOrEqual(120);
});

test('a generation that replies before each rejected molt is iterating, and is never halted or slowed for it', async () => {
  const rounds = 6;
  const restartBudget = 2;
  expect(rounds).toBeGreaterThan(REJECTION_LIMIT);
  expect(rounds).toBeGreaterThan(restartBudget);
  // Speaks, asks for a molt that will be rejected, and after `rounds` rejections stops by itself.
  const r = await seedOnly(`${HEAD}
const rejected = readEvents(journal).filter((e) => e.type === 'molt.rejected').length;
appendEvent(journal, gen, { type: 'generation.ready', commit: gen });
appendEvent(journal, gen, { type: 'assistant', text: 'trying again', toolCalls: [] });
if (rejected >= ${rounds}) process.exit(0);
appendEvent(journal, gen, { type: 'molt.requested', commit: '${'b'.repeat(40)}', motive: 'attempt ' + rejected });
process.exit(75);
`, { gates: () => ({ ok: false, gate: 'tests-body', output: 'boom' }), restartBudget, restartDelayMs: 30 });
  expect(r.outcome).toBe('stopped');
  expect(r.events.filter((e) => e.type === 'molt.rejected')).toHaveLength(rounds);
  expect(started(r.events)).toBe(rounds + 1);
  // Each wait is one unit: the count of rejections in a row starts again at every reply.
  const waits = r.logs.filter((line) => line.includes('rejected at gate'));
  expect(waits).toHaveLength(rounds);
  for (const line of waits) expect(line).toContain('restarting in 30 ms');
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
  expect(r.logs.join('\n')).toContain('keeps requesting molts the gates reject without a reply in between');
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
  const outcome = await supervise({ root: dir, ...QUIET, gates: () => { process.kill(process.pid, 'SIGHUP'); return PASS; } });
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
