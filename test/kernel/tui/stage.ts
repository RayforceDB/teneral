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

// A talk screen on a made-up terminal, over a journal the test writes: keys go in as the bytes a
// terminal sends, and what comes out is read as the grid of characters the owner would see.

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
  /** Let the screen look at the journal, then give the screen as text. */
  frame: () => string;
  /** Press keys: the bytes a terminal sends. */
  type: (bytes: string) => void;
  /** The owner types a line here and sends it, and the agent's body takes it into the journal. */
  say: (text: string, at?: number) => void;
}

export function stage(cols: number, rows: number, o: { caps?: Partial<Caps>; env?: Record<string, string>; banner?: string; open?: boolean; lifelineMs?: number } = {}): Stage {
  const root = mkdtempSync(join(tmpdir(), 'teneral-screen-'));
  const p = paths(root);
  mkdirSync(dirname(p.journal), { recursive: true });
  const term = fakeTerm(cols, rows, o.caps);
  const clock = { at: 0 };
  const alive: Alive = { supervisor: true, body: true };
  let serial = 0;
  const app = new TalkScreen({ term, paths: p, env: { TENERAL_MODEL: 'gpt-6.1-sol', ...o.env }, banner: o.banner ?? null, now: () => T0 + clock.at, alive: () => alive, lifelineMs: o.lifelineMs });
  const s: Stage = {
    term, app, p, clock, alive,
    journal: (body, at = clock.at, gen = A) => {
      serial += 1;
      const id = `e${serial}`;
      appendFileSync(p.journal, `${JSON.stringify({ ...body, v: 1, id, ts: new Date(T0 + at).toISOString(), gen })}\n`);
      return id;
    },
    frame: () => {
      app.tick();
      return term.vt.text();
    },
    type: (bytes) => {
      term.type(bytes);
      app.settle();
    },
    say: (text, at) => {
      s.type(`${text}\r`);
      for (const name of existsSync(p.owner) ? readdirSync(p.owner) : []) unlinkSync(join(p.owner, name));
      s.journal({ type: 'stimulus', source: 'terminal', text }, at);
    },
  };
  if (o.open !== false) app.open();
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
