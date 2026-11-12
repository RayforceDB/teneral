import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main as acceptMain } from '../../kernel/accept';
import { git, runGates, type GateOptions, type GateResult } from '../../kernel/gates';
import { readEvents } from '../../kernel/journal';
import { ACCEPT_SUFFIX, INTERRUPT_SUFFIX, accept, tell } from '../../kernel/owner';
import {
  CAGE, acceptSpecies, cageDifferences, cageNotice, chooseAccept, readConsent, speciesMode, speciesRef, takeAccepts,
} from '../../kernel/species';
import { init, paths } from '../../kernel/supervisor';
import { commitAll, makeRepo, writeFiles } from './helpers';

// The species: the rule the gate keeps for everything outside the changeable paths, the owner's
// consent, and what is said about the cage. Every repository here is made for the test; the
// "remote" ones are other directories on this machine.

const NO_CHECKS: never[] = [];
const ID = ['-c', 'user.name=test', '-c', 'user.email=test@localhost'];
const SEED = { 'kernel/k.ts': 'export const k = 1;\n', 'kernel/launch.json': '{ "launcher": 1 }\n', 'body/a.ts': 'export const a = 1;\n', 'README.md': 'one\n' };

/** An install whose species is the local branch `main`: the owner's checkout on it, and the agent's workspace on the lineage branch. */
function local(files: Record<string, string> = SEED) {
  const { dir: root, seed } = makeRepo(files);
  const work = join(root, '.teneral', 'candidate');
  git(root, 'worktree', 'add', '-q', '-b', 'lineage/local', work, seed);
  return { root, work, seed };
}

/** A commit on the species, made where the species lives. */
function publish(where: string, files: Record<string, string>, message = 'species'): string {
  writeFiles(where, files);
  return commitAll(where, message);
}

/** The workspace takes `what` in, as the agent would: a merge, with its own body kept where both changed it. */
function merge(work: string, what: string): string {
  git(work, ...ID, 'merge', '-q', '--no-edit', '-X', 'ours', what);
  return git(work, 'rev-parse', 'HEAD');
}

const gate = (work: string, from: string, to: string, species: GateOptions['species'] = {}): Promise<GateResult> => (
  runGates(work, from, to, NO_CHECKS, { species: { launcher: 1, mode: 'auto', ...species } })
);

// --- which ref ---

test('the species is TENERAL_UPSTREAM: a branch of a remote when its first part names one, else a local branch', () => {
  const { root } = local();
  expect(speciesRef(root, 'main')).toEqual({ name: 'main', ref: 'refs/heads/main', remote: null });
  expect(speciesRef(root, 'origin/main')).toEqual({ name: 'origin/main', ref: 'refs/heads/origin/main', remote: null });
  git(root, 'remote', 'add', 'origin', '/nowhere');
  git(root, 'remote', 'add', 'fork', '/nowhere-else');
  expect(speciesRef(root, 'origin/main')).toEqual({ name: 'origin/main', ref: 'refs/remotes/origin/main', remote: { name: 'origin', branch: 'main' } });
  expect(speciesRef(root, ' fork/release/v2 ')).toEqual({ name: 'fork/release/v2', ref: 'refs/remotes/fork/release/v2', remote: { name: 'fork', branch: 'release/v2' } });
  expect(speciesRef(root, 'feature/x')).toEqual({ name: 'feature/x', ref: 'refs/heads/feature/x', remote: null });
  for (const bad of ['--upload-pack=x', 'a b', 'a..b', 'x;rm']) expect(speciesRef(root, bad)).toHaveProperty('problem');
});

test('unset, it is origin/main when there is a remote origin, else the branch the owner\'s checkout is on, and never the lineage\'s own', () => {
  const { root } = local();
  expect(speciesRef(root)).toEqual({ name: 'main', ref: 'refs/heads/main', remote: null });
  expect(speciesRef(root, '')).toEqual({ name: 'main', ref: 'refs/heads/main', remote: null });
  git(root, 'remote', 'add', 'origin', '/nowhere');
  expect(speciesRef(root)).toEqual({ name: 'origin/main', ref: 'refs/remotes/origin/main', remote: { name: 'origin', branch: 'main' } });
  git(root, 'remote', 'remove', 'origin');
  git(root, 'checkout', '-q', '--detach');
  expect(speciesRef(root)).toHaveProperty('problem');
  const own = makeRepo(SEED);
  git(own.dir, 'checkout', '-q', '-b', 'lineage/local');
  expect(speciesRef(own.dir)).toHaveProperty('problem');
});

