import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BODY_SIZE_LIMIT, DEFAULT_CHECKS, git, runGates, sh, startStubProvider, type GateOptions,
} from '../../kernel/gates';
import { readResponsesStream } from '../../body/provider';
import { PROVIDERS } from '../../kernel/providers';
import { commitAll, makeRepo, writeFiles } from './helpers';

const NO_CHECKS: never[] = [];

test('a change inside body/ passes', async () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'export const a = 1;\n' });
  writeFiles(dir, { 'body/a.ts': 'export const a = 2;\n' });
  const next = commitAll(dir, 'change');
  expect(await runGates(dir, seed, next, NO_CHECKS)).toEqual({ ok: true, gate: 'all', output: '' });
});

test('a change to a protected path is rejected and named', async () => {
  const { dir, seed } = makeRepo({ 'kernel/k.ts': 'export const k = 1;\n' });
  writeFiles(dir, { 'kernel/k.ts': 'export const k = 2;\n' });
  const next = commitAll(dir, 'touch kernel');
  const result = await runGates(dir, seed, next, NO_CHECKS);
  expect(result.ok).toBe(false);
  expect(result.gate).toBe('protected');
  expect(result.output).toContain('kernel/k.ts');
});

test('moving a protected file away is rejected', async () => {
  const { dir, seed } = makeRepo({ 'kernel/k.ts': 'export const k = 1;\n' });
  writeFiles(dir, { 'body/k.ts': 'export const k = 1;\n' });
  rmSync(join(dir, 'kernel/k.ts'));
  const next = commitAll(dir, 'move');
  expect((await runGates(dir, seed, next, NO_CHECKS)).gate).toBe('protected');
});

test('a name outside ASCII is matched and reported as it is, not as git quotes it', async () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'export const a = 1;\n', 'kernel/k.ts': 'export const k = 1;\n' });
  writeFiles(dir, { 'body/é.ts': 'export const e = 1;\n' });
  const allowed = commitAll(dir, 'add body/é.ts');
  expect(await runGates(dir, seed, allowed, NO_CHECKS)).toEqual({ ok: true, gate: 'all', output: '' });

  writeFiles(dir, { 'kernel/é.ts': 'export const e = 1;\n' });
  const forbidden = commitAll(dir, 'add kernel/é.ts');
  const result = await runGates(dir, seed, forbidden, NO_CHECKS);
  expect(result.ok).toBe(false);
  expect(result.gate).toBe('protected');
  expect(result.output).toContain('kernel/é.ts');
  expect(result.output).not.toContain('\\303');
  expect(result.output).not.toContain('"');
});

test('a name that only looks changeable once whitespace is trimmed is rejected', async () => {
  const spaced = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(spaced.dir, { ' body/x.ts': 'x\n' });
  expect((await runGates(spaced.dir, spaced.seed, commitAll(spaced.dir, 'space'), NO_CHECKS)).gate).toBe('protected');

  const tabbed = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(tabbed.dir, { '\tBACKLOG.md': 'x\n' });
  expect((await runGates(tabbed.dir, tabbed.seed, commitAll(tabbed.dir, 'tab'), NO_CHECKS)).gate).toBe('protected');
});

test('uncommitted work in the candidate is rejected', async () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(dir, { 'body/a.ts': 'b\n' });
  const next = commitAll(dir, 'change');
  writeFiles(dir, { 'body/stray.ts': 'x\n' });
  expect((await runGates(dir, seed, next, NO_CHECKS)).gate).toBe('head');
});

test('a commit other than the checked-out one is rejected', async () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  expect((await runGates(dir, seed, '0'.repeat(40), NO_CHECKS)).gate).toBe('head');
});

test('an body/ larger than the limit is rejected', async () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(dir, { 'body/big.ts': 'x'.repeat(BODY_SIZE_LIMIT + 1) });
  const next = commitAll(dir, 'grow');
  expect((await runGates(dir, seed, next, NO_CHECKS)).gate).toBe('size');
});

