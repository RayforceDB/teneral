import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, createReadStream, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync,
  readSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { createGunzip } from 'node:zlib';

// An organ is a native dependency the body adopts: a release archive somebody else published,
// pinned in the body by its hash. The pin is in git and mutates with the body; the bytes are not.
// They lie in a cache beside the worktrees, named by their hash, so a generation always finds
// the organ it was gated with, and the one before it finds its own again after a rollback.
//
//   .teneral/organs/archives/<sha256>.tar.gz   put there by the agent, never trusted: the kernel hashes it itself
//   .teneral/organs/trees/<sha256>/            unpacked by the kernel, once
//   .teneral/organs/sets/<id>/<name>           a link per pinned organ: what TENERAL_ORGANS names
//
// Nothing here reaches the network, and nothing here deletes an archive or a tree.

/** Where the body's pins are, in every commit that has any: what it acts with. */
export const ORGANS_FILE = 'body/organs.json';
/**
 * Where the brain's pins are: the engines it remembers and thinks with, such as the database its
 * memory lives in. They are no organs of the body, but they are pinned, cached, checked, handed
 * over and rolled back by exactly the same means, and found by name in the same directory.
 */
export const ENGINES_FILE = 'brain/engines.json';
/** Organs and engines one individual may pin, together. */
export const MAX_ORGANS = 16;
/** Bytes of one archive as it lies in the cache. */
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
/** Bytes of the files one archive unpacks to. */
export const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;
/** Files, directories and links in one archive. */
export const MAX_ENTRIES = 20_000;
/** How long an organ's check may run. */
export const ORGAN_CHECK_TIMEOUT_MS = 60_000;

export interface Organ {
  name: string;
  /** Where the archive was published. The kernel never fetches it; it is what a message tells the agent or the owner to download. */
  url: string;
  /** SHA-256 of the archive, lowercase hex. The archive and its unpacked tree are both cached under it. */
  sha256: string;
  /** A directory inside the archive that is the organ's root, when the archive wraps everything in one. '' for the archive's own top. */
  dir: string;
  /** A command that shows the organ works here, run in the organ's root; its first word is a file in the organ. */
  check?: string[];
}