test('TENERAL_SPECIES is ask unless it says auto or off', () => {
  expect([undefined, '', 'ask', 'yes', 'AUTO', ' off '].map(speciesMode)).toEqual(['ask', 'ask', 'ask', 'ask', 'auto', 'off']);
});

// --- the rule ---

test('a commit that merges a later species commit, and holds outside the changeable paths exactly what that commit holds, passes', async () => {
  const { root, work, seed } = local();
  writeFiles(work, { 'body/a.ts': 'export const a = 2;\n' });
  const own = commitAll(work, 'my body');
  expect(await gate(work, seed, own)).toEqual({ ok: true, gate: 'all', output: '' });
  publish(root, { 'kernel/k.ts': 'export const k = 2;\n', 'kernel/new.ts': 'export const n = 1;\n', 'README.md': 'two\n', 'body/a.ts': 'export const a = 9;\n' });
  const merged = merge(work, 'main');
  expect(readFileSync(join(work, 'body/a.ts'), 'utf8')).toBe('export const a = 2;\n');
  expect(await gate(work, own, merged)).toEqual({ ok: true, gate: 'all', output: '' });
  // And the next molt from there is an ordinary one again.
  writeFiles(work, { 'body/a.ts': 'export const a = 3;\n' });
  expect(await gate(work, merged, commitAll(work, 'on'))).toEqual({ ok: true, gate: 'all', output: '' });
});

test('a species commit that changes nothing outside the changeable paths is taken like any change to the body: no consent, no launcher', async () => {
  const { root, work, seed } = local();
  publish(root, { 'body/a.ts': 'export const a = 7;\n', 'BACKLOG.md': 'more\n' });
  const merged = merge(work, 'main');
  expect(await runGates(work, seed, merged, NO_CHECKS, { species: { mode: 'off' } })).toEqual({ ok: true, gate: 'all', output: '' });
});

test('a commit that stands where the running generation stands and changes a protected path is refused in the words it always was', async () => {
  const { work, seed } = local();
  writeFiles(work, { 'kernel/k.ts': 'export const k = 99;\n', 'body/a.ts': 'export const a = 2;\n' });
  const next = commitAll(work, 'touch the kernel');
  for (const mode of ['ask', 'auto', 'off']) {
    expect(await gate(work, seed, next, { mode })).toEqual({ ok: false, gate: 'protected', output: 'protected paths changed: kernel/k.ts' });
  }
});

test('a commit that merges a species commit and then touches a kernel file is refused, and told which files differ from which commit', async () => {
  const { root, work, seed } = local();
  const b = publish(root, { 'kernel/k.ts': 'export const k = 2;\n' });
  merge(work, 'main');
  writeFiles(work, { 'kernel/k.ts': 'export const k = 3;\n', 'kernel/mine.ts': 'export {};\n' });
  const next = commitAll(work, 'and a little more');
  const r = await gate(work, seed, next);
  expect(r.ok).toBe(false);
  expect(r.gate).toBe('species');
  expect(r.undecided).toBeUndefined();
  expect(r.output).toContain(`differs from the species commit ${b} in: kernel/k.ts, kernel/mine.ts`);
  expect(r.output).toContain(`git checkout ${b.slice(0, 12)} -- <path>`);
  // Mended as the message says, it passes.
  git(work, 'checkout', b, '--', 'kernel/k.ts');
  git(work, 'rm', '-q', 'kernel/mine.ts');
  expect((await gate(work, seed, commitAll(work, 'as the species has it'))).ok).toBe(true);
});

test('a commit that would stand on an earlier species commit than the running generation is refused as a move back', async () => {
  const { root, work, seed } = local();
  writeFiles(work, { 'body/a.ts': 'export const a = 2;\n' });
  const early = commitAll(work, 'before the species moved');
  const b = publish(root, { 'kernel/k.ts': 'export const k = 2;\n' });
  const on = merge(work, 'main');
  expect((await gate(work, early, on)).ok).toBe(true);
  // The workspace is put back on the older line and something is added there.
  git(work, 'reset', '-q', '--hard', early);
  writeFiles(work, { 'body/a.ts': 'export const a = 3;\n' });
  const back = commitAll(work, 'on the old kernel again');
  const r = await gate(work, on, back);
  expect(r).toMatchObject({ ok: false, gate: 'species' });
  expect(r.output).toContain(`would move the species back from ${b} to ${seed}`);
  expect(r.output).toContain('Merge main (now ');
});

