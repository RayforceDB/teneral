import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { bodyEnv, git, organsAt, runGates, tryOrgans, type GateResult } from '../../kernel/gates';
import { readEvents } from '../../kernel/journal';
import {
  MAX_ARCHIVE_BYTES, MAX_ENTRIES, MAX_ORGANS, MAX_UNPACKED_BYTES, ORGANS_FILE, archivePath, organCache, parseOrgans,
  provideOrgans, treePath, type Organ,
} from '../../kernel/organs';
import { init, paths, supervise } from '../../kernel/supervisor';
import { commitAll, makeRepo, writeFiles } from './helpers';

const OK: GateResult = { ok: true, gate: 'all', output: '' };
const NO_CHECKS: never[] = [];
const SLOW = 60_000;
const URL_OF = (name: string) => `https://example.org/releases/${name}.tar.gz`;

// --- archives, made by hand so that every kind of entry can be put in one ---

interface Entry {
  name: string;
  /** Tar's typeflag: 0 file (the default), 5 directory, 2 symlink, 1 hard link, 3 and 4 devices, 6 fifo. */
  type?: string;
  data?: string;
  link?: string;
  mode?: number;
  /** The size the header claims, when that is not the data's. */
  size?: number;
}

function header(e: Entry, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(e.name, 0, 100, 'utf8');
  h.write(`${(e.mode ?? 0o644).toString(8).padStart(7, '0')}\0`, 100, 'latin1');
  h.write('0000000\0', 108, 'latin1');
  h.write('0000000\0', 116, 'latin1');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  h.write('00000000000\0', 136, 'latin1');
  h.write('        ', 148, 'latin1');
  h.write(e.type ?? '0', 156, 'latin1');
  if (e.link !== undefined) h.write(e.link, 157, 100, 'utf8');
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return h;
}

/** A .tar.gz of exactly these entries, in this order. */
function tarGz(entries: Entry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '', 'utf8');
    blocks.push(header(e, e.size ?? data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Puts an archive into the cache of the install at `root`, as the agent would after downloading it. Returns its hash. */
function stock(root: string, bytes: Buffer): string {
  const hash = sha(bytes);
  mkdirSync(organCache(root).archives, { recursive: true });
  writeFileSync(archivePath(root, hash), bytes);
  return hash;
}

const CHECK_OK = '#!/bin/sh\nexit 0\n';
/** A small organ: a data file, a program that passes as its check, a directory, a link inside. */
const tool = (says = 'hello'): Entry[] => [
  { name: 'tool/', type: '5' },
  { name: 'tool/hello.txt', data: `${says}\n` },
  { name: 'tool/bin/', type: '5' },
  { name: 'tool/bin/check', data: CHECK_OK, mode: 0o755 },
  { name: 'tool/current', type: '2', link: 'bin/check' },
];

const pinOf = (name: string, hash: string, more: Record<string, unknown> = {}) => ({ [name]: { url: URL_OF(name), sha256: hash, ...more } });

/** A repo whose candidate commit pins `pins`; the seed pins nothing. */
function pinned(pins: unknown, files: Record<string, string> = {}) {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'export const a = 1;\n' });
  writeFiles(dir, { [ORGANS_FILE]: typeof pins === 'string' ? pins : JSON.stringify(pins, null, 2), ...files });
  return { dir, seed, next: commitAll(dir, 'pin') };
}

/** Gates a candidate that pins one organ made of `entries`. */
async function gateOne(entries: Entry[], more: Record<string, unknown> = {}, opts: Parameters<typeof runGates>[4] = {}) {
  const bytes = tarGz(entries);
  const r = pinned(pinOf('tool', sha(bytes), more));
  stock(r.dir, bytes);
  const result = await runGates(r.dir, r.seed, r.next, NO_CHECKS, opts);
  return { ...r, result, hash: sha(bytes), tree: treePath(r.dir, sha(bytes)) };
}

/** What the cache holds besides archives: nothing half-made may stay after a refusal. */
function unpackedIn(root: string): string[] {
  const { trees } = organCache(root);
  return existsSync(trees) ? readdirSync(trees) : [];
}

// --- the pins ---

test('no file and an empty object both mean no organs', () => {
  expect(parseOrgans(null)).toEqual([]);
  expect(parseOrgans('{}')).toEqual([]);
  expect(parseOrgans(' {\n}\n')).toEqual([]);
});

test('a pin is a name, an https address of a .tar.gz, a hash, and optionally a directory and a check', () => {
  const hash = 'ab'.repeat(32);
  expect(parseOrgans(JSON.stringify({
    store: { url: 'https://example.org/v1/store-1.0-linux-x86_64.tar.gz', sha256: hash },
    'tool-2': { url: 'https://example.org/t.tar.gz?token=1', sha256: hash, dir: './tool-2.0/', check: ['bin/tool', '--version'] },
  }))).toEqual([
    { name: 'store', url: 'https://example.org/v1/store-1.0-linux-x86_64.tar.gz', sha256: hash, dir: '' },
    { name: 'tool-2', url: 'https://example.org/t.tar.gz?token=1', sha256: hash, dir: 'tool-2.0', check: ['bin/tool', '--version'] },
  ]);
});

