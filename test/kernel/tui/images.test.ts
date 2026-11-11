import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Clip, IMAGES_PER_MESSAGE, IMAGE_MAX_BYTES, NotKept, describe, dimensions, keep, look, marker, namedLikeImage, pathsIn, sizeText, sniff,
  splitMarkers, whyNoClipboard, withMarkers,
} from '../../../kernel/tui/images';
import { gif, jpeg, png, webp } from './pictures';

const ONE = `memory/images/${'1'.repeat(64)}.png`;
const TWO = `memory/images/${'2'.repeat(64)}.jpeg`;

// --- the line that names an image ---

test('a message carries its images as lines at its end, one for each, in exactly one form', () => {
  expect(marker(ONE)).toBe(`[image: ${ONE}]`);
  expect(withMarkers('look at this ', [ONE, TWO])).toBe(`look at this\n[image: ${ONE}]\n[image: ${TWO}]`);
  expect(withMarkers('', [ONE])).toBe(`[image: ${ONE}]`);
  expect(withMarkers('only words', [])).toBe('only words');
  expect(splitMarkers(`look at this\n[image: ${ONE}]\n[image: ${TWO}]`)).toEqual({ text: 'look at this', paths: [ONE, TWO] });
  expect(splitMarkers(`[image: ${ONE}]`)).toEqual({ text: '', paths: [ONE] });
  expect(splitMarkers('no images\nhere')).toEqual({ text: 'no images\nhere', paths: [] });
  expect(IMAGES_PER_MESSAGE).toBe(4);
});

test('only lines at the end, and only of that exact form, name images: anything else is the words it is', () => {
  // In the middle of a text it is text.
  expect(splitMarkers(`[image: ${ONE}]\nand then words`).paths).toEqual([]);
  for (const not of [
    '[image: memory/images/abc.png]', `[image: ${ONE.replace('.png', '.svg')}]`, `[image: /etc/${'1'.repeat(64)}.png]`, `[image: memory/images/../${'1'.repeat(64)}.png]`,
    `[image:${ONE}]`, `[Image: ${ONE}]`, ` [image: ${ONE}]`, `[image: ${ONE}] `, `[image: ${ONE.toUpperCase()}]`, `[image: memory/images/${'g'.repeat(64)}.png]`,
  ]) {
    expect(splitMarkers(`words\n${not}`)).toEqual({ text: `words\n${not}`.trimEnd(), paths: [] });
  }
  for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp']) expect(splitMarkers(`[image: memory/images/${'a'.repeat(64)}.${ext}]`).paths).toHaveLength(1);
});

// --- what the bytes say ---

test('the kind of picture is told from its first bytes, never from a name', () => {
  expect(sniff(png(1, 1))).toBe('png');
  expect(sniff(jpeg(1, 1))).toBe('jpg');
  expect(sniff(gif(1, 1))).toBe('gif');
  expect(sniff(Buffer.from('GIF87a....'))).toBe('gif');
  for (const kind of ['VP8X', 'VP8L', 'VP8 '] as const) expect(sniff(webp(kind, 1, 1))).toBe('webp');
  for (const not of ['', 'hello', '<svg xmlns="http://www.w3.org/2000/svg"/>', '%PDF-1.7', 'RIFF\0\0\0\0WAVEfmt ', '\x89PNG', 'GIF90a', 'BM\0\0']) expect(sniff(Buffer.from(not, 'latin1'))).toBeNull();
});

test('the size of the picture is read from the header of each format', () => {
  expect(dimensions(png(1280, 720))).toEqual({ width: 1280, height: 720 });
  expect(dimensions(png(70_000, 3))).toEqual({ width: 70_000, height: 3 });
  expect(dimensions(gif(640, 480))).toEqual({ width: 640, height: 480 });
  expect(dimensions(jpeg(4032, 3024))).toEqual({ width: 4032, height: 3024 });
  expect(dimensions(webp('VP8X', 16_000, 9000))).toEqual({ width: 16_000, height: 9000 });
  expect(dimensions(webp('VP8L', 801, 601))).toEqual({ width: 801, height: 601 });
  expect(dimensions(webp('VP8 ', 320, 200))).toEqual({ width: 320, height: 200 });
  // A header cut short, or of no picture, has no size; nothing throws.
  for (const short of [png(10, 10).subarray(0, 18), jpeg(10, 10).subarray(0, 24), gif(1, 1).subarray(0, 7), webp('VP8X', 5, 5).subarray(0, 22), Buffer.from('hello'), Buffer.alloc(0), png(0, 0)]) {
    expect(dimensions(short)).toBeNull();
  }
});