test('a species ref that was force-moved: the body still molts, and the lineage gets onto the new line only with exactly its files', async () => {
  const { root, work, seed } = local();
  publish(root, { 'kernel/k.ts': 'export const k = 2;\n', 'kernel/only-b.ts': 'export {};\n' });
  const g = merge(work, 'main');
  // The owner takes that commit back and publishes another in its place.
  git(root, 'reset', '-q', '--hard', seed);
  const moved = publish(root, { 'kernel/k.ts': 'export const k = 5;\n' }, 'instead');
  writeFiles(work, { 'body/a.ts': 'export const a = 2;\n' });
  const own = commitAll(work, 'my body, on the kernel that was taken back');
  expect(await gate(work, g, own)).toEqual({ ok: true, gate: 'all', output: '' });
  git(work, ...ID, 'merge', '-q', '--no-edit', '-X', 'theirs', 'main');
  const mixed = git(work, 'rev-parse', 'HEAD');
  const r = await gate(work, own, mixed);
  expect(r).toMatchObject({ ok: false, gate: 'species' });
  expect(r.output).toContain(`differs from the species commit ${moved} in: kernel/only-b.ts`);
  git(work, 'rm', '-q', 'kernel/only-b.ts');
  expect(await gate(work, own, commitAll(work, 'what the species no longer has'))).toEqual({ ok: true, gate: 'all', output: '' });
});

test('a first generation, started from the species\' tip, takes the next species commit', async () => {
  const { dir: root, seed } = makeRepo({ ...SEED, 'body/main.ts': 'process.exit(0);\n' });
  expect(init(root)).toEqual({ current: seed, previous: null });
  const p = paths(root);
  publish(root, { 'kernel/k.ts': 'export const k = 2;\n' });
  const merged = merge(p.candidate, 'main');
  expect(await gate(p.candidate, seed, merged)).toEqual({ ok: true, gate: 'all', output: '' });
});

test('a commit with more than one merge base with the species is refused until it merges the species\' tip', async () => {
  const { root, work, seed } = local();
  // The species takes a commit of the lineage in, while the lineage takes one of the species: a criss-cross.
  writeFiles(work, { 'body/a.ts': 'export const a = 2;\n' });
  const l1 = commitAll(work, 'l1');
  const s1 = publish(root, { 'kernel/k.ts': 'export const k = 2;\n' }, 's1');
  git(root, ...ID, 'merge', '-q', '--no-edit', l1);
  publish(root, { 'kernel/k.ts': 'export const k = 3;\n' }, 's2');
  git(work, ...ID, 'merge', '-q', '--no-edit', s1);
  const crossed = git(work, 'rev-parse', 'HEAD');
  expect(git(work, 'merge-base', '--all', crossed, 'main').split('\n').length).toBe(2);
  const r = await gate(work, seed, crossed);
  expect(r).toMatchObject({ ok: false, gate: 'species' });
  expect(r.output).toContain('more than one merge base');
  expect((await gate(work, seed, merge(work, 'main'))).ok).toBe(true);
});

// --- a species on a remote ---

/** The species published somewhere else, and an install cloned from it. `depth`: a shallow clone. */
function remote(o: { depth?: number; history?: number } = {}) {
  const up = makeRepo(SEED);
  for (let i = 0; i < (o.history ?? 0); i++) publish(up.dir, { 'README.md': `history ${i}\n` }, `history ${i}`);
  const root = join(mkdtempSync(join(tmpdir(), 'teneral-install-')), 'install');
  const depth = o.depth === undefined ? [] : ['--depth', String(o.depth)];
  git(tmpdir(), 'clone', '-q', ...depth, `file://${up.dir}`, root);
  const start = git(root, 'rev-parse', 'HEAD');
  const work = join(root, '.teneral', 'candidate');
  git(root, 'worktree', 'add', '-q', '-b', 'lineage/local', work, start);
  return { up: up.dir, root, work, start };
}

test('the kernel fetches a remote species itself: a commit the agent pulled by address, with the remote-tracking ref left behind, is seen for what it is', async () => {
  const { up, root, work, start } = remote();
  const b = publish(up, { 'kernel/k.ts': 'export const k = 2;\n' });
  git(work, ...ID, 'pull', '-q', '--no-edit', '--no-rebase', `file://${up}`, 'main');
  const merged = git(work, 'rev-parse', 'HEAD');
  expect(git(root, 'rev-parse', 'origin/main')).toBe(start);
  expect(await gate(work, start, merged, { upstream: undefined })).toEqual({ ok: true, gate: 'all', output: '' });
  expect(git(root, 'rev-parse', 'origin/main')).toBe(b);
  // Fetching is all the kernel did to the remote: its address is as it was.
  expect(git(root, 'remote', 'get-url', 'origin')).toBe(`file://${up}`);
});

