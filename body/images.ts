import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';

// Images the model is shown. They live as files under `<root>/memory/images/`, named by the SHA-256
// of their bytes, where `<root>` is the directory that holds `memory/`. The owner's terminal puts
// a file there and ends the message with a line naming it; `look` (body/tools.ts) puts one there
// for the agent itself. The journal holds only the line: brain/memory.ts decides which lines are
// honoured (the owner's, and the results of `look`), and nothing else ever makes a file be read.

export interface Image {
  /** The file's name in the store. */
  name: string;
  mime: string;
  /** The bytes, in base64. */
  data: string;
}

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** Markers honoured in one message. */
export const IMAGES_PER_MESSAGE = 4;
/** Images sent in one request, unless the owner set another number (body/main.ts). */
export const DEFAULT_IMAGES = 4;
/**
 * What one image counts for against the character budget of a request. Not its base64 length: a
 * megabyte of picture is a few thousand tokens to the model, not a million characters. OpenAI's
 * vision guide gives at most 2,500 patches for an image at high detail and a multiplier of 1.2,
 * so 3,000 tokens; at the four characters a token that the budget assumes of text, 12,000.
 */
export const IMAGE_CHARS = 12_000;

const STORE = 'memory/images';
const MARKER = /^\[image: (memory\/images\/[0-9a-f]{64}\.(?:png|jpg|jpeg|gif|webp))\]$/;

/** The individual's root, from where its journal is: `<root>/memory/journal.jsonl`. */
export function rootOf(journal: string): string {
  return dirname(dirname(journal));
}

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

/** The type the bytes themselves say they are; a file's name proves nothing. */
function kind(b: Buffer): { mime: string; ext: string } | null {
  const at = (from: number, ascii: string): boolean => b.subarray(from, from + ascii.length).toString('latin1') === ascii;
  if (at(0, '\x89PNG\r\n\x1a\n')) return { mime: 'image/png', ext: 'png' };
  if (at(0, '\xff\xd8\xff')) return { mime: 'image/jpeg', ext: 'jpg' };
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return { mime: 'image/gif', ext: 'gif' };
  if (at(0, 'RIFF') && at(8, 'WEBP')) return { mime: 'image/webp', ext: 'webp' };
  return null;
}

/** The bytes of an image file and their type, or, as text, why it cannot be shown. Never throws. */
function readImage(file: string): { bytes: Buffer; mime: string; ext: string } | string {
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return 'it is not a file';
    if (stat.size > IMAGE_MAX_BYTES) return `it is larger than ${IMAGE_MAX_BYTES / 1024 / 1024} MB`;
    const bytes = readFileSync(file);
    if (bytes.length > IMAGE_MAX_BYTES) return `it is larger than ${IMAGE_MAX_BYTES / 1024 / 1024} MB`;
    const is = kind(bytes);
    return is === null ? 'it is not a PNG, JPEG, GIF or WebP image' : { bytes, ...is };
  } catch (err) {
    return (err as { code?: unknown }).code === 'ENOENT' ? 'the file is missing' : 'the file cannot be read';
  }
}

/**
 * Loads images of the store under `root` by the path a marker names. The path is taken only in the
 * marker's exact form, and the file it leads to, links followed, must lie in the store itself: a
 * link out of it, or a store that is itself a link, is refused. What was loaded is kept, since
 * every request of a turn shows the same few files and a file named by its content does not change.
 */
export function imageStore(root: string, keep = 8): (path: string) => Image | string {
  const kept = new Map<string, Image>();
  return (path) => {
    if (!MARKER.test(`[image: ${path}]`)) return 'the path is not one of the image store';
    const known = kept.get(path);
    if (known) return known;
    let real: string;
    try {
      real = realpathSync(join(root, path));
      if (!real.startsWith(join(realpathSync(root), STORE) + sep)) return 'the file is outside the image store';
    } catch {
      return 'the file is missing';
    }
    const read = readImage(real);
    if (typeof read === 'string') return read;
    const image = { name: basename(path), mime: read.mime, data: read.bytes.toString('base64') };
    if (kept.size >= keep) kept.delete(kept.keys().next().value!);
    kept.set(path, image);
    return image;
  };
}

/** Copies the image at `file` into the store under `root` and returns the marker line that names it. Throws, saying why, when it is not an image that can be shown. */
export function keepImage(root: string, file: string): { marker: string; mime: string; bytes: number } {
  const read = readImage(file);
  if (typeof read === 'string') throw new Error(`${file} cannot be shown: ${read}`);
  const path = `${STORE}/${createHash('sha256').update(read.bytes).digest('hex')}.${read.ext}`;
  const target = join(root, path);
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, read.bytes);
  }
  return { marker: `[image: ${path}]`, mime: read.mime, bytes: read.bytes.length };
}
