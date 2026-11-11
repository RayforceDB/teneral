import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { BODY_SIZE_LIMIT, DEFAULT_CHECKS, git, runGates, sh } from '../../kernel/gates';
import { commitAll, makeRepo, writeFiles } from './helpers';

const NO_CHECKS: never[] = [];

test('a change inside body/ passes', () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'export const a = 1;\n' });
  writeFiles(dir, { 'body/a.ts': 'export const a = 2;\n' });
  const next = commitAll(dir, 'change');
  expect(runGates(dir, seed, next, NO_CHECKS)).toEqual({ ok: true, gate: 'all', output: '' });
});

test('a change to a protected path is rejected and named', () => {
  const { dir, seed } = makeRepo({ 'kernel/k.ts': 'export const k = 1;\n' });
  writeFiles(dir, { 'kernel/k.ts': 'export const k = 2;\n' });
  const next = commitAll(dir, 'touch kernel');
  const result = runGates(dir, seed, next, NO_CHECKS);
  expect(result.ok).toBe(false);
  expect(result.gate).toBe('protected');
  expect(result.output).toContain('kernel/k.ts');
});

test('moving a protected file away is rejected', () => {
  const { dir, seed } = makeRepo({ 'kernel/k.ts': 'export const k = 1;\n' });
  writeFiles(dir, { 'body/k.ts': 'export const k = 1;\n' });
  rmSync(join(dir, 'kernel/k.ts'));
  const next = commitAll(dir, 'move');
  expect(runGates(dir, seed, next, NO_CHECKS).gate).toBe('protected');
});

test('a name outside ASCII is matched and reported as it is, not as git quotes it', () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'export const a = 1;\n', 'kernel/k.ts': 'export const k = 1;\n' });
  writeFiles(dir, { 'body/é.ts': 'export const e = 1;\n' });
  const allowed = commitAll(dir, 'add body/é.ts');
  expect(runGates(dir, seed, allowed, NO_CHECKS)).toEqual({ ok: true, gate: 'all', output: '' });

  writeFiles(dir, { 'kernel/é.ts': 'export const e = 1;\n' });
  const forbidden = commitAll(dir, 'add kernel/é.ts');
  const result = runGates(dir, seed, forbidden, NO_CHECKS);
  expect(result.ok).toBe(false);
  expect(result.gate).toBe('protected');
  expect(result.output).toContain('kernel/é.ts');
  expect(result.output).not.toContain('\\303');
  expect(result.output).not.toContain('"');
});

test('a name that only looks changeable once whitespace is trimmed is rejected', () => {
  const spaced = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(spaced.dir, { ' body/x.ts': 'x\n' });
  expect(runGates(spaced.dir, spaced.seed, commitAll(spaced.dir, 'space'), NO_CHECKS).gate).toBe('protected');

  const tabbed = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(tabbed.dir, { '\tBACKLOG.md': 'x\n' });
  expect(runGates(tabbed.dir, tabbed.seed, commitAll(tabbed.dir, 'tab'), NO_CHECKS).gate).toBe('protected');
});

test('uncommitted work in the candidate is rejected', () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(dir, { 'body/a.ts': 'b\n' });
  const next = commitAll(dir, 'change');
  writeFiles(dir, { 'body/stray.ts': 'x\n' });
  expect(runGates(dir, seed, next, NO_CHECKS).gate).toBe('head');
});

test('a commit other than the checked-out one is rejected', () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  expect(runGates(dir, seed, '0'.repeat(40), NO_CHECKS).gate).toBe('head');
});

test('an body/ larger than the limit is rejected', () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(dir, { 'body/big.ts': 'x'.repeat(BODY_SIZE_LIMIT + 1) });
  const next = commitAll(dir, 'grow');
  expect(runGates(dir, seed, next, NO_CHECKS).gate).toBe('size');
});

test('the first failing check is reported with its output', () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(dir, { 'body/a.ts': 'b\n' });
  const next = commitAll(dir, 'change');
  const result = runGates(dir, seed, next, [
    { gate: 'types', cmd: ['bash', '-c', 'exit 0'] },
    { gate: 'tests', cmd: ['bash', '-c', 'echo boom; exit 1'] },
  ]);
  expect(result.ok).toBe(false);
  expect(result.gate).toBe('tests');
  expect(result.output).toContain('boom');
});

test('sh keeps stdout and stderr apart', () => {
  const { dir } = makeRepo({ 'body/a.ts': 'a\n' });
  const r = sh(['bash', '-c', 'echo out; echo err >&2'], dir);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe('out\n');
  expect(r.stderr).toBe('err\n');
});

