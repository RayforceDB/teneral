import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JournalEvent } from '../kernel/journal';
import type { Stimulus } from '../body/sensors';

/** Characters of soul shown per turn. The files themselves may be longer. */
export const SOUL_CAP = 20_000;

/** A turn cannot run without the system prompt, so a soul entry that cannot be read is named, never thrown. */
function readOrSay(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (err) {
    return `[could not be read: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

/** Every `.md` file in the soul directory, in name order, each under its file name. */
export function loadSoul(dir: string): string {
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => `### ${name}\n\n${readOrSay(join(dir, name))}`)
    .join('\n\n');
}

/** The species' prompt, then the individual's soul. Built again every turn, since the soul can change. */
export function composeSystem(prompt: string, soulDir: string, journal: string): string {
  const head = `${prompt.trim()}\n\n## Who you are\n\nYour journal is the file ${journal}. Your soul directory is ${soulDir}.`;
  const soul = loadSoul(soulDir);
  if (soul === '') return `${head} It is empty: you have not been born yet. Your first message tells you what to do.`;
  const shown = soul.length <= SOUL_CAP
    ? soul
    : `${soul.slice(0, SOUL_CAP)}\n[your soul is longer than ${SOUL_CAP} characters; the rest is not shown. Shorten it.]`;
  return `${head} These files are yours. This is what they say now.\n\n${shown}`;
}

/** The birth letter, if this journal has never held a stimulus. */
export function birth(events: JournalEvent[], letter: string): Stimulus | null {
  return events.some((e) => e.type === 'stimulus') ? null : { source: 'birth', text: letter.trim() };
}
