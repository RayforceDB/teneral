import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAGE, approvalMode, approveMutation, approvedSummary, cageDifferences, cageNotice, chooseApproval, stemDiff, readApproval, someOf, takeApprovals,
} from '../../immune/approval';
import { main as approveMain } from '../../keeper/approve';
import { git, runGates, type GateOptions, type GateResult } from '../../immune/gates';
import { readEvents } from '../../brain/journal';
import { INTERRUPT_SUFFIX, MUTATION_SUFFIX, leaveApproval, tell } from '../../keeper/owner';
import { init, paths } from '../../stem/supervisor';
import { commitAll, makeRepo, writeFiles } from '../helpers';

// The owner's approval: the rule the gate keeps for everything outside the free paths, the owner's
// word, and what is said about the cage. Every repository here is made for the test.

const NO_CHECKS: never[] = [];
const ID = ['-c', 'user.name=test', '-c', 'user.email=test@localhost'];
const SEED = { 'stem/k.ts': 'export const k = 1;\n', 'stem/launch.json': '{ "launcher": 1 }\n', 'body/a.ts': 'export const a = 1;\n', 'README.md': 'one\n' };

/** An install: the owner's checkout on `main`, and the agent's workspace on the lineage branch. */
function local(files: Record<string, string> = SEED) {
  const { dir: root, seed } = makeRepo(files);
  const work = join(root, '.teneral', 'candidate');
  git(root, 'worktree', 'add', '-q', '-b', 'lineage/local', work, seed);
  return { root, work, seed };
}

/** A commit the agent makes in its workspace. */
function change(work: string, files: Record<string, string>, message = 'mine'): string {
  writeFiles(work, files);
  return commitAll(work, message);
}

const gate = (work: string, from: string, to: string, approval: GateOptions['approval'] = {}): Promise<GateResult> => (
  runGates(work, from, to, NO_CHECKS, { approval: { launcher: 1, mode: 'auto', ...approval } })
);
const PASSED = { ok: true, gate: 'all', output: '' };

test('TENERAL_APPROVAL is ask unless it says auto or off', () => {
  expect([undefined, '', 'ask', 'yes', 'AUTO', ' off '].map(approvalMode)).toEqual(['ask', 'ask', 'ask', 'ask', 'auto', 'off']);
});

// --- the rule ---

test('a change to the body alone is never asked about: whatever the owner set, and with no launcher', async () => {
  const { root, work, seed } = local();
  const next = change(work, { 'body/a.ts': 'export const a = 2;\n', 'test/body/a.test.ts': '// a\n', 'BACKLOG.md': 'more\n' });
  for (const mode of ['ask', 'auto', 'off']) expect(await gate(work, seed, next, { mode, launcher: null })).toEqual(PASSED);
  expect(readApproval(root).asked).toBeUndefined();
});

test('ask: a commit that changes the stem waits at gate approval, undecided, with the paths named and the owner\'s command; and what was asked is remembered', async () => {
  const { root, work, seed } = local();
  const next = change(work, { 'stem/k.ts': 'export const k = 2;\n', 'stem/new.ts': 'export const n = 1;\n', 'package.json': '{}\n', 'body/a.ts': 'export const a = 2;\n' });
  const r = await gate(work, seed, next, { mode: 'ask' });
  expect(r).toMatchObject({ ok: false, gate: 'approval', undecided: true });
  expect(r.output.split('\n')[0]).toBe('this commit changes 3 paths outside `body/`, `brain/`, `test/body/`, `test/brain/`, `BACKLOG.md`: package.json, stem/k.ts, stem/new.ts');
  expect(r.output).toContain(`./nest approve ${next.slice(0, 12)}`);
  expect(r.output).toContain('/approve in ./nest talk');
  expect(r.output).toContain('ask again for this same commit');
  expect(readApproval(root)).toMatchObject({ asked: next });
  expect(readApproval(root).approved).toBeUndefined();
  // Asking again changes nothing.
  expect((await gate(work, seed, next, { mode: 'ask' })).undecided).toBe(true);
});

