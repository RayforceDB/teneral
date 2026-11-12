import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../../kernel/gates';
import { readEvents } from '../../kernel/journal';
import { LAUNCHER, OUTDATED_EXIT, RELAUNCH_EXIT, kernelOf, launch } from '../../kernel/launcher';
import { init, paths, readState } from '../../kernel/supervisor';
import { commitAll, makeRepo, writeFiles } from './helpers';

// The launcher, against kernels made for the test: each generation here carries a `kernel/main.ts`
// of a few lines that notes that it ran, from where and for which generation, and then does one
// thing. What is tested is the launcher's part alone: which kernel it starts, and what it does
// when the one it started does not work. The launcher under test is this project's own file.

const LAUNCHER_FILE = join(import.meta.dir, '..', '..', 'kernel', 'launcher.ts');

/** A stand-in kernel named `name`. `does` is what it does once started as a supervisor; `gen`, `journal`, `state`, `note` and `t` are there for it. */
const kernel = (name: string, does: string): string => `
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.TENERAL_ROOT;
const t = join(root, '.teneral');
const note = (text) => appendFileSync(join(root, 'kernels.log'), text + '\\n');
const where = import.meta.dir === join(root, 'kernel') ? 'the install' : import.meta.dir === join(t, 'live', 'kernel') ? 'live' : import.meta.dir;
const journal = (e) => {
  mkdirSync(join(root, 'memory'), { recursive: true });
  appendFileSync(join(root, 'memory', 'journal.jsonl'), JSON.stringify({ ...e, v: 1, id: String(Math.random()), ts: new Date().toISOString() }) + '\\n');
};
const state = (next) => {
  if (next) writeFileSync(join(t, 'state.json'), JSON.stringify(next));
  return JSON.parse(readFileSync(join(t, 'state.json'), 'utf8'));
};
if (process.argv[2] === '--prepare') {
  note('${name} prepares, from ' + where);
  if (!existsSync(join(t, 'live'))) {
    const made = Bun.spawnSync(['git', 'worktree', 'add', '-q', '--detach', join(t, 'live'), 'HEAD'], { cwd: root });
    if (made.exitCode !== 0) process.exit(1);
  }
  if (!existsSync(join(t, 'state.json'))) state({ current: Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim(), previous: null });
  process.exit(0);
}
const gen = state().current;
note('${name} runs ' + gen.slice(0, 7) + ' from ' + where + ', launcher ' + process.env.TENERAL_LAUNCHER);
const ready = () => journal({ type: 'generation.ready', commit: gen, gen });
/** As a supervisor does after its gates passed a commit with another kernel: the trial, the state, the journal, and the exit that asks for that kernel. */
const promote = (next) => {
  writeFileSync(join(t, 'trial.json'), JSON.stringify({ generation: next, previous: gen }));
  state({ current: next, previous: gen });
  journal({ type: 'generation.promoted', commit: next, previous: gen, gen: next });
  process.exit(${RELAUNCH_EXIT});
};
${does}
`;

/** Becomes ready and is stopped, unless `.teneral/next` names a commit to promote first. */
const HEALTHY = `
ready();
if (existsSync(join(t, 'next'))) {
  const next = readFileSync(join(t, 'next'), 'utf8').trim();
  rmSync(join(t, 'next'));
  promote(next);
}
process.exit(0);
`;

const tree = (main: string, launcher: number | null = 1): Record<string, string> => ({
  'kernel/main.ts': main, 'body/a.ts': 'export const a = 1;\n',
  ...(launcher === null ? {} : { 'kernel/launch.json': `{ "launcher": ${launcher} }\n` }),
});

/** An install started on a generation whose kernel is `main`, with the launcher's contract or, for `launcher: null`, from before it. */
function install(main: string, launcher: number | null = 1) {
  const { dir: root, seed } = makeRepo(tree(main, launcher));
  init(root);
  return { root, p: paths(root), seed };
}

/** A later generation in the agent's workspace, with a kernel of its own. */
function generation(root: string, main: string, launcher: number | null = 1): string {
  const work = paths(root).candidate;
  if (launcher === null) rmSync(join(work, 'kernel', 'launch.json'), { force: true });
  writeFiles(work, tree(main, launcher));
  return commitAll(work, 'another kernel');
}