test('a warning git prints on stderr is not part of what git returns', () => {
  const { dir } = makeRepo({ 'body/a.ts': 'a\n' });
  // An alias that runs a shell command stands in for a git command that succeeds with a warning.
  expect(git(dir, '-c', 'alias.warns=!echo body/a.ts; echo "warning: something" >&2', 'warns')).toBe('body/a.ts');
});

test('when git fails, its stderr is in the error', () => {
  const { dir } = makeRepo({ 'body/a.ts': 'a\n' });
  expect(() => git(dir, 'rev-parse', '--verify', 'no-such-ref')).toThrow(/git rev-parse --verify no-such-ref failed: fatal:/);
});

const OK = { ok: true, gate: 'all', output: '' };

/** Gate checkouts left behind under the repo's .teneral/, and the worktrees git knows about. */
function leftovers(dir: string): { trees: string[]; worktrees: number } {
  const home = join(dir, '.teneral');
  return {
    trees: existsSync(home) ? readdirSync(home).filter((name) => name.startsWith('gate-')) : [],
    worktrees: git(dir, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length,
  };
}

test('checks do not see an ignored file that exists only in the candidate worktree', () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'old\n' });
  writeFiles(dir, { 'body/a.ts': 'changed\n' });
  const next = commitAll(dir, 'change');
  // node_modules is ignored, so the candidate still counts as clean.
  writeFiles(dir, { 'body/node_modules/dep.js': 'x\n' });
  expect(git(dir, 'status', '--porcelain')).toBe('');
  expect(runGates(dir, seed, next, [
    { gate: 'sees-the-commit', cmd: ['bash', '-c', 'grep -q changed body/a.ts'] },
    { gate: 'sees-the-ignored-file', cmd: ['bash', '-c', 'test ! -e body/node_modules/dep.js'] },
  ])).toEqual(OK);
});

test('checks see the committed content of a file edited behind skip-worktree', () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'old\n' });
  writeFiles(dir, { 'body/a.ts': 'committed\n' });
  const next = commitAll(dir, 'change');
  git(dir, 'update-index', '--skip-worktree', 'body/a.ts');
  writeFiles(dir, { 'body/a.ts': 'edited behind git\n' });
  expect(git(dir, 'status', '--porcelain')).toBe('');
  expect(runGates(dir, seed, next, [{ gate: 'content', cmd: ['bash', '-c', 'grep -q committed body/a.ts'] }])).toEqual(OK);
});

test('the checkout the checks ran in is gone afterwards, whether they passed or failed', () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(dir, { 'body/a.ts': 'b\n' });
  const next = commitAll(dir, 'change');

  expect(runGates(dir, seed, next, [{ gate: 'fine', cmd: ['bash', '-c', 'exit 0'] }])).toEqual(OK);
  expect(leftovers(dir)).toEqual({ trees: [], worktrees: 1 });

  const failed = runGates(dir, seed, next, [{ gate: 'where', cmd: ['bash', '-c', 'pwd; exit 1'] }]);
  expect(failed.gate).toBe('where');
  expect(failed.output).toContain(join('.teneral', 'gate-'));
  expect(leftovers(dir)).toEqual({ trees: [], worktrees: 1 });
});

test('a checkout left behind by a gate run that was killed does not block the next one', () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(dir, { 'body/a.ts': 'b\n' });
  const next = commitAll(dir, 'change');
  const stale = join(dir, '.teneral', `gate-${next.slice(0, 12)}`);
  git(dir, 'worktree', 'add', '--detach', stale, seed);
  writeFiles(stale, { 'junk.txt': 'x\n' });

  expect(runGates(dir, seed, next, [{ gate: 'content', cmd: ['bash', '-c', 'grep -q b body/a.ts && test ! -e junk.txt'] }])).toEqual(OK);
  expect(leftovers(dir)).toEqual({ trees: [], worktrees: 1 });
});

test('a symlink committed under body/ is rejected and named', () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  symlinkSync('a.ts', join(dir, 'body/link.ts'));
  const next = commitAll(dir, 'link');
  const result = runGates(dir, seed, next, NO_CHECKS);
  expect(result.ok).toBe(false);
  expect(result.gate).toBe('body');
  expect(result.output).toContain('body/link.ts');
  expect(result.output).not.toContain('body/a.ts');
});

test('body size is the size of the commit, not of what lies in the worktree', () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(dir, { 'body/a.ts': 'small\n' });
  const next = commitAll(dir, 'change');
  git(dir, 'update-index', '--skip-worktree', 'body/a.ts');
  writeFiles(dir, { 'body/a.ts': 'x'.repeat(BODY_SIZE_LIMIT + 1) });
  expect(runGates(dir, seed, next, NO_CHECKS)).toEqual(OK);
});

