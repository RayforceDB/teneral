// The owner's commands in the talk clients, in one place: what each is called, what may follow
// it and what it does. What `/help` prints, what the screen client offers while a command is
// typed and how it colours one are all read from this table, so none of them can say something
// the others do not. Nothing here carries a command out: each client does that for itself.

export interface Command {
  /** As it is typed, with its slash. Lower-case letters only. */
  name: string;
  /** What may follow it, as it is shown: `<path>` has to, `[commit]` may, and nothing does where this is empty. */
  hint: string;
  /** One line on what it does. */
  about: string;
  /** The key that does the same in the screen client, where there is one. */
  also?: string;
  /** Whether the plain client has it as well. The screen client has them all. */
  plain: boolean;
}

export const COMMANDS: readonly Command[] = [
  { name: '/help', hint: '', about: 'the keys and commands', plain: true },
  { name: '/image', hint: '<path>', about: 'attach an image file from your machine', plain: false },
  { name: '/stop', hint: '', about: 'interrupt what the agent is doing now', also: 'Esc', plain: true },
  { name: '/accept', hint: '[commit]', about: 'accept the species commit the agent asked about, or the one named', plain: true },
  { name: '/tools', hint: '', about: 'show or hide what each tool call returned', also: 'Tab', plain: false },
  { name: '/generations', hint: '', about: 'the generations this individual has lived in', plain: false },
  { name: '/history', hint: '', about: 'print the earlier conversation that was read from the journal', plain: false },
  // These two are answered by `ownerCommand` in kernel/offer.ts.
  { name: '/offers', hint: '', about: 'what waits for your approval before it goes out to the species', plain: true },
  { name: '/approve', hint: '<commit>', about: 'let exactly that commit go out', plain: true },
  { name: '/plain', hint: '', about: 'how to get the plain text client', plain: false },
  { name: '/quit', hint: '', about: 'leave', also: 'Ctrl-D on an empty line, and Ctrl-C', plain: true },
];

/** Whether something follows the command: it has to, it may, or nothing does. */
export function takes(c: Command): 'required' | 'optional' | 'none' {
  return c.hint === '' ? 'none' : c.hint.startsWith('[') ? 'optional' : 'required';
}

/** The command of exactly this name, slash and all. */
export function commandNamed(name: string): Command | null {
  return COMMANDS.find((c) => c.name === name) ?? null;
}

/** The command as it is shown: its name, and what may follow it. */
export const usage = (c: Command): string => (c.hint === '' ? c.name : `${c.name} ${c.hint}`);

/** The commands of one client as the rows `/help` prints: each with what may follow it, and what it does. */
export function helpRows(client: 'screen' | 'plain'): string[] {
  const all = COMMANDS.filter((c) => client === 'screen' || c.plain);
  const wide = Math.max(...all.map((c) => usage(c).length));
  return all.map((c) => `  ${usage(c).padEnd(wide)}  ${c.about}${client === 'screen' && c.also !== undefined ? ` (also ${c.also})` : ''}`);
}

/** How many single changes (a letter put in, left out or replaced, or two neighbours swapped) turn `a` into `b`. */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array.from({ length: b.length }, () => 0)]);
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * The command a mistyped name most likely meant: the first one it begins, else the one fewest
 * changes away, when that is at most two and fewer than the letters typed. Null when none is near.
 */
export function closest(name: string, among: readonly Command[] = COMMANDS): Command | null {
  if (name.length < 2) return null;
  const begun = among.find((c) => c.name.startsWith(name));
  if (begun !== undefined) return begun;
  let best: Command | null = null;
  let least = 3;
  for (const c of among) {
    const n = distance(name, c.name);
    if (n < least) {
      least = n;
      best = c;
    }
  }
  return best !== null && least < name.length - 1 ? best : null;
}