async function run(root: string, o: { trialMs?: number } = {}) {
  const logs: string[] = [];
  let stderr = '';
  const code = await launch({ root, trialMs: o.trialMs ?? 20_000, graceMs: 2_000, log: (line) => logs.push(line), stderr: (chunk) => { stderr += chunk.toString(); } });
  const ran = existsSync(join(root, 'kernels.log')) ? readFileSync(join(root, 'kernels.log'), 'utf8').trim().split('\n') : [];
  return { code, logs, stderr, ran, state: existsSync(paths(root).state) ? readState(paths(root)) : null, events: readEvents(paths(root).journal) };
}

const s7 = (commit: string): string => commit.slice(0, 7);

// --- which kernel ---

test('the kernel of a generation is the one in its checkout when it states a launcher this one is; the install\'s for a generation from before the launcher', () => {
  const dir = mkdtempSync(join(tmpdir(), 'teneral-kernel-of-'));
  const live = join(dir, '.teneral', 'live');
  expect(kernelOf(dir, live)).toEqual({ home: dir, problem: null });
  writeFiles(live, { 'kernel/main.ts': '' });
  expect(kernelOf(dir, live)).toEqual({ home: dir, problem: null });
  writeFiles(live, { 'kernel/launch.json': `{ "launcher": ${LAUNCHER} }` });
  expect(kernelOf(dir, live)).toEqual({ home: live, problem: null });
  writeFiles(live, { 'kernel/launch.json': `{ "launcher": ${LAUNCHER + 1} }` });
  expect(kernelOf(dir, live).home).toBe(dir);
  expect(kernelOf(dir, live).problem).toContain(`needs launcher version ${LAUNCHER + 1} and this install's launcher is version ${LAUNCHER}`);
  for (const text of ['', 'soon', '{}', '{ "launcher": "1" }', '{ "launcher": 0 }', '{ "launcher": 1.5 }', 'null']) {
    writeFiles(live, { 'kernel/launch.json': text });
    expect(kernelOf(dir, live).problem).toContain('does not say which launcher it needs');
  }
});

// --- a normal start ---

test('the launcher checks the generation out afresh and starts its own kernel from there, with the install and its version named', async () => {
  const { root, p, seed } = install(kernel('A', HEALTHY));
  // Whatever was left in the checkout, by a kill or by a hand.
  writeFileSync(join(p.live, 'kernel', 'main.ts'), 'process.exit(9);\n');
  writeFileSync(join(p.live, 'stray.ts'), '');
  const r = await run(root);
  expect(r.code).toBe(0);
  expect(r.ran).toEqual([`A runs ${s7(seed)} from live, launcher ${LAUNCHER}`]);
  expect(existsSync(join(p.live, 'stray.ts'))).toBe(false);
  expect(r.state).toEqual({ current: seed, previous: null });
  expect(r.logs).toEqual([]);
});

test('an install that was never started is prepared by the install\'s own kernel, and then run by the generation\'s', async () => {
  const { dir: root, seed } = makeRepo(tree(kernel('A', HEALTHY)));
  const r = await run(root);
  expect(r.code).toBe(0);
  expect(r.ran).toEqual(['A prepares, from the install', `A runs ${s7(seed)} from live, launcher ${LAUNCHER}`]);
  expect(r.state).toEqual({ current: seed, previous: null });
});

test('a kernel that stops with a status of its own, with nothing on trial, is simply what the launcher ends with', async () => {
  const { root, seed } = install(kernel('A', 'process.exit(1);'));
  // A generation before it is named, as it stays for as long as this one is current; that alone is no trial.
  const earlier = git(root, 'commit-tree', '-m', 'earlier', `${seed}^{tree}`);
  writeFileSync(paths(root).state, JSON.stringify({ current: seed, previous: earlier }));
  const r = await run(root);
  expect(r.code).toBe(1);
  expect(r.state).toEqual({ current: seed, previous: earlier });
  expect(r.events).toEqual([]);
});