test('the first failing check is reported with its output', async () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(dir, { 'body/a.ts': 'b\n' });
  const next = commitAll(dir, 'change');
  const result = await runGates(dir, seed, next, [
    { gate: 'types', cmd: ['bash', '-c', 'exit 0'] },
    { gate: 'tests', cmd: ['bash', '-c', 'echo boom; exit 1'] },
  ]);
  expect(result.ok).toBe(false);
  expect(result.gate).toBe('tests');
  expect(result.output).toContain('boom');
});

test('sh keeps stdout and stderr apart', async () => {
  const { dir } = makeRepo({ 'body/a.ts': 'a\n' });
  const r = sh(['bash', '-c', 'echo out; echo err >&2'], dir);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe('out\n');
  expect(r.stderr).toBe('err\n');
});

test('a warning git prints on stderr is not part of what git returns', async () => {
  const { dir } = makeRepo({ 'body/a.ts': 'a\n' });
  // An alias that runs a shell command stands in for a git command that succeeds with a warning.
  expect(git(dir, '-c', 'alias.warns=!echo body/a.ts; echo "warning: something" >&2', 'warns')).toBe('body/a.ts');
});

test('when git fails, its stderr is in the error', async () => {
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

test('checks do not see an ignored file that exists only in the candidate worktree', async () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'old\n' });
  writeFiles(dir, { 'body/a.ts': 'changed\n' });
  const next = commitAll(dir, 'change');
  // node_modules is ignored, so the candidate still counts as clean.
  writeFiles(dir, { 'body/node_modules/dep.js': 'x\n' });
  expect(git(dir, 'status', '--porcelain')).toBe('');
  expect(await runGates(dir, seed, next, [
    { gate: 'sees-the-commit', cmd: ['bash', '-c', 'grep -q changed body/a.ts'] },
    { gate: 'sees-the-ignored-file', cmd: ['bash', '-c', 'test ! -e body/node_modules/dep.js'] },
  ])).toEqual(OK);
});

test('checks see the committed content of a file edited behind skip-worktree', async () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'old\n' });
  writeFiles(dir, { 'body/a.ts': 'committed\n' });
  const next = commitAll(dir, 'change');
  git(dir, 'update-index', '--skip-worktree', 'body/a.ts');
  writeFiles(dir, { 'body/a.ts': 'edited behind git\n' });
  expect(git(dir, 'status', '--porcelain')).toBe('');
  expect(await runGates(dir, seed, next, [{ gate: 'content', cmd: ['bash', '-c', 'grep -q committed body/a.ts'] }])).toEqual(OK);
});

test('the checkout the checks ran in is gone afterwards, whether they passed or failed', async () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(dir, { 'body/a.ts': 'b\n' });
  const next = commitAll(dir, 'change');

  expect(await runGates(dir, seed, next, [{ gate: 'fine', cmd: ['bash', '-c', 'exit 0'] }])).toEqual(OK);
  expect(leftovers(dir)).toEqual({ trees: [], worktrees: 1 });

  const failed = await runGates(dir, seed, next, [{ gate: 'where', cmd: ['bash', '-c', 'pwd; exit 1'] }]);
  expect(failed.gate).toBe('where');
  expect(failed.output).toContain(join('.teneral', 'gate-'));
  expect(leftovers(dir)).toEqual({ trees: [], worktrees: 1 });
});

test('a checkout left behind by a gate run that was killed does not block the next one', async () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(dir, { 'body/a.ts': 'b\n' });
  const next = commitAll(dir, 'change');
  const stale = join(dir, '.teneral', `gate-${next.slice(0, 12)}`);
  git(dir, 'worktree', 'add', '--detach', stale, seed);
  writeFiles(stale, { 'junk.txt': 'x\n' });

  expect(await runGates(dir, seed, next, [{ gate: 'content', cmd: ['bash', '-c', 'grep -q b body/a.ts && test ! -e junk.txt'] }])).toEqual(OK);
  expect(leftovers(dir)).toEqual({ trees: [], worktrees: 1 });
});

test('a symlink committed under body/ is rejected and named', async () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  symlinkSync('a.ts', join(dir, 'body/link.ts'));
  const next = commitAll(dir, 'link');
  const result = await runGates(dir, seed, next, NO_CHECKS);
  expect(result.ok).toBe(false);
  expect(result.gate).toBe('body');
  expect(result.output).toContain('body/link.ts');
  expect(result.output).not.toContain('body/a.ts');
});

