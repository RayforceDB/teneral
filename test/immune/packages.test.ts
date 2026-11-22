import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packagesAt, runGates, type Check } from '../../immune/gates';
import { PACKAGES_FILE, PACKAGES_LOCK, linkPackages, packagesCache, packagesId, packagesProblem, providePackages, type Installer, type Packages } from '../../immune/packages';
import { commitAll, makeRepo, writeFiles } from '../helpers';

const dir = (name: string): string => mkdtempSync(join(tmpdir(), `teneral-packages-${name}-`));
const MARK = join(dir('mark'), 'script-ran');

/**
 * A registry with one package, `hello-tool`, in two versions. Each has a program, a module, and an
 * install script that would leave a mark if anything ran it.
 */
let registry: ReturnType<typeof Bun.serve>;
let url = '';
const tarballs = new Map<string, Buffer>();
let served: string[] = [];

function tarball(version: string): Buffer {
  const at = dir(`pkg-${version}`);
  writeFiles(join(at, 'package'), {
    'package.json': JSON.stringify({ name: 'hello-tool', version, bin: { 'hello-tool': 'bin/hello.js' }, exports: './index.js', scripts: { postinstall: `touch ${MARK}` } }),
    'bin/hello.js': `#!/usr/bin/env bun\nconsole.log('hello from tool ${version}');\n`,
    'index.js': `export const version = '${version}';\n`,
  });
  Bun.spawnSync(['chmod', '755', join(at, 'package', 'bin', 'hello.js')]);
  Bun.spawnSync(['tar', '-czf', join(at, 'pkg.tgz'), '-C', at, 'package']);
  return readFileSync(join(at, 'pkg.tgz'));
}