// --- handing over ---

test('after a kernel promoted a generation with another kernel and asked for it, the launcher starts that one, on trial until its generation is ready', async () => {
  const { root, p, seed } = install(kernel('A', HEALTHY));
  const b = generation(root, kernel('B', HEALTHY));
  writeFileSync(join(root, '.teneral', 'next'), b);
  const r = await run(root);
  expect(r.code).toBe(0);
  expect(r.ran).toEqual([`A runs ${s7(seed)} from live, launcher ${LAUNCHER}`, `B runs ${s7(b)} from live, launcher ${LAUNCHER}`]);
  expect(r.state).toEqual({ current: b, previous: seed });
  expect(r.events.map((e) => e.type)).toEqual(['generation.ready', 'generation.promoted', 'generation.ready']);
  // Proven: the trial is over.
  expect(existsSync(p.trial)).toBe(false);
  expect(r.logs).toEqual([]);
  // The next start is an ordinary one, of the new kernel.
  expect((await run(root)).ran.at(-1)).toBe(`B runs ${s7(b)} from live, launcher ${LAUNCHER}`);
});

test('migration: an install from before the launcher comes up under it as it is, supervised by the install\'s kernel, and hands over when a species commit brings a kernel of its own', async () => {
  // As it stands today: a state file, a live checkout, and a generation whose kernel knows nothing of a launcher.
  const { root, p, seed } = install('process.exit(9); // a kernel from before the launcher: it must never be started from the checkout\n', null);
  expect(JSON.parse(readFileSync(p.state, 'utf8'))).toEqual({ current: seed, previous: null });
  // The owner updates the checkout: its kernel is now one that the launcher can start.
  writeFiles(root, tree(kernel('install', HEALTHY)));
  commitAll(root, 'the project moved on');
  const first = await run(root);
  expect(first.code).toBe(0);
  expect(first.ran).toEqual([`install runs ${s7(seed)} from the install, launcher ${LAUNCHER}`]);
  expect(first.state).toEqual({ current: seed, previous: null });
  // The lineage takes that commit's kernel in, and the install's kernel promotes it.
  const b = generation(root, kernel('B', HEALTHY));
  writeFileSync(join(root, '.teneral', 'next'), b);
  const r = await run(root);
  expect(r.code).toBe(0);
  expect(r.ran.slice(1)).toEqual([`install runs ${s7(seed)} from the install, launcher ${LAUNCHER}`, `B runs ${s7(b)} from live, launcher ${LAUNCHER}`]);
  expect(r.state).toEqual({ current: b, previous: seed });
});

test('a generation gone back to that is from before the launcher is supervised by the install\'s kernel again', async () => {
  const { root, p, seed } = install(kernel('A', HEALTHY));
  const old = generation(root, 'process.exit(9);\n', null);
  // A's kernel, in the owner's checkout as well, goes back by itself to a generation without a kernel of its own.
  writeFileSync(p.state, JSON.stringify({ current: old, previous: null }));
  const r = await run(root);
  expect(r.code).toBe(0);
  expect(r.ran).toEqual([`A runs ${s7(old)} from the install, launcher ${LAUNCHER}`]);
  expect(seed).not.toBe(old);
});

// --- a new kernel that does not work ---

const FAILURES: [string, string, RegExp][] = [
  ['cannot be started at all', 'this is not a program (\n', /that kernel ended with status \d+ before the generation was ready/],
  ['falls over at once', kernel('B', 'console.error("B: the new kernel fell over"); process.exit(3);'), /that kernel ended with status 3 before the generation was ready/],
  ['ends quietly before its generation is ready', kernel('B', 'process.exit(0);'), /that kernel ended with status 0 before the generation was ready/],
  ['gives up as if nothing could run', kernel('B', 'process.exit(1);'), /that kernel ended with status 1 before the generation was ready/],
  ['never brings its generation to ready', kernel('B', 'setInterval(() => {}, 1000);'), /that kernel did not bring it to ready within 0\.6 s/],
  ['only asks for another kernel, over and over', kernel('B', `process.exit(${RELAUNCH_EXIT});`), /its kernel asked for another kernel to be started without having changed the generation/],
];