test('anything that is not exactly a pin is refused, and the refusal names the organ and the field', () => {
  const hash = 'ab'.repeat(32);
  const good = { url: URL_OF('x'), sha256: hash };
  const refused = (pins: unknown, ...says: string[]) => {
    let message = '';
    try { parseOrgans(typeof pins === 'string' ? pins : JSON.stringify(pins)); } catch (err) { message = (err as Error).message; }
    expect(message).toStartWith(`${ORGANS_FILE}: `);
    for (const part of says) expect(message).toContain(part);
  };
  refused('{ not json', 'is not JSON');
  for (const whole of ['[]', 'null', '"x"', '7']) refused(whole, 'must be an object');
  for (const name of ['', 'Tool', 'a_b', 'a.b', 'a/b', '../x', 'a b', 'x'.repeat(41)]) refused({ [name]: good }, 'name');
  for (const pin of [null, [], 'x', 7]) refused({ x: pin }, 'organ x', '"url" and "sha256"');
  refused({ x: { ...good, sha: hash } }, 'organ x', 'not known: sha');
  refused({ x: { ...good, strip: 1 } }, 'not known: strip');
  for (const url of [undefined, 7, '', 'http://example.org/x.tar.gz', 'file:///x.tar.gz', 'https://example.org', 'https:///x.tar.gz', 'https://example.org/a b.tar.gz',
    `https://example.org/${'a'.repeat(2000)}.tar.gz`]) {
    refused({ x: { ...good, url } }, 'organ x', '"url"');
  }
  for (const url of ['https://example.org/x.zip', 'https://example.org/x.tar.xz', 'https://example.org/x.tgz', 'https://example.org/x']) {
    refused({ x: { ...good, url } }, '.tar.gz');
  }
  for (const sha256 of [undefined, 7, '', hash.slice(1), `${hash}0`, hash.toUpperCase(), `${hash.slice(0, 63)}g`]) {
    refused({ x: { ...good, sha256 } }, 'organ x', '"sha256"');
  }
  for (const dir of ['', '.', '/abs', '../up', 'a/../../b', 'a\0b', 7, null, 'd'.repeat(201)]) refused({ x: { ...good, dir } }, 'organ x', '"dir"');
  for (const check of ['bin/x', [], [7], ['bin/x', null], Array(17).fill('a'), ['a', 'x'.repeat(501)], null]) refused({ x: { ...good, check } }, 'organ x', '"check"');
  for (const program of ['/bin/sh', '../sh', 'a/../../sh', '.', '']) refused({ x: { ...good, check: [program, '-c', 'true'] } }, 'organ x', 'a file in the organ');
  const many = Object.fromEntries(Array.from({ length: MAX_ORGANS + 1 }, (_, i) => [`o${i}`, good]));
  refused(many, `the limit is ${MAX_ORGANS}`);
  expect(parseOrgans(JSON.stringify(Object.fromEntries(Object.entries(many).slice(1))))).toHaveLength(MAX_ORGANS);
});

// --- the gate ---

test('a candidate whose organ is in the cache under its hash passes; the organ is unpacked once, by that hash', async () => {
  const r = await gateOne(tool(), { dir: 'tool', check: ['bin/check'] });
  expect(r.result).toEqual(OK);
  expect(readFileSync(join(r.tree, 'tool', 'hello.txt'), 'utf8')).toBe('hello\n');
  expect(statSync(join(r.tree, 'tool', 'bin', 'check')).mode & 0o111).not.toBe(0);
  expect(readlinkSync(join(r.tree, 'tool', 'current'))).toBe('bin/check');
  expect(unpackedIn(r.dir)).toEqual([r.hash]);
  // The archive stays where the agent put it.
  expect(sha(readFileSync(archivePath(r.dir, r.hash)))).toBe(r.hash);

  // A second run finds the tree and leaves it alone, down to the inode.
  const before = statSync(join(r.tree, 'tool', 'hello.txt')).ino;
  expect(await runGates(r.dir, r.seed, r.next, NO_CHECKS)).toEqual(OK);
  expect(statSync(join(r.tree, 'tool', 'hello.txt')).ino).toBe(before);
});

test('pins that cannot be read reject the molt at gate organs, before anything is looked for', async () => {
  for (const [pins, says] of [['{ nope', 'is not JSON'], [JSON.stringify({ Tool: {} }), 'name'], [JSON.stringify(pinOf('tool', 'zz')), '"sha256"']] as const) {
    const r = pinned(pins);
    const result = await runGates(r.dir, r.seed, r.next, NO_CHECKS);
    expect(result).toMatchObject({ ok: false, gate: 'organs' });
    expect(result.output).toContain(ORGANS_FILE);
    expect(result.output).toContain(says);
    expect(existsSync(join(r.dir, '.teneral', 'organs'))).toBe(false);
  }
});

test('an archive that is not in the cache rejects the molt, and the message says where to put it and from where', async () => {
  const hash = sha(tarGz(tool()));
  const r = pinned(pinOf('tool', hash));
  const result = await runGates(r.dir, r.seed, r.next, NO_CHECKS);
  expect(result).toMatchObject({ ok: false, gate: 'organs' });
  expect(result.output).toContain(`organ tool: it is not unpacked, and archive ${hash} is not in the cache at ${archivePath(r.dir, hash)}`);
  expect(result.output).toContain(`download ${URL_OF('tool')} there first`);
  expect(unpackedIn(r.dir)).toEqual([]);
});

test('the kernel hashes the cached archive itself: other bytes under the pinned name are refused, and nothing is unpacked', async () => {
  const bytes = tarGz(tool());
  const other = tarGz(tool('something else'));
  const r = pinned(pinOf('tool', sha(bytes)));
  mkdirSync(organCache(r.dir).archives, { recursive: true });
  writeFileSync(archivePath(r.dir, sha(bytes)), other);
  const result = await runGates(r.dir, r.seed, r.next, NO_CHECKS);
  expect(result).toMatchObject({ ok: false, gate: 'organs' });
  expect(result.output).toContain(`has sha256 ${sha(other)}, not the pinned ${sha(bytes)}`);
  expect(unpackedIn(r.dir)).toEqual([]);

  // Something that is not a file at all, where the archive should lie.
  rmSync(archivePath(r.dir, sha(bytes)));
  symlinkSync('/etc/hostname', archivePath(r.dir, sha(bytes)));
  expect((await runGates(r.dir, r.seed, r.next, NO_CHECKS)).output).toContain('is not a regular file');
});