test('an approval is for what a commit holds outside the body: a later commit that changes only the body passes on it, and one that changes the stem again waits again', async () => {
  const { root, work, seed } = local();
  const p = paths(root);
  const next = change(work, { 'stem/k.ts': 'export const k = 2;\n' });
  approveMutation(root, p.journal, seed, next, 'nest');
  expect(await gate(work, seed, next, { mode: 'ask' })).toEqual(PASSED);
  const mended = change(work, { 'body/a.ts': 'export const a = 3;\n' });
  expect(await gate(work, seed, mended, { mode: 'ask' })).toEqual(PASSED);
  // The same stem under a later generation: nothing outside the body differs, so nothing is asked.
  expect(await gate(work, next, mended, { mode: 'ask' })).toEqual(PASSED);
  const again = change(work, { 'stem/k.ts': 'export const k = 3;\n' });
  const r = await gate(work, mended, again, { mode: 'ask' });
  expect(r).toMatchObject({ ok: false, gate: 'approval', undecided: true });
  expect(r.output).toContain(`the last one approved is ${next.slice(0, 12)}`);
  expect(readApproval(root)).toMatchObject({ asked: again, approved: next });
  // Back to exactly what was approved: that word still stands.
  const back = change(work, { 'stem/k.ts': 'export const k = 2;\n' });
  expect(await gate(work, mended, back, { mode: 'ask' })).toEqual(PASSED);
});

test('a merge of the species is a change outside the body like any other: it waits for the same word', async () => {
  const { root, work, seed } = local();
  const own = change(work, { 'stem/mine.ts': 'export const mine = 1;\n' });
  approveMutation(root, paths(root).journal, seed, own, 'nest');
  expect(await gate(work, seed, own, { mode: 'ask' })).toEqual(PASSED);
  writeFiles(root, { 'stem/k.ts': 'export const k = 2;\n' });
  commitAll(root, 'the species moves');
  git(work, ...ID, 'merge', '-q', '--no-edit', 'main');
  const merged = git(work, 'rev-parse', 'HEAD');
  // The lineage keeps its own stem file beside what the species brought.
  expect(stemDiff(root, own, merged)).toEqual(['stem/k.ts']);
  expect(await gate(work, own, merged, { mode: 'ask' })).toMatchObject({ ok: false, gate: 'approval', undecided: true });
  approveMutation(root, paths(root).journal, own, merged, 'nest');
  expect(await gate(work, own, merged, { mode: 'ask' })).toEqual(PASSED);
});

test('auto needs no approval, and off refuses a change outside the body outright', async () => {
  const { root, work, seed } = local();
  const next = change(work, { 'stem/k.ts': 'export const k = 2;\n' });
  expect(await gate(work, seed, next, { mode: 'auto' })).toEqual(PASSED);
  const r = await gate(work, seed, next, { mode: 'off' });
  expect(r).toMatchObject({ ok: false, gate: 'stem' });
  expect(r.undecided).toBeUndefined();
  expect(r.output).toContain('TENERAL_APPROVAL=off');
  expect(r.output).toContain('stem/k.ts');
  expect(readApproval(root).asked).toBeUndefined();
});

test('the page, the documents and the CI alone are changed without approval and without a launcher; with a stem file beside them they are not', async () => {
  const { root, work, seed } = local();
  const inert = change(work, { 'site/index.html': '<p>one</p>\n', 'docs/guide.md': 'one\n', '.github/workflows/x.yml': 'name: x\n', 'README.md': 'two\n', LICENSE: 'MIT\n' });
  for (const mode of ['ask', 'off']) expect(await gate(work, seed, inert, { mode, launcher: null })).toEqual(PASSED);
  expect(readApproval(root).asked).toBeUndefined();
  const withStem = change(work, { 'site/index.html': '<p>two</p>\n', 'stem/k.ts': 'export const k = 2;\n' });
  const asked = await gate(work, inert, withStem, { mode: 'ask' });
  expect(asked).toMatchObject({ ok: false, gate: 'approval', undecided: true });
  expect(asked.output.split('\n')[0]).toContain('changes 1 path outside');
  expect(asked.output.split('\n')[0]).not.toContain('site/index.html');
});

test('paths git would quote, and paths that only look like the body, wait for approval', async () => {
  const { work, seed } = local();
  const next = change(work, { 'Body/x.ts': '1\n', 'bodyguard/x.ts': '1\n', 'stem/é.ts': '1\n' });
  const r = await gate(work, seed, next, { mode: 'ask' });
  expect(r.gate).toBe('approval');
  expect(r.output.split('\n')[0]).toContain('Body/x.ts, bodyguard/x.ts, stem/é.ts');
});