test('with the remote out of reach, a mutation from the species is refused without a verdict and may be asked again; the body molts as ever', async () => {
  const { up, root, work, start } = remote();
  publish(up, { 'kernel/k.ts': 'export const k = 2;\n' });
  git(root, 'fetch', '-q', 'origin');
  const merged = merge(work, 'origin/main');
  git(root, 'remote', 'set-url', 'origin', join(up, 'gone'));
  const r = await gate(work, start, merged);
  expect(r).toMatchObject({ ok: false, gate: 'species', undecided: true });
  expect(r.output).toContain('the species origin/main could not be fetched');
  expect(r.output).toContain('Call molt again');
  // Offline, a change to the body alone needs nothing of the species.
  git(work, 'reset', '-q', '--hard', start);
  writeFiles(work, { 'body/a.ts': 'export const a = 2;\n' });
  expect(await gate(work, start, commitAll(work, 'body'))).toEqual({ ok: true, gate: 'all', output: '' });
  // And a change to the kernel that merges nothing is still the plain refusal, with the reason it could not be looked at further.
  writeFiles(work, { 'kernel/k.ts': 'export const k = 7;\n' });
  const touched = await gate(work, start, commitAll(work, 'kernel'));
  expect(touched).toMatchObject({ ok: false, gate: 'protected' });
  expect(touched.undecided).toBeUndefined();
  expect(touched.output.startsWith('protected paths changed: kernel/k.ts\n')).toBe(true);
  expect(touched.output).toContain('could not be fetched');
});

test('a fetch that does not end in time is stopped, and the molt refused without a verdict', async () => {
  const { root, work, start } = remote();
  // A remote that never answers: git is told to reach it through a command that only waits.
  git(root, 'remote', 'set-url', 'origin', 'ext::sleep 30');
  git(root, 'config', 'protocol.ext.allow', 'always');
  writeFiles(work, { 'kernel/k.ts': 'export const k = 7;\n' });
  const next = commitAll(work, 'kernel');
  const began = Date.now();
  const r = await gate(work, start, next, { fetchTimeoutMs: 300 });
  expect(Date.now() - began).toBeLessThan(10_000);
  expect(r).toMatchObject({ ok: false, gate: 'protected' });
  expect(r.output).toContain('could not be fetched');
});

test('a shallow clone takes a mutation from the species; one whose history git cannot see is told so', async () => {
  const { up, root, work, start } = remote({ depth: 1, history: 3 });
  expect(git(root, 'rev-parse', '--is-shallow-repository')).toBe('true');
  publish(up, { 'kernel/k.ts': 'export const k = 2;\n' });
  git(root, 'fetch', '-q', 'origin');
  const merged = merge(work, 'origin/main');
  expect(await gate(work, start, merged)).toEqual({ ok: true, gate: 'all', output: '' });

  // The agent fetches the next one with its history cut off, and builds on that.
  const c = publish(up, { 'kernel/k.ts': 'export const k = 3;\n' });
  git(root, 'fetch', '-q', '--depth', '1', 'origin', 'main');
  git(work, 'reset', '-q', '--hard', c);
  writeFiles(work, { 'body/a.ts': 'export const a = 2;\n' });
  const cut = commitAll(work, 'on a commit without a past');
  const r = await gate(work, merged, cut);
  expect(r).toMatchObject({ ok: false, gate: 'species' });
  expect(r.output).toContain('shares no history with the species');
  expect(r.output).toContain('git fetch --unshallow');
});