test('a molt is judged by the archive every time, even when the organ was unpacked before', async () => {
  const r = await gateOne(tool());
  expect(r.result).toEqual(OK);
  writeFileSync(archivePath(r.dir, r.hash), 'no longer the archive');
  expect((await runGates(r.dir, r.seed, r.next, NO_CHECKS)).output).toContain('not the pinned');
  rmSync(archivePath(r.dir, r.hash));
  const gone = await runGates(r.dir, r.seed, r.next, NO_CHECKS);
  expect(gone).toMatchObject({ ok: false, gate: 'organs' });
  expect(gone.output).toContain(`organ tool: archive ${r.hash} is not in the cache`);
  // The tree it made the first time is not taken away for that.
  expect(existsSync(join(r.tree, 'tool', 'hello.txt'))).toBe(true);
});

test('an entry whose name is absolute or climbs out is refused, and nothing is written anywhere', async () => {
  for (const name of ['../evil.txt', 'tool/../../evil.txt', '/tmp/teneral-evil.txt', 'a/b/../../../evil.txt', '..']) {
    const r = await gateOne([{ name: 'ok.txt', data: 'fine' }, { name, data: 'evil' }]);
    expect(r.result).toMatchObject({ ok: false, gate: 'organs' });
    expect(r.result.output).toContain(`organ tool: archive ${r.hash} cannot be unpacked: entry ${JSON.stringify(name)} would land outside the organ's directory`);
    // Not the tree, not a half-made one beside it, not the file.
    expect(unpackedIn(r.dir)).toEqual([]);
    expect(existsSync(join(organCache(r.dir).trees, 'evil.txt'))).toBe(false);
    expect(existsSync(join(dirname(organCache(r.dir).trees), 'evil.txt'))).toBe(false);
  }
  expect(existsSync('/tmp/teneral-evil.txt')).toBe(false);
});

test('a link that points out of the organ is refused: absolute, climbing too far, or climbing after descending', async () => {
  for (const link of ['/etc/passwd', '../outside', 'sub/../../outside', '../../..', '', '.', './']) {
    const r = await gateOne([{ name: 'sub/', type: '5' }, { name: 'escape', type: '2', link }]);
    expect(r.result).toMatchObject({ ok: false, gate: 'organs' });
    expect(r.result.output).toContain('entry "escape" is a link to');
    expect(unpackedIn(r.dir)).toEqual([]);
  }
  // One level down, one step up is still inside; two are not.
  expect((await gateOne([{ name: 'sub/', type: '5' }, { name: 'sub/up', type: '2', link: '../sub' }])).result).toEqual(OK);
  expect((await gateOne([{ name: 'sub/', type: '5' }, { name: 'sub/up', type: '2', link: '../../x' }])).result.gate).toBe('organs');
});

test('nothing is written through a link, so a link and a later entry cannot reach outside together', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'teneral-outside-'));
  // A link to a directory in the organ is allowed by itself; writing through it is not.
  const through = await gateOne([{ name: 'sub/', type: '5' }, { name: 'door', type: '2', link: 'sub' }, { name: 'door/x.txt', data: 'x' }]);
  expect(through.result.output).toContain('entry "door/x.txt" would be written through "door", which is not a directory');
  const twice = await gateOne([{ name: 'a.txt', data: '1' }, { name: 'a.txt', data: '2' }]);
  expect(twice.result.output).toContain('entry "a.txt" appears twice');
  // A file first, then a link of the same name that would turn later writes elsewhere.
  const swapped = await gateOne([{ name: 'd/', type: '5' }, { name: 'd', type: '2', link: outside }]);
  expect(swapped.result.gate).toBe('organs');
  const hard = await gateOne([{ name: 'h', type: '1', link: '../../../etc/hostname' }]);
  expect(hard.result.output).toContain('entry "h" is a hard link to');
  const hardAbs = await gateOne([{ name: 'h', type: '1', link: '/etc/hostname' }]);
  expect(hardAbs.result.gate).toBe('organs');
  const viaLink = await gateOne([{ name: 'sub/f', data: 'x' }, { name: 'door', type: '2', link: 'sub' }, { name: 'h', type: '1', link: 'door/f' }]);
  expect(viaLink.result.output).toContain('is a hard link to');
  for (const r of [through, twice, swapped, hard, hardAbs, viaLink]) expect(unpackedIn(r.dir)).toEqual([]);
  expect(readdirSync(outside)).toEqual([]);

  // A hard link to a file unpacked before it is the same file.
  const linked = await gateOne([{ name: 'f', data: 'same' }, { name: 'sub/h', type: '1', link: 'f' }]);
  expect(linked.result).toEqual(OK);
  expect(statSync(join(linked.tree, 'sub', 'h')).ino).toBe(statSync(join(linked.tree, 'f')).ino);
});

test('a device, a fifo or an entry of an unknown kind is refused', async () => {
  for (const [type, says] of [['3', 'a character device'], ['4', 'a block device'], ['6', 'a fifo'], ['S', 'of a kind ("S") that is not unpacked']] as const) {
    const r = await gateOne([{ name: 'ok.txt', data: 'fine' }, { name: 'odd', type }]);
    expect(r.result).toMatchObject({ ok: false, gate: 'organs' });
    expect(r.result.output).toContain(`entry "odd" is ${says}`);
    expect(unpackedIn(r.dir)).toEqual([]);
  }
});