const NAME = /^[a-z0-9-]{1,40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const KEYS = new Set(['url', 'sha256', 'dir', 'check']);

/** The parts of a path that stays inside the directory it is read from, or null: absolute, climbing, or holding a NUL. */
function inside(path: string): string[] | null {
  if (path.includes('\0') || path.startsWith('/')) return null;
  const parts = path.split('/').filter((part) => part !== '' && part !== '.');
  return parts.includes('..') ? null : parts;
}

/** What one commit pins: the text of its body/organs.json and of its brain/engines.json, each null when the commit has no such file. */
export interface Pins {
  organs: string | null;
  engines: string | null;
}

/**
 * Everything a commit pins, the body's organs and the brain's engines, as one list: each is found
 * by its name in TENERAL_ORGANS, so a name stands for one thing. Throws as `parseOrgans` does.
 */
export function parsePins(pins: Pins): Organ[] {
  const organs = parseOrgans(pins.organs);
  const engines = parseOrgans(pins.engines, ENGINES_FILE);
  const twice = engines.find((engine) => organs.some((organ) => organ.name === engine.name));
  if (twice !== undefined) throw new Error(`${ENGINES_FILE}: ${twice.name} is pinned in ${ORGANS_FILE} as well; a name stands for one thing`);
  if (organs.length + engines.length > MAX_ORGANS) throw new Error(`${ORGANS_FILE} and ${ENGINES_FILE} pin ${organs.length + engines.length} together; the limit is ${MAX_ORGANS}`);
  return [...organs, ...engines];
}

/**
 * The pins a body holds. `text` is what `body/organs.json` contains, or null when the commit has
 * no such file: that, and `{}`, mean no organs. Throws, naming the organ and the field, for
 * anything that is not exactly the shape; a field nobody defined is refused, not ignored.
 */
export function parseOrgans(text: string | null, file: string = ORGANS_FILE): Organ[] {
  if (text === null) return [];
  const bad = (what: string): never => { throw new Error(`${file}: ${what}`); };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return bad(`is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return bad('must be an object that maps an organ\'s name to its pin');
  const entries = Object.entries(parsed);
  if (entries.length > MAX_ORGANS) bad(`pins ${entries.length} organs; the limit is ${MAX_ORGANS}`);
  return entries.map(([name, value]): Organ => {
    if (!NAME.test(name)) bad(`an organ's name must be 1 to 40 characters of a-z, 0-9 and "-"; ${JSON.stringify(name)} is not`);
    const at = `organ ${name}`;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) bad(`${at} must be an object with "url" and "sha256"`);
    const pin = value as Record<string, unknown>;
    const unknown = Object.keys(pin).filter((key) => !KEYS.has(key));
    if (unknown.length > 0) bad(`${at} has a field that is not known: ${unknown.join(', ')}. The fields are url, sha256, dir and check`);
    const { url, sha256, dir, check } = pin;
    if (typeof url !== 'string' || url.length > 2000 || !/^https:\/\/[^\s/]+\/\S+$/.test(url) || !URL.canParse(url)) {
      bad(`${at}: "url" must be an https address of the archive`);
    }
    if (!new URL(url as string).pathname.endsWith('.tar.gz')) bad(`${at}: "url" must name a .tar.gz archive; no other kind is unpacked`);
    if (typeof sha256 !== 'string' || !SHA256.test(sha256)) bad(`${at}: "sha256" must be the archive's SHA-256 as 64 lowercase hex characters`);
    let root = '';
    if (dir !== undefined) {
      const parts = typeof dir === 'string' && dir.length <= 200 ? inside(dir) : null;
      if (parts === null || parts.length === 0) bad(`${at}: "dir" must be a directory inside the archive, as a relative path without ".."`);
      root = parts!.join('/');
    }
    if (check !== undefined) {
      const words = Array.isArray(check) && check.length >= 1 && check.length <= 16
        && check.every((word) => typeof word === 'string' && word.length <= 500 && !word.includes('\0'));
      if (!words) bad(`${at}: "check" must be a command as a list of 1 to 16 strings`);
      const program = inside((check as string[])[0]!);
      if (program === null || program.length === 0) {
        bad(`${at}: the first word of "check" must be a file in the organ, as a relative path without ".."`);
      }
    }
    return { name, url: url as string, sha256: sha256 as string, dir: root, ...(check !== undefined ? { check: check as string[] } : {}) };
  });
}

/** The cache of an install: `root` is the main checkout, the one that holds `.teneral/`. */
export function organCache(root: string): { archives: string; trees: string; sets: string } {
  const home = join(root, '.teneral', 'organs');
  return { archives: join(home, 'archives'), trees: join(home, 'trees'), sets: join(home, 'sets') };
}