// --- the launcher ---

test('a stem that needs a newer launcher than the install\'s is refused, the owner is the one to act, and nothing is asked of them', async () => {
  const { root, work, seed } = local();
  const next = change(work, { 'stem/launch.json': '{ "launcher": 2 }\n' });
  const r = await gate(work, seed, next, { launcher: 1, mode: 'ask' });
  expect(r).toMatchObject({ ok: false, gate: 'stem' });
  expect(r.undecided).toBeUndefined();
  expect(r.output).toContain('needs launcher version 2, and this install\'s launcher is version 1');
  expect(r.output).toContain('your owner must update the install');
  expect(readApproval(root).asked).toBeUndefined();
  expect((await gate(work, seed, next, { launcher: 2 })).ok).toBe(true);
});

test('a launch.json that says nothing usable, and a supervisor that no launcher started, refuse a change to the stem', async () => {
  const { work, seed } = local();
  const broken = await gate(work, seed, change(work, { 'stem/launch.json': 'soon\n' }));
  expect(broken).toMatchObject({ ok: false, gate: 'stem' });
  expect(broken.output).toContain('does not say which launcher version it needs');

  const other = local();
  const next = change(other.work, { 'stem/k.ts': 'export const k = 2;\n' });
  for (const launcher of [null, undefined]) {
    const r = await runGates(other.work, other.seed, next, NO_CHECKS, { approval: { mode: 'auto', launcher } });
    expect(r).toMatchObject({ ok: false, gate: 'stem' });
    expect(r.output).toContain('was not started by the launcher');
  }
  // With no options at all: the same.
  expect((await runGates(other.work, other.seed, next, NO_CHECKS)).gate).toBe('stem');
});

test('a generation from before the launcher, with no launch.json, can change its stem: the install\'s stem runs it', async () => {
  const { work, seed } = local({ 'stem/k.ts': 'export const k = 1;\n', 'body/a.ts': 'a\n' });
  expect((await gate(work, seed, change(work, { 'stem/k.ts': 'export const k = 2;\n' }))).ok).toBe(true);
});

// --- the owner's word ---

/** A mutation that changes the stem, ready to be judged, on an install that has been started. */
function waiting() {
  const { dir: root, seed } = makeRepo({ ...SEED, 'body/main.ts': 'process.exit(0);\n' });
  init(root);
  const p = paths(root);
  const b = change(p.candidate, { 'stem/k.ts': 'export const k = 2;\n' }, 'the second stem');
  const ask = () => gate(p.candidate, seed, b, { mode: 'ask' });
  return { root, p, seed, b, ask };
}

test('./nest approve: with no commit it approves what was asked, says what that changes, writes it down, journals it with its route, and the gate lets the commit through', async () => {
  const { root, p, seed, b, ask } = waiting();
  const said: string[] = [];
  expect(approveMain([], root, (line) => said.push(line), (line) => said.push(line))).toBe(1);
  expect(said.join('\n')).toContain('nothing is waiting for your approval');
  await ask();
  said.length = 0;
  expect(approveMain([], root, (line) => said.push(line), (line) => said.push(line))).toBe(0);
  expect(said[0]).toBe(`Approved commit ${b.slice(0, 12)}, "the second stem". It changes 1 path outside the body: stem/k.ts.`);
  expect(readApproval(root)).toMatchObject({ approved: b, route: 'nest' });
  expect(readApproval(root).asked).toBeUndefined();
  const events = readEvents(p.journal).filter((e) => e.type === 'mutation.approved');
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: 'mutation.approved', commit: b, route: 'nest', gen: seed });
  // The agent is told, as a line of the owner's.
  expect(readdirSync(p.owner).filter((name) => name.endsWith('.txt')).map((name) => readFileSync(join(p.owner, name), 'utf8')))
    .toEqual([`I approved commit ${b.slice(0, 12)}. Ask to mutate again for the same commit.`]);
  expect(await ask()).toEqual(PASSED);
});