test('a chip says the kind, the size in pixels when known, and the size in bytes as a person reads it', () => {
  expect([0, 900, 1024, 245_760, 1_048_576, 2_500_000, IMAGE_MAX_BYTES].map(sizeText)).toEqual(['0 B', '900 B', '1 KB', '240 KB', '1.0 MB', '2.4 MB', '10.0 MB']);
  expect(describe({ ext: 'png', width: 1280, height: 720, bytes: 245_760 })).toBe('png · 1280×720 · 240 KB');
  expect(describe({ ext: 'jpg', width: null, height: null, bytes: 900 })).toBe('jpg · 900 B');
  expect(describe({ ext: 'gif', width: 2, height: 3, bytes: 2048 }, '|', 'x')).toBe('gif | 2x3 | 2 KB');
});

// --- keeping ---

test('an image is kept under the SHA-256 of its bytes with the extension its bytes call for, whole or not at all, and once', () => {
  const root = mkdtempSync(join(tmpdir(), 'teneral-images-'));
  const bytes = png(1280, 720, 5000);
  const kept = keep(root, bytes);
  const sha = createHash('sha256').update(bytes).digest('hex');
  expect(kept).toEqual({ path: `memory/images/${sha}.png`, ext: 'png', width: 1280, height: 720, bytes: bytes.length });
  expect(readFileSync(join(root, kept.path)).equals(bytes)).toBe(true);
  expect(splitMarkers(marker(kept.path)).paths).toEqual([kept.path]);
  // The same picture again is the same file; nothing is left beside it.
  expect(keep(root, bytes).path).toBe(kept.path);
  expect(keep(root, jpeg(8, 8)).path).toMatch(/^memory\/images\/[0-9a-f]{64}\.jpg$/);
  expect(keep(root, gif(8, 8)).ext).toBe('gif');
  expect(keep(root, webp('VP8L', 8, 8)).ext).toBe('webp');
  expect(readdirSync(join(root, 'memory', 'images')).sort()).toHaveLength(4);
  expect(readdirSync(join(root, 'memory', 'images')).every((name) => /^[0-9a-f]{64}\.(png|jpg|gif|webp)$/.test(name))).toBe(true);
  // What a line names is looked at without reading it whole.
  expect(look(root, kept.path)).toEqual(kept);
  expect(look(root, `memory/images/${'0'.repeat(64)}.png`)).toBeNull();
  expect(look(root, '../../etc/passwd')).toBeNull();
});

test('what is over 10 MB, or is no picture, is refused with the reason, and nothing is written', () => {
  const root = mkdtempSync(join(tmpdir(), 'teneral-images-'));
  expect(() => keep(root, png(10, 10, IMAGE_MAX_BYTES))).toThrow(NotKept);
  expect(() => keep(root, png(10, 10, IMAGE_MAX_BYTES))).toThrow(/it is 10\.0 MB, and the limit is 10 MB for one image/);
  expect(() => keep(root, Buffer.from('#!/bin/sh\nrm -rf /\n'))).toThrow(/it is not a PNG, JPEG, GIF or WebP image/);
  expect(() => keep(root, Buffer.alloc(0))).toThrow(NotKept);
  expect(existsSync(join(root, 'memory'))).toBe(false);
  // Exactly at the limit it is kept.
  const most = png(10, 10, IMAGE_MAX_BYTES - png(10, 10).length);
  expect(most.length).toBe(IMAGE_MAX_BYTES);
  expect(keep(root, most).bytes).toBe(IMAGE_MAX_BYTES);
});

// --- a path, as a terminal types it when a file is dragged in ---

