import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

// Packages are what the body takes from the npm registry: tools it runs and modules it imports.
// It declares them in body/package.json and pins every one, with the hash of its archive, in
// body/bun.lock. Both files are in git and mutate with the body; the installed tree is not. It lies
// in a cache beside the worktrees, named by the hash of the two files, so a generation always finds
// the packages it was gated with, and the one before it finds its own again after a rollback.
//
//   .teneral/packages/<id>/package.json, bun.lock   the two files as the commit holds them
//   .teneral/packages/<id>/node_modules/            installed by the stem, once, from the lock alone
//   <worktree>/body/node_modules                    a link to that, made by the stem: what bun resolves imports by
//
// Unlike an organ's archive, which the agent brings, the stem fetches these itself: bun checks
// each archive against the hash in the lock as it arrives, and a tree the agent had made could
// not be checked afterwards. No script of any package is run, at install or later by the stem.
// Nothing here deletes a tree.

/** Where the body declares what it takes, in every commit that takes anything. */
export const PACKAGES_FILE = 'body/package.json';
/** The lock bun wrote for it: every package, direct or not, with the hash of its archive. */
export const PACKAGES_LOCK = 'body/bun.lock';
/** Packages in one lock, direct or not. */
export const MAX_PACKAGES = 2000;
/** How long one install may take. */
export const INSTALL_TIMEOUT_MS = 600_000;

/** The two files as one commit holds them; `lock` is null when it has no lock. */
export interface Packages { manifest: string; lock: string | null }

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * What is wrong with the two files, in words the agent can act on, or null when they can be
 * installed. `count` is how many packages the lock holds: with none there is nothing to install.
 */
export function packagesProblem(packages: Packages): { problem: string | null; count: number } {
  const bad = (problem: string): { problem: string; count: number } => ({ problem, count: 0 });
  let manifest: unknown;
  try { manifest = JSON.parse(packages.manifest); } catch (err) { return bad(`${PACKAGES_FILE} is not JSON: ${reasonOf(err)}`); }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return bad(`${PACKAGES_FILE} must be a JSON object`);
  const declared = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
    .flatMap((field) => Object.keys(((manifest as Record<string, unknown>)[field] ?? {}) as object));
  if ((manifest as Record<string, unknown>).workspaces !== undefined) return bad(`${PACKAGES_FILE} must not declare workspaces: the body is one package`);
  if (packages.lock === null) {
    return declared.length === 0 ? { problem: null, count: 0 } : bad(`${PACKAGES_FILE} declares packages and ${PACKAGES_LOCK} is missing: run \`bun install\` in body/ and commit the lock it writes`);
  }
  let lock: unknown;
  try { lock = Bun.JSONC.parse(packages.lock); } catch (err) { return bad(`${PACKAGES_LOCK} cannot be read: ${reasonOf(err)}`); }
  const entries = typeof lock === 'object' && lock !== null ? (lock as { packages?: unknown }).packages : undefined;
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) return bad(`${PACKAGES_LOCK} has no "packages": it is not a lock bun wrote as text`);
  const names = Object.keys(entries);
  if (names.length > MAX_PACKAGES) return bad(`${PACKAGES_LOCK} holds ${names.length} packages; at most ${MAX_PACKAGES}`);
  for (const name of names) {
    const entry = (entries as Record<string, unknown>)[name];
    const hash = Array.isArray(entry) ? entry[entry.length - 1] : undefined;
    // A package from the registry ends with the hash of its archive. One from a path, a git
    // repository or an address has none: nothing would say that it is the same tomorrow.
    if (typeof hash !== 'string' || !/^sha(512|384|256)-[A-Za-z0-9+/]+=*$/.test(hash)) {
      return bad(`${PACKAGES_LOCK}: package ${name} has no hash of its archive. Only packages from the registry can be taken, not one from a path, a git repository or an address`);
    }
  }
  return { problem: null, count: names.length };
}

/** One id for the two files together: the same pair is installed once, whatever commit holds it. */
export function packagesId(packages: Packages): string {
  return createHash('sha256').update(packages.manifest).update('\0').update(packages.lock ?? '').digest('hex').slice(0, 16);
}

export function packagesCache(root: string): string {
  return join(root, '.teneral', 'packages');
}

export interface Installed { code: number | null; output: string }
/** Runs bun's install in `dir` and waits for it. Replaced in tests of everything around it. */
export type Installer = (dir: string, o: { timeoutMs: number; signal?: AbortSignal }) => Promise<Installed>;

/**
 * `bun install` from the lock as it is written, with no script run. It sees no more than a check
 * does, and keeps its downloads in a directory of this one install: a cache it shared could be
 * written by anything, and bun does not check a package it finds there.
 */