test('a lineage from before this rule, whose kernel is ahead of the published species, molts its body, and joins the species when that is published', async () => {
  // As the living lineages are: the owner merged an unpublished main into the lineage by hand.
  const { up, root, work, start } = remote();
  const unpublished = publish(root, { 'kernel/k.ts': 'export const k = 2;\n' }, 'the owner\'s own, not pushed');
  const g = merge(work, 'main');
  expect(git(root, 'rev-parse', 'origin/main')).toBe(start);
  // Its body molts, with the remote out of reach too.
  git(root, 'remote', 'set-url', 'origin', join(up, 'gone'));
  writeFiles(work, { 'body/a.ts': 'export const a = 2;\n' });
  const own = commitAll(work, 'body');
  expect(await gate(work, g, own, { mode: 'ask' })).toEqual({ ok: true, gate: 'all', output: '' });
  git(root, 'remote', 'set-url', 'origin', `file://${up}`);
  // A kernel file changed by the agent is the plain refusal.
  writeFiles(work, { 'kernel/k.ts': 'export const k = 3;\n' });
  const touched = commitAll(work, 'kernel');
  expect(await gate(work, own, touched)).toEqual({ ok: false, gate: 'protected', output: 'protected paths changed: kernel/k.ts' });
  git(work, 'reset', '-q', '--hard', own);
  // The owner publishes main, with more on it. What the lineage stands on is then the commit it already had.
  const next = publish(root, { 'kernel/k.ts': 'export const k = 4;\n' }, 'and the next');
  git(up, 'pull', '-q', '--ff-only', root, 'main');
  expect(git(root, 'rev-parse', 'origin/main')).toBe(start);
  const merged = merge(work, next);
  const asked = await gate(work, own, merged, { mode: 'ask' });
  expect(asked).toMatchObject({ ok: false, gate: 'species', undecided: true });
  expect(asked.output).toContain(`from species commit ${unpublished.slice(0, 12)} to ${next}`);
  expect(await gate(work, own, merged)).toEqual({ ok: true, gate: 'all', output: '' });
});

test('the owner of a development checkout points the species at a local branch, and nothing is fetched', async () => {
  const { up, root, work, start } = remote();
  git(root, 'remote', 'set-url', 'origin', join(up, 'gone'));
  publish(root, { 'kernel/k.ts': 'export const k = 2;\n' }, 'not pushed');
  const merged = merge(work, 'main');
  expect((await gate(work, start, merged)).gate).toBe('protected');
  expect(await gate(work, start, merged, { upstream: 'main' })).toEqual({ ok: true, gate: 'all', output: '' });
});

test('a species ref that does not exist is said, after the plain refusal', async () => {
  const { work, seed } = local();
  writeFiles(work, { 'kernel/k.ts': 'export const k = 2;\n' });
  const r = await gate(work, seed, commitAll(work, 'kernel'), { upstream: 'release' });
  expect(r).toMatchObject({ ok: false, gate: 'protected' });
  expect(r.output.startsWith('protected paths changed: kernel/k.ts\n')).toBe(true);
  expect(r.output).toContain('the species release (refs/heads/release) is not in this repository');
});

// --- the launcher's contract, at the gate ---

test('a species commit whose kernel needs a newer launcher than the install\'s is refused, and the owner is the one to act', async () => {
  const { root, work, seed } = local();
  publish(root, { 'kernel/launch.json': '{ "launcher": 2 }\n' });
  const merged = merge(work, 'main');
  const r = await gate(work, seed, merged, { launcher: 1 });
  expect(r).toMatchObject({ ok: false, gate: 'species' });
  expect(r.output).toContain('needs launcher version 2, and this install\'s launcher is version 1');
  expect(r.output).toContain('your owner must update the install');
  expect((await gate(work, seed, merged, { launcher: 2 })).ok).toBe(true);
  // Nothing was asked of the owner for a commit that could not be started anyway.
  expect((await gate(work, seed, merged, { launcher: 1, mode: 'ask' })).undecided).toBeUndefined();
  expect(readConsent(root).asked).toBeUndefined();
});

test('a launch.json that says nothing usable, and a supervisor that no launcher started, refuse a mutation from the species', async () => {
  const { root, work, seed } = local();
  publish(root, { 'kernel/launch.json': 'soon\n' });
  const broken = await gate(work, seed, merge(work, 'main'));
  expect(broken).toMatchObject({ ok: false, gate: 'species' });
  expect(broken.output).toContain('does not say which launcher version it needs');

  const other = local();
  publish(other.root, { 'kernel/k.ts': 'export const k = 2;\n' });
  const merged = merge(other.work, 'main');
  for (const launcher of [null, undefined]) {
    const r = await runGates(other.work, other.seed, merged, NO_CHECKS, { species: { mode: 'auto', launcher } });
    expect(r).toMatchObject({ ok: false, gate: 'species' });
    expect(r.output).toContain('was not started by the launcher');
  }
  // With no options at all, as a caller from before the species would call it: the same.
  expect((await runGates(other.work, other.seed, merged, NO_CHECKS)).gate).toBe('species');
});

test('a species commit from before the launcher, with no launch.json, can be stood on: the install\'s kernel runs it', async () => {
  const { root, work, seed } = local({ 'kernel/k.ts': 'export const k = 1;\n', 'body/a.ts': 'a\n' });
  publish(root, { 'kernel/k.ts': 'export const k = 2;\n' });
  expect((await gate(work, seed, merge(work, 'main'))).ok).toBe(true);
});