test('body size is the size of the commit, not of what lies in the worktree', async () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(dir, { 'body/a.ts': 'small\n' });
  const next = commitAll(dir, 'change');
  git(dir, 'update-index', '--skip-worktree', 'body/a.ts');
  writeFiles(dir, { 'body/a.ts': 'x'.repeat(BODY_SIZE_LIMIT + 1) });
  expect(await runGates(dir, seed, next, NO_CHECKS)).toEqual(OK);
});

test('a check does not inherit the environment, only what it needs to run', async () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(dir, { 'body/a.ts': 'b\n' });
  const next = commitAll(dir, 'change');
  // The check fails on purpose so that its output, the environment it saw, comes back.
  const result = await runGates(dir, seed, next, [{ gate: 'env', cmd: ['bash', '-c', 'env; exit 1'] }]);
  expect(result.gate).toBe('env');
  const names = result.output.split('\n').filter((line) => line.includes('=')).map((line) => line.slice(0, line.indexOf('=')));
  expect(names).toContain('PATH');
  // PWD, OLDPWD, SHLVL and _ are set by bash itself.
  // TMP, TEMP and GIT_CEILING_DIRECTORIES come with the private temp directory.
  const allowed = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'GIT_CEILING_DIRECTORIES', 'LANG', 'BUN_INSTALL', 'PWD', 'OLDPWD', 'SHLVL', '_'];
  expect(names.filter((name) => !allowed.includes(name))).toEqual([]);
});

test('a bun test check needs bun\'s own summary, not just exit 0', async () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(dir, { 'body/a.ts': 'b\n' });
  const next = commitAll(dir, 'change');
  const check = (script: string) => runGates(dir, seed, next, [{ gate: 'tests-x', cmd: ['bash', '-c', script], bunSummary: true }]);

  const silent = await check('exit 0');
  expect(silent.ok).toBe(false);
  expect(silent.gate).toBe('tests-x');
  expect(silent.output).toContain('summary');

  expect((await check('echo " 3 pass" >&2; echo " 1 fail" >&2; echo "Ran 4 tests across 1 file. [1.00ms]" >&2')).ok).toBe(false);
  expect((await check('echo " 0 pass" >&2; echo " 0 fail" >&2; echo "Ran 0 tests across 0 files. [1.00ms]" >&2')).ok).toBe(false);
  expect(await check('echo " 3 pass" >&2; echo " 0 fail" >&2; echo "Ran 3 tests across 1 file. [1.00ms]" >&2')).toEqual(OK);
  expect(await check('echo " 1 pass" >&2; echo " 0 fail" >&2; echo "Ran 1 test across 1 file. [1.00ms]" >&2')).toEqual(OK);

  // The shape bun really prints, with the optional lines.
  expect(await check('printf "\nnoise\n\n 2 pass\n 1 skip\n 1 todo\n 0 fail\nsnapshots: +1 added\n 3 expect() calls\nRan 4 tests across 2 files. [11.00ms]\n" >&2')).toEqual(OK);
  // Every test skipped: tests were found, none ran.
  expect((await check('printf " 0 pass\n 2 skip\n 0 fail\nRan 2 tests across 1 file. [1.00ms]\n" >&2')).ok).toBe(false);
});

test('a summary counts only on stderr and only as the last thing there', async () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(dir, { 'body/a.ts': 'b\n' });
  const next = commitAll(dir, 'change');
  const check = (script: string) => runGates(dir, seed, next, [{ gate: 'tests-x', cmd: ['bash', '-c', script], bunSummary: true }]);
  const summary = 'printf " 3 pass\n 0 fail\nRan 3 tests across 1 file. [1.00ms]\n"';

  expect(await check(`${summary} >&2`)).toEqual(OK);
  // bun prints its summary on stderr; the same words on stdout are something a test printed.
  const onStdout = await check(summary);
  expect(onStdout.ok).toBe(false);
  expect(onStdout.output).toContain('summary');
  // Something after the summary means the run did not end with it.
  expect((await check(`${summary} >&2; echo "and then something else" >&2`)).ok).toBe(false);
  // A failure count from an earlier paragraph does not stand in for the final one.
  expect((await check('printf " 3 pass\n 0 fail\n\nRan 3 tests across 1 file. [1.00ms]\n" >&2')).ok).toBe(false);
});

