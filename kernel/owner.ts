import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The owner's channel: `.teneral/owner/`, one file per line typed, holding that line as plain text.
// The body reads the files in name order, takes each as a typed line and removes it. Nothing is
// signed: whoever may write to the directory is the owner. `inbox/` is a different thing, for
// everyone else, and what arrives there is not trusted.
//
// One other thing travels here: an interrupt, which asks the body to stop the turn in progress. It
// is a file of its own kind, told apart by the end of its name and holding nothing. A line is
// always written under a name ending in `.txt`, so no text, whatever it says, can be taken for an
// interrupt. A body from before interrupts reads the file as an empty line and drops it.

/** What the name of an interrupt ends with. */
export const INTERRUPT_SUFFIX = '.interrupt';

let lastMs = 0;
let count = 0;

/** A file name that sorts after every name this process made before it, also within one millisecond and when the clock steps back. */
function nextName(suffix = '.txt'): string {
  const now = Math.max(Date.now(), lastMs);
  count = now === lastMs ? count + 1 : 0;
  lastMs = now;
  // Time, then the count within that millisecond, both padded so that names sort as numbers do.
  // The pid only keeps two writers apart; between them, the order within a millisecond is no one's.
  return `${String(now).padStart(15, '0')}-${String(count).padStart(6, '0')}-${process.pid}${suffix}`;
}

/**
 * Leave one line for the agent, as its owner. Written under a dot-prefixed name, which the
 * reader skips, and renamed: the line appears whole or not at all. Returns the file's name.
 */
export function tell(dir: string, text: string): string {
  if (text.trim() === '') throw new Error('there is nothing in that line');
  mkdirSync(dir, { recursive: true });
  const name = nextName();
  const tmp = join(dir, `.${name}.tmp`);
  writeFileSync(tmp, text);
  renameSync(tmp, join(dir, name));
  return name;
}

/**
 * Ask the agent, as its owner, to stop the turn in progress. The body acts on it only while a turn
 * is running or owed, and drops it otherwise (body/main.ts). Returns the file's name.
 */
export function interrupt(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const name = nextName(INTERRUPT_SUFFIX);
  const tmp = join(dir, `.${name}.tmp`);
  writeFileSync(tmp, '');
  renameSync(tmp, join(dir, name));
  return name;
}