// --- consent ---

/** A mutation from the species, ready to be judged, on an install that has been started. */
function waiting() {
  const { dir: root, seed } = makeRepo({ ...SEED, 'body/main.ts': 'process.exit(0);\n' });
  init(root);
  const p = paths(root);
  const b = publish(root, { 'kernel/k.ts': 'export const k = 2;\n' }, 'the second kernel');
  const merged = merge(p.candidate, 'main');
  const ask = () => gate(p.candidate, seed, merged, { mode: 'ask' });
  return { root, p, seed, b, merged, ask };
}

test('ask: the gate refuses a mutation from the species until the owner has accepted its commit, names it, and remembers what was asked', async () => {
  const { root, seed, b, ask } = waiting();
  const r = await ask();
  expect(r).toMatchObject({ ok: false, gate: 'species', undecided: true });
  expect(r.output).toContain(`from species commit ${seed.slice(0, 12)} to ${b}`);
  expect(r.output).toContain(`./box accept ${b.slice(0, 12)}`);
  expect(r.output).toContain('/accept in ./box talk');
  expect(r.output).toContain('call molt again for this same commit');
  expect(readConsent(root)).toMatchObject({ asked: b });
  expect(readConsent(root).accepted).toBeUndefined();
  // Asking again changes nothing.
  expect((await ask()).undecided).toBe(true);
});

test('./box accept: with no commit it accepts what was asked, writes that down, journals it with its route, and the gate lets the commit through', async () => {
  const { root, p, seed, b, ask } = waiting();
  const said: string[] = [];
  expect(acceptMain([], root, (line) => said.push(line), (line) => said.push(line))).toBe(1);
  expect(said.join('\n')).toContain('nothing is waiting for your acceptance');
  await ask();
  said.length = 0;
  expect(acceptMain([], root, (line) => said.push(line), (line) => said.push(line))).toBe(0);
  expect(said[0]).toBe(`Accepted species commit ${b.slice(0, 12)} (the second kernel), and every one before it.`);
  expect(readConsent(root)).toMatchObject({ accepted: b, route: 'box' });
  expect(readConsent(root).asked).toBeUndefined();
  const events = readEvents(p.journal).filter((e) => e.type === 'species.accepted');
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: 'species.accepted', commit: b, route: 'box', gen: seed });
  expect(await ask()).toEqual({ ok: true, gate: 'all', output: '' });
});

test('./box accept <commit>: a prefix is enough, anything that is no commit is refused, and an install never started has nothing to accept for', () => {
  const { root, b } = waiting();
  const said: string[] = [];
  const run = (...args: string[]) => acceptMain(args, root, (line) => said.push(line), (line) => said.push(line));
  expect(run(b.slice(0, 8))).toBe(0);
  expect(readConsent(root).accepted).toBe(b);
  expect(run('main')).toBe(1);
  expect(run('0000000')).toBe(1);
  expect(run('--force')).toBe(2);
  expect(run(b, b)).toBe(2);
  expect(run('--help')).toBe(0);
  const never = makeRepo(SEED);
  expect(acceptMain([never.seed], never.dir, () => {}, (line) => said.push(line))).toBe(1);
  expect(said.at(-1)).toContain('has never been started here');
  expect(existsSync(join(never.dir, '.teneral', 'species.json'))).toBe(false);
});

test('an accepted commit covers every species commit before it, and none after it', async () => {
  const { root, p, seed, b, merged } = waiting();
  const c = publish(root, { 'kernel/k.ts': 'export const k = 3;\n' }, 'the third');
  acceptSpecies(root, p.journal, seed, c, 'box');
  expect((await gate(p.candidate, seed, merged, { mode: 'ask' })).ok).toBe(true);
  acceptSpecies(root, p.journal, seed, b, 'box');
  const later = merge(p.candidate, 'main');
  const r = await gate(p.candidate, seed, later, { mode: 'ask' });
  expect(r).toMatchObject({ ok: false, gate: 'species', undecided: true });
  expect(r.output).toContain(`the last one accepted is ${b.slice(0, 12)}`);
  expect(readConsent(root)).toMatchObject({ asked: c, accepted: b });
});