// The tests below run the real default checks (tsc and bun test) on a small project of the same shape as this one.
const PROJECT = join(import.meta.dir, '../..');
const SLOW = 120_000;

const passing = (name: string, module: string, value: number) => `import { expect, test } from 'bun:test';
import { ${name} } from '../../${module}';
test('${name}', () => { expect(${name}).toBe(${value}); });
`;

/** The smallest body that keeps the kernel's contract: says it is ready, answers what is waiting through the endpoint it was given, stays up. */
const MINI_BODY = `import { appendFileSync, readFileSync } from 'node:fs';
const gen = process.env.TENERAL_GEN!;
const journal = process.env.TENERAL_JOURNAL!;
const write = (body: Record<string, unknown>): void => {
  appendFileSync(journal, JSON.stringify({ ...body, v: 1, id: crypto.randomUUID(), ts: new Date().toISOString(), gen }) + '\\n');
};
write({ type: 'generation.ready', commit: gen });
if (readFileSync(journal, 'utf8').includes('"stimulus"')) {
  const res = await fetch(process.env.TENERAL_BASE_URL + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.TENERAL_API_KEY },
    body: JSON.stringify({ model: process.env.TENERAL_MODEL, messages: [{ role: 'user', content: 'hello' }] }),
  });
  const data = await res.json() as { choices: { message: { content: string } }[] };
  write({ type: 'assistant', text: data.choices[0]!.message.content, toolCalls: [] });
}
setInterval(() => {}, 1000);
`;

function makeProject(): { dir: string; seed: string } {
  const made = makeRepo({
    'tsconfig.json': readFileSync(join(PROJECT, 'tsconfig.json'), 'utf8'),
    'kernel/k.ts': 'export const k: number = 1;\n',
    'test/kernel/k.test.ts': passing('k', 'kernel/k', 1),
    'body/a.ts': 'export const a: number = 1;\n',
    'body/main.ts': MINI_BODY,
    'test/body/a.test.ts': passing('a', 'body/a', 1),
  });
  symlinkSync(join(PROJECT, 'node_modules'), join(made.dir, 'node_modules'));
  return made;
}

function candidate(files: Record<string, string>, opts: GateOptions = {}) {
  const { dir, seed } = makeProject();
  writeFiles(dir, files);
  return runGates(dir, seed, commitAll(dir, 'candidate'), DEFAULT_CHECKS, opts);
}

test('default checks: a clean candidate passes', async () => {
  expect(await candidate({ 'body/a.ts': 'export const a: number = 2;\n', 'test/body/a.test.ts': passing('a', 'body/a', 2) })).toEqual(OK);
}, SLOW);

test('default checks: a type error fails at types', async () => {
  const result = await candidate({ 'body/a.ts': "export const a: number = 'one';\n" });
  expect(result.ok).toBe(false);
  expect(result.gate).toBe('types');
  expect(result.output).toContain('body/a.ts');
}, SLOW);

test('default checks: a failing body test fails at tests-body', async () => {
  const result = await candidate({ 'test/body/a.test.ts': passing('a', 'body/a', 2) });
  expect(result.ok).toBe(false);
  expect(result.gate).toBe('tests-body');
  expect(result.output).toContain('1 fail');
}, SLOW);

