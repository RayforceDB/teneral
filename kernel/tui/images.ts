import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

// Images the owner gives the agent. An image is kept for good under `memory/images/`, named by
// the SHA-256 of its bytes, and a message that carries it ends with one line naming that file.
// The journal holds only the line; a body that knows the line shows the model the picture.
//
// The client runs inside the container, where there is no clipboard and no file of the owner's
// machine. `./box talk` therefore starts a helper on the host, and the two talk through files in
// a directory of their own under the owner's channel: `Clip` below is the client's end of it.

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** Images one message may carry. */
export const IMAGES_PER_MESSAGE = 4;
/** Where images are kept, from the directory that holds `memory/`. */
export const STORE = 'memory/images';

export type ImageExt = 'png' | 'jpg' | 'gif' | 'webp';

const MARKER = /^\[image: (memory\/images\/[0-9a-f]{64}\.(?:png|jpg|jpeg|gif|webp))\]$/;

/** The line that names a kept image in a message. */
export const marker = (path: string): string => `[image: ${path}]`;

/** `text` without the marker lines it ends with, and the paths those lines name, in order. */
export function splitMarkers(text: string): { text: string; paths: string[] } {
  const lines = text.split('\n');
  const paths: string[] = [];
  for (let m = MARKER.exec(lines.at(-1) ?? ''); m !== null && lines.length > 0; m = MARKER.exec(lines.at(-1) ?? '')) {
    paths.unshift(m[1]!);
    lines.pop();
  }
  return { text: lines.join('\n').trimEnd(), paths };
}

/** A message as it is sent: the words, then one marker line for each image. */
export function withMarkers(text: string, paths: readonly string[]): string {
  return [...(text.trim() === '' ? [] : [text.trim()]), ...paths.map(marker)].join('\n');
}

/** The type the bytes themselves say they are; a file's name proves nothing. */
export function sniff(b: Uint8Array): ImageExt | null {
  const at = (from: number, ascii: string): boolean => {
    if (b.length < from + ascii.length) return false;
    for (let i = 0; i < ascii.length; i++) if (b[from + i] !== ascii.charCodeAt(i)) return false;
    return true;
  };
  if (at(0, '\x89PNG\r\n\x1a\n')) return 'png';
  if (at(0, '\xff\xd8\xff')) return 'jpg';
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return 'gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'webp';
  return null;
}

/** How wide and high the picture is, read from its own header; null when the header does not say. */
export function dimensions(b: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const sane = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : null);
  try {
    switch (sniff(b)) {
      case 'png':
        // The first chunk is the header: its width and height follow the chunk's length and name.
        return sane(view.getUint32(16), view.getUint32(20));
      case 'gif':
        return sane(view.getUint16(6, true), view.getUint16(8, true));
      case 'jpg': {
        // Segments, each with its length, until the one that starts a frame.
        for (let at = 2; at + 9 < b.length;) {
          if (b[at] !== 0xff) return null;
          const kind = b[at + 1]!;
          if (kind === 0xff) { at += 1; continue; }
          if (kind >= 0xc0 && kind <= 0xcf && kind !== 0xc4 && kind !== 0xc8 && kind !== 0xcc) {
            return sane(view.getUint16(at + 7), view.getUint16(at + 5));
          }
          // Markers that stand alone have no length after them.
          if (kind === 0x01 || (kind >= 0xd0 && kind <= 0xd8)) { at += 2; continue; }
          at += 2 + view.getUint16(at + 2);
        }
        return null;
      }
      case 'webp': {
        const chunk = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
        if (chunk === 'VP8X') return b.length < 30 ? null : sane(1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)));
        if (chunk === 'VP8L' && b[20] === 0x2f) {
          const bits = view.getUint32(21, true);
          return sane(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
        }
        if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
          return sane(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
        }
        return null;
      }
      default:
        return null;
    }
  } catch {
    // A header cut short.
    return null;
  }
}

/** A size as a person reads it: 240 KB, 2.4 MB. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** An image attached to the line being typed, or named by a line already sent. */
export interface Attachment {
  /** `memory/images/<sha256>.<ext>`. */
  path: string;
  ext: string;
  width: number | null;
  height: number | null;
  bytes: number;
}

/** What a chip says after its number: `png · 1280×720 · 240 KB`. */
export function describe(a: Pick<Attachment, 'ext' | 'width' | 'height' | 'bytes'>, sep = '·', times = '×'): string {
  return [a.ext, ...(a.width !== null && a.height !== null ? [`${a.width}${times}${a.height}`] : []), sizeText(a.bytes)].join(` ${sep} `);
}