test('what is not a gzipped tar archive, or is one cut short, is refused whole', async () => {
  const whole = tarGz([{ name: 'a.txt', data: 'x'.repeat(5000) }]);
  const cases: [Buffer, string][] = [
    [Buffer.from('this is not an archive at all'), 'cannot be unpacked'],
    [gzipSync(Buffer.from('gzip, but of no tar archive'.repeat(40))), 'a header\'s checksum is wrong'],
    [gzipSync(Buffer.alloc(2048)), 'it holds nothing'],
    [whole.subarray(0, whole.length - 20), 'cannot be unpacked'],
    // Says 5000 bytes follow, and ends after a few.
    [gzipSync(Buffer.concat([header({ name: 'a.txt' }, 5000), Buffer.from('short')])), 'it ends in the middle of an entry'],
  ];
  for (const [bytes, says] of cases) {
    const r = pinned(pinOf('tool', sha(bytes)));
    stock(r.dir, bytes);
    const result = await runGates(r.dir, r.seed, r.next, NO_CHECKS);
    expect(result).toMatchObject({ ok: false, gate: 'organs' });
    expect(result.output).toContain(says);
    expect(unpackedIn(r.dir)).toEqual([]);
  }
});

test('an archive over the size limit is refused unread, and so is one that would unpack to more than its limit or holds too many entries', async () => {
  // A file with a hole in it: its size is over the limit and it takes no room. It is refused by its size, before it is hashed.
  const hash = 'cd'.repeat(32);
  const big = pinned(pinOf('tool', hash));
  mkdirSync(organCache(big.dir).archives, { recursive: true });
  const fd = openSync(archivePath(big.dir, hash), 'w');
  ftruncateSync(fd, MAX_ARCHIVE_BYTES + 1);
  closeSync(fd);
  const t = Date.now();
  const refused = await runGates(big.dir, big.seed, big.next, NO_CHECKS);
  expect(refused).toMatchObject({ ok: false, gate: 'organs' });
  expect(refused.output).toContain(`is ${MAX_ARCHIVE_BYTES + 1} bytes; the limit is ${MAX_ARCHIVE_BYTES}`);
  expect(Date.now() - t).toBeLessThan(3000);

  // A header that claims more than may be unpacked is believed and refused before a byte of it is written.
  const bomb = await gateOne([{ name: 'small.txt', data: 'x' }, { name: 'huge.bin', data: 'x', size: MAX_UNPACKED_BYTES }]);
  expect(bomb.result).toMatchObject({ ok: false, gate: 'organs' });
  expect(bomb.result.output).toContain(`it unpacks to more than ${MAX_UNPACKED_BYTES} bytes`);
  expect(unpackedIn(bomb.dir)).toEqual([]);

  const crowd = await gateOne(Array.from({ length: MAX_ENTRIES + 1 }, () => ({ name: 'd/', type: '5' })));
  expect(crowd.result).toMatchObject({ ok: false, gate: 'organs' });
  expect(crowd.result.output).toContain(`it holds more than ${MAX_ENTRIES} entries`);
  expect(unpackedIn(crowd.dir)).toEqual([]);
}, SLOW);

test('a check that fails rejects the molt with what it printed; one that does not end is stopped and rejected', async () => {
  const failing = await gateOne([{ name: 'bin/check', mode: 0o755, data: '#!/bin/sh\necho CHECK-STDOUT-MARK\necho CHECK-STDERR-MARK >&2\nexit 3\n' }], { check: ['bin/check', 'an argument'] });
  expect(failing.result).toMatchObject({ ok: false, gate: 'organs' });
  expect(failing.result.output).toContain('CHECK-STDOUT-MARK');
  expect(failing.result.output).toContain('CHECK-STDERR-MARK');
  expect(failing.result.output).toContain('organ tool: its check (bin/check an argument), run in the organ\'s directory, did not exit with 0');
  // The organ itself was sound and stays unpacked; only the molt is refused.
  expect(unpackedIn(failing.dir)).toEqual([failing.hash]);

  const pidFile = join(tmpdir(), `teneral-organ-check-${failing.hash.slice(0, 12)}.pid`);
  const t = Date.now();
  const hanging = await gateOne(
    [{ name: 'bin/check', mode: 0o755, data: `#!/bin/sh\necho $$ > ${JSON.stringify(pidFile)}\nsleep 300 &\nwait\n` }],
    { check: ['bin/check'] }, { organTimeoutMs: 400, killGraceMs: 200 },
  );
  expect(hanging.result).toMatchObject({ ok: false, gate: 'organs' });
  expect(hanging.result.output).toContain('it was still running after 400 ms');
  expect(hanging.result.output).toContain('did not exit with 0 within 0.4 s');
  expect(Date.now() - t).toBeLessThan(10_000);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  for (let i = 0; i < 100 && existsSync(`/proc/${pid}`); i++) await Bun.sleep(20);
  expect(() => process.kill(pid, 0)).toThrow();
  rmSync(pidFile);
}, SLOW);

test('a check whose program is not a file in the organ, or a dir the archive does not hold, is refused before anything runs', async () => {
  const absent = await gateOne(tool(), { check: ['tool/bin/nothing-here'] });
  expect(absent.result.output).toContain('organ tool: the program of its check, "tool/bin/nothing-here", is not in the archive');
  const aDir = await gateOne(tool(), { check: ['tool/bin'] });
  expect(aDir.result.output).toContain('is not a file');
  const noDir = await gateOne(tool(), { dir: 'tool-9.9' });
  expect(noDir.result.output).toContain('organ tool: its "dir", "tool-9.9", is not in the archive');
  const fileDir = await gateOne(tool(), { dir: 'tool/hello.txt' });
  expect(fileDir.result.output).toContain('is not a directory');
  for (const r of [absent, aDir, noDir, fileDir]) expect(r.result).toMatchObject({ ok: false, gate: 'organs' });
  // A check may be a link in the organ to a file in the organ.
  expect((await gateOne(tool(), { dir: 'tool', check: ['current'] })).result).toEqual(OK);
});