/** Where the archive with this hash has to lie. */
export const archivePath = (root: string, sha256: string): string => join(organCache(root).archives, `${sha256}.tar.gz`);
/** Where the archive with this hash is unpacked. */
export const treePath = (root: string, sha256: string): string => join(organCache(root).trees, sha256);

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** SHA-256 of a file, read in pieces. */
function hashFile(path: string): string {
  const hash = createHash('sha256');
  const piece = Buffer.alloc(1024 * 1024);
  const fd = openSync(path, 'r');
  try {
    for (;;) {
      const n = readSync(fd, piece, 0, piece.length, null);
      if (n === 0) break;
      hash.update(piece.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/** Why the cached archive of `organ` cannot be used, or null when it is there and is the bytes that were pinned. */
export function archiveProblem(root: string, organ: Organ): string | null {
  const path = archivePath(root, organ.sha256);
  let stat: ReturnType<typeof lstatSync> | null = null;
  try { stat = lstatSync(path); } catch { /* not there */ }
  if (stat === null) {
    return `archive ${organ.sha256} is not in the cache at ${path}; download ${organ.url} there first (under another name, then rename it)`;
  }
  if (!stat.isFile()) return `${path} is not a regular file; the archive itself has to lie there`;
  if (stat.size > MAX_ARCHIVE_BYTES) return `the archive at ${path} is ${stat.size} bytes; the limit is ${MAX_ARCHIVE_BYTES}`;
  let actual: string;
  try {
    actual = hashFile(path);
  } catch (err) {
    return `the archive at ${path} cannot be read: ${reasonOf(err)}`;
  }
  if (actual !== organ.sha256) {
    return `the file at ${path} has sha256 ${actual}, not the pinned ${organ.sha256}; download it again, or pin the hash its publisher gives`;
  }
  return null;
}

/** Hands out a stream's bytes in the amounts asked for. */
class Bytes {
  private held: Buffer = Buffer.alloc(0);
  private ended = false;

  constructor(private readonly source: AsyncIterator<Buffer>) {}

  private async more(): Promise<boolean> {
    if (this.ended) return false;
    const next = await this.source.next();
    if (next.done) {
      this.ended = true;
      return false;
    }
    this.held = this.held.length === 0 ? next.value : Buffer.concat([this.held, next.value]);
    return true;
  }

  /** Exactly `n` bytes, or null when the stream ends first. */
  async take(n: number): Promise<Buffer | null> {
    while (this.held.length < n) if (!await this.more()) return null;
    const out = this.held.subarray(0, n);
    this.held = this.held.subarray(n);
    return out;
  }

  /** The next `n` bytes, piece by piece, to `sink`. False when the stream ends first. */
  async pass(n: number, sink: (piece: Buffer) => void): Promise<boolean> {
    let left = n;
    while (left > 0) {
      if (this.held.length === 0 && !await this.more()) return false;
      const piece = this.held.subarray(0, left);
      this.held = this.held.subarray(piece.length);
      left -= piece.length;
      sink(piece);
    }
    return true;
  }
}

/** A number as a tar header holds it: octal digits, or, with the top bit set, a binary number. */
function tarNumber(field: Buffer): number {
  if ((field[0]! & 0x80) !== 0) {
    let value = 0;
    for (let i = 1; i < field.length; i++) value = value * 256 + field[i]!;
    return value;
  }
  const digits = field.toString('latin1').replace(/\0.*$/s, '').trim();
  return digits === '' ? 0 : Number.parseInt(digits, 8);
}

const tarText = (field: Buffer): string => {
  const end = field.indexOf(0);
  return field.toString('utf8', 0, end === -1 ? field.length : end);
};

/** The records of a pax header: `<length> <key>=<value>\n`, the length counting the whole record. */
function paxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const length = space === -1 ? Number.NaN : Number(data.toString('latin1', at, space));
    if (!Number.isInteger(length) || length <= space - at + 1 || at + length > data.length) throw new Error('it holds an extended header that cannot be read');
    const record = data.toString('utf8', space + 1, at + length - 1);
    const equals = record.indexOf('=');
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1));
    at += length;
  }
  return records;
}

/** A long name or an extended header is itself an entry; one larger than this is not a name. */
const MAX_META_BYTES = 1024 * 1024;

/**
 * Unpacks a gzipped tar archive into `dest`, an empty directory, and refuses the whole of it when
 * any entry is not a plain file, a directory, or a link that stays inside: a name that is absolute
 * or climbs with `..`, a second entry for a name already written, a file that would be written
 * through something that is not a directory, a link pointing out, a device, a fifo. Nothing is
 * trusted to be what its name suggests, and what is refused is said in terms of the entry.
 *
 * A symlink may only climb first and then descend (`../lib/x`, never `a/../../x`). The directories
 * above an entry are real ones made here, so the climb is counted against real depth, and every
 * step down lands on something in the tree, which by the same rule leads nowhere else.
 */