test('a text that is the path of a file and nothing else is known as one: quoted, escaped, as a file address, with spaces', () => {
  expect(pathsIn('/home/me/a.png')).toEqual(['/home/me/a.png']);
  expect(pathsIn('  /home/me/a.png \n')).toEqual(['/home/me/a.png']);
  expect(pathsIn('\'/home/me/My Pictures/a b.png\' ')).toEqual(['/home/me/My Pictures/a b.png']);
  expect(pathsIn('"/home/me/My Pictures/a b.png"')).toEqual(['/home/me/My Pictures/a b.png']);
  expect(pathsIn('/home/me/My\\ Pictures/a\\ \\(1\\).png')).toEqual(['/home/me/My Pictures/a (1).png']);
  expect(pathsIn('\'/home/me/it\'\\\'\'s.png\'')).toEqual(['/home/me/it\'s.png']);
  expect(pathsIn('"/home/me/say \\"hi\\".png"')).toEqual(['/home/me/say "hi".png']);
  expect(pathsIn('file:///home/me/My%20Pictures/%D1%84%D0%BE%D1%82%D0%BE.png')).toEqual(['/home/me/My Pictures/фото.png']);
  expect(pathsIn('file://localhost/home/me/a.jpg')).toEqual(['/home/me/a.jpg']);
  expect(pathsIn('~/Pictures/a.webp')).toEqual(['~/Pictures/a.webp']);
  // Written as it is, spaces and all: one path, when it is named as pictures are.
  expect(pathsIn('/home/me/My Pictures/screen shot.PNG')).toEqual(['/home/me/My Pictures/screen shot.PNG']);
  // Several files dragged at once.
  expect(pathsIn('\'/a/one.png\' \'/b/two three.jpg\'')).toEqual(['/a/one.png', '/b/two three.jpg']);
  // A path that is no picture by its name is still a path: what it holds is the helper's to say.
  expect(pathsIn('/home/me/notes')).toEqual(['/home/me/notes']);
  expect([namedLikeImage('/a/b.JPEG'), namedLikeImage('/a/b.jpg'), namedLikeImage('/a/b.gif'), namedLikeImage('/a/b.txt'), namedLikeImage('/a/png')]).toEqual([true, true, true, false, false]);
});

test('anything else is text: words, a path among words, a relative path, an address on the web, several lines', () => {
  for (const text of [
    '', '   ', 'hello', 'look at /home/me/a.png', '/teneral/body is where you live', '/home/me/a.png please', 'a.png', './a.png', '../a.png', 'pictures/a.png',
    'https://example.com/a.png', 'file://other-host/home/me/a.png', 'file:///home/me/%zz.png', '/home/me/a.png\n/home/me/b.png', '\'/home/me/unclosed.png', '"/home/me/unclosed.png',
    '/', '~', '/home/me/a\x07.png', `/${'a'.repeat(9000)}.png`, '/home/me/My Documents/notes.txt',
  ]) {
    expect(pathsIn(text)).toBeNull();
  }
});

// --- the talk with the helper on the owner's machine ---

/** A helper as `./box talk` runs one, for a test: it answers every request waiting in `dir` with what `answer` gives. */
function helper(dir: string, answer: (action: string, path: string) => { first: string; data?: Buffer }): string[] {
  const seen: string[] = [];
  for (const name of readdirSync(dir).filter((file) => /^req-\d+$/.test(file)).sort()) {
    const n = name.slice(4);
    const [action = '', path = ''] = readFileSync(join(dir, name), 'utf8').split('\n');
    unlinkSync(join(dir, name));
    seen.push(`${action} ${path}`.trim());
    const { first, data } = answer(action, path);
    if (data) writeFileSync(join(dir, `dat-${n}`), data);
    writeFileSync(join(dir, `.rep-${n}.tmp`), `${first}\n`);
    renameSync(join(dir, `.rep-${n}.tmp`), join(dir, `rep-${n}`));
  }
  return seen;
}

function shared(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'teneral-clip-')), '.clip', '123-4');
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('a request is a file naming an action and a path; the answer comes back once, with the bytes, and the files are cleared away', () => {
  const dir = shared();
  writeFileSync(join(dir, 'helper'), 'xclip\n');
  const clip = new Clip(dir);
  expect(clip.there).toBe(true);
  expect(clip.tool()).toBe('xclip');
  const a = clip.ask('clipboard')!;
  const b = clip.ask('file', '/home/me/My Pictures/a b.png')!;
  expect([a, b]).toEqual([1, 2]);
  expect(readFileSync(join(dir, 'req-1'), 'utf8')).toBe('clipboard\n\n');
  expect(readFileSync(join(dir, 'req-2'), 'utf8')).toBe('file\n/home/me/My Pictures/a b.png\n');
  // Not answered yet: nothing, and asking again changes nothing.
  expect(clip.answer(a)).toBeNull();
  expect(clip.answer(b)).toBeNull();
  const picture = png(64, 48, 100);
  expect(helper(dir, (action) => (action === 'clipboard' ? { first: 'ok', data: picture } : { first: 'error not-found' }))).toEqual(['clipboard', 'file /home/me/My Pictures/a b.png']);
  const got = clip.answer(a);
  expect(got).toMatchObject({ ok: true });
  expect(got !== null && got.ok && got.bytes.equals(picture)).toBe(true);
  expect(clip.answer(b)).toEqual({ ok: false, code: 'not-found', detail: '' });
  expect(readdirSync(dir)).toEqual(['helper']);
  // An answer is given once.
  expect(clip.answer(a)).toMatchObject({ ok: false, code: 'gone' });
});