test('a check runs in its organ\'s directory with the checks\' bare environment, and can be interrupted', async () => {
  const before = process.env.TENERAL_API_KEY;
  process.env.TENERAL_API_KEY = 'a-secret-the-check-must-not-see';
  let r: Awaited<ReturnType<typeof gateOne>>;
  try {
    r = await gateOne([{ name: 'v1/', type: '5' }, { name: 'v1/check', mode: 0o755, data: '#!/bin/sh\necho "CWD=$(pwd -P)"\nenv\nexit 1\n' }], { dir: 'v1', check: ['check'] });
  } finally {
    if (before === undefined) delete process.env.TENERAL_API_KEY; else process.env.TENERAL_API_KEY = before;
  }
  expect(r.result.gate).toBe('organs');
  const lines = r.result.output.split('\n');
  expect(lines).toContain(`CWD=${realpathSync(join(r.tree, 'v1'))}`);
  const names = lines.filter((line) => /^[A-Za-z_]+=/.test(line)).map((line) => line.slice(0, line.indexOf('=')));
  const allowed = ['CWD', 'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'GIT_CEILING_DIRECTORIES', 'LANG', 'BUN_INSTALL', 'PWD', 'OLDPWD', 'SHLVL', '_', 'TENERAL_ORGANS'];
  expect(names.filter((name) => !allowed.includes(name))).toEqual([]);
  expect(r.result.output).not.toContain('a-secret');
  expect(lines.find((line) => line.startsWith('TMPDIR='))).toContain(join('.teneral', 'gate-'));

  const stop = new AbortController();
  setTimeout(() => stop.abort(), 300);
  const t = Date.now();
  const cut = await gateOne([{ name: 'check', mode: 0o755, data: '#!/bin/sh\nsleep 300\n' }], { check: ['check'] }, { signal: stop.signal, killGraceMs: 200 });
  expect(cut.result.gate).toBe('interrupted');
  expect(Date.now() - t).toBeLessThan(5000);
}, SLOW);

test('the candidate\'s checks and its smoke run are handed the candidate\'s organs, by name, in TENERAL_ORGANS', async () => {
  const bytes = tarGz(tool('from the candidate\'s pin'));
  const r = pinned({ ...pinOf('tool', sha(bytes), { dir: 'tool', check: ['bin/check'] }), ...pinOf('whole', sha(bytes)) }, {
    'body/main.ts': "console.error('ENV=' + JSON.stringify(process.env));\nprocess.exit(1);\n",
  });
  stock(r.dir, bytes);
  // Fails on purpose, so what it saw comes back.
  const check = await runGates(r.dir, r.seed, r.next, [{
    gate: 'sees', cmd: ['bash', '-c', 'echo "ORGANS=$TENERAL_ORGANS"; ls "$TENERAL_ORGANS"; cat "$TENERAL_ORGANS/tool/hello.txt" "$TENERAL_ORGANS/whole/tool/hello.txt"; exit 1'],
  }]);
  expect(check.gate).toBe('sees');
  const lines = check.output.trim().split('\n');
  const dir = lines[0]!.slice('ORGANS='.length);
  expect(dir.startsWith(`${organCache(r.dir).sets}/`)).toBe(true);
  expect(lines.slice(1)).toEqual(['tool', 'whole', 'from the candidate\'s pin', 'from the candidate\'s pin']);
  // One entry per organ: a link, relative, so it holds wherever the install is mounted.
  expect(readlinkSync(join(dir, 'tool'))).toBe(join('..', '..', 'trees', sha(bytes), 'tool'));
  expect(readlinkSync(join(dir, 'whole'))).toBe(join('..', '..', 'trees', sha(bytes)));
  expect(realpathSync(join(dir, 'tool'))).toBe(realpathSync(join(treePath(r.dir, sha(bytes)), 'tool')));

  const smoke = await runGates(r.dir, r.seed, r.next, [], { smoke: true, smokeTimeoutMs: 20_000, killGraceMs: 200 });
  expect(smoke.gate).toBe('smoke');
  const env = JSON.parse(smoke.output.split('\n').find((line) => line.startsWith('ENV='))!.slice(4)) as Record<string, string>;
  expect(env.TENERAL_ORGANS).toBe(dir);

  // A gate that fails earlier never gets as far as the organs: nothing of a refused commit is unpacked.
  const early = pinned(pinOf('tool', sha(bytes)), { 'kernel/k.ts': 'export const k = 1;\n' });
  stock(early.dir, bytes);
  expect((await runGates(early.dir, early.seed, early.next, NO_CHECKS)).gate).toBe('protected');
  expect(unpackedIn(early.dir)).toEqual([]);
}, SLOW);

test('the pins are read from the commit, not from what lies in the worktree', async () => {
  const bytes = tarGz(tool());
  const r = pinned(pinOf('tool', sha(bytes)));
  stock(r.dir, bytes);
  expect(parseOrgans(organsAt(r.dir, r.next))).toHaveLength(1);
  expect(organsAt(r.dir, r.seed)).toBeNull();
  // Edited behind git's back, as an ignored or skipped file can be: the gate still judges the commit's pin.
  git(r.dir, 'update-index', '--skip-worktree', ORGANS_FILE);
  writeFileSync(join(r.dir, ORGANS_FILE), '{}');
  expect(git(r.dir, 'status', '--porcelain')).toBe('');
  expect(await runGates(r.dir, r.seed, r.next, NO_CHECKS)).toEqual(OK);
  expect(unpackedIn(r.dir)).toEqual([sha(bytes)]);
});

test('a body that pins nothing is gated exactly as before, and no cache is made for it', async () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'export const a = 1;\n' });
  writeFiles(dir, { 'body/a.ts': 'export const a = 2;\n' });
  const next = commitAll(dir, 'change');
  const seen = await runGates(dir, seed, next, [{ gate: 'env', cmd: ['bash', '-c', 'env; exit 1'] }]);
  expect(seen.gate).toBe('env');
  expect(seen.output).not.toContain('TENERAL_ORGANS');
  writeFiles(dir, { [ORGANS_FILE]: '{}\n' });
  const empty = commitAll(dir, 'an empty pin file');
  expect(await runGates(dir, next, empty, NO_CHECKS)).toEqual(OK);
  expect((await runGates(dir, next, empty, [{ gate: 'env', cmd: ['bash', '-c', 'env; exit 1'] }])).output).not.toContain('TENERAL_ORGANS');
  expect(existsSync(join(dir, '.teneral', 'organs'))).toBe(false);
  expect(await provideOrgans(dir, [], { verify: true })).toEqual({ dir: null });
  expect(await tryOrgans(dir, [], tmpdir())).toEqual({ dir: null });
  expect(bodyEnv({ gen: 'g', journal: 'j', workspace: 'w', id: 'i', inbox: 'in', peers: 'p', soul: 's', owner: 'o' })).not.toHaveProperty('TENERAL_ORGANS');
  expect(bodyEnv({ gen: 'g', journal: 'j', workspace: 'w', id: 'i', inbox: 'in', peers: 'p', soul: 's', owner: 'o', organs: '/x' }).TENERAL_ORGANS).toBe('/x');
});