async function unpackInto(archive: string, dest: string): Promise<void> {
  const file = createReadStream(archive);
  const gunzip = createGunzip();
  file.on('error', (err) => gunzip.destroy(err));
  file.pipe(gunzip);
  const bytes = new Bytes(gunzip[Symbol.asyncIterator]() as AsyncIterator<Buffer>);
  const cut = new Error('it ends in the middle of an entry');
  let entries = 0;
  let unpacked = 0;
  let longName: string | null = null;
  let longLink: string | null = null;
  let pax: Map<string, string> | null = null;
  const links: string[] = [];

  /** Makes the directories `parts` name, one by one, and refuses to pass through anything that is not one. */
  const enter = (parts: string[], entry: string): string => {
    let dir = dest;
    for (const part of parts) {
      dir = join(dir, part);
      let stat: ReturnType<typeof lstatSync> | null = null;
      try { stat = lstatSync(dir); } catch { /* to be made */ }
      if (stat === null) mkdirSync(dir, { mode: 0o755 });
      else if (!stat.isDirectory()) throw new Error(`entry ${JSON.stringify(entry)} would be written through ${JSON.stringify(parts.join('/'))}, which is not a directory`);
    }
    return dir;
  };
  const taken = (path: string): boolean => {
    try { lstatSync(path); return true; } catch { return false; }
  };

  try {
    for (;;) {
      const header = await bytes.take(512);
      // Two empty blocks end an archive; so does the end of the stream, for one written without them.
      if (header === null || header.every((byte) => byte === 0)) break;
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
      if (sum !== tarNumber(header.subarray(148, 156))) throw new Error('it is not a tar archive, or it is damaged: a header\'s checksum is wrong');
      const type = String.fromCharCode(header[156]!);
      let size = tarNumber(header.subarray(124, 136));
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('an entry gives a size that is not a number');

      if (type === 'L' || type === 'K' || type === 'x' || type === 'g') {
        if (size > MAX_META_BYTES) throw new Error('it holds a name or an extended header of more than a megabyte');
        const data = await bytes.take(Math.ceil(size / 512) * 512);
        if (data === null) throw cut;
        if (type === 'L') longName = tarText(data.subarray(0, size));
        else if (type === 'K') longLink = tarText(data.subarray(0, size));
        else if (type === 'x') pax = paxRecords(data.subarray(0, size));
        // 'g' speaks of the whole archive (a comment, as git writes one) and names nothing.
        continue;
      }

      const ustar = header.toString('latin1', 257, 263) === 'ustar\0';
      const prefix = ustar ? tarText(header.subarray(345, 500)) : '';
      const short = tarText(header.subarray(0, 100));
      const name = pax?.get('path') ?? longName ?? (prefix === '' ? short : `${prefix}/${short}`);
      const target = pax?.get('linkpath') ?? longLink ?? tarText(header.subarray(157, 257));
      if (pax?.has('size')) {
        size = Number(pax.get('size'));
        if (!Number.isSafeInteger(size) || size < 0) throw new Error(`entry ${JSON.stringify(name)} gives a size that is not a number`);
      }
      longName = null;
      longLink = null;
      pax = null;

      entries += 1;
      if (entries > MAX_ENTRIES) throw new Error(`it holds more than ${MAX_ENTRIES} entries`);
      const parts = inside(name);
      if (parts === null) throw new Error(`entry ${JSON.stringify(name)} would land outside the organ's directory: its name is absolute or climbs with ".."`);
      const isFile = type === '0' || type === '\0' || type === '7';
      const body = isFile ? size : 0;
      const skip = async (): Promise<void> => {
        if (!await bytes.pass(Math.ceil(body / 512) * 512, () => {})) throw cut;
      };

      if (type === '5' || (isFile && name.endsWith('/'))) {
        enter(parts, name);
        await skip();
        continue;
      }
      // The archive's own top, `./`, as a file or a link: nothing to write.
      if (parts.length === 0) throw new Error(`entry ${JSON.stringify(name)} names the organ's directory itself and is not a directory`);
      const path = join(enter(parts.slice(0, -1), name), parts.at(-1)!);
      if (taken(path)) throw new Error(`entry ${JSON.stringify(name)} appears twice, or would replace something an earlier entry made`);

      if (isFile) {
        unpacked += size;
        if (unpacked > MAX_UNPACKED_BYTES) throw new Error(`it unpacks to more than ${MAX_UNPACKED_BYTES} bytes`);
        // Readable and writable by the owner whatever the archive says, so the tree can be read and, one day, removed; no setuid.
        const fd = openSync(path, 'wx', (tarNumber(header.subarray(100, 108)) & 0o777) | 0o600);
        try {
          const whole = await bytes.pass(size, (piece) => {
            let offset = 0;
            while (offset < piece.length) offset += writeSync(fd, piece, offset, piece.length - offset);
          });
          if (!whole || !await bytes.pass(Math.ceil(size / 512) * 512 - size, () => {})) throw cut;
        } finally {
          closeSync(fd);
        }
      } else if (type === '2') {
        const steps = target.includes('\0') || target.startsWith('/') ? null : target.split('/').filter((step) => step !== '' && step !== '.');
        const up = steps?.findIndex((step) => step !== '..') ?? 0;
        const climbs = steps === null ? 0 : (up === -1 ? steps.length : up);
        if (steps === null || steps.length === 0 || steps.slice(climbs).includes('..') || climbs > parts.length - 1) {
          throw new Error(`entry ${JSON.stringify(name)} is a link to ${JSON.stringify(target)}, which is absolute, or leads outside the organ's directory, `
            + 'or climbs after descending');
        }
        symlinkSync(target, path);
        links.push(path);
      } else if (type === '1') {
        const to = inside(target);
        const source = to === null || to.length === 0 ? null : join(dest, ...to);
        let plain = false;
        try { plain = source !== null && lstatSync(source).isFile(); } catch { /* no such file */ }
        // Every directory on the way has to be a real one, as for a file that is written.
        for (let i = 1; plain && i < to!.length; i++) plain = lstatSync(join(dest, ...to!.slice(0, i))).isDirectory();
        if (!plain) throw new Error(`entry ${JSON.stringify(name)} is a hard link to ${JSON.stringify(target)}, which is not a file unpacked before it`);
        linkSync(source!, path);
      } else {
        const kind = ({ 3: 'a character device', 4: 'a block device', 6: 'a fifo' } as Record<string, string>)[type] ?? `of a kind (${JSON.stringify(type)}) that is not unpacked`;
        throw new Error(`entry ${JSON.stringify(name)} is ${kind}; an organ holds only files, directories and links`);
      }
    }
  } finally {
    file.destroy();
    gunzip.destroy();
  }
  if (entries === 0) throw new Error('it holds nothing');
  // Said again by the file system itself: no link that leads anywhere leads out.
  const top = realpathSync(dest);
  for (const link of links) {
    let real: string;
    try { real = realpathSync(link); } catch { continue; /* it leads nowhere */ }
    if (real !== top && !real.startsWith(top + sep)) throw new Error(`the link ${JSON.stringify(link.slice(dest.length + 1))} leads outside the organ's directory`);
  }
}