beforeAll(() => {
  for (const version of ['1.0.0', '2.0.0']) tarballs.set(version, tarball(version));
  registry = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    fetch(request) {
      const path = new URL(request.url).pathname;
      served.push(path);
      const file = /^\/hello-tool\/-\/hello-tool-(.+)\.tgz$/.exec(path);
      if (file !== null && tarballs.has(file[1]!)) return new Response(new Uint8Array(tarballs.get(file[1]!)!).buffer as ArrayBuffer);
      if (path !== '/hello-tool') return new Response('not found', { status: 404 });
      const versions = Object.fromEntries([...tarballs].map(([version, bytes]) => [version, {
        name: 'hello-tool', version, bin: { 'hello-tool': 'bin/hello.js' }, scripts: { postinstall: `touch ${MARK}` },
        dist: { tarball: `${url}/hello-tool/-/hello-tool-${version}.tgz`, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` },
      }]));
      return Response.json({ name: 'hello-tool', 'dist-tags': { latest: '2.0.0' }, versions });
    },
  });
  url = `http://127.0.0.1:${registry.port}`;
  process.env.BUN_CONFIG_REGISTRY = url;
});
afterAll(() => { delete process.env.BUN_CONFIG_REGISTRY; registry.stop(true); });

/** The manifest and the lock as an agent comes by them: it writes the first and runs `bun install` for the second. */
async function declared(version: string): Promise<Packages & { lock: string }> {
  const at = dir('declare');
  const manifest = JSON.stringify({ name: 'body', private: true, type: 'module', dependencies: { 'hello-tool': version } }, null, 2) + '\n';
  writeFileSync(join(at, 'package.json'), manifest);
  // Not spawnSync: the registry is served by this very process.
  const ran = Bun.spawn([process.execPath, 'install', '--ignore-scripts'], { cwd: at, env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(at, '.cache') }, stdout: 'ignore', stderr: 'pipe' });
  const said = await new Response(ran.stderr).text();
  if ((await ran.exited) !== 0) throw new Error(said);
  return { manifest, lock: readFileSync(join(at, 'bun.lock'), 'utf8') };
}

const EMPTY = JSON.stringify({ name: 'body', private: true, type: 'module', dependencies: {} });

test('a manifest that takes nothing needs no lock and no install; one that cannot be read, or has no lock, is said so', () => {
  expect(packagesProblem({ manifest: EMPTY, lock: null })).toEqual({ problem: null, count: 0 });
  expect(packagesProblem({ manifest: '{ nope', lock: null }).problem).toContain(`${PACKAGES_FILE} is not JSON`);
  expect(packagesProblem({ manifest: '[]', lock: null }).problem).toBe(`${PACKAGES_FILE} must be a JSON object`);
  expect(packagesProblem({ manifest: JSON.stringify({ workspaces: ['x'] }), lock: null }).problem).toContain('must not declare workspaces');
  expect(packagesProblem({ manifest: JSON.stringify({ dependencies: { a: '1' } }), lock: null }).problem)
    .toBe(`${PACKAGES_FILE} declares packages and ${PACKAGES_LOCK} is missing: run \`bun install\` in body/ and commit the lock it writes`);
  expect(packagesProblem({ manifest: EMPTY, lock: 'not a lock {' }).problem).toContain(`${PACKAGES_LOCK}`);
  expect(packagesProblem({ manifest: EMPTY, lock: '{}' }).problem).toContain('has no "packages"');
});

test('every package in the lock must carry the hash of its archive: a path, a repository or an address is refused', () => {
  const lock = (entry: string): string => `{\n  "lockfileVersion": 2,\n  "packages": {\n    "tool": ${entry},\n  }\n}\n`;
  const manifest = JSON.stringify({ dependencies: { tool: '1.0.0' } });
  expect(packagesProblem({ manifest, lock: lock('["tool@1.0.0", "", {}, "sha512-abc+/=="]') })).toEqual({ problem: null, count: 1 });
  for (const entry of ['["tool@file:../tool", {}]', '["tool@github:someone/tool#abc", {}, "someone-tool-abc"]', '["tool@https://example.com/tool.tgz", {}]', '"tool"']) {
    expect(packagesProblem({ manifest, lock: lock(entry) }).problem).toContain('package tool has no hash of its archive');
  }
});

test('the two files have one id together, and either changing changes it', () => {
  const one = { manifest: 'a', lock: 'b' };
  expect(packagesId(one)).toMatch(/^[0-9a-f]{16}$/);
  expect(packagesId({ manifest: 'a', lock: 'b' })).toBe(packagesId(one));
  expect(packagesId({ manifest: 'a', lock: 'c' })).not.toBe(packagesId(one));
  expect(packagesId({ manifest: 'ab', lock: '' })).not.toBe(packagesId({ manifest: 'a', lock: 'b' }));
});

test('the packages are installed from the lock, once, with no script run, and the tree is closed to writing', async () => {
  const root = dir('root');
  const packages = await declared('1.0.0');
  served = [];
  const provided = await providePackages(root, packages);
  expect(provided.problem).toBeUndefined();
  const at = (provided as { dir: string }).dir;
  expect(at).toBe(join(packagesCache(root), packagesId(packages)));
  expect(readFileSync(join(at, 'node_modules', 'hello-tool', 'index.js'), 'utf8')).toContain("'1.0.0'");
  const ran = Bun.spawnSync([join(at, 'node_modules', '.bin', 'hello-tool')]);
  expect(ran.stdout.toString()).toBe('hello from tool 1.0.0\n');
  // The package's install script would have left this.
  expect(existsSync(MARK)).toBe(false);
  expect(() => accessSync(join(at, 'node_modules', 'hello-tool', 'index.js'), constants.W_OK)).toThrow();
  expect(() => writeFileSync(join(at, 'node_modules', 'added.js'), '')).toThrow();
  // Nothing of the install is left beside the tree, and nothing else in the cache.
  expect(readdirSync(at).sort()).toEqual(['bun.lock', 'node_modules', 'package.json']);
  expect(readdirSync(packagesCache(root))).toEqual([packagesId(packages)]);
  // A second asking finds the tree and does not go to the registry.
  served = [];
  expect(await providePackages(root, packages, { install: async () => { throw new Error('installed again'); } })).toEqual({ dir: at });
  expect(served).toEqual([]);
  // Another version is another tree; the first stays as it was, for the generation that pins it.
  const next = (await providePackages(root, await declared('2.0.0'))) as { dir: string };
  expect(next.dir).not.toBe(at);
  expect(readFileSync(join(at, 'node_modules', 'hello-tool', 'index.js'), 'utf8')).toContain("'1.0.0'");
  expect(readFileSync(join(next.dir, 'node_modules', 'hello-tool', 'index.js'), 'utf8')).toContain("'2.0.0'");
});

test('a lock that does not match its manifest, an archive that is not what the lock says, and a registry that cannot be reached are refused', async () => {
  const root = dir('root');
  const packages = await declared('1.0.0');
  const changed = { manifest: packages.manifest.replace('1.0.0', '2.0.0'), lock: packages.lock };
  const stale = await providePackages(root, changed);
  expect(stale.problem).toContain('could not be installed from body/bun.lock');
  // The archive the registry now hands out is not the one the lock was written for.
  const forged = { manifest: packages.manifest, lock: packages.lock.replace(/sha512-[A-Za-z0-9+/]+=*/, `sha512-${createHash('sha512').update('other').digest('base64')}`) };
  expect((await providePackages(root, forged)).problem).toContain('could not be installed');
  const before = process.env.BUN_CONFIG_REGISTRY;
  process.env.BUN_CONFIG_REGISTRY = 'http://127.0.0.1:9';
  try {
    const away = { manifest: packages.manifest, lock: packages.lock.replaceAll(url, 'http://127.0.0.1:9') };
    expect((await providePackages(root, away, { timeoutMs: 20_000 })).problem).toContain('the registry must be reachable');
  } finally { process.env.BUN_CONFIG_REGISTRY = before; }
  // Nothing half made is left for a later run to take as whole.
  expect(existsSync(packagesCache(root)) ? readdirSync(packagesCache(root)) : []).toEqual([]);
}, 60_000);

test('the link in a checkout is relative, is moved to another tree, is removed with nothing to link, and never replaces a real directory', () => {
  const root = dir('root'); const worktree = join(root, '.teneral', 'live'); mkdirSync(join(worktree, 'body'), { recursive: true });
  const first = join(packagesCache(root), 'aaaa'), second = join(packagesCache(root), 'bbbb');
  for (const tree of [first, second]) mkdirSync(join(tree, 'node_modules'), { recursive: true });
  expect(linkPackages(worktree, first)).toBe(true);
  expect(readlinkSync(join(worktree, 'body', 'node_modules'))).toBe('../../packages/aaaa/node_modules');
  expect(linkPackages(worktree, second)).toBe(true);
  expect(readlinkSync(join(worktree, 'body', 'node_modules'))).toBe('../../packages/bbbb/node_modules');
  expect(linkPackages(worktree, null)).toBe(true);
  expect(() => lstatSync(join(worktree, 'body', 'node_modules'))).toThrow();
  // The agent's own install in its workspace.
  mkdirSync(join(worktree, 'body', 'node_modules'));
  expect(linkPackages(worktree, first)).toBe(false);
  expect(lstatSync(join(worktree, 'body', 'node_modules')).isDirectory()).toBe(true);
  // A checkout with no body has nothing to link into.
  expect(linkPackages(join(root, 'empty'), first)).toBe(true);
  expect(existsSync(join(root, 'empty'))).toBe(false);
});

const USES: Check[] = [
  { gate: 'imports', cmd: ['bun', 'body/uses.ts'] },
  { gate: 'runs', cmd: ['body/node_modules/.bin/hello-tool'] },
];

function candidate(packages: Packages | null, uses = "import { version } from 'hello-tool';\nif (version !== '1.0.0') process.exit(3);\n") {
  const repo = makeRepo({ 'body/main.ts': '// a body\n' });
  writeFiles(repo.dir, { 'body/uses.ts': uses, ...(packages === null ? {} : { [PACKAGES_FILE]: packages.manifest, ...(packages.lock === null ? {} : { [PACKAGES_LOCK]: packages.lock }) }) });
  return { ...repo, next: commitAll(repo.dir, 'takes a package') };
}

test('a mutation that takes a package is gated with it: its checks import the module and run the program from the commit\'s own lock', async () => {
  const packages = await declared('1.0.0');
  const r = candidate(packages);
  expect(packagesAt(r.dir, r.next)).toEqual(packages);
  expect(packagesAt(r.dir, r.seed)).toBeNull();
  expect(await runGates(r.dir, r.seed, r.next, USES)).toEqual({ ok: true, gate: 'all', output: '' });
  expect(readdirSync(packagesCache(r.dir))).toEqual([packagesId(packages)]);
  expect(existsSync(MARK)).toBe(false);
  // The checkout the checks ran in is gone, link and all; the agent's workspace was not touched.
  expect(readdirSync(join(r.dir, '.teneral')).filter((name) => name.startsWith('gate-'))).toEqual([]);
  expect(existsSync(join(r.dir, 'body', 'node_modules'))).toBe(false);
});

test('a mutation whose packages cannot be had is rejected at gate packages, before any of its code runs', async () => {
  const ran = join(dir('ran'), 'check-ran');
  const checks: Check[] = [{ gate: 'ran', cmd: ['touch', ran] }];
  const unlocked = candidate({ manifest: JSON.stringify({ dependencies: { 'hello-tool': '1.0.0' } }), lock: null });
  const first = await runGates(unlocked.dir, unlocked.seed, unlocked.next, checks);
  expect(first).toMatchObject({ ok: false, gate: 'packages' });
  expect(first.output).toContain(`${PACKAGES_LOCK} is missing`);
  const failing: Installer = async () => ({ code: 1, output: 'error: lockfile had changes, but lockfile is frozen' });
  const stale = candidate(await declared('1.0.0'));
  const second = await runGates(stale.dir, stale.seed, stale.next, checks, { install: failing });
  expect(second).toMatchObject({ ok: false, gate: 'packages' });
  expect(second.output).toContain('lockfile is frozen');
  expect(second.output.trimEnd().endsWith('the registry must be reachable')).toBe(true);
  expect(existsSync(ran)).toBe(false);
});

test('a commit that takes nothing passes the gate without an install, and a body without a manifest is not asked for one', async () => {
  const never: Installer = async () => { throw new Error('installed'); };
  const empty = candidate({ manifest: EMPTY, lock: null }, '// uses nothing\n');
  expect(await runGates(empty.dir, empty.seed, empty.next, [{ gate: 'imports', cmd: ['bun', 'body/uses.ts'] }], { install: never })).toMatchObject({ ok: true });
  const none = candidate(null, '// uses nothing\n');
  expect(await runGates(none.dir, none.seed, none.next, [{ gate: 'imports', cmd: ['bun', 'body/uses.ts'] }], { install: never })).toMatchObject({ ok: true });
  expect(existsSync(packagesCache(none.dir))).toBe(false);
});

test('a check that leaves something closed to writing does not leave the gate\'s checkout behind', async () => {
  const repo = makeRepo({ 'body/main.ts': '// a body\n' });
  writeFiles(repo.dir, { 'body/next.ts': '// next\n' });
  const next = commitAll(repo.dir, 'next');
  // As a test of an installed tree does: a directory with a file in it, both closed, in the check's temp directory.
  const closes: Check[] = [{ gate: 'closes', cmd: ['sh', '-c', 'mkdir -p "$TMPDIR/tree/inner" && touch "$TMPDIR/tree/inner/file" && chmod -R a-w "$TMPDIR/tree"'] }];
  expect(await runGates(repo.dir, repo.seed, next, closes)).toMatchObject({ ok: true });
  expect(readdirSync(join(repo.dir, '.teneral')).filter((name) => name.startsWith('gate-'))).toEqual([]);
  // The same commit can be gated again at once.
  expect(await runGates(repo.dir, repo.seed, next, closes)).toMatchObject({ ok: true });
});