test('default checks: a test file that exits 0 before its failing test runs does not pass', async () => {
  const result = await candidate({
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

test('default checks: a candidate with no body tests at all does not pass', async () => {
  const { dir, seed } = makeProject();
  rmSync(join(dir, 'test/body/a.test.ts'));
  const result = await runGates(dir, seed, commitAll(dir, 'no tests'), DEFAULT_CHECKS);
  expect(result.ok).toBe(false);
  expect(result.gate).toBe('tests-body');
  expect(result.output).toContain('did not match any test files');
}, SLOW);

test('default checks: a test file that prints a made-up summary and exits 0 does not pass', async () => {
  const result = await candidate({
    'test/body/a.test.ts': `import { expect, test } from 'bun:test';
import { a } from '../../body/a';
console.log(' 5 pass\\n 0 fail\\n 5 expect() calls\\nRan 5 tests across 1 file. [1.00ms]');
process.exit(0);
test('a', () => { expect(a).toBe(2); });
`,
  });
  expect(result.ok).toBe(false);
  expect(result.gate).toBe('tests-body');
  expect(result.output).toContain('summary');
}, SLOW);

test('default checks: a candidate that type-checks and passes its tests but never becomes ready fails last, at smoke', async () => {
  const result = await candidate({ 'body/main.ts': 'for (;;) { /* alive and useless */ }\n' }, { smokeTimeoutMs: 1500, killGraceMs: 200 });
  expect(result.ok).toBe(false);
  expect(result.gate).toBe('smoke');
}, SLOW);

// --- checks can be interrupted, and keep their temp files to themselves ---

const gone = async (pid: number): Promise<boolean> => {
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch { return true; }
    await Bun.sleep(20);
  }
  return false;
};

test('an interrupted gate run stops at once, kills its check and the check\'s children, and leaves no checkout', async () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(dir, { 'body/a.ts': 'b\n' });
  const next = commitAll(dir, 'change');
  const pidFile = join(dir, '.teneral', 'child-of-the-check.pid');
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 400);
  const t = Date.now();
  const result = await runGates(dir, seed, next, [
    { gate: 'slow', cmd: ['bash', '-c', `sleep 300 & echo $! > ${JSON.stringify(pidFile)}; wait`] },
    { gate: 'never', cmd: ['bash', '-c', 'exit 0'] },
  ], { signal: stop.signal, killGraceMs: 200 });
  expect(Date.now() - t).toBeLessThan(2000);
  expect(result.ok).toBe(false);
  expect(result.gate).toBe('interrupted');
  expect(await gone(Number(readFileSync(pidFile, 'utf8')))).toBe(true);
  expect(leftovers(dir)).toEqual({ trees: [], worktrees: 1 });
});

test('a check that ignores SIGTERM is killed after the grace period', async () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(dir, { 'body/a.ts': 'b\n' });
  const next = commitAll(dir, 'change');
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 300);
  const t = Date.now();
  const result = await runGates(dir, seed, next, [
    { gate: 'deaf', cmd: ['bash', '-c', 'trap "" TERM; while true; do sleep 0.1; done'] },
  ], { signal: stop.signal, killGraceMs: 200 });
  expect(result.gate).toBe('interrupted');
  expect(Date.now() - t).toBeLessThan(3000);
});

test('what a check writes to its temp directory stays inside the gate checkout and goes with it', async () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(dir, { 'body/a.ts': 'b\n' });
  const next = commitAll(dir, 'change');
  const marker = `teneral-leak-${randomUUID()}`;
  // Fails on purpose, so the path it made comes back in the output.
  const result = await runGates(dir, seed, next, [{
    gate: 'tmp',
    cmd: ['bash', '-c', `test "$TMP" = "$TMPDIR" && test "$TEMP" = "$TMPDIR" && mktemp -t ${marker}.XXXXXX && mktemp -d -t ${marker}.XXXXXX; exit 1`],
  }]);
  expect(result.gate).toBe('tmp');
  const made = result.output.trim().split('\n');
  expect(made).toHaveLength(2);
  for (const path of made) {
    expect(path).toContain(join('.teneral', 'gate-'));
    expect(path).toContain(marker);
    expect(existsSync(path)).toBe(false);
  }
  expect(readdirSync(tmpdir()).filter((name) => name.includes(marker))).toEqual([]);
});

test('git run from a check\'s temp directory does not find the repository around it', async () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(dir, { 'body/a.ts': 'b\n' });
  const next = commitAll(dir, 'change');
  expect(await runGates(dir, seed, next, [
    { gate: 'in-the-tree', cmd: ['bash', '-c', 'git rev-parse --show-toplevel'] },
    { gate: 'in-its-tmp', cmd: ['bash', '-c', 'cd "$(mktemp -d)" && ! git rev-parse --show-toplevel 2>/dev/null'] },
  ])).toEqual(OK);
});