export const install: Installer = async (dir, o) => {
  const env: Record<string, string> = { BUN_INSTALL_CACHE_DIR: join(dir, '.cache'), TMPDIR: join(dir, '.cache') };
  for (const name of ['PATH', 'HOME', 'LANG', 'BUN_INSTALL', 'BUN_CONFIG_REGISTRY']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  mkdirSync(join(dir, '.cache'), { recursive: true });
  const child = Bun.spawn([process.execPath, 'install', '--frozen-lockfile', '--ignore-scripts', '--no-progress', '--no-summary'], {
    cwd: dir, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const stop = (): void => { child.kill('SIGKILL'); };
  const timer = setTimeout(stop, o.timeoutMs);
  o.signal?.addEventListener('abort', stop, { once: true });
  try {
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;
    return { code: child.exitCode, output: (out + err).slice(-2000) };
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', stop);
  }
};

export type ProvidedPackages = { dir: string | null; problem?: undefined } | { problem: string; interrupted?: boolean };

/**
 * Makes the packages of one commit available and returns the directory that holds them, null when
 * it takes none, or what is in the way. A tree that is there is taken as it is: it was installed
 * from these very files. One that is not is installed now, which needs the registry.
 */
export async function providePackages(
  root: string, packages: Packages | null, o: { install?: Installer; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ProvidedPackages> {
  if (packages === null) return { dir: null };
  const judged = packagesProblem(packages);
  if (judged.problem !== null) return { problem: judged.problem };
  if (judged.count === 0 || packages.lock === null) return { dir: null };
  const cache = packagesCache(root);
  const dir = join(cache, packagesId(packages));
  if (existsSync(join(dir, 'node_modules'))) return { dir };
  const tmp = join(cache, `.${randomUUID()}`);
  try {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, 'package.json'), packages.manifest);
    writeFileSync(join(tmp, 'bun.lock'), packages.lock);
    const ran = await (o.install ?? install)(tmp, { timeoutMs: o.timeoutMs ?? INSTALL_TIMEOUT_MS, signal: o.signal });
    if (o.signal?.aborted) return { problem: 'the install was stopped before it finished', interrupted: true };
    if (ran.code !== 0) {
      // The reason goes last: a gate's output is kept from its end.
      return { problem: `${ran.output.trimEnd()}\nthe packages of ${PACKAGES_FILE} could not be installed from ${PACKAGES_LOCK} (bun install --frozen-lockfile, ${ran.code === null ? 'killed' : `exit ${ran.code}`}). `
        + 'The lock must match the manifest, and the registry must be reachable' };
    }
    if (!existsSync(join(tmp, 'node_modules'))) mkdirSync(join(tmp, 'node_modules'));
    rmSync(join(tmp, '.cache'), { recursive: true, force: true });
    try {
      renameSync(tmp, dir);
    } catch (err) {
      // Another run installed the same pair meanwhile; its tree is as good.
      if (!existsSync(join(dir, 'node_modules'))) throw err;
    }
    // Every generation that pins this pair shares the tree, so it is closed to writing: an install
    // run through the link in a worktree fails instead of changing what an older generation was gated with.
    Bun.spawnSync(['chmod', '-R', 'a-w', join(dir, 'node_modules')]);
    return { dir };
  } catch (err) {
    return { problem: `the packages could not be prepared: ${reasonOf(err)}` };
  } finally {
    if (existsSync(tmp)) {
      Bun.spawnSync(['chmod', '-R', 'u+w', tmp]);
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

/**
 * Makes `dir`'s packages what bun finds from the body of the checkout at `worktree`: a link
 * `body/node_modules`, relative, so it holds wherever the install is mounted. With `dir` null the
 * link is removed. A real directory there is the agent's own install in its workspace and is left
 * alone; returns false then, true otherwise.
 */
export function linkPackages(worktree: string, dir: string | null): boolean {
  const body = join(worktree, 'body');
  const at = join(body, 'node_modules');
  const target = dir === null ? null : relative(body, join(dir, 'node_modules'));
  let stat: ReturnType<typeof lstatSync> | null = null;
  try { stat = lstatSync(at); } catch { /* nothing there */ }
  if (stat?.isSymbolicLink()) {
    if (target !== null && readlinkSync(at) === target) return true;
    rmSync(at, { force: true });
  } else if (stat) {
    return false;
  }
  if (target !== null && existsSync(body)) {
    mkdirSync(dirname(at), { recursive: true });
    symlinkSync(target, at);
  }
  return true;
}