/** Why some bytes were not kept, in words for the owner. */
export class NotKept extends Error {}

/**
 * Keep an image under `root` for good and say what it is. The file is named by its content, so
 * the same picture kept twice is one file; it is written aside and renamed, so it is there whole
 * or not at all. Throws `NotKept` for what is too large or is not a picture.
 */
export function keep(root: string, bytes: Uint8Array): Attachment {
  if (bytes.length > IMAGE_MAX_BYTES) throw new NotKept(`it is ${sizeText(bytes.length)}, and the limit is ${IMAGE_MAX_BYTES / 1024 / 1024} MB for one image`);
  const ext = sniff(bytes);
  if (ext === null) throw new NotKept('it is not a PNG, JPEG, GIF or WebP image');
  const path = `${STORE}/${createHash('sha256').update(bytes).digest('hex')}.${ext}`;
  const target = join(root, path);
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true });
    const tmp = join(dirname(target), `.${process.pid}-${Date.now()}.tmp`);
    writeFileSync(tmp, bytes);
    renameSync(tmp, target);
  }
  const size = dimensions(bytes);
  return { path, ext, width: size?.width ?? null, height: size?.height ?? null, bytes: bytes.length };
}

/** What a kept image is, for showing a line that names it; null when the file is not there or is no image. Reads its first bytes only. */
export function look(root: string, path: string): Attachment | null {
  if (!MARKER.test(marker(path))) return null;
  try {
    const file = join(root, path);
    const size = statSync(file).size;
    const head = Buffer.alloc(Math.min(size, 256 * 1024));
    const fd = openSync(file, 'r');
    try {
      readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
    const ext = sniff(head);
    if (ext === null) return null;
    const d = dimensions(head);
    return { path, ext, width: d?.width ?? null, height: d?.height ?? null, bytes: size };
  } catch {
    return null;
  }
}

const IMAGE_NAME = /\.(?:png|jpe?g|gif|webp)$/i;
/** Whether a path is named as pictures are. Says nothing of what the file holds. */
export const namedLikeImage = (path: string): boolean => IMAGE_NAME.test(path);

/** One word of a shell line, quotes and escapes undone; null when the quoting never closes. */
function words(line: string): string[] | null {
  const out: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === ' ' || c === '\t') {
      if (word !== null) out.push(word);
      word = null;
    } else if (c === '\\') {
      if (i + 1 >= line.length) return null;
      word = (word ?? '') + line[i + 1];
      i += 1;
    } else if (c === '\'') {
      const end = line.indexOf('\'', i + 1);
      if (end === -1) return null;
      word = (word ?? '') + line.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      word ??= '';
      for (i += 1; ; i++) {
        if (i >= line.length) return null;
        if (line[i] === '"') break;
        if (line[i] === '\\' && i + 1 < line.length && '"\\$`'.includes(line[i + 1]!)) i += 1;
        word += line[i];
      }
    } else {
      word = (word ?? '') + c;
    }
  }
  if (word !== null) out.push(word);
  return out;
}

/** A word as a path on the owner's machine, or null when it is not one: absolute, under `~/`, or a `file://` address. */
function asPath(word: string): string | null {
  let path = word;
  const url = /^file:\/\/(?:localhost)?(\/.*)$/i.exec(word);
  if (url) {
    try {
      path = decodeURIComponent(url[1]!);
    } catch {
      return null;
    }
  }
  if (!(path.startsWith('/') || path.startsWith('~/')) || path.length < 2 || /[\x00-\x1f\x7f]/.test(path)) return null;
  return path;
}

/**
 * The files a pasted or typed text names, when it names files and nothing else: what a terminal
 * types when a file is dragged into it. One path or several, each in single or double quotes, or
 * with its spaces escaped, or as a `file://` address; or one path written as it is, spaces and
 * all, when it is named as pictures are. Anything else is text, and gives null.
 */