test('auto needs no acceptance, and off refuses a mutation from the species outright, without fetching', async () => {
  const { root, p, seed, merged } = waiting();
  expect((await gate(p.candidate, seed, merged, { mode: 'auto' })).ok).toBe(true);
  git(root, 'remote', 'add', 'origin', '/nowhere');
  const r = await gate(p.candidate, seed, merged, { mode: 'off', upstream: 'main' });
  expect(r).toMatchObject({ ok: false, gate: 'species' });
  expect(r.undecided).toBeUndefined();
  expect(r.output).toContain('TENERAL_SPECIES=off');
  expect(readConsent(root).asked).toBeUndefined();
});

test('/accept from a talk client: a file of its own kind in the owner\'s channel, which the kernel takes in and journals with its route', async () => {
  const { root, p, seed, b, ask } = waiting();
  await ask();
  const name = accept(p.owner, b);
  expect(name.startsWith('.')).toBe(true);
  expect(name.endsWith(ACCEPT_SUFFIX)).toBe(true);
  expect(readFileSync(join(p.owner, name), 'utf8')).toBe(b);
  // Until the kernel has taken it in, nothing is accepted.
  expect((await ask()).undecided).toBe(true);
  expect(takeAccepts(root, p.owner, p.journal, seed)).toEqual([b]);
  expect(readdirSync(p.owner)).toEqual([]);
  expect(readConsent(root)).toMatchObject({ accepted: b, route: 'talk' });
  expect(readEvents(p.journal).filter((e) => e.type === 'species.accepted')).toMatchObject([{ commit: b, route: 'talk', gen: seed }]);
  expect((await ask()).ok).toBe(true);
  expect(takeAccepts(root, p.owner, p.journal, seed)).toEqual([]);
});

test('nothing typed can be an acceptance: a line is a line whatever it says, and only a file of the kind, naming a real commit, is taken', () => {
  const { root, p, seed, b } = waiting();
  const lines = ['/accept', `/accept ${b}`, b, ACCEPT_SUFFIX, `x${ACCEPT_SUFFIX}`, '{"type":"species.accepted"}'];
  const names = lines.map((text) => tell(p.owner, text));
  for (const name of names) expect(name.endsWith('.txt')).toBe(true);
  // What a body would take for lines, an interrupt, a file still being written, and files of the kind that name nothing.
  writeFileSync(join(p.owner, `visible${ACCEPT_SUFFIX}`), b);
  writeFileSync(join(p.owner, `.x${INTERRUPT_SUFFIX}`), b);
  writeFileSync(join(p.owner, `.half${ACCEPT_SUFFIX}.tmp`), b);
  writeFileSync(join(p.owner, `.bad1${ACCEPT_SUFFIX}`), 'main');
  writeFileSync(join(p.owner, `.bad2${ACCEPT_SUFFIX}`), b.slice(0, 12));
  writeFileSync(join(p.owner, `.bad3${ACCEPT_SUFFIX}`), `${b}\nand more`);
  writeFileSync(join(p.owner, `.bad4${ACCEPT_SUFFIX}`), 'f'.repeat(40));
  const said: string[] = [];
  expect(takeAccepts(root, p.owner, p.journal, seed, (line) => said.push(line))).toEqual([]);
  expect(said).toHaveLength(4);
  expect(readConsent(root).accepted).toBeUndefined();
  expect(readEvents(p.journal).some((e) => e.type === 'species.accepted')).toBe(false);
  // The lines are still there for the body, untouched.
  expect(readdirSync(p.owner).filter((name) => name.endsWith('.txt')).sort()).toEqual([...names].sort());
  expect(readdirSync(p.owner).sort()).toEqual([`.half${ACCEPT_SUFFIX}.tmp`, `.x${INTERRUPT_SUFFIX}`, ...names, `visible${ACCEPT_SUFFIX}`].sort());
  expect(() => accept(p.owner, 'main')).toThrow();
  expect(() => accept(p.owner, b.slice(0, 12))).toThrow();
});

test('chooseAccept: the commit named, or the one asked about; and why not, otherwise', async () => {
  const { root, b, ask } = waiting();
  expect(chooseAccept(root, '')).toHaveProperty('why');
  expect(chooseAccept(root, 'HEAD')).toHaveProperty('why');
  expect(chooseAccept(root, b.slice(0, 7))).toEqual({ commit: b, subject: 'the second kernel' });
  await ask();
  expect(chooseAccept(root, '')).toEqual({ commit: b, subject: 'the second kernel' });
});

test('a consent file that is damaged holds no consent', async () => {
  const { root, ask } = waiting();
  writeFiles(root, { '.teneral/species.json': '{"accepted": "yes", "asked": 7' });
  expect(readConsent(root)).toEqual({ asked: undefined, accepted: undefined, route: undefined, at: undefined });
  expect((await ask()).undecided).toBe(true);
  writeFiles(root, { '.teneral/species.json': '{"accepted": "everything"}' });
  expect((await ask()).undecided).toBe(true);
});