// --- the smoke gate ---

/** Runs only the smoke gate on a candidate whose body/main.ts is `main`. */
async function smoke(main: string, opts: GateOptions = {}) {
  const { dir, seed } = makeRepo({ 'body/main.ts': MINI_BODY });
  writeFiles(dir, { 'body/main.ts': main });
  const next = commitAll(dir, 'candidate');
  const t = Date.now();
  const result = await runGates(dir, seed, next, [], { smoke: true, smokeTimeoutMs: 20_000, killGraceMs: 200, ...opts });
  return { result, dir, ms: Date.now() - t };
}

/** A line for a test body that leaves its pid where the test can read it. */
function pidNote(): { file: string; line: string } {
  const file = join(tmpdir(), `teneral-smoke-pid-${randomUUID()}`);
  return { file, line: `require('node:fs').writeFileSync(${JSON.stringify(file)}, String(process.pid));\n` };
}

test('smoke: a body that becomes ready and answers what is waiting passes, and is stopped afterwards', async () => {
  const note = pidNote();
  const r = await smoke(note.line + MINI_BODY);
  expect(r.result).toEqual(OK);
  expect(await gone(Number(readFileSync(note.file, 'utf8')))).toBe(true);
  expect(leftovers(r.dir)).toEqual({ trees: [], worktrees: 1 });
  rmSync(note.file);
}, SLOW);

test('smoke: a body that spins before it is ready is rejected for not becoming ready', async () => {
  const r = await smoke('for (;;) { /* alive and useless */ }\n', { smokeTimeoutMs: 1500 });
  expect(r.result.ok).toBe(false);
  expect(r.result.gate).toBe('smoke');
  expect(r.result.output).toContain('did not journal generation.ready');
  expect(leftovers(r.dir)).toEqual({ trees: [], worktrees: 1 });
}, SLOW);

test('smoke: a body that becomes ready and then never replies is rejected for not replying', async () => {
  const ready = MINI_BODY.slice(0, MINI_BODY.indexOf('if (readFileSync'));
  for (const rest of ['for (;;) { /* spins */ }\n', 'await new Promise(() => {});\n']) {
    const r = await smoke(ready + rest, { smokeTimeoutMs: 1500 });
    expect(r.result.ok).toBe(false);
    expect(r.result.gate).toBe('smoke');
    expect(r.result.output).toContain('became ready but did not reply');
    expect(r.result.output).not.toContain('did not journal generation.ready');
  }
}, SLOW);

test('smoke: a body that dies says so at once, with the end of its stderr', async () => {
  const r = await smoke("console.error('SMOKE-STDERR-MARK');\nprocess.exit(3);\n");
  expect(r.result.ok).toBe(false);
  expect(r.result.gate).toBe('smoke');
  expect(r.result.output).toContain('exited with 3');
  expect(r.result.output).toContain('did not journal generation.ready');
  expect(r.result.output).toContain('SMOKE-STDERR-MARK');
  // It did not wait out the 20 s it was given.
  expect(r.ms).toBeLessThan(10_000);
}, SLOW);

test('smoke: a healthy body that ignores SIGTERM still passes and is still killed', async () => {
  const note = pidNote();
  const r = await smoke(`${note.line}process.on('SIGTERM', () => {});\n${MINI_BODY}`);
  expect(r.result).toEqual(OK);
  expect(await gone(Number(readFileSync(note.file, 'utf8')))).toBe(true);
  rmSync(note.file);
}, SLOW);