// --- archives as real tools write them ---

test('an archive written by tar itself unpacks: long names, links, modes, in the GNU and the pax format', async () => {
  for (const format of ['gnu', 'pax', 'ustar']) {
    const src = mkdtempSync(join(tmpdir(), 'teneral-tar-src-'));
    // Longer than the 100 bytes a plain header has for a name; ustar can still split it, the others write it apart.
    const deep = join('pkg-1.0', 'a-directory-with-a-long-name'.repeat(3), 'and-another-one-below-it'.repeat(2));
    writeFiles(src, { 'pkg-1.0/bin/run': '#!/bin/sh\necho ran\n', 'pkg-1.0/README': 'read me\n', [join(deep, 'leaf.txt')]: 'deep\n', 'pkg-1.0/empty': '' });
    Bun.spawnSync(['chmod', '755', join(src, 'pkg-1.0/bin/run')]);
    symlinkSync('bin/run', join(src, 'pkg-1.0', 'run'));
    symlinkSync(join('..', 'README'), join(src, 'pkg-1.0', 'bin', 'README'));
    const made = Bun.spawnSync(['tar', `--format=${format}`, '-czf', join(src, 'out.tar.gz'), '-C', src, 'pkg-1.0']);
    expect(made.exitCode).toBe(0);
    const bytes = readFileSync(join(src, 'out.tar.gz'));
    const r = pinned(pinOf('pkg', sha(bytes), { dir: 'pkg-1.0', check: ['run'] }));
    stock(r.dir, bytes);
    expect(await runGates(r.dir, r.seed, r.next, NO_CHECKS)).toEqual(OK);
    const tree = join(treePath(r.dir, sha(bytes)), 'pkg-1.0');
    expect(readFileSync(join(tree, deep.slice('pkg-1.0/'.length), 'leaf.txt'), 'utf8')).toBe('deep\n');
    expect(readFileSync(join(tree, 'bin', 'README'), 'utf8')).toBe('read me\n');
    expect(readFileSync(join(tree, 'empty'), 'utf8')).toBe('');
    expect(lstatSync(join(tree, 'run')).isSymbolicLink()).toBe(true);
    expect(statSync(join(tree, 'bin', 'run')).mode & 0o777).toBe(0o755);
    expect(Bun.spawnSync([join(tree, 'run')]).stdout.toString()).toBe('ran\n');
  }
}, SLOW);

// --- what a generation is handed ---

const JOURNAL_MODULE = join(import.meta.dir, '../../kernel/journal.ts');
/** Journals what it finds in its organs, as a stimulus, then becomes ready. */
const REPORT = `
import { appendEvent, readEvents } from ${JSON.stringify(JOURNAL_MODULE)};
import { existsSync, readFileSync } from 'node:fs';
const journal = process.env.TENERAL_JOURNAL;
const gen = process.env.TENERAL_GEN;
const organs = process.env.TENERAL_ORGANS;
const hello = organs && existsSync(organs + '/tool/hello.txt') ? readFileSync(organs + '/tool/hello.txt', 'utf8').trim() : 'nothing';
appendEvent(journal, gen, { type: 'stimulus', source: 'test', text: String(organs) + '|' + hello });
`;
const READY = "appendEvent(journal, gen, { type: 'generation.ready', commit: gen });\n";
const seen = (journal: string) => readEvents(journal).flatMap((e) => (e.type === 'stimulus' ? [{ gen: e.gen, dir: e.text.split('|')[0]!, hello: e.text.split('|')[1]! }] : []));
const PASS = () => OK;
const QUIET = { gates: PASS, readyTimeoutMs: 5000, restartDelayMs: 0 };