test('./nest approve <commit>: a prefix is enough, anything that is no commit is refused, and an install never started has nothing to approve for', () => {
  const { root, b } = waiting();
  const said: string[] = [];
  const run = (...args: string[]) => approveMain(args, root, (line) => said.push(line), (line) => said.push(line));
  expect(run(b.slice(0, 8))).toBe(0);
  expect(readApproval(root).approved).toBe(b);
  expect(run('main')).toBe(1);
  expect(run('0000000')).toBe(1);
  expect(run('--force')).toBe(2);
  expect(run(b, b)).toBe(2);
  expect(run('--help')).toBe(0);
  const never = makeRepo(SEED);
  expect(approveMain([never.seed], never.dir, () => {}, (line) => said.push(line))).toBe(1);
  expect(said.at(-1)).toContain('has never been started here');
  expect(existsSync(join(never.dir, '.teneral', 'approval.json'))).toBe(false);
});

test('/approve from a talk client: a file of its own kind in the owner\'s channel, which the stem takes in and journals with its route', async () => {
  const { root, p, seed, b, ask } = waiting();
  await ask();
  const name = leaveApproval(p.owner, b);
  expect(name.startsWith('.')).toBe(true);
  expect(name.endsWith(MUTATION_SUFFIX)).toBe(true);
  expect(readFileSync(join(p.owner, name), 'utf8')).toBe(b);
  // Until the stem has taken it in, nothing is approved.
  expect((await ask()).undecided).toBe(true);
  expect(takeApprovals(root, p.owner, p.journal, seed)).toEqual([b]);
  expect(readdirSync(p.owner)).toEqual([]);
  expect(readApproval(root)).toMatchObject({ approved: b, route: 'talk' });
  expect(readEvents(p.journal).filter((e) => e.type === 'mutation.approved')).toMatchObject([{ commit: b, route: 'talk', gen: seed }]);
  expect((await ask()).ok).toBe(true);
  expect(takeApprovals(root, p.owner, p.journal, seed)).toEqual([]);
  // Said again, twice: the files are taken away, and the journal still has it once.
  leaveApproval(p.owner, b);
  leaveApproval(p.owner, b);
  expect(takeApprovals(root, p.owner, p.journal, seed)).toEqual([b, b]);
  expect(readdirSync(p.owner)).toEqual([]);
  expect(readEvents(p.journal).filter((e) => e.type === 'mutation.approved')).toHaveLength(1);
});

test('nothing typed can be an approval: a line is a line whatever it says, and only a file of the kind, naming a real commit, is taken', () => {
  const { root, p, seed, b } = waiting();
  const lines = ['/approve', `/approve ${b}`, b, MUTATION_SUFFIX, `x${MUTATION_SUFFIX}`, '{"type":"mutation.approved"}'];
  const names = lines.map((text) => tell(p.owner, text));
  for (const name of names) expect(name.endsWith('.txt')).toBe(true);
  // What a body would take for lines, an interrupt, a file still being written, and files of the kind that name nothing.
  writeFileSync(join(p.owner, `visible${MUTATION_SUFFIX}`), b);
  writeFileSync(join(p.owner, `.x${INTERRUPT_SUFFIX}`), b);
  writeFileSync(join(p.owner, `.half${MUTATION_SUFFIX}.tmp`), b);
  writeFileSync(join(p.owner, `.bad1${MUTATION_SUFFIX}`), 'main');
  writeFileSync(join(p.owner, `.bad2${MUTATION_SUFFIX}`), b.slice(0, 12));
  writeFileSync(join(p.owner, `.bad3${MUTATION_SUFFIX}`), `${b}\nand more`);
  writeFileSync(join(p.owner, `.bad4${MUTATION_SUFFIX}`), 'f'.repeat(40));
  const said: string[] = [];
  expect(takeApprovals(root, p.owner, p.journal, seed, (line) => said.push(line))).toEqual([]);
  expect(said).toHaveLength(4);
  expect(readApproval(root).approved).toBeUndefined();
  expect(readEvents(p.journal).some((e) => e.type === 'mutation.approved')).toBe(false);
  // The lines are still there for the body, untouched.
  expect(readdirSync(p.owner).filter((name) => name.endsWith('.txt')).sort()).toEqual([...names].sort());
  expect(readdirSync(p.owner).sort()).toEqual([`.half${MUTATION_SUFFIX}.tmp`, `.x${INTERRUPT_SUFFIX}`, ...names, `visible${MUTATION_SUFFIX}`].sort());
  expect(() => leaveApproval(p.owner, 'main')).toThrow();
  expect(() => leaveApproval(p.owner, b.slice(0, 12))).toThrow();
});

