import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { runGates } from '../../immune/gates';
import { ORGANS_FILE, archiveKind, archivePath, fetchMissing, organCache, parseOrgans, treePath } from '../../immune/organs';
import { commitAll, makeLineage, writeFiles } from '../helpers';

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const URL_OF = (name: string) => `https://example.org/releases/${name}.zip`;

// --- zip archives, made by hand so that every kind of entry, and every kind of lie, can be put in one ---

interface Entry {
  name: string;
  data?: string | Buffer;
  /** Unix mode with its type bits: 0o100755 a program, 0o120777 a link (its data is the target), 0o040755 a directory. 0 for an archive made where files have none. */
  mode?: number;
  /** Stored as it is, not deflated. */
  stored?: boolean;
  /** What the directory says in place of the truth. */
  claim?: { size?: number; crc?: number; method?: number; flags?: number; headerAt?: number };
}

function zip(entries: Entry[], end: { count?: number; disk?: number; comment?: string } = {}): Buffer {
  const locals: Buffer[] = []; const central: Buffer[] = []; let at = 0;
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '');
    const method = entry.claim?.method ?? (entry.stored === true || data.length === 0 ? 0 : 8);
    const packed = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(entry.name);
    const size = entry.claim?.size ?? data.length, sum = entry.claim?.crc ?? crc32(data), flags = entry.claim?.flags ?? 0;
    // The entry's own header has an extra field the directory's has not, as real archives do.
    const extra = Buffer.from([0x55, 0x54, 0x05, 0x00, 0x01, 0, 0, 0, 0]);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(sum, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt8(20, 4); record.writeUInt8(entry.mode === 0 ? 0 : 3, 5); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(flags, 8); record.writeUInt16LE(method, 10); record.writeUInt32LE(sum, 16);
    record.writeUInt32LE(packed.length, 20); record.writeUInt32LE(size, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38); record.writeUInt32LE(entry.claim?.headerAt ?? at, 42);
    locals.push(local, name, extra, packed); central.push(record, name);
    at += 30 + name.length + extra.length + packed.length;
  }
  const directory = Buffer.concat(central); const comment = Buffer.from(end.comment ?? '');
  const tail = Buffer.alloc(22);
  tail.writeUInt32LE(0x06054b50, 0); tail.writeUInt16LE(end.disk ?? 0, 4); tail.writeUInt16LE(end.count ?? entries.length, 8); tail.writeUInt16LE(end.count ?? entries.length, 10);
  tail.writeUInt32LE(directory.length, 12); tail.writeUInt32LE(at, 16); tail.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, directory, tail, comment]);
}

const tool = (): Entry[] => [
  { name: 'tool/', mode: 0o040755 },
  { name: 'tool/bin/check', data: '#!/bin/sh\nexit 0\n', mode: 0o100755 },
  { name: 'tool/hello.txt', data: 'hello '.repeat(2000) },
  { name: 'tool/empty', data: '' },
  { name: 'tool/raw.bin', data: Buffer.from([0, 1, 2, 255]), stored: true },
  { name: 'tool/current', data: 'bin/check', mode: 0o120777 },
  { name: 'tool/lib/up', data: '../hello.txt', mode: 0o120777 },
];

