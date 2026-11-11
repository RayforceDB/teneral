import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { protectedChanges } from './protected';

/** Bytes of tracked files under body/. Roughly 50k tokens: small enough to read whole. */
export const BODY_SIZE_LIMIT = 200_000;

export interface GateResult {
  ok: boolean;
  gate: string;
  output: string;
}

export interface Check {
  gate: string;
  cmd: string[];
}

export const DEFAULT_CHECKS: readonly Check[] = [
  { gate: 'types', cmd: ['bun', 'x', 'tsc', '--noEmit'] },
  { gate: 'tests', cmd: ['bun', 'test'] },
];

export interface ShResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout followed by stderr, for showing to a reader. */
  output: string;
}

export function sh(cmd: string[], cwd: string, timeoutMs = 600_000): ShResult {
  const p = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs });
  const stdout = p.stdout.toString();
  const stderr = p.stderr.toString();
  return { code: p.exitCode ?? 1, stdout, stderr, output: stdout + stderr };
}

/** git's stdout only: a warning on stderr must never be read as part of the answer. */
function gitRaw(dir: string, ...args: string[]): string {
  const r = sh(['git', ...args], dir);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.output.trim()}`);
  return r.stdout;
}

/** Runs git in `dir`; throws with git's own words when it fails. */
export function git(dir: string, ...args: string[]): string {
  return gitRaw(dir, ...args).trim();
}

/**
 * The NUL-separated paths a `-z` git command prints, exactly as git gave them.
 * Never trimmed: ` body/x` is not `body/x`, and trimming would let it through the allowlist.
 */
function gitPaths(dir: string, ...args: string[]): string[] {
  return gitRaw(dir, ...args).split('\0').filter(Boolean);
}

export interface BodyEntry {
  path: string;
  /** Git's file mode, e.g. 100644. */
  mode: string;
  /** Blob size in bytes; 0 for entries that are not blobs. */
  size: number;
}

/** What `commit` holds under body/, read from the commit itself, never from a worktree. */
export function bodyEntries(dir: string, commit: string): BodyEntry[] {
  // Each record is `<mode> <type> <object> <size>\t<path>`, the size padded with spaces.
  return gitPaths(dir, 'ls-tree', '-r', '-l', '-z', commit, '--', 'body').map((record) => {
    const tab = record.indexOf('\t');
    const [mode = '', , , size = ''] = record.slice(0, tab).split(/ +/);
    return { path: record.slice(tab + 1), mode, size: Number(size) || 0 };
  });
}

/** Bytes of the files `commit` holds under body/. */
export function bodySize(dir: string, commit = 'HEAD'): number {
  return bodyEntries(dir, commit).reduce((total, entry) => total + entry.size, 0);
}

/** Regular and executable files. Anything else (a symlink, a nested repo) is not plain. */
const PLAIN_MODES = new Set(['100644', '100755']);

/** Makes the repo's dependencies visible in a worktree without copying them. */
export function linkModules(root: string, dir: string): void {
  const source = join(root, 'node_modules');
  const target = join(dir, 'node_modules');
  if (existsSync(source) && !existsSync(target)) symlinkSync(source, target);
}

/** The main checkout of the repo that `dir` (possibly one of its worktrees) belongs to. */
function repoRoot(dir: string): string {
  return dirname(git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
}

/** Never throws: whatever is at `tree` is gone afterwards, or was never there. */
function dropGateTree(root: string, tree: string): void {
  if (existsSync(tree)) sh(['git', 'worktree', 'remove', '--force', tree], root);
  rmSync(tree, { recursive: true, force: true });
  sh(['git', 'worktree', 'prune'], root);
}

/**
 * A fresh, kernel-owned checkout of exactly `commit`. Checks run here, so nothing
 * that exists only in the agent's worktree (ignored files, edits git was told to
 * overlook) can make them pass.
 */
function makeGateTree(root: string, commit: string): string {
  const tree = join(root, '.teneral', `gate-${commit.slice(0, 12)}`);
  mkdirSync(dirname(tree), { recursive: true });
  // A gate run that was killed may have left its checkout behind.
  dropGateTree(root, tree);
  git(root, 'worktree', 'add', '--detach', tree, commit);
  linkModules(root, tree);
  return tree;
}

/**
 * Decide whether commit `to`, checked out in `dir`, may replace generation `from`.
 * Checks run in a temporary checkout of `to`, so they test that commit and nothing else.
 */
export function runGates(dir: string, from: string, to: string, checks: readonly Check[] = DEFAULT_CHECKS): GateResult {
  const fail = (gate: string, output: string): GateResult => ({ ok: false, gate, output: output.slice(-4000) });
  let root: string;
  try {
    // These two say early, in the agent's own terms, why its worktree is not what it asked for.
    if (git(dir, 'rev-parse', 'HEAD') !== to) return fail('head', `the candidate is not at ${to}`);
    if (git(dir, 'status', '--porcelain') !== '') return fail('head', 'the candidate has uncommitted changes');
    // --no-renames lists both ends of a move, so moving a protected file out is caught.
    // -z: without it git prints unusual names quoted and escaped, which would not match the allowlist.
    const changed = gitPaths(dir, 'diff', '--name-only', '--no-renames', '-z', from, to);
    const forbidden = protectedChanges(changed);
    if (forbidden.length > 0) return fail('protected', `protected paths changed: ${forbidden.join(', ')}`);
    const entries = bodyEntries(dir, to);
    const odd = entries.filter((entry) => !PLAIN_MODES.has(entry.mode));
    if (odd.length > 0) {
      return fail('body', `body/ may hold only plain files; these are not: ${odd.map((entry) => entry.path).join(', ')}`);
    }
    const size = entries.reduce((total, entry) => total + entry.size, 0);
    if (size > BODY_SIZE_LIMIT) return fail('size', `body/ is ${size} bytes; the limit is ${BODY_SIZE_LIMIT}`);
    root = repoRoot(dir);
  } catch (err) {
    return fail('git', err instanceof Error ? err.message : String(err));
  }
  if (checks.length === 0) return { ok: true, gate: 'all', output: '' };

  let tree: string;
  try {
    tree = makeGateTree(root, to);
  } catch (err) {
    return fail('git', err instanceof Error ? err.message : String(err));
  }
  try {
    for (const check of checks) {
      const r = sh(check.cmd, tree);
      if (r.code !== 0) return fail(check.gate, r.output);
    }
    return { ok: true, gate: 'all', output: '' };
  } finally {
    dropGateTree(root, tree);
  }
}
