import { statSync } from 'node:fs';
import { join } from 'node:path';
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

export function sh(cmd: string[], cwd: string, timeoutMs = 600_000): { code: number; output: string } {
  const p = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs });
  return { code: p.exitCode ?? 1, output: p.stdout.toString() + p.stderr.toString() };
}

function gitRaw(dir: string, ...args: string[]): string {
  const r = sh(['git', ...args], dir);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.output.trim()}`);
  return r.output;
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

export function bodySize(dir: string): number {
  return gitPaths(dir, 'ls-files', '-z', 'body')
    .reduce((total, file) => total + statSync(join(dir, file)).size, 0);
}

/**
 * Decide whether commit `to`, checked out in `dir`, may replace generation `from`.
 * Checks run inside `dir`, so they test the candidate's code, not the running one.
 */
export function runGates(dir: string, from: string, to: string, checks: readonly Check[] = DEFAULT_CHECKS): GateResult {
  const fail = (gate: string, output: string): GateResult => ({ ok: false, gate, output: output.slice(-4000) });
  try {
    if (git(dir, 'rev-parse', 'HEAD') !== to) return fail('head', `the candidate is not at ${to}`);
    if (git(dir, 'status', '--porcelain') !== '') return fail('head', 'the candidate has uncommitted changes');
    // --no-renames lists both ends of a move, so moving a protected file out is caught.
    // -z: without it git prints unusual names quoted and escaped, which would not match the allowlist.
    const changed = gitPaths(dir, 'diff', '--name-only', '--no-renames', '-z', from, to);
    const forbidden = protectedChanges(changed);
    if (forbidden.length > 0) return fail('protected', `protected paths changed: ${forbidden.join(', ')}`);
    const size = bodySize(dir);
    if (size > BODY_SIZE_LIMIT) return fail('size', `body/ is ${size} bytes; the limit is ${BODY_SIZE_LIMIT}`);
  } catch (err) {
    return fail('git', err instanceof Error ? err.message : String(err));
  }
  for (const check of checks) {
    const r = sh(check.cmd, dir);
    if (r.code !== 0) return fail(check.gate, r.output);
  }
  return { ok: true, gate: 'all', output: '' };
}
