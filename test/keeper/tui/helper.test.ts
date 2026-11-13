import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Clip, IMAGE_MAX_BYTES, keep, type ClipReply } from '../../../keeper/tui/images';
import { gif, jpeg, png, webp } from './pictures';

// The helper that `./one talk` runs on the owner's machine, the real one: its functions are taken
// out of the `one` script as they stand and run here, with the client's own end of the talk
// (`Clip`) on the other side. No clipboard is touched: a stand-in for the clipboard tool is put
// first on the PATH where one is needed.

const BOX = join(import.meta.dir, '..', '..', '..', 'one');
const source = readFileSync(BOX, 'utf8');
const from = source.indexOf('clip_limit=');
const to = source.indexOf('# Start the helper for one client');
const functions = source.slice(from, to);
const bash = Bun.which('bash');
const started: { kill: () => void }[] = [];
afterAll(() => { for (const helper of started) helper.kill(); });

/** One helper over a directory of its own, as `clip_start` starts it; `env` is what its shell has. */
function helper(env: Record<string, string> = {}): { dir: string; clip: Clip; stop: () => void } {
  const dir = join(mkdtempSync(join(tmpdir(), 'teneral-helper-')), '.teneral', 'owner', '.clip', `${process.pid}-1`);
  mkdirSync(dir, { recursive: true });
  const script = join(dir, '..', 'helper.sh');
  writeFileSync(script, `set -euo pipefail\n${functions}\nclip_helper "$1" "$2"\n`);
  const { DISPLAY: _x, WAYLAND_DISPLAY: _w, ...rest } = process.env;
  const child = Bun.spawn([bash!, script, dir, String(process.pid)], { env: { ...rest, ...env }, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  started.push(child);
  return { dir, clip: new Clip(dir), stop: () => child.kill() };
}

async function answer(clip: Clip, n: number | null): Promise<ClipReply> {
  expect(n).not.toBeNull();
  for (let i = 0; i < 400; i++) {
    const reply = clip.answer(n!);
    if (reply !== null) return reply;
    await Bun.sleep(25);
  }
  throw new Error('the helper did not answer');
}

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

test.skipIf(bash === null)('the part of box that is the helper is found where this test looks for it', () => {
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  for (const name of ['clip_tool()', 'clip_reply()', 'clip_save()', 'clip_file()', 'clip_helper()', 'clip_clear()']) expect(functions).toContain(name);
  // Nothing a request holds is ever run, and nothing is removed by walking a directory.
  expect(functions).not.toMatch(/\beval\b|\bsource\b|rm -r|\$\(\s*\$(path|action)/);
});

test.skipIf(bash === null)('the real helper brings in an image file byte for byte, whatever its name, and refuses what is no image, too large, missing or no file', async () => {
  const h = helper();
  const files = mkdtempSync(join(tmpdir(), 'teneral-files-'));
  mkdirSync(join(files, 'My Pictures'));
  const pictures: [string, Buffer][] = [
    ['My Pictures/shot (1).png', png(640, 360, 3000)], ['photo.JPG', jpeg(4032, 3024)], ['anim.gif', gif(32, 32)], ['modern.webp', webp('VP8X', 100, 50)],
    ['named-wrong.txt', png(8, 8)], ['it\'s "quoted" $HOME `x`.png', png(9, 9)],
  ];
  for (const [name, bytes] of pictures) writeFileSync(join(files, name), bytes);
  writeFileSync(join(files, 'notes.png'), 'not a picture at all\n');
  writeFileSync(join(files, 'empty.png'), '');
  writeFileSync(join(files, 'big.png'), png(8, 8, IMAGE_MAX_BYTES));
  // The helper says what it can do before anything is asked: here, with no display, nothing of the clipboard.
  for (let i = 0; i < 200 && h.clip.tool() === null; i++) await Bun.sleep(25);
  expect(h.clip.tool()).toBe('none headless');

  for (const [name, bytes] of pictures) {
    const reply = await answer(h.clip, h.clip.ask('file', join(files, name)));
    expect(reply.ok).toBe(true);
    if (reply.ok) expect(sha(reply.bytes)).toBe(sha(bytes));
  }
  expect(await answer(h.clip, h.clip.ask('file', join(files, 'notes.png')))).toEqual({ ok: false, code: 'not-image', detail: '' });
  expect(await answer(h.clip, h.clip.ask('file', join(files, 'empty.png')))).toEqual({ ok: false, code: 'not-image', detail: '' });
  expect(await answer(h.clip, h.clip.ask('file', join(files, 'big.png')))).toEqual({ ok: false, code: 'too-large', detail: String(png(8, 8, IMAGE_MAX_BYTES).length) });
  expect(await answer(h.clip, h.clip.ask('file', join(files, 'nothing.png')))).toEqual({ ok: false, code: 'not-found', detail: '' });
  expect(await answer(h.clip, h.clip.ask('file', files))).toEqual({ ok: false, code: 'not-file', detail: '' });
  expect(await answer(h.clip, h.clip.ask('file', 'relative/shot.png'))).toEqual({ ok: false, code: 'not-found', detail: '' });
  // A path is read and never run; a clipboard with no tool to read it says so.
  expect(await answer(h.clip, h.clip.ask('file', `$(touch ${files}/PWNED); \`touch ${files}/PWNED\``))).toEqual({ ok: false, code: 'not-found', detail: '' });
  expect(await answer(h.clip, h.clip.ask('clipboard'))).toEqual({ ok: false, code: 'no-tool', detail: '' });
  expect(readdirSync(files)).not.toContain('PWNED');
  // Every answer was taken and its files with it: the two ends leave nothing lying about.
  expect(readdirSync(h.dir)).toEqual(['helper']);
  h.stop();
}, 30_000);

test.skipIf(bash === null)('the real helper takes the clipboard\'s image through the tool the machine has: PNG before the other kinds, as it is, and says when there is none or it is too large', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'teneral-bin-'));
  const shot = png(1280, 720, 9000);
  writeFileSync(join(bin, 'clipboard.png'), shot);
  // A stand-in for wl-paste, which lists what the clipboard offers and gives the kind asked for.
  writeFileSync(join(bin, 'wl-paste'), `#!/bin/sh
case "$*" in
  *--list-types*) cat "${bin}/types" ;;
  *image/png*) cat "${bin}/clipboard.png" ;;
  *image/jpeg*) printf 'not what should be taken' ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, 'types'), 'text/plain\nimage/jpeg\nimage/png\n');
  const h = helper({ WAYLAND_DISPLAY: 'wayland-0', PATH: `${bin}:${process.env.PATH ?? ''}` });
  for (let i = 0; i < 200 && h.clip.tool() === null; i++) await Bun.sleep(25);
  expect(h.clip.tool()).toBe('wl-paste');
  const reply = await answer(h.clip, h.clip.ask('clipboard'));
  expect(reply.ok).toBe(true);
  if (reply.ok) {
    expect(sha(reply.bytes)).toBe(sha(shot));
    // And what arrives is kept under the name its bytes give it.
    const root = mkdtempSync(join(tmpdir(), 'teneral-root-'));
    expect(keep(root, reply.bytes)).toMatchObject({ path: `memory/images/${sha(shot)}.png`, width: 1280, height: 720 });
  }
  // Text only in the clipboard: no image. An image over the limit: refused by the helper, with its size.
  writeFileSync(join(bin, 'types'), 'text/plain\nUTF8_STRING\n');
  expect(await answer(h.clip, h.clip.ask('clipboard'))).toEqual({ ok: false, code: 'no-image', detail: '' });
  writeFileSync(join(bin, 'types'), 'image/png\n');
  writeFileSync(join(bin, 'clipboard.png'), png(8, 8, IMAGE_MAX_BYTES));
  expect(await answer(h.clip, h.clip.ask('clipboard'))).toEqual({ ok: false, code: 'too-large', detail: String(png(8, 8, IMAGE_MAX_BYTES).length) });
  expect(readdirSync(h.dir)).toEqual(['helper']);
  h.stop();
}, 30_000);

test.skipIf(bash === null)('the helper ends by itself when its directory goes', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'teneral-helper-')), '.teneral', 'owner', '.clip', `${process.pid}-2`);
  mkdirSync(dir, { recursive: true });
  const script = join(dir, '..', 'run.sh');
  // As box does when the client has left: the directory is cleared by the names of its files, and removed.
  writeFileSync(script, `set -euo pipefail\n${functions}\nclip_helper "$1" "$2" &\nsleep 0.5\nclip_clear "$1"\nwait\n`);
  const child = Bun.spawn([bash!, script, dir, String(process.pid)], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  started.push(child);
  expect(await Promise.race([child.exited, Bun.sleep(8000).then(() => 'still running')])).toBe(0);
  expect(readdirSync(join(dir, '..'))).toEqual(['run.sh']);
}, 15_000);