test.each(FAILURES)('a new kernel that %s: the launcher goes back to the generation before, by its own hand, and the journal says why', async (_what, main, why) => {
  const { root, p, seed } = install(kernel('A', HEALTHY));
  const b = generation(root, main);
  writeFileSync(join(root, '.teneral', 'next'), b);
  const r = await run(root, { trialMs: 600 });
  // The generation before runs again, under its own kernel, and is what the launcher ends with.
  expect(r.code).toBe(0);
  expect(r.ran[0]).toBe(`A runs ${s7(seed)} from live, launcher ${LAUNCHER}`);
  expect(r.ran.at(-1)).toBe(`A runs ${s7(seed)} from live, launcher ${LAUNCHER}`);
  expect(r.ran.filter((line) => line.startsWith('A runs'))).toHaveLength(2);
  expect(r.state).toEqual({ current: seed, previous: null });
  expect(existsSync(p.trial)).toBe(false);
  const back = r.events.filter((e) => e.type === 'generation.rolledback');
  expect(back).toHaveLength(1);
  expect(back[0]).toMatchObject({ commit: b, to: seed, gen: seed, v: 1 });
  const reason = (back[0] as { reason: string }).reason;
  expect(reason.startsWith('came with a new kernel, and ')).toBe(true);
  expect(reason).toMatch(why);
  expect(reason).toContain('so the launcher went back to the generation before it');
  expect(r.logs.some((line) => line.startsWith(`rolled back ${b} to ${seed}: it came with a new kernel`))).toBe(true);
  // The order a reader of the journal relies on: promoted, rolled back, and the old generation ready again.
  const types = r.events.map((e) => e.type);
  expect(types.indexOf('generation.rolledback')).toBeGreaterThan(types.indexOf('generation.promoted'));
  expect(types.at(-1)).toBe('generation.ready');
});

test('what the failed kernel last wrote to stderr is shown as it comes and is in the reason', async () => {
  const { root } = install(kernel('A', HEALTHY));
  const b = generation(root, kernel('B', 'console.error("B: the new kernel fell over"); process.exit(3);'));
  writeFileSync(join(root, '.teneral', 'next'), b);
  const r = await run(root);
  expect(r.stderr).toContain('B: the new kernel fell over');
  const back = r.events.find((e) => e.type === 'generation.rolledback') as { reason: string };
  expect(back.reason).toContain('That kernel\'s stderr ended with:\nB: the new kernel fell over');
});

test('a journal line a killed writer left unfinished does not swallow the launcher\'s rollback', async () => {
  const { root, p } = install(kernel('A', HEALTHY));
  const b = generation(root, kernel('B', `appendFileSync(join(root, 'memory', 'journal.jsonl'), '{"type":"assistant","text":"half a li'); process.exit(3);`));
  writeFileSync(join(root, '.teneral', 'next'), b);
  const r = await run(root);
  expect(r.events.some((e) => e.type === 'generation.rolledback' && e.commit === b)).toBe(true);
  expect(readFileSync(p.journal, 'utf8')).toContain('half a li\n');
});

test('a new kernel that works and whose body does not: it goes back itself, asks for the old kernel, and the launcher adds nothing', async () => {
  const { root, seed } = install(kernel('A', HEALTHY));
  const b = generation(root, kernel('B', `
    journal({ type: 'generation.rolledback', commit: gen, to: state().previous, reason: 'exited with 1 before it was ready', gen: state().previous });
    state({ current: state().previous, previous: null });
    process.exit(${RELAUNCH_EXIT});`));
  writeFileSync(join(root, '.teneral', 'next'), b);
  const r = await run(root);
  expect(r.code).toBe(0);
  expect(r.ran.map((line) => line.slice(0, 6))).toEqual(['A runs', 'B runs', 'A runs']);
  expect(r.state).toEqual({ current: seed, previous: null });
  expect(r.events.filter((e) => e.type === 'generation.rolledback')).toHaveLength(1);
  expect(existsSync(paths(root).trial)).toBe(false);
  expect(r.logs).toEqual([]);
});

