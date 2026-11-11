import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IMAGE_CHARS, IMAGE_MAX_BYTES, imageStore, keepImage, rootOf, splitMarkers } from '../../body/images';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const WEBP = Buffer.from('RIFF\x1a\x00\x00\x00WEBPVP8 ', 'latin1');

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** An individual's root with an image store, and a way to put a file in it under its content's name. */
function root() {
  const dir = mkdtempSync(join(tmpdir(), 'teneral-images-'));
  mkdirSync(join(dir, 'memory', 'images'), { recursive: true });
  const put = (bytes: Buffer, ext = 'png'): string => {
    const path = `memory/images/${hash(bytes)}.${ext}`;
    writeFileSync(join(dir, path), bytes);
    return path;
  };
  return { dir, put };
}

test('the root is the directory that holds memory/, from the journal\'s path', () => {
  expect(rootOf('/data/me/memory/journal.jsonl')).toBe('/data/me');
});

test('marker lines are taken from the end of a message only, in order, and only in the exact form', () => {
  const a = `memory/images/${'a'.repeat(64)}.png`;
  const b = `memory/images/${'b'.repeat(64)}.jpeg`;
  expect(splitMarkers(`look at these\n[image: ${a}]\n[image: ${b}]`)).toEqual({ text: 'look at these', paths: [a, b] });
  expect(splitMarkers(`[image: ${a}]`)).toEqual({ text: '', paths: [a] });
  expect(splitMarkers('no marker here')).toEqual({ text: 'no marker here', paths: [] });
  // In the middle of the text it is text.
  expect(splitMarkers(`[image: ${a}]\nand then words`).paths).toEqual([]);
  const not = [
    `[image: memory/images/${'a'.repeat(63)}.png]`, `[image: memory/images/${'A'.repeat(64)}.png]`, `[image: memory/images/${'a'.repeat(64)}.svg]`,
    `[image: memory/images/../${'a'.repeat(64)}.png]`, `[image: /etc/${'a'.repeat(64)}.png]`, `[image: memory/images/${'a'.repeat(64)}.png] `,
    ` [image: ${a}]`, `[image:${a}]`, `[image: ${a}] [image: ${b}]`, `words [image: ${a}]`, `[image: memory/images/x/${'a'.repeat(64)}.png]`,
    '[image: ../../.env]', '[image: memory/images/]',
  ];
  for (const line of not) expect(splitMarkers(`text\n${line}`)).toEqual({ text: `text\n${line}`.trimEnd(), paths: [] });
});

test('an image of each supported kind is loaded with the type its bytes say, whatever its name says', () => {
  const r = root();
  const load = imageStore(r.dir);
  expect(load(r.put(PNG))).toEqual({ name: `${hash(PNG)}.png`, mime: 'image/png', data: PNG.toString('base64') });
  expect(load(r.put(JPEG, 'jpg'))).toMatchObject({ mime: 'image/jpeg' });
  expect(load(r.put(GIF, 'gif'))).toMatchObject({ mime: 'image/gif' });
  expect(load(r.put(WEBP, 'webp'))).toMatchObject({ mime: 'image/webp' });
  // A JPEG under a .png name is sent as what it is.
  expect(load(r.put(JPEG, 'png'))).toMatchObject({ mime: 'image/jpeg', data: JPEG.toString('base64') });
});

test('what cannot be shown gives a reason as text, never an error', () => {
  const r = root();
  const load = imageStore(r.dir);
  expect(load(`memory/images/${'0'.repeat(64)}.png`)).toBe('the file is missing');
  expect(load(r.put(Buffer.from('#!/bin/sh\necho no\n')))).toBe('it is not a PNG, JPEG, GIF or WebP image');
  expect(load(r.put(Buffer.alloc(0)))).toBe('it is not a PNG, JPEG, GIF or WebP image');
  const big = r.put(PNG, 'webp');
  truncateSync(join(r.dir, big), IMAGE_MAX_BYTES + 1);
  expect(load(big)).toBe('it is larger than 10 MB');
  const dir = `memory/images/${'d'.repeat(64)}.png`;
  mkdirSync(join(r.dir, dir));
  expect(load(dir)).toBe('it is not a file');
  // Exactly at the limit it is taken.
  const full = r.put(GIF, 'gif');
  truncateSync(join(r.dir, full), IMAGE_MAX_BYTES);
  expect(load(full)).toMatchObject({ mime: 'image/gif' });
});

test('only a path in the marker\'s exact form is looked at: nothing else reaches the file system', () => {
  const r = root();
  writeFileSync(join(r.dir, 'secret.png'), PNG);
  writeFileSync(join(r.dir, 'memory', 'images', 'plain.png'), PNG);
  const load = imageStore(r.dir);
  for (const path of ['secret.png', '../secret.png', 'memory/images/plain.png', `memory/images/../../secret.png`, join(r.dir, 'secret.png'), '/etc/passwd',
    `memory/images/${'a'.repeat(64)}.png/../../../secret.png`, `memory/images/${'a'.repeat(64)}.png\n`, '']) {
    expect(load(path)).toBe('the path is not one of the image store');
  }
});

