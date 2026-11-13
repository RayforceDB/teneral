import { COMMANDS, closest, commandNamed, takes, usage, type Command } from '../commands';
import type { Style } from './theme';

// What the owner types, read as a command or as words for the agent: while it is typed (which
// commands to offer, how to colour the word) and when Enter is pressed (run it, send it, or
// neither). One reading for both, so the box never shows as a command what Enter would send, nor
// the other way round. Pure: the table is keeper/commands.ts, and the client carries them out.

/** A text that has the shape of a command line: a slash, lower-case letters, and on the same line what follows. */
export interface Typed {
  /** Where the command word lies in the text, slash and all. */
  from: number;
  to: number;
  name: string;
  /** What follows the word after a blank; null when nothing does, not even the blank. */
  rest: string | null;
}

/**
 * One line, a slash first, then letters only, then a blank or the end. A path (`/home/you/a.png`)
 * has a second slash or a dot in its first word and is not of this shape; nor is a text of several
 * lines, nor one that begins with two slashes.
 */
const SHAPE = /^(\s*)(\/[a-z]*)(?:[ \t]+([^\n]*?))?\s*$/;

export function typed(text: string): Typed | null {
  const m = SHAPE.exec(text);
  if (m === null) return null;
  const from = m[1]!.length;
  return { from, to: from + m[2]!.length, name: m[2]!, rest: m[3] ?? null };
}

/** The commands whose names begin with what is typed, in the table's order. */
export function matching(name: string): Command[] {
  return COMMANDS.filter((c) => c.name.startsWith(name));
}

export interface Offer {
  typed: Typed;
  /** At least one. */
  matches: Command[];
}

/**
 * The commands to offer for a text with the cursor at `cursor`: those the word begins, as long
 * as the cursor is in the word or at its end and nothing follows it. Null when there is nothing
 * to offer: the text is no command, the word is finished, or no command begins so.
 */
export function offer(text: string, cursor: number): Offer | null {
  const t = typed(text);
  if (t === null || t.rest !== null || cursor <= t.from || cursor > t.to) return null;
  const matches = matching(t.name);
  return matches.length === 0 ? null : { typed: t, matches };
}

/** The text with its command word made `c`, a blank after it when something may follow, and the cursor after that. */
export function complete(text: string, t: Typed, c: Command): { text: string; cursor: number } {
  const word = takes(c) === 'none' ? c.name : `${c.name} `;
  return { text: text.slice(0, t.from) + word + text.slice(t.to).replace(/^[ \t]+/, ''), cursor: t.from + word.length };
}

/**
 * How the command word is drawn in the input box, and where it is; null for a text that is no
 * command. A command there is: the owner's own colour. One still being typed, which some command
 * begins with: set back. Anything else Enter would refuse (a name that is no command, or words
 * after a command that takes none) is drawn as the mistake it is, before Enter.
 */
export function mark(text: string): { from: number; to: number; style: Style } | null {
  const t = typed(text);
  // A slash with a blank after it names nothing, and is words.
  if (t === null || (t.name === '/' && t.rest !== null)) return null;
  const command = commandNamed(t.name);
  const refused = command === null || (takes(command) === 'none' && (t.rest ?? '') !== '');
  const style: Style = !refused ? { fg: 'accent', bold: true }
    : command === null && t.rest === null && matching(t.name).length > 0 ? { fg: 'dim' } : { fg: 'warn' };
  return { from: t.from, to: t.to, style };
}

/** What Enter makes of a line. */
export type Entered =
  /** Words for the agent. `text` is what is sent. */
  | { kind: 'words'; text: string }
  | { kind: 'command'; command: Command; arg: string }
  /** It has the shape of a command and cannot be run as one: nothing is run and nothing is sent, and `why` is said. */
  | { kind: 'refused'; why: string };

const ESCAPE = 'To send the line to the agent as your words, begin it with two slashes.';

/**
 * A line of the owner's, trimmed, read once Enter is pressed. A line that begins with two
 * slashes is words, sent with one. A line of a command's shape is that command, or is refused:
 * its name is none here, or something follows a command that takes nothing. Everything else is
 * words, among them every path, and a slash with no letter after it.
 */
export function entered(line: string): Entered {
  if (line.startsWith('//')) return { kind: 'words', text: line.slice(1) };
  const t = typed(line);
  if (t === null || t.name === '/') return { kind: 'words', text: line };
  const command = commandNamed(t.name);
  const arg = t.rest ?? '';
  if (command === null) {
    const near = closest(t.name);
    return { kind: 'refused', why: `${t.name} is not a command here, and was not sent. ${near === null ? '/help lists them.' : `The nearest is ${usage(near)}.`} ${ESCAPE}` };
  }
  if (arg !== '' && takes(command) === 'none') {
    return { kind: 'refused', why: `${command.name} takes nothing after it, so it was not run, and the line was not sent. ${ESCAPE}` };
  }
  return { kind: 'command', command, arg };
}

/** The first of `rows` rows shown out of `total`, so that the chosen one is among them, in the middle where it can be. */
export function windowStart(total: number, chosen: number, rows: number): number {
  return Math.max(0, Math.min(chosen - Math.floor(rows / 2), total - rows));
}