test('a generation is handed its own organs; one that pins none is handed none, whatever the supervisor\'s own environment says', async () => {
  const bytes = tarGz(tool('for the generation'));
  const { dir } = makeRepo({ 'body/main.ts': `${REPORT}${READY}process.exit(0);\n`, [ORGANS_FILE]: JSON.stringify(pinOf('tool', sha(bytes), { dir: 'tool' })) });
  stock(dir, bytes);
  const p = paths(dir);
  expect(await supervise({ root: dir, ...QUIET, log: () => {} })).toBe('stopped');
  const [first] = seen(p.journal);
  expect(first!.hello).toBe('for the generation');
  expect(first!.dir.startsWith(`${organCache(dir).sets}/`)).toBe(true);
  expect(readdirSync(first!.dir)).toEqual(['tool']);

  const bare = makeRepo({ 'body/main.ts': `${REPORT}${READY}process.exit(0);\n` });
  const before = process.env.TENERAL_ORGANS;
  process.env.TENERAL_ORGANS = first!.dir;
  try {
    expect(await supervise({ root: bare.dir, ...QUIET, log: () => {} })).toBe('stopped');
  } finally {
    if (before === undefined) delete process.env.TENERAL_ORGANS; else process.env.TENERAL_ORGANS = before;
  }
  expect(seen(paths(bare.dir).journal)).toEqual([{ gen: bare.seed, dir: 'undefined', hello: 'nothing' }]);
  expect(existsSync(join(bare.dir, '.teneral', 'organs'))).toBe(false);
}, SLOW);

test('after a rollback the generation before finds the organ it pinned, not the failed one\'s', async () => {
  const v1 = tarGz(tool('version one'));
  const v2 = tarGz(tool('version two'));
  // The seed asks for the molt once; the candidate upgrades the organ, sees the new one, and dies before it is ready.
  const molts = `
if (!readEvents(journal).some((e) => e.type === 'generation.rolledback')) {
  appendEvent(journal, gen, { type: 'molt.requested', commit: process.env.TEST_NEXT, motive: 'upgrade the organ' });
  process.exit(75);
}
process.exit(0);
`;
  const { dir, seed } = makeRepo({ 'body/main.ts': `${REPORT}${READY}${molts}`, [ORGANS_FILE]: JSON.stringify(pinOf('tool', sha(v1), { dir: 'tool' })) });
  stock(dir, v1);
  stock(dir, v2);
  init(dir);
  const p = paths(dir);
  writeFiles(p.candidate, { 'body/main.ts': `${REPORT}process.exit(1);\n`, [ORGANS_FILE]: JSON.stringify(pinOf('tool', sha(v2), { dir: 'tool' })) });
  const next = commitAll(p.candidate, 'upgrade');
  process.env.TEST_NEXT = next;

  // The real organs gate, and nothing else: it is what unpacks the candidate's organ.
  const outcome = await supervise({ root: dir, ...QUIET, log: () => {}, gates: (candidate, from, to) => runGates(candidate, from, to, NO_CHECKS) });
  expect(outcome).toBe('stopped');
  const types = readEvents(p.journal).map((e) => e.type);
  expect(types).toContain('generation.promoted');
  expect(types).toContain('generation.rolledback');
  expect(seen(p.journal).map(({ gen, hello }) => ({ gen, hello }))).toEqual([
    { gen: seed, hello: 'version one' }, { gen: next, hello: 'version two' }, { gen: seed, hello: 'version one' },
  ]);
  const dirs = seen(p.journal).map((s) => s.dir);
  expect(dirs[0]).toBe(dirs[2]!);
  expect(dirs[1]).not.toBe(dirs[0]!);
  // Both archives and both trees are still there: the kernel removes neither.
  for (const bytes of [v1, v2]) {
    expect(existsSync(archivePath(dir, sha(bytes)))).toBe(true);
    expect(existsSync(treePath(dir, sha(bytes)))).toBe(true);
  }
  expect(JSON.parse(readFileSync(p.state, 'utf8'))).toEqual({ current: seed, previous: null });
}, SLOW);

test('an organ whose unpacked tree is gone at start is unpacked again from its archive; the links are mended too', async () => {
  const bytes = tarGz(tool('restored'));
  const { dir } = makeRepo({ 'body/main.ts': `${REPORT}${READY}process.exit(0);\n`, [ORGANS_FILE]: JSON.stringify(pinOf('tool', sha(bytes), { dir: 'tool' })) });
  stock(dir, bytes);
  const p = paths(dir);
  expect(await supervise({ root: dir, ...QUIET, log: () => {} })).toBe('stopped');
  rmSync(organCache(dir).trees, { recursive: true });
  rmSync(organCache(dir).sets, { recursive: true });
  // What an unpacking that was killed would have left beside the tree's place.
  mkdirSync(join(organCache(dir).trees, `.${sha(bytes)}.left-behind`, 'half'), { recursive: true });
  expect(await supervise({ root: dir, ...QUIET, log: () => {} })).toBe('stopped');
  expect(seen(p.journal).map((s) => s.hello)).toEqual(['restored', 'restored']);
  expect(unpackedIn(dir)).toEqual([sha(bytes)]);

  // With its tree in place a generation starts without its archive: the start does not depend on it.
  rmSync(archivePath(dir, sha(bytes)));
  expect(await supervise({ root: dir, ...QUIET, log: () => {} })).toBe('stopped');
  expect(seen(p.journal).map((s) => s.hello)).toEqual(['restored', 'restored', 'restored']);
}, SLOW);