test('smoke: the body sees a throwaway install and a stub endpoint, not the real ones, and the stub is gone afterwards', async () => {
  const r = await smoke("console.error('ENV=' + JSON.stringify(process.env));\nprocess.exit(1);\n");
  const line = r.result.output.split('\n').find((l) => l.startsWith('ENV='));
  expect(line).toBeDefined();
  const env = JSON.parse(line!.slice(4)) as Record<string, string>;
  const passed = ['PATH', 'HOME', 'LANG', 'BUN_INSTALL', 'TMPDIR', 'TMP', 'TEMP', 'GIT_CEILING_DIRECTORIES'];
  const set = [
    'TENERAL_GEN', 'TENERAL_JOURNAL', 'TENERAL_WORKSPACE', 'TENERAL_ID', 'TENERAL_INBOX', 'TENERAL_PEERS', 'TENERAL_SOUL',
    'TENERAL_OWNER', 'TENERAL_BASE_URL', 'TENERAL_API_KEY', 'TENERAL_MODEL', 'TENERAL_HEARTBEAT_MINUTES',
  ];
  expect(Object.keys(env).filter((name) => !passed.includes(name) && !set.includes(name))).toEqual([]);
  expect(Object.keys(env)).toEqual(expect.arrayContaining(set));
  expect(env.TENERAL_HEARTBEAT_MINUTES).toBe('0');
  expect(env.TENERAL_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  expect(env.TENERAL_API_KEY).toBe('smoke');
  // Everything the body is pointed at lies inside the gate checkout, which no longer exists.
  for (const name of ['TENERAL_JOURNAL', 'TENERAL_WORKSPACE', 'TENERAL_INBOX', 'TENERAL_PEERS', 'TENERAL_SOUL', 'TENERAL_OWNER']) {
    expect(env[name]).toContain(join('.teneral', 'gate-'));
    expect(existsSync(env[name]!)).toBe(false);
  }
  await expect(fetch(`${env.TENERAL_BASE_URL}/chat/completions`, { method: 'POST', body: '{}' })).rejects.toThrow();
}, SLOW);

test('smoke: an interrupted smoke run stops the body and reports the interruption', async () => {
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 500);
  const r = await smoke('for (;;) { /* spins */ }\n', { signal: stop.signal });
  expect(r.result.gate).toBe('interrupted');
  expect(r.ms).toBeLessThan(3000);
  expect(leftovers(r.dir)).toEqual({ trees: [], worktrees: 1 });
}, SLOW);