test('a trial file that names anything but the current generation and the one before it is from a change that never happened: dropped, not acted on', async () => {
  const { root, p, seed } = install(kernel('A', 'process.exit(1);'));
  const other = generation(root, kernel('B', HEALTHY));
  writeFileSync(p.trial, JSON.stringify({ generation: other, previous: seed }));
  const r = await run(root);
  expect(r.code).toBe(1);
  expect(r.state).toEqual({ current: seed, previous: null });
  expect(existsSync(p.trial)).toBe(false);
  expect(r.events).toEqual([]);
});

// --- the contract ---

test('a generation whose kernel needs a newer launcher is not started and not looped on: the owner is told to update the install', async () => {
  const { root, p } = install(kernel('A', HEALTHY));
  const b = generation(root, kernel('B', HEALTHY), LAUNCHER + 1);
  writeFileSync(p.state, JSON.stringify({ current: b, previous: null }));
  const r = await run(root);
  expect(r.code).toBe(OUTDATED_EXIT);
  expect(r.ran).toEqual([]);
  expect(r.logs).toEqual([`generation ${b} cannot be run: its kernel needs launcher version ${LAUNCHER + 1} and this install's launcher is version ${LAUNCHER}: the owner must update the install (git pull, then ./box down and ./box up)`]);
  expect(r.state).toEqual({ current: b, previous: null });
});

test('the same on trial, should a kernel have promoted it all the same: back to the generation before, with that reason', async () => {
  const { root, seed } = install(kernel('A', HEALTHY));
  const b = generation(root, kernel('B', HEALTHY), LAUNCHER + 1);
  writeFileSync(join(root, '.teneral', 'next'), b);
  const r = await run(root);
  expect(r.code).toBe(0);
  expect(r.ran.some((line) => line.startsWith('B'))).toBe(false);
  expect(r.state).toEqual({ current: seed, previous: null });
  const back = r.events.find((e) => e.type === 'generation.rolledback') as { reason: string };
  expect(back.reason).toContain(`its kernel needs launcher version ${LAUNCHER + 1} and this install's launcher is version ${LAUNCHER}: the owner must update the install`);
});

test('a kernel that asks for another without having changed the generation, with nothing on trial, ends the launcher instead of spinning it', async () => {
  const { root } = install(kernel('A', `process.exit(${RELAUNCH_EXIT});`));
  const r = await run(root);
  expect(r.code).toBe(1);
  expect(r.ran).toHaveLength(1);
  expect(r.logs.at(-1)).toContain('asked for another kernel to be started without having changed the generation');
});

// --- being stopped ---

test('told to stop, the launcher passes that on to the kernel and ends with its status; a kernel on trial is not rolled back for it', async () => {
  const { root, p, seed } = install(kernel('A', HEALTHY));
  const b = generation(root, kernel('B', `
    process.on('SIGTERM', () => { note('B was told to stop'); process.exit(0); });
    note('B waits');
    setInterval(() => {}, 1000);`));
  writeFileSync(join(root, '.teneral', 'next'), b);
  const runner = join(root, '.teneral', 'run.ts');
  writeFileSync(runner, `import { launch } from ${JSON.stringify(LAUNCHER_FILE)};\nprocess.exit(await launch({ root: ${JSON.stringify(root)}, log: () => {} }));\n`);
  const child = Bun.spawn([process.execPath, runner], { cwd: root, stdout: 'ignore', stderr: 'ignore' });
  const log = join(root, 'kernels.log');
  for (let i = 0; i < 200 && !(existsSync(log) && readFileSync(log, 'utf8').includes('B waits')); i++) await Bun.sleep(50);
  child.kill('SIGTERM');
  expect(await child.exited).toBe(0);
  expect(readFileSync(log, 'utf8')).toContain('B was told to stop');
  expect(readState(p)).toEqual({ current: b, previous: seed });
  expect(readEvents(p.journal).some((e) => e.type === 'generation.rolledback')).toBe(false);
  // Still on trial at the next start.
  expect(existsSync(p.trial)).toBe(true);
});
