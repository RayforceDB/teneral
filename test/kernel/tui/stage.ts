import { expect } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { EventBody } from '../../../kernel/journal';
import { paths, type Paths } from '../../../kernel/supervisor';
import type { Alive } from '../../../kernel/tui/model';
import { TalkScreen } from '../../../kernel/tui/talk';
import type { Caps } from '../../../kernel/tui/theme';
import { fakeTerm, type FakeTerm } from './vt';

// The talk client on a made-up terminal, over a journal the test writes: keys go in as the bytes a
// terminal sends, and what comes out is read as the characters the owner would see: the screen,
// and above it what has scrolled off into the terminal's scrollback.

export const A = 'a1b2c3d4'.repeat(5);
export const B = 'e5f6a7b8'.repeat(5);
export const C = '0c9d8e7f'.repeat(5);
/** When every story here begins. */
export const T0 = 1_800_000_000_000;

export interface Stage {
  term: FakeTerm;
  app: TalkScreen;
  p: Paths;
  /** Append one event to the journal, `at` milliseconds into the story. Returns its id. */
  journal: (body: EventBody, at?: number, gen?: string) => string;
  /** The time the screen reads, in milliseconds into the story. */
  clock: { at: number };
  alive: Alive;
  /** Let the client look at the journal, then give the screen as text. */
  frame: () => string;
  /** The same, with everything that scrolled off the screen above it: what the owner can scroll through. */
  all: () => string;
  /** The same, the live region only: from the blank row over what is under way, or over the input box, to the footer. */
  live: () => string;
  /** The directory the client shares with the helper on the owner's machine, when the stage has one. */
  clip: string;
  /** Press keys: the bytes a terminal sends. */
  type: (bytes: string) => void;
  /** The owner types a line here and sends it, and the agent's body takes it into the journal. */
  say: (text: string, at?: number) => void;
}

export function stage(cols: number, rows: number, o: { caps?: Partial<Caps>; env?: Record<string, string>; banner?: string; cage?: string; open?: boolean; lifelineMs?: number; reflow?: boolean; helper?: string; name?: string } = {}): Stage {
  const root = mkdtempSync(join(tmpdir(), 'teneral-screen-'));
  const p = paths(root);
  mkdirSync(dirname(p.journal), { recursive: true });
  // The individual's own name, as its soul gives it: in a file of its own choosing.
  if (o.name !== undefined) {
    mkdirSync(p.soul, { recursive: true });
    writeFileSync(join(p.soul, 'identity.md'), `# ${o.name}\n\nI am curious.\n\n# My owner and their work\n`);
  }
  const term = fakeTerm(cols, rows, o.caps);
  term.vt.reflow = o.reflow === true;
  // A helper on the owner's machine, as ./box talk starts one: its directory, and what it said of the clipboard.
  const clip = join(p.owner, '.clip', 'stage');
  if (o.helper !== undefined) {
    mkdirSync(clip, { recursive: true });
    writeFileSync(join(clip, 'helper'), `${o.helper}\n`);
  }
  const clock = { at: 0 };
  const alive: Alive = { supervisor: true, body: true };
  let serial = 0;
  mkdirSync(join(root, '.teneral'), { recursive: true });
  writeFileSync(join(root, '.teneral', 'id'), '5e1f0a9c-1111-4222-8333-444455556666\n');
  const app = new TalkScreen({ term, paths: p, env: { TENERAL_MODEL: 'gpt-6.1-sol', TENERAL_HOST_DIR: '/home/owner/work/teneral', ...(o.helper !== undefined ? { TENERAL_CLIP: 'stage' } : {}), ...o.env }, banner: o.banner ?? null, cage: o.cage ?? null, now: () => T0 + clock.at, alive: () => alive, lifelineMs: o.lifelineMs });
  // The client attaches when the story first looks at it, so that what a test journals before that is the history it finds.
  let opened = o.open === false;
  const attach = () => {
    if (opened) return;
    opened = true;
    app.open();
  };
  const s: Stage = {
    term, app, p, clock, alive, clip,
    journal: (body, at = clock.at, gen = A) => {
      serial += 1;
      const id = `e${serial}`;
      appendFileSync(p.journal, `${JSON.stringify({ ...body, v: 1, id, ts: new Date(T0 + at).toISOString(), gen })}\n`);
      return id;
    },
    frame: () => {
      attach();
      app.tick();
      return term.vt.text();
    },
    all: () => {
      attach();
      app.tick();
      return term.vt.all();
    },
    live: () => {
      attach();
      app.tick();
      // The terminal's cursor rests on the first row of the live region.
      return term.vt.text().split('\n').slice(term.vt.cursor.row).join('\n').trimEnd();
    },
    type: (bytes) => {
      attach();
      term.type(bytes);
      app.settleKeys();
    },
    say: (text, at) => {
      s.type(`${text}\r`);
      for (const name of existsSync(p.owner) ? readdirSync(p.owner) : []) if (!name.startsWith('.')) unlinkSync(join(p.owner, name));
      s.journal({ type: 'stimulus', source: 'terminal', text }, at);
    },
  };
  return s;
}

const FRAMES = join(import.meta.dir, 'frames');

/**
 * Compare a screen with the one kept under test/kernel/tui/frames/, which anyone can open to see
 * what the screens look like. UPDATE_FRAMES=1 writes them anew.
 */
export function expectFrame(name: string, text: string): void {
  const file = join(FRAMES, `${name}.txt`);
  if (process.env.UPDATE_FRAMES || !existsSync(file)) {
    if (!process.env.UPDATE_FRAMES) throw new Error(`there is no kept frame ${file}; run the tests once with UPDATE_FRAMES=1 and read what it wrote`);
    mkdirSync(FRAMES, { recursive: true });
    writeFileSync(file, `${text}\n`);
  }
  expect(`${text}\n`).toBe(readFileSync(file, 'utf8'));
}