test('the stub endpoint answers a chat-completions request, plain or streamed, and nothing once stopped', async () => {
  const stub = startStubProvider();
  try {
    const ask = (body: unknown) => fetch(`${stub.url}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const plain = await (await ask({ model: 'm', messages: [] })).json() as { choices: { message: { role: string; content: string; tool_calls?: unknown } }[] };
    expect(plain.choices[0]!.message.role).toBe('assistant');
    expect(plain.choices[0]!.message.content.length).toBeGreaterThan(0);
    expect(plain.choices[0]!.message.tool_calls).toBeUndefined();

    const streamed = await ask({ model: 'm', messages: [], stream: true });
    expect(streamed.headers.get('content-type')).toContain('text/event-stream');
    const text = await streamed.text();
    expect(text).toContain('"delta"');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  } finally {
    stub.stop();
  }
  await expect(fetch(`${stub.url}/chat/completions`, { method: 'POST', body: '{}' })).rejects.toThrow();
});

// --- the smoke gate and the Responses protocol ---

test('the stub endpoint answers a Responses request as an event stream that ends completed', async () => {
  const stub = startStubProvider();
  try {
    const res = await fetch(`${stub.url}/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'smoke', input: [{ role: 'user', content: 'hello' }], store: false, stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    const events = text.trim().split('\n\n').map((block) => {
      const [event, data] = block.split('\n');
      expect(event).toStartWith('event: ');
      expect(data).toStartWith('data: ');
      const parsed = JSON.parse(data!.slice(6)) as { type: string; response?: { status: string; output: { type: string; content: { type: string; text: string }[] }[] } };
      // Each event is named twice, on its `event:` line and in its data, and the two agree.
      expect(parsed.type).toBe(event!.slice(7));
      return parsed;
    });
    expect(events[0]!.type).toBe('response.created');
    expect(events.map((e) => e.type)).toContain('response.output_item.done');
    const last = events.at(-1)!;
    expect(last.type).toBe('response.completed');
    expect(last.response!.status).toBe('completed');
    expect(last.response!.output[0]!.content[0]!.type).toBe('output_text');
    expect(last.response!.output[0]!.content[0]!.text.length).toBeGreaterThan(0);
    // And the body's own reader takes it: text, and no tool calls, so a turn ends with it.
    const reply = readResponsesStream(text);
    expect(reply.text.length).toBeGreaterThan(0);
    expect(reply.toolCalls).toEqual([]);
  } finally {
    stub.stop();
  }
});

test('smoke: run for a sign-in provider, the body is told the provider, handed a dummy token, and not told where sign-ins are kept', async () => {
  const r = await smoke("console.error('ENV=' + JSON.stringify(process.env));\nprocess.exit(1);\n", { provider: 'chatgpt' });
  const env = JSON.parse(r.result.output.split('\n').find((l) => l.startsWith('ENV='))!.slice(4)) as Record<string, string>;
  expect(env.TENERAL_PROVIDER).toBe('chatgpt');
  expect(env.TENERAL_API_KEY).toBe('smoke');
  expect(env.TENERAL_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  expect('TENERAL_AUTH' in env).toBe(false);
  expect(JSON.stringify(env)).not.toContain(join('.teneral', 'auth'));
}, SLOW);

/** A repository holding this project's own kernel and body, as a candidate's checkout would. */
function ownRepo(): { dir: string; seed: string } {
  const here = join(import.meta.dir, '..', '..');
  const { dir } = makeRepo({});
  for (const name of ['body', 'kernel', 'BIRTH.md', 'package.json']) cpSync(join(here, name), join(dir, name), { recursive: true });
  return { dir, seed: commitAll(dir, 'own') };
}

/** Smokes this project's body, with `change` applied to it, as the provider `provider`. */
async function smokeOwn(provider: string | undefined, change?: (dir: string) => void) {
  const { dir, seed } = ownRepo();
  let next = seed;
  if (change) {
    change(dir);
    next = commitAll(dir, 'candidate');
  }
  return runGates(dir, seed, next, [], { smoke: true, smokeTimeoutMs: change ? 4000 : 20_000, killGraceMs: 200, provider });
}

test('smoke: this project\'s own body passes under every provider in the table, and with none set', async () => {
  for (const provider of [undefined, ...PROVIDERS.map((p) => p.id)]) {
    expect({ provider, result: await smokeOwn(provider) }).toEqual({ provider, result: OK });
  }
}, 4 * SLOW);

test('smoke: a body whose Responses path is broken is rejected when the configuration uses that protocol, where it would pass as chat', async () => {
  const breakResponses = (dir: string) => {
    const file = join(dir, 'body', 'provider.ts');
    const code = readFileSync(file, 'utf8');
    expect(code).toContain('}/responses`');
    writeFileSync(file, code.replace('}/responses`', '}/responsesX`'));
  };
  const broken = await smokeOwn('chatgpt', breakResponses);
  expect(broken.ok).toBe(false);
  expect(broken.gate).toBe('smoke');
  expect(broken.output).toMatch(/became ready but did not reply/);
  expect(await smokeOwn(undefined, breakResponses)).toEqual(OK);
}, 4 * SLOW);

test('smoke: for a sign-in provider the real sign-in is neither read nor renewed, even when one is there to find', async () => {
  // A sign-in where the supervisor would keep it, pointing at a server that counts what reaches it.
  let hits = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => { hits += 1; return new Response('no', { status: 500 }); } });
  const { dir, seed } = ownRepo();
  const auth = join(dir, '.teneral', 'auth');
  const file = join(auth, 'chatgpt.json');
  const address = `http://127.0.0.1:${server.port}`;
  writeFiles(dir, { '.teneral/auth/chatgpt.json': JSON.stringify({
    issuer: address, client_id: 'oaiapp_real', access_token: 'at-real', refresh_token: 'rt-real', expires_at: 0, api_base: `${address}/v1`,
  }) });
  const before = readFileSync(file, 'utf8');
  try {
    expect(await runGates(dir, seed, seed, [], { smoke: true, smokeTimeoutMs: 20_000, killGraceMs: 200, provider: 'chatgpt' })).toEqual(OK);
  } finally {
    void server.stop(true);
  }
  expect(hits).toBe(0);
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(readdirSync(auth)).toEqual(['chatgpt.json']);
}, SLOW);