export function pathsIn(text: string): string[] | null {
  const line = text.trim();
  if (line === '' || line.length > 8192 || /[\n\r]/.test(line)) return null;
  const split = words(line);
  if (split !== null && split.length > 0 && split.length <= 16) {
    const paths = split.map(asPath);
    if (paths.every((path) => path !== null)) return paths as string[];
  }
  const whole = asPath(line);
  return whole !== null && namedLikeImage(whole) && !/['"\\]/.test(whole) ? [whole] : null;
}

/** How the helper on the host can read the clipboard, as it said itself when it started. */
export type ClipTool = 'xclip' | 'wl-paste' | 'pngpaste' | 'osascript' | 'none wayland' | 'none x11' | 'none headless';

export type ClipReply =
  | { ok: true; bytes: Buffer }
  /** `code` is the helper's own word for what went wrong; `detail` what it added. */
  | { ok: false; code: string; detail: string };

/** How long a request may go unanswered before the helper is taken for gone. */
const ANSWER_MS = 8000;

/**
 * The client's end of the talk with the helper on the host. A request is a file `req-N` holding
 * an action from a fixed set and, for a file, its path; the helper answers with `rep-N`, and
 * with the bytes in `dat-N`. Each is written aside and renamed. Nothing here waits: `ask` leaves
 * the request and `answer` is called until it has something.
 */
export class Clip {
  private serial = 0;
  private readonly asked = new Map<number, number>();

  /** `dir`: the directory shared with the helper, or null when there is no helper. */
  constructor(private readonly dir: string | null, private readonly now: () => number = Date.now) {}

  /** Whether a helper was started for this client and its directory is still there. */
  get there(): boolean {
    return this.dir !== null && existsSync(this.dir);
  }

  /** What the helper said of the clipboard when it started; null while it has not, or when there is none. */
  tool(): ClipTool | null {
    if (this.dir === null) return null;
    try {
      const said = readFileSync(join(this.dir, 'helper'), 'utf8').trim();
      return ['xclip', 'wl-paste', 'pngpaste', 'osascript', 'none wayland', 'none x11', 'none headless'].includes(said) ? said as ClipTool : null;
    } catch {
      return null;
    }
  }

  /** Leave a request. Returns its number, or null when it could not be left. */
  ask(action: 'clipboard' | 'file', path = ''): number | null {
    if (this.dir === null || /[\n\r\x00]/.test(path)) return null;
    this.serial += 1;
    const n = this.serial;
    try {
      const tmp = join(this.dir, `.req-${n}.tmp`);
      writeFileSync(tmp, `${action}\n${path}\n`);
      renameSync(tmp, join(this.dir, `req-${n}`));
    } catch {
      return null;
    }
    this.asked.set(n, this.now());
    return n;
  }

  /** The answer to request `n`, or null while there is none yet. An answer is given once; its files are removed. */
  answer(n: number): ClipReply | null {
    const since = this.asked.get(n);
    if (this.dir === null || since === undefined) return { ok: false, code: 'gone', detail: '' };
    const rep = join(this.dir, `rep-${n}`);
    const dat = join(this.dir, `dat-${n}`);
    let said: string;
    try {
      said = readFileSync(rep, 'utf8');
    } catch {
      if (this.now() - since < ANSWER_MS) return null;
      this.asked.delete(n);
      rmSync(join(this.dir, `req-${n}`), { force: true });
      return { ok: false, code: 'gone', detail: '' };
    }
    this.asked.delete(n);
    let reply: ClipReply;
    const [first = '', ...rest] = said.split('\n');
    if (first.trim() === 'ok') {
      try {
        // Never more than the limit is read, whatever the helper left there.
        const size = statSync(dat).size;
        reply = size > IMAGE_MAX_BYTES ? { ok: false, code: 'too-large', detail: String(size) } : { ok: true, bytes: readFileSync(dat) };
      } catch {
        reply = { ok: false, code: 'failed', detail: 'the helper said it had the image, and left none' };
      }
    } else {
      reply = { ok: false, code: /^error ([a-z-]+)/.exec(first)?.[1] ?? 'failed', detail: first.replace(/^error [a-z-]+ ?/, '').trim() || rest.join(' ').trim() };
    }
    rmSync(rep, { force: true });
    rmSync(dat, { force: true });
    return reply;
  }
}

/** What to install or do when the helper has no way to read the clipboard, in words for the owner. */
export function whyNoClipboard(tool: ClipTool | null, there: boolean): string | null {
  if (!there) {
    return 'This client was started without its helper on your machine (./box talk starts one; a plain docker exec or bun kernel/talk.ts does not), so it cannot reach your clipboard. /image <path> still takes a file this client can read itself.';
  }
  switch (tool) {
    case 'none wayland': return 'Your machine has no tool to read the clipboard with. On Wayland that is wl-paste: install the package wl-clipboard, then run ./box talk again. /image <path> and dragging a file in work without it.';
    case 'none x11': return 'Your machine has no tool to read the clipboard with. On X11 that is xclip: install the package xclip, then run ./box talk again. /image <path> and dragging a file in work without it.';
    case 'none headless': return 'The shell that ran ./box talk has no display (neither WAYLAND_DISPLAY nor DISPLAY is set, as over SSH), so there is no clipboard to read. /image <path> and dragging a file in still work.';
    case null: return 'The helper on your machine has not answered yet. Try again in a moment.';
    default: return null;
  }
}