function stock(root: string, bytes: Buffer): string {
  const path = archivePath(root, sha(bytes), 'zip');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

async function gateOne(bytes: Buffer, more: Record<string, unknown> = {}) {
  const { dir, seed } = makeLineage({ 'body/a.ts': 'export const a = 1;\n' });
  writeFiles(dir, { [ORGANS_FILE]: JSON.stringify({ tool: { url: URL_OF('tool'), sha256: sha(bytes), ...more } }) });
  const next = commitAll(dir, 'pin');
  stock(dir, bytes);
  const result = await runGates(dir, seed, next, []);
  return { dir, result, tree: treePath(dir, sha(bytes)) };
}
const refused = async (bytes: Buffer, says: string): Promise<void> => {
  const r = await gateOne(bytes);
  expect(r.result).toMatchObject({ ok: false, gate: 'organs' });
  expect(r.result.output).toContain(says);
  // Nothing half made stays for a later run to take as whole.
  const { trees } = organCache(r.dir);
  expect(existsSync(trees) ? readdirSync(trees) : []).toEqual([]);
};

test('a pin may name a .zip archive as well as a .tar.gz, and nothing else', () => {
  const hash = 'ab'.repeat(32);
  const [organ] = parseOrgans(JSON.stringify({ clangd: { url: 'https://example.org/clangd-linux-19.1.2.zip', sha256: hash, dir: 'clangd_19.1.2' } }));
  expect(organ).toEqual({ name: 'clangd', url: 'https://example.org/clangd-linux-19.1.2.zip', sha256: hash, dir: 'clangd_19.1.2' });
  expect(archiveKind(organ!)).toBe('zip');
  expect(archiveKind({ url: 'https://example.org/t.tar.gz?x=1.zip' })).toBe('tar.gz');
  expect(archivePath('/r', hash, 'zip')).toBe(`/r/.teneral/organs/archives/${hash}.zip`);
  expect(archivePath('/r', hash)).toBe(`/r/.teneral/organs/archives/${hash}.tar.gz`);
  for (const url of ['https://example.org/t.tar.xz', 'https://example.org/t.tgz', 'https://example.org/t', 'https://example.org/t.zip.sig']) {
    expect(() => parseOrgans(JSON.stringify({ t: { url, sha256: hash } }))).toThrow('"url" must name a .tar.gz or .zip archive; no other kind is unpacked');
  }
});

test('a zip archive in the cache is unpacked: files with their modes, directories, links that stay inside, and the check runs', async () => {
  const r = await gateOne(zip(tool(), { comment: 'made by hand' }), { dir: 'tool', check: ['bin/check'] });
  expect(r.result).toEqual({ ok: true, gate: 'all', output: '' });
  expect(readFileSync(join(r.tree, 'tool', 'hello.txt'), 'utf8')).toBe('hello '.repeat(2000));
  expect(readFileSync(join(r.tree, 'tool', 'empty'), 'utf8')).toBe('');
  expect([...readFileSync(join(r.tree, 'tool', 'raw.bin'))]).toEqual([0, 1, 2, 255]);
  expect(statSync(join(r.tree, 'tool', 'bin', 'check')).mode & 0o777).toBe(0o755);
  expect(statSync(join(r.tree, 'tool', 'hello.txt')).mode & 0o777).toBe(0o644);
  expect(readlinkSync(join(r.tree, 'tool', 'current'))).toBe('bin/check');
  expect(readFileSync(join(r.tree, 'tool', 'lib', 'up'), 'utf8')).toBe('hello '.repeat(2000));
  // The set a body is handed names the organ's root, as for a tar.
  const { sets } = organCache(r.dir);
  const [set] = readdirSync(sets);
  expect(readFileSync(join(sets, set!, 'tool', 'hello.txt'), 'utf8')).toHaveLength(12_000);
});

test('an archive made where files have no modes holds plain files, and a setuid bit is never kept', async () => {
  const r = await gateOne(zip([{ name: 'plain.txt', data: 'x', mode: 0 }, { name: 'su', data: 'x', mode: 0o104755 }, { name: 'closed', data: 'x', mode: 0o100000 }]));
  expect(r.result.ok).toBe(true);
  expect(statSync(join(r.tree, 'plain.txt')).mode & 0o7777).toBe(0o644);
  expect(statSync(join(r.tree, 'su')).mode & 0o7777).toBe(0o755);
  // Readable and writable by its owner whatever the archive says.
  expect(statSync(join(r.tree, 'closed')).mode & 0o7777).toBe(0o644);
});

test('a zip whose entry would land outside, or be written through a file or a link, is refused whole', async () => {
  await refused(zip([{ name: '../out.txt', data: 'x' }]), 'would land outside the organ\'s directory');
  await refused(zip([{ name: '/abs.txt', data: 'x' }]), 'would land outside the organ\'s directory');
  await refused(zip([{ name: 'a/b/../../../out', data: 'x' }]), 'would land outside the organ\'s directory');
  await refused(zip([{ name: 'a', data: 'x' }, { name: 'a/b', data: 'x' }]), 'which is not a directory');
  await refused(zip([{ name: 'link', data: 'sub', mode: 0o120777 }, { name: 'sub/', mode: 0o040755 }, { name: 'link/x', data: 'x' }]), 'which is not a directory');
  await refused(zip([{ name: 'same', data: 'one' }, { name: 'same', data: 'two' }]), 'appears twice');
  await refused(zip([{ name: '.', data: 'x' }]), 'names the organ\'s directory itself');
});

test('a zip link that is absolute, climbs out, or climbs after descending is refused', async () => {
  for (const target of ['/etc/passwd', '../outside', 'a/../../x', '', 'ok\0/etc']) {
    await refused(zip([{ name: 'link', data: target, mode: 0o120777, stored: true }]), 'is a link to');
  }
  await refused(zip([{ name: 'sub/', mode: 0o040755 }, { name: 'sub/up', data: '../../x', mode: 0o120777 }]), 'is a link to');
  // A device or a fifo is not something an organ holds.
  await refused(zip([{ name: 'dev', data: '', mode: 0o020644 }]), 'is of a kind that is not unpacked');
});

test('a zip that lies about its contents is refused: a wrong checksum, a wrong size, a bomb, an entry that is elsewhere', async () => {
  await refused(zip([{ name: 'f', data: 'hello', claim: { crc: 1 } }]), 'is damaged: its bytes are not what the archive\'s own checksum says');
  await refused(zip([{ name: 'f', data: 'hello', stored: true, claim: { size: 4 } }]), 'is damaged');
  // It says ten bytes and inflates to a megabyte: inflating stops at what it said.
  await refused(zip([{ name: 'bomb', data: Buffer.alloc(1024 * 1024), claim: { size: 10 } }]), 'cannot be inflated, or is larger than the archive says');
  await refused(zip([{ name: 'f', data: 'hello' }, { name: 'g', data: 'world', claim: { headerAt: 3 } }]), 'is not where the archive\'s directory says');
  await refused(zip([{ name: 'f', data: 'hello', claim: { headerAt: 1_000_000 } }]), 'points past its own end');
  // What it would unpack to is counted from what the directory says, before anything is inflated.
  await refused(zip([{ name: 'big', data: 'x', claim: { size: 0x7fffffff } }]), 'it unpacks to more than');
});

test('what a zip can hold beyond files, directories and links is refused, not guessed at', async () => {
  await refused(zip([{ name: 'f', data: 'secret', claim: { flags: 1 } }]), 'is encrypted');
  await refused(zip([{ name: 'f', data: 'hello', claim: { method: 12 } }]), 'compressed by a method (12) that is not unpacked');
  await refused(zip([{ name: 'f', data: 'hello', claim: { size: 0xffffffff } }]), 'is of the 64-bit form');
  await refused(zip([{ name: 'f', data: 'hello' }], { count: 0xffff }), 'of the 64-bit form');
  await refused(zip([{ name: 'f', data: 'hello' }], { disk: 1 }), 'in several parts');
  await refused(zip([]), 'it holds nothing');
  await refused(zip([{ name: 'f', data: 'hello' }], { count: 2 }), 'its directory cannot be read');
  await refused(Buffer.from('this is not a zip archive at all, only some text that is long enough'), 'it is not a zip archive');
  // A tar.gz under a zip's name is not unpacked as one.
  await refused(Buffer.concat([Buffer.from([0x1f, 0x8b, 8, 0]), Buffer.alloc(64)]), 'it is not a zip archive');
});

test('a zip that is not in the cache rejects the mutation and says where to put it; a fresh install fetches it there', async () => {
  const bytes = zip(tool());
  const { dir, seed } = makeLineage({ 'body/a.ts': 'export const a = 1;\n' });
  writeFiles(dir, { [ORGANS_FILE]: JSON.stringify({ tool: { url: URL_OF('tool'), sha256: sha(bytes) } }) });
  const next = commitAll(dir, 'pin');
  const missing = await runGates(dir, seed, next, []);
  expect(missing).toMatchObject({ ok: false, gate: 'organs' });
  expect(missing.output).toContain(`is not in the cache at ${archivePath(dir, sha(bytes), 'zip')}; download ${URL_OF('tool')} there first`);
  const organs = parseOrgans(readFileSync(join(dir, ORGANS_FILE), 'utf8'));
  const problems = await fetchMissing(dir, organs, { get: (async () => new Response(new Uint8Array(bytes).buffer as ArrayBuffer)) as unknown as typeof fetch });
  expect(problems).toEqual([]);
  expect(lstatSync(archivePath(dir, sha(bytes), 'zip')).isFile()).toBe(true);
  expect(await runGates(dir, seed, next, [])).toMatchObject({ ok: true });
});