// --- the cage ---

test('the cage is the install\'s: when the generation\'s checkout has other cage files, that is said, and nothing is changed', () => {
  const { dir: root, seed } = makeRepo({ ...SEED, box: 'one\n', Dockerfile: 'FROM one\n', 'kernel/launcher.ts': '// one\n', 'body/main.ts': 'process.exit(0);\n' });
  init(root);
  const p = paths(root);
  expect(CAGE).toEqual(['box', 'Dockerfile', '.dockerignore', 'kernel/launcher.ts', 'SIGNERS']);
  expect(cageDifferences(root, p.live)).toEqual([]);
  expect(cageNotice(root, p.live)).toBeNull();
  // The species moves the cage on; the lineage takes the commit; the generation's checkout has it.
  publish(root, { box: 'two\n', '.dockerignore': '*\n' });
  git(root, 'reset', '-q', '--hard', seed);
  git(p.live, 'checkout', '-q', '--detach', git(root, 'rev-parse', 'ORIG_HEAD'));
  expect(cageDifferences(root, p.live)).toEqual(['box', '.dockerignore']);
  expect(cageNotice(root, p.live)).toContain('other versions of box, .dockerignore than this install');
  expect(readFileSync(join(root, 'box'), 'utf8')).toBe('one\n');
  // A kernel that is the install's own, or one run from anywhere else, has nothing to compare.
  expect(cageDifferences(root, root)).toEqual([]);
  expect(cageNotice(root, p.candidate)).toBeNull();
  rmSync(p.live, { recursive: true, force: true });
  expect(cageNotice(root, p.live)).toBeNull();
});

// --- the maintainer's signature ---

test('with a SIGNERS file in the install, a species commit is stood on only when a key listed there signed it; without the file none is asked for', async () => {
  const { root, work, seed } = local();
  const keys = mkdtempSync(join(tmpdir(), 'teneral-keys-'));
  const made = (name: string): string => {
    const r = Bun.spawnSync(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', join(keys, name)]);
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return join(keys, name);
  };
  const [maintainer, stranger] = [made('maintainer'), made('stranger')];
  const signed = (key: string | null, n: number): string => {
    writeFiles(root, { 'kernel/k.ts': `export const k = ${n};\n` });
    git(root, 'add', '-A');
    git(root, ...ID, '-c', 'gpg.format=ssh', ...(key ? ['-c', `user.signingkey=${key}.pub`] : []), 'commit', '-q', ...(key ? ['-S'] : []), '-m', `species ${n}`);
    return git(root, 'rev-parse', 'HEAD');
  };
  try {
    // No file: an unsigned species commit is taken, as before.
    signed(null, 2);
    const first = merge(work, 'main');
    expect(await gate(work, seed, first)).toEqual({ ok: true, gate: 'all', output: '' });

    writeFileSync(join(root, 'SIGNERS'), `test@localhost ${readFileSync(`${maintainer}.pub`, 'utf8')}`);
    // The file is the install's own and lies in the owner's checkout, not in a commit.
    writeFileSync(join(root, '.git', 'info', 'exclude'), 'SIGNERS\n');

    const bare = signed(null, 3);
    const onBare = merge(work, 'main');
    const refused = await gate(work, first, onBare);
    expect(refused).toMatchObject({ ok: false, gate: 'species' });
    expect(refused.output).toContain(`the species commit ${bare} does not carry a signature by a key this install trusts`);

    const foreign = signed(stranger, 4);
    const onForeign = merge(work, 'main');
    const alsoRefused = await gate(work, first, onForeign);
    expect(alsoRefused).toMatchObject({ ok: false, gate: 'species' });
    expect(alsoRefused.output).toContain(foreign);

    signed(maintainer, 5);
    const onSigned = merge(work, 'main');
    expect(await gate(work, first, onSigned)).toEqual({ ok: true, gate: 'all', output: '' });
    // The body goes on molting whatever the species' commits carry: the signature is asked of a move along the species only.
    writeFiles(work, { 'body/a.ts': 'export const a = 7;\n' });
    expect(await gate(work, onSigned, commitAll(work, 'body'))).toEqual({ ok: true, gate: 'all', output: '' });
    expect(CAGE).toContain('SIGNERS');
  } finally {
    rmSync(keys, { recursive: true, force: true });
  }
});