test('a check does not inherit the environment, only what it needs to run', () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(dir, { 'body/a.ts': 'b\n' });
  const next = commitAll(dir, 'change');
  // The check fails on purpose so that its output, the environment it saw, comes back.
  const result = runGates(dir, seed, next, [{ gate: 'env', cmd: ['bash', '-c', 'env; exit 1'] }]);
  expect(result.gate).toBe('env');
  const names = result.output.split('\n').filter((line) => line.includes('=')).map((line) => line.slice(0, line.indexOf('=')));
  expect(names).toContain('PATH');
  // PWD, OLDPWD, SHLVL and _ are set by bash itself.
  const allowed = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'BUN_INSTALL', 'PWD', 'OLDPWD', 'SHLVL', '_'];
  expect(names.filter((name) => !allowed.includes(name))).toEqual([]);
});

test('a bun test check needs bun\'s own summary, not just exit 0', () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(dir, { 'body/a.ts': 'b\n' });
  const next = commitAll(dir, 'change');
  const check = (script: string) => runGates(dir, seed, next, [{ gate: 'tests-x', cmd: ['bash', '-c', script], bunSummary: true }]);

  const silent = check('exit 0');
  expect(silent.ok).toBe(false);
  expect(silent.gate).toBe('tests-x');
  expect(silent.output).toContain('summary');

  expect(check('echo " 3 pass" >&2; echo " 1 fail" >&2; echo "Ran 4 tests across 1 file. [1.00ms]" >&2').ok).toBe(false);
  expect(check('echo " 0 pass" >&2; echo " 0 fail" >&2; echo "Ran 0 tests across 0 files. [1.00ms]" >&2').ok).toBe(false);
  expect(check('echo " 3 pass" >&2; echo " 0 fail" >&2; echo "Ran 3 tests across 1 file. [1.00ms]" >&2')).toEqual(OK);
  expect(check('echo " 1 pass" >&2; echo " 0 fail" >&2; echo "Ran 1 test across 1 file. [1.00ms]" >&2')).toEqual(OK);
});

// The tests below run the real default checks (tsc and bun test) on a small project of the same shape as this one.
const PROJECT = join(import.meta.dir, '../..');
const SLOW = 120_000;

const passing = (name: string, module: string, value: number) => `import { expect, test } from 'bun:test';
import { ${name} } from '../../${module}';
test('${name}', () => { expect(${name}).toBe(${value}); });
`;

function makeProject(): { dir: string; seed: string } {
  const made = makeRepo({
    'tsconfig.json': readFileSync(join(PROJECT, 'tsconfig.json'), 'utf8'),
    'kernel/k.ts': 'export const k: number = 1;\n',
    'test/kernel/k.test.ts': passing('k', 'kernel/k', 1),
    'body/a.ts': 'export const a: number = 1;\n',
    'test/body/a.test.ts': passing('a', 'body/a', 1),
  });
  symlinkSync(join(PROJECT, 'node_modules'), join(made.dir, 'node_modules'));
  return made;
}

function candidate(files: Record<string, string>) {
  const { dir, seed } = makeProject();
  writeFiles(dir, files);
  return runGates(dir, seed, commitAll(dir, 'candidate'), DEFAULT_CHECKS);
}

test('default checks: a clean candidate passes', () => {
  expect(candidate({ 'body/a.ts': 'export const a: number = 2;\n', 'test/body/a.test.ts': passing('a', 'body/a', 2) })).toEqual(OK);
}, SLOW);

test('default checks: a type error fails at types', () => {
  const result = candidate({ 'body/a.ts': "export const a: number = 'one';\n" });
  expect(result.ok).toBe(false);
  expect(result.gate).toBe('types');
  expect(result.output).toContain('body/a.ts');
}, SLOW);

test('default checks: a failing body test fails at tests-body', () => {
  const result = candidate({ 'test/body/a.test.ts': passing('a', 'body/a', 2) });
  expect(result.ok).toBe(false);
  expect(result.gate).toBe('tests-body');
  expect(result.output).toContain('1 fail');
}, SLOW);

test('default checks: a test file that exits 0 before its failing test runs does not pass', () => {
  const result = candidate({
    'test/body/a.test.ts': `import { expect, test } from 'bun:test';
import { a } from '../../body/a';
process.exit(0);
test('a', () => { expect(a).toBe(2); });
`,
  });
  expect(result.ok).toBe(false);
  expect(result.gate).toBe('tests-body');
  expect(result.output).toContain('summary');
}, SLOW);

test('default checks: a candidate with no body tests at all does not pass', () => {
  const { dir, seed } = makeProject();
  rmSync(join(dir, 'test/body/a.test.ts'));
  const result = runGates(dir, seed, commitAll(dir, 'no tests'), DEFAULT_CHECKS);
  expect(result.ok).toBe(false);
  expect(result.gate).toBe('tests-body');
  expect(result.output).toContain('did not match any test files');
}, SLOW);