test('a link that leads out of the store is not followed, and neither is a store that is itself a link', () => {
  const r = root();
  const outside = mkdtempSync(join(tmpdir(), 'teneral-outside-'));
  writeFileSync(join(outside, 'secret.png'), PNG);
  const name = `memory/images/${'c'.repeat(64)}.png`;
  symlinkSync(join(outside, 'secret.png'), join(r.dir, name));
  expect(imageStore(r.dir)(name)).toBe('the file is outside the image store');
  // A link that stays inside the store is an image like any other.
  const inside = r.put(PNG);
  const alias = `memory/images/${'e'.repeat(64)}.png`;
  symlinkSync(join(r.dir, inside), join(r.dir, alias));
  expect(imageStore(r.dir)(alias)).toMatchObject({ mime: 'image/png' });
  // A link to nowhere.
  const dangling = `memory/images/${'f'.repeat(64)}.png`;
  symlinkSync(join(outside, 'gone.png'), join(r.dir, dangling));
  expect(imageStore(r.dir)(dangling)).toBe('the file is missing');

  // The whole store replaced by a link to another directory that holds a well-named file.
  const other = root();
  const real = `${hash(PNG)}.png`;
  writeFileSync(join(outside, real), PNG);
  rmSync(join(other.dir, 'memory', 'images'), { recursive: true });
  symlinkSync(outside, join(other.dir, 'memory', 'images'));
  expect(imageStore(other.dir)(`memory/images/${real}`)).toBe('the file is outside the image store');
  // A root reached through a link is still the root.
  const linked = join(outside, 'root-link');
  symlinkSync(r.dir, linked);
  expect(imageStore(linked)(inside)).toMatchObject({ mime: 'image/png' });
});

test('a loaded image is kept, so a turn does not read the same file for every request; a failure is not kept', () => {
  const r = root();
  const load = imageStore(r.dir, 2);
  const path = r.put(PNG);
  const first = load(path);
  renameSync(join(r.dir, path), join(r.dir, 'memory', 'images', 'moved'));
  expect(load(path)).toBe(first as never);
  const late = `memory/images/${hash(GIF)}.gif`;
  expect(load(late)).toBe('the file is missing');
  r.put(GIF, 'gif');
  expect(load(late)).toMatchObject({ mime: 'image/gif' });
  // Only so many are kept: the oldest goes, and is then read from disk again.
  load(r.put(JPEG, 'jpg'));
  expect(load(path)).toBe('the file is missing');
});

test('keepImage copies an image into the store under the name of its content and gives the marker for it', () => {
  const r = root();
  const elsewhere = mkdtempSync(join(tmpdir(), 'teneral-shot-'));
  writeFileSync(join(elsewhere, 'shot.dat'), PNG);
  const kept = keepImage(r.dir, join(elsewhere, 'shot.dat'));
  expect(kept).toEqual({ marker: `[image: memory/images/${hash(PNG)}.png]`, mime: 'image/png', bytes: PNG.length });
  expect(readFileSync(join(r.dir, 'memory', 'images', `${hash(PNG)}.png`)).equals(PNG)).toBe(true);
  // The marker is one the store honours, and the same file kept twice is one file.
  expect(splitMarkers(kept.marker).paths).toHaveLength(1);
  expect(keepImage(r.dir, join(elsewhere, 'shot.dat'))).toEqual(kept);
  // Where there is no store yet, it is made.
  const fresh = mkdtempSync(join(tmpdir(), 'teneral-fresh-'));
  keepImage(fresh, join(elsewhere, 'shot.dat'));
  expect(existsSync(join(fresh, 'memory', 'images', `${hash(PNG)}.png`))).toBe(true);
});

test('keepImage refuses, saying why, what is not an image, is too large, or is not there', () => {
  const r = root();
  const dir = mkdtempSync(join(tmpdir(), 'teneral-shot-'));
  writeFileSync(join(dir, 'notes.png'), 'just text');
  expect(() => keepImage(r.dir, join(dir, 'notes.png'))).toThrow(/cannot be shown: it is not a PNG, JPEG, GIF or WebP image/);
  writeFileSync(join(dir, 'big.png'), PNG);
  truncateSync(join(dir, 'big.png'), IMAGE_MAX_BYTES + 1);
  expect(() => keepImage(r.dir, join(dir, 'big.png'))).toThrow(/larger than 10 MB/);
  expect(() => keepImage(r.dir, join(dir, 'gone.png'))).toThrow(/the file is missing/);
  expect(() => keepImage(r.dir, dir)).toThrow(/not a file/);
});

test('an image is charged what a large one costs the model in tokens, at four characters a token', () => {
  // 2,500 patches at most, times 1.2, is 3,000 tokens (OpenAI's vision guide, patch-based models at high detail).
  expect(IMAGE_CHARS).toBe(Math.ceil(2500 * 1.2) * 4);
});