test('an organ that is gone from the cache altogether halts the start and says what to put where; nothing is started or rolled back', async () => {
  const v1 = tarGz(tool('version one'));
  const v2 = tarGz(tool('version two'));
  const { dir, seed } = makeRepo({ 'body/main.ts': `${REPORT}${READY}process.exit(0);\n`, [ORGANS_FILE]: JSON.stringify(pinOf('tool', sha(v1), { dir: 'tool' })) });
  stock(dir, v1);
  init(dir);
  const p = paths(dir);
  writeFiles(p.candidate, { [ORGANS_FILE]: JSON.stringify(pinOf('tool', sha(v2), { dir: 'tool' })) });
  const next = commitAll(p.candidate, 'upgrade');
  // An established generation with one before it, as after a molt long ago, and its organ nowhere.
  writeFileSync(p.state, JSON.stringify({ current: next, previous: seed }));
  const logs: string[] = [];
  const run = () => supervise({ root: dir, ...QUIET, log: (line) => { logs.push(line); } });

  expect(await run()).toBe('halted');
  const said = logs.join('\n');
  expect(said).toContain(`cannot start generation ${next}: organ tool: it is not unpacked, and archive ${sha(v2)} is not in the cache at ${archivePath(dir, sha(v2))}`);
  expect(said).toContain(`download ${URL_OF('tool')} there first`);
  expect(JSON.parse(readFileSync(p.state, 'utf8'))).toEqual({ current: next, previous: seed });
  const types = readEvents(p.journal).map((e) => e.type);
  expect(types).not.toContain('generation.started');
  expect(types).not.toContain('generation.rolledback');
  expect(seen(p.journal)).toEqual([]);
  // The same every time it is tried, with no restart and no wait: it is not a crash to count.
  expect(await run()).toBe('halted');

  // A wrong file at the archive's place is said as plainly, and not unpacked.
  mkdirSync(organCache(dir).archives, { recursive: true });
  writeFileSync(archivePath(dir, sha(v2)), v1);
  logs.length = 0;
  expect(await run()).toBe('halted');
  expect(logs.join('\n')).toContain(`has sha256 ${sha(v1)}, not the pinned ${sha(v2)}`);
  expect(unpackedIn(dir)).toEqual([]);

  // Put back, it starts, as the generation it was.
  writeFileSync(archivePath(dir, sha(v2)), v2);
  expect(await run()).toBe('stopped');
  expect(seen(p.journal).map(({ gen, hello }) => ({ gen, hello }))).toEqual([{ gen: next, hello: 'version two' }]);
}, SLOW);

test('pins the current generation holds that cannot be read halt the start and name the file', async () => {
  const { dir } = makeRepo({ 'body/main.ts': `${READY}process.exit(0);\n`, [ORGANS_FILE]: '{ "tool": { "url": "http://example.org/x.tar.gz" } }' });
  const logs: string[] = [];
  expect(await supervise({ root: dir, ...QUIET, log: (line) => { logs.push(line); } })).toBe('halted');
  expect(logs.join('\n')).toContain(`${ORGANS_FILE}: organ tool: "url" must be an https address`);
  expect(readEvents(paths(dir).journal)).toEqual([]);
});

// --- for the agent, before it asks ---

test('bun kernel/organs.ts does for the workspace\'s pins what the gate will do, and prints the directory to use', async () => {
  const cli = join(import.meta.dir, '../../kernel/organs.ts');
  const bytes = tarGz(tool('tried by hand'));
  const { dir } = makeRepo({ 'body/a.ts': 'export const a = 1;\n' });
  const run = (cwd: string) => {
    const r = Bun.spawnSync(['bun', cli], { cwd, stdout: 'pipe', stderr: 'pipe' });
    return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
  };
  const none = run(dir);
  expect(none).toMatchObject({ code: 0, out: '' });
  expect(none.err).toContain(`pins no organs. Archives go to ${organCache(dir).archives}/<sha256>.tar.gz`);

  // Not committed yet: it is the file as it stands that is tried. From a worktree, the cache is the install's.
  init(dir);
  const p = paths(dir);
  writeFiles(p.candidate, { [ORGANS_FILE]: JSON.stringify(pinOf('tool', sha(bytes), { dir: 'tool', check: ['bin/check'] })) });
  const missing = run(p.candidate);
  expect(missing).toMatchObject({ code: 1, out: '' });
  expect(missing.err).toContain(`is not in the cache at ${archivePath(dir, sha(bytes))}`);

  stock(dir, bytes);
  const ready = run(p.candidate);
  expect(ready).toMatchObject({ code: 0, err: '' });
  expect(readFileSync(join(ready.out, 'tool', 'hello.txt'), 'utf8')).toBe('tried by hand\n');
  expect(ready.out.startsWith(`${organCache(dir).sets}/`)).toBe(true);

  writeFiles(p.candidate, { [ORGANS_FILE]: JSON.stringify(pinOf('tool', sha(bytes), { check: ['tool/hello.txt'] })) });
  const failing = run(p.candidate);
  expect(failing).toMatchObject({ code: 1, out: '' });
  expect(failing.err).toContain('organ tool: its check (tool/hello.txt)');
}, SLOW);

test('the set of links is made again when it is not what the pins say', async () => {
  const bytes = tarGz(tool());
  const { dir } = makeRepo({ 'body/a.ts': 'a\n' });
  stock(dir, bytes);
  const organs: Organ[] = parseOrgans(JSON.stringify(pinOf('tool', sha(bytes), { dir: 'tool' })));
  const first = await provideOrgans(dir, organs, { verify: true });
  expect(first.problem).toBeUndefined();
  const set = (first as { dir: string }).dir;
  rmSync(join(set, 'tool'));
  symlinkSync('/etc', join(set, 'tool'));
  symlinkSync('/etc', join(set, 'stray'));
  expect(await provideOrgans(dir, organs, { verify: false })).toEqual({ dir: set });
  expect(readdirSync(set)).toEqual(['tool']);
  expect(readlinkSync(join(set, 'tool'))).toBe(join('..', '..', 'trees', sha(bytes), 'tool'));
  // Other pins, another set: a body never sees an organ under a name it did not pin.
  const other = await provideOrgans(dir, parseOrgans(JSON.stringify(pinOf('other', sha(bytes)))), { verify: false });
  expect((other as { dir: string }).dir).not.toBe(set);
});