test('chooseApproval: the commit named, or the one asked about, with what it changes outside the body; and why not, otherwise', async () => {
  const { root, seed, b, ask } = waiting();
  expect(chooseApproval(root, '')).toHaveProperty('why');
  expect(chooseApproval(root, 'HEAD')).toHaveProperty('why');
  expect(chooseApproval(root, b.slice(0, 7))).toEqual({ commit: b, subject: 'the second stem', changes: [] });
  expect(chooseApproval(root, b.slice(0, 7), seed)).toEqual({ commit: b, subject: 'the second stem', changes: ['stem/k.ts'] });
  await ask();
  expect(chooseApproval(root, '', seed)).toEqual({ commit: b, subject: 'the second stem', changes: ['stem/k.ts'] });
});

test('what the owner is told: the commit, its first line, and the paths, the first few of many', () => {
  const commit = 'a'.repeat(40);
  expect(approvedSummary({ commit, subject: '', changes: [] })).toBe('Approved commit aaaaaaaaaaaa.');
  expect(approvedSummary({ commit, subject: 'one\ttwo', changes: ['stem/a.ts', 'package.json'] }))
    .toBe('Approved commit aaaaaaaaaaaa, "one two". It changes 2 paths outside the body: stem/a.ts, package.json.');
  const many = Array.from({ length: 11 }, (_, i) => `stem/${i}.ts`);
  expect(someOf(many)).toBe(`${many.slice(0, 8).join(', ')} and 3 more`);
  expect(someOf(many.slice(0, 8))).toBe(many.slice(0, 8).join(', '));
});

test('an approval file that is damaged, or names a commit that is gone, approves nothing', async () => {
  const { root, ask } = waiting();
  writeFiles(root, { '.teneral/approval.json': '{"approved": "yes", "asked": 7' });
  expect(readApproval(root)).toEqual({ asked: undefined, approved: undefined, route: undefined, at: undefined });
  expect((await ask()).undecided).toBe(true);
  writeFiles(root, { '.teneral/approval.json': '{"approved": "everything"}' });
  expect((await ask()).undecided).toBe(true);
  writeFiles(root, { '.teneral/approval.json': `{"approved": "${'f'.repeat(40)}"}` });
  expect((await ask()).undecided).toBe(true);
});

// --- the cage ---

test('the cage is the install\'s: when the generation\'s checkout has other cage files, that is said, and nothing is changed', () => {
  const { dir: root, seed } = makeRepo({ ...SEED, nest: 'one\n', Dockerfile: 'FROM one\n', 'stem/launcher.ts': '// one\n', 'body/main.ts': 'process.exit(0);\n' });
  init(root);
  const p = paths(root);
  expect(CAGE).toEqual(['nest', 'Dockerfile', '.dockerignore', 'stem/launcher.ts']);
  expect(cageDifferences(root, p.live)).toEqual([]);
  expect(cageNotice(root, p.live)).toBeNull();
  // A commit moves the cage on; the lineage takes it; the generation's checkout has it.
  writeFiles(root, { nest: 'two\n', '.dockerignore': '*\n' });
  commitAll(root, 'another cage');
  git(root, 'reset', '-q', '--hard', seed);
  git(p.live, 'checkout', '-q', '--detach', git(root, 'rev-parse', 'ORIG_HEAD'));
  expect(cageDifferences(root, p.live)).toEqual(['nest', '.dockerignore']);
  expect(cageNotice(root, p.live)).toContain('other versions of nest, .dockerignore than this install');
  expect(readFileSync(join(root, 'nest'), 'utf8')).toBe('one\n');
  // A stem that is the install's own, or one run from anywhere else, has nothing to compare.
  expect(cageDifferences(root, root)).toEqual([]);
  expect(cageNotice(root, p.candidate)).toBeNull();
  rmSync(p.live, { recursive: true, force: true });
  expect(cageNotice(root, p.live)).toBeNull();
});