/**
 * Unpacks the cached archive of `organ` into its place under trees/, where nothing may be yet.
 * It is unpacked beside that place and renamed into it, so a tree that is there is a whole one.
 * Returns why it could not, or null.
 */
async function unpackOrgan(root: string, organ: Organ): Promise<string | null> {
  const tree = treePath(root, organ.sha256);
  const trees = dirname(tree);
  mkdirSync(trees, { recursive: true });
  // What an unpacking that was killed left behind for this archive.
  for (const name of readdirSync(trees)) {
    if (name.startsWith(`.${organ.sha256}.`)) rmSync(join(trees, name), { recursive: true, force: true });
  }
  const tmp = join(trees, `.${organ.sha256}.${randomUUID()}`);
  mkdirSync(tmp);
  try {
    await unpackInto(archivePath(root, organ.sha256), tmp);
    renameSync(tmp, tree);
    return null;
  } catch (err) {
    return `archive ${organ.sha256} cannot be unpacked: ${reasonOf(err)}`;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The organ's root: its tree, or the directory in it that the pin names. */
export function organRoot(root: string, organ: Organ): string {
  return organ.dir === '' ? treePath(root, organ.sha256) : join(treePath(root, organ.sha256), organ.dir);
}

/** Why `path`, somewhere under the organ's tree, is not what it has to be, or null. */
function strayProblem(root: string, organ: Organ, path: string, want: 'directory' | 'file'): string | null {
  try {
    const top = realpathSync(treePath(root, organ.sha256));
    const real = realpathSync(path);
    if (real !== top && !real.startsWith(top + sep)) return 'leads outside the organ';
    const stat = lstatSync(real);
    return (want === 'directory' ? stat.isDirectory() : stat.isFile()) ? null : `is not a ${want}`;
  } catch {
    return 'is not in the archive';
  }
}

/** The name of the set of links for exactly these pins. Bodies that pin the same organs share one. */
function setId(organs: readonly Organ[]): string {
  const pins = organs.map((organ) => [organ.name, organ.sha256, organ.dir]).sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
  return createHash('sha256').update(JSON.stringify(pins)).digest('hex').slice(0, 16);
}

/**
 * The directory a body is handed as TENERAL_ORGANS: one link per organ, by its name, to that
 * organ's root. The links are relative, so they hold wherever the install is mounted.
 */
function linkSet(root: string, organs: readonly Organ[]): string {
  const { sets } = organCache(root);
  const dir = join(sets, setId(organs));
  const target = (organ: Organ): string => join('..', '..', 'trees', organ.sha256, organ.dir);
  const whole = (): boolean => {
    try {
      return readdirSync(dir).length === organs.length && organs.every((organ) => readlinkSync(join(dir, organ.name)) === target(organ));
    } catch {
      return false;
    }
  };
  if (whole()) return dir;
  mkdirSync(sets, { recursive: true });
  const tmp = join(sets, `.${randomUUID()}`);
  mkdirSync(tmp);
  for (const organ of organs) symlinkSync(target(organ), join(tmp, organ.name));
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  return dir;
}

export type Provided = { dir: string | null; problem?: undefined } | { problem: string };

/**
 * Makes the pinned organs available and returns the directory that holds them, null when none is
 * pinned, or what is in the way, in words the agent or the owner can act on.
 *
 * `verify` is how a mutation is judged: every archive must be in the cache and hash to its pin,
 * whether or not it was unpacked before. Without it, as when a generation starts, a tree that is
 * there is taken as it is, and only a missing one is made again from its archive, which is then
 * verified first. The start must not depend on an archive the gate has already seen.
 */
export async function provideOrgans(root: string, organs: readonly Organ[], o: { verify: boolean }): Promise<Provided> {
  if (organs.length === 0) return { dir: null };
  try {
    for (const organ of organs) {
      const at = `organ ${organ.name}`;
      const unpacked = existsSync(treePath(root, organ.sha256));
      if (o.verify || !unpacked) {
        const problem = archiveProblem(root, organ);
        if (problem !== null) return { problem: `${at}: ${unpacked ? '' : 'it is not unpacked, and '}${problem}` };
      }
      if (!unpacked) {
        const problem = await unpackOrgan(root, organ);
        if (problem !== null) return { problem: `${at}: ${problem}` };
      }
      if (organ.dir !== '') {
        const stray = strayProblem(root, organ, organRoot(root, organ), 'directory');
        if (stray !== null) return { problem: `${at}: its "dir", ${JSON.stringify(organ.dir)}, ${stray}` };
      }
      if (organ.check) {
        const stray = strayProblem(root, organ, join(organRoot(root, organ), organ.check[0]!), 'file');
        if (stray !== null) return { problem: `${at}: the program of its check, ${JSON.stringify(organ.check[0])}, ${stray}` };
      }
    }
    return { dir: linkSet(root, organs) };
  } catch (err) {
    return { problem: `the organs could not be prepared: ${reasonOf(err)}` };
  }
}

/**
 * For an install that is being started: bring into the cache every pinned archive that is neither
 * there nor unpacked, from the address its pin gives. This is how a fresh clone comes by what the
 * seed pins, before there is an agent to fetch anything. What arrives is trusted no more than what
 * an agent puts there: it is kept only when it has the pinned hash, and the gate and the start
 * verify it again. Returns what could not be had, in words for the owner; never throws.
 */
export async function fetchMissing(
  root: string, organs: readonly Organ[], o: { get?: typeof fetch; timeoutMs?: number; log?: (line: string) => void } = {},
): Promise<string[]> {
  const get = o.get ?? fetch;
  const problems: string[] = [];
  for (const organ of organs) {
    const path = archivePath(root, organ.sha256);
    if (existsSync(path) || existsSync(treePath(root, organ.sha256))) continue;
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      o.log?.(`fetching ${organ.name} from ${organ.url}`);
      const response = await get(organ.url, { redirect: 'follow', signal: AbortSignal.timeout(o.timeoutMs ?? 300_000) });
      if (!response.ok) throw new Error(`the address answered ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error(`it is ${bytes.length} bytes; the limit is ${MAX_ARCHIVE_BYTES}`);
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== organ.sha256) throw new Error(`what came has sha256 ${actual}, not the pinned ${organ.sha256}`);
      mkdirSync(organCache(root).archives, { recursive: true });
      writeFileSync(tmp, bytes);
      renameSync(tmp, path);
    } catch (err) {
      rmSync(tmp, { force: true });
      problems.push(`${organ.name}: ${organ.url} could not be fetched: ${reasonOf(err)}. Download it to ${path} by hand, or start again when the address can be reached`);
    }
  }
  return problems;
}

// `bun kernel/organs.ts`, run in a checkout: does for the pins in its body/organs.json and brain/engines.json,
// as the files stand there, what the gate will do for the commit, and prints the directory to use as TENERAL_ORGANS.
if (import.meta.main) {
  // Loaded here, not at the top: gates.ts builds on this file.
  const { repoRoot, tryOrgans } = await import('./gates');
  const file = join(process.cwd(), ORGANS_FILE);
  const read = (path: string): string | null => (existsSync(join(process.cwd(), path)) ? readFileSync(join(process.cwd(), path), 'utf8') : null);
  const tmp = mkdtempSync(join(tmpdir(), 'teneral-organs-'));
  let status = 1;
  try {
    const root = repoRoot(process.cwd());
    // `bun kernel/organs.ts fetch`: first bring what is pinned and missing into the cache, as an install does when it starts.
    if (process.argv[2] === 'fetch') {
      for (const problem of await fetchMissing(root, parsePins({ organs: read(ORGANS_FILE), engines: read(ENGINES_FILE) }), { log: (line) => console.error(line) })) console.error(problem);
    }
    const tried = await tryOrgans(root, parsePins({ organs: read(ORGANS_FILE), engines: read(ENGINES_FILE) }), tmp);
    if (tried.problem !== undefined) console.error(tried.problem);
    else if (tried.dir === null) console.error(`${file} pins no organs, and ${ENGINES_FILE} no engines. Archives go to ${organCache(root).archives}/<sha256>.tar.gz`);
    else console.log(tried.dir);
    status = tried.problem === undefined ? 0 : 1;
  } catch (err) {
    console.error(reasonOf(err));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(status);
}