test('what the helper refuses comes back as its word for it; a path that could carry a second line is never asked for', () => {
  const dir = shared();
  const clip = new Clip(dir);
  const asked = [clip.ask('clipboard')!, clip.ask('file', '/x/big.png')!, clip.ask('file', '/x/notes.txt')!, clip.ask('clipboard')!, clip.ask('clipboard')!];
  const answers = [{ first: 'error no-image' }, { first: 'error too-large 14200000' }, { first: 'error not-image' }, { first: 'error no-tool' }, { first: 'nonsense\x1b[2J' }];
  let i = 0;
  helper(dir, () => answers[i++]!);
  expect(asked.map((n) => clip.answer(n))).toEqual([
    { ok: false, code: 'no-image', detail: '' }, { ok: false, code: 'too-large', detail: '14200000' }, { ok: false, code: 'not-image', detail: '' },
    { ok: false, code: 'no-tool', detail: '' }, { ok: false, code: 'failed', detail: 'nonsense\x1b[2J' },
  ]);
  expect(clip.ask('file', '/x/a.png\nclipboard')).toBeNull();
  expect(clip.ask('file', '/x/a.png\rb')).toBeNull();
  expect(readdirSync(dir)).toEqual([]);
});

test('the client never reads more than the limit, whatever the helper left; and says ok only with the bytes there', () => {
  const dir = shared();
  const clip = new Clip(dir);
  const big = clip.ask('clipboard')!;
  helper(dir, () => ({ first: 'ok', data: Buffer.alloc(IMAGE_MAX_BYTES + 1) }));
  expect(clip.answer(big)).toEqual({ ok: false, code: 'too-large', detail: String(IMAGE_MAX_BYTES + 1) });
  const none = clip.ask('clipboard')!;
  helper(dir, () => ({ first: 'ok' }));
  expect(clip.answer(none)).toMatchObject({ ok: false, code: 'failed' });
  expect(readdirSync(dir)).toEqual([]);
});

test('a helper that does not answer is given up on after a while, and its request is taken back', () => {
  const dir = shared();
  let now = 1000;
  const clip = new Clip(dir, () => now);
  const n = clip.ask('clipboard')!;
  now += 7000;
  expect(clip.answer(n)).toBeNull();
  now += 2000;
  expect(clip.answer(n)).toEqual({ ok: false, code: 'gone', detail: '' });
  expect(readdirSync(dir)).toEqual([]);
});

test('without a helper nothing can be asked, and the owner is told exactly why and what to do', () => {
  const none = new Clip(null);
  expect([none.there, none.tool(), none.ask('clipboard')]).toEqual([false, null, null]);
  expect(whyNoClipboard(null, false)).toContain('./box talk starts one');
  expect(whyNoClipboard(null, false)).toContain('/image <path>');
  expect(whyNoClipboard('none x11', true)).toContain('install the package xclip');
  expect(whyNoClipboard('none wayland', true)).toContain('install the package wl-clipboard');
  expect(whyNoClipboard('none headless', true)).toContain('neither WAYLAND_DISPLAY nor DISPLAY');
  expect(whyNoClipboard(null, true)).toContain('has not answered yet');
  for (const tool of ['xclip', 'wl-paste', 'pngpaste', 'osascript'] as const) expect(whyNoClipboard(tool, true)).toBeNull();
  // What the helper says of itself is believed only when it is one of the things a helper says.
  const dir = shared();
  writeFileSync(join(dir, 'helper'), 'rm -rf\n');
  expect(new Clip(dir).tool()).toBeNull();
  writeFileSync(join(dir, 'helper'), 'none wayland\n');
  expect(new Clip(dir).tool()).toBe('none wayland');
});
