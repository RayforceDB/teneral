import { closeSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { journalSize, readEventsFrom, type JournalEvent } from './journal';
import { tell } from './owner';
import { planNotice } from './providers';
import { paths } from './supervisor';

// The owner's terminal: `./box talk` runs this inside the agent's container. What is typed goes to
// the agent as files in the owner directory (kernel/owner.ts); what the agent says is read back
// from the journal. Nothing here talks to the agent's process, so any number of these can run at
// once, and ending one ends nothing else.
//
// It is in kernel/ because it is the owner's tool, not part of the agent: it has to keep working
// whatever the body does to itself. For the same reason nothing here trusts the shape of what the
// body journaled.

/** A journal field as text, whatever was written there. */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value) ?? '';
}

/** What a model or a tool wrote goes to the owner's terminal without control characters; line breaks and tabs stay. */
const plain = (text: string): string => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');

function oneLine(text: string, limit: number): string {
  const flat = plain(text).replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** The end of `text`: the end is where a failed check says what went wrong. */
function tail(text: string, limit: number): string {
  const clean = plain(text).trimEnd();
  return clean.length > limit ? `…${clean.slice(-limit)}` : clean;
}

/** Enough of a commit's name to find it by. */
const short = (commit: unknown): string => plain(asText(commit)).replace(/\s+/g, '').slice(0, 12);

const callsOf = (e: JournalEvent): number => {
  const calls = (e as { toolCalls?: unknown }).toolCalls;
  return Array.isArray(calls) ? calls.length : 0;
};

/** A tool call's arguments in a few words: `command: ls -la`. */
function summary(args: unknown): string {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return asText(args);
  return Object.entries(args).map(([key, value]) => `${key}: ${asText(value)}`).join(', ');
}

/**
 * What one journal event looks like on the owner's terminal, or null for an event that is not
 * shown: a tool's result, a generation starting, a reply that only calls tools.
 * A typed line comes out as `> line`; whether it is shown at all is the caller's business.
 */
export function render(e: JournalEvent): string | null {
  const f = e as unknown as Record<string, unknown>;
  switch (e.type) {
    case 'assistant': {
      const text = plain(asText(f.text)).trim();
      // The blank line after it keeps one reply apart from the next thing.
      return text === '' ? null : `${text}\n`;
    }
    case 'tool.intent':
      return `  [${oneLine(asText(f.name), 40)}] ${oneLine(summary(f.args), 120)}`.trimEnd();
    case 'stimulus':
      if (f.source === 'terminal') return `> ${plain(asText(f.text))}`;
      // Whatever else woke the agent, in one line: another agent's message, the clock, the birth letter.
      return `[${oneLine(asText(f.source), 80)}] ${oneLine(asText(f.text), 200)}`;
    case 'molt.rejected': {
      const output = tail(asText(f.output), 1500);
      const said = output === '' ? '' : `:\n${output.split('\n').map((line) => `    ${line}`).join('\n')}`;
      return `[kernel] molt to ${short(f.commit)} rejected at gate "${oneLine(asText(f.gate), 40)}"${said}`;
    }
    case 'generation.promoted':
      return `[kernel] promoted ${short(f.commit)} (before: ${short(f.previous)})`;
    case 'generation.rolledback':
      return `[kernel] rolled back ${short(f.commit)} to ${short(f.to)}: ${oneLine(asText(f.reason), 300)}`;
    default:
      return null;
  }
}

/**
 * Where the agent stands, as far as the journal shows.
 * `busy`: something was said to it that it has not finished answering.
 * `late`: how many things arrived after the request now being answered was sent; the reply to
 *   that request will not have seen them, and the body asks again because of them.
 * `burst`: when the last thing arrived that the request in progress certainly saw, in ms, while
 *   nothing else has happened since; what follows closely was taken in with it.
 */
export interface Turn {
  busy: boolean;
  late: number;
  burst: number | null;
}

export const AT_REST: Turn = { busy: false, late: 0, burst: null };

/** Stimuli journaled this close together were taken in by one pass of a sensor, before the model was asked. */
const BURST_MS = 100;

/**
 * Follow one journal event. The point of all this is one question: is a finished reply the
 * answer to a given line, or was it already being written when the line arrived?
 *
 * The body reads the journal, asks the model, journals the reply. A reply with tool calls is
 * followed by their results and another request, which sees everything journaled until then.
 * A reply without tool calls ends the turn, unless something arrived while it was being
 * written: then the body asks once more. So a line that arrives during a request is answered by
 * the finished reply after the next one, and that is what `late` counts.
 */
export function track(t: Turn, e: JournalEvent): Turn {
  const at = Date.parse(asText(e.ts));
  switch (e.type) {
    case 'stimulus':
    case 'molt.rejected':
    case 'generation.promoted':
    case 'generation.rolledback':
      // At rest, this is what starts a turn, and the turn's first request sees it.
      if (!t.busy) return { busy: true, late: 0, burst: at };
      if (t.late === 0 && t.burst !== null && at - t.burst <= BURST_MS) return { busy: true, late: 0, burst: at };
      return { busy: true, late: t.late + 1, burst: null };
    case 'assistant':
      // With tool calls, the next request comes after their results and sees everything so far.
      if (callsOf(e) > 0) return { busy: true, late: 0, burst: null };
      return t.late > 0 ? { busy: true, late: 0, burst: null } : AT_REST;
    case 'tool.result':
      return { busy: true, late: 0, burst: null };
    case 'generation.started':
      // A new process: its first request will see everything journaled before it was asked.
      return { busy: t.busy, late: 0, burst: null };
    case 'generation.ready':
      // What its sensors find waiting is journaled right after this, before the first request.
      return { busy: t.busy, late: 0, burst: at };
    default:
      return t;
  }
}

function endsWithLineBreak(path: string, size: number): boolean {
  const fd = openSync(path, 'r');
  try {
    const last = Buffer.alloc(1);
    return readSync(fd, last, 0, 1, size - 1) === 1 && last[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

/** Reads what is appended to a journal, each event once, without reading what came before. */
export class Follower {
  private offset: number;
  /** Ids from the last read: it may have gone past the size measured before it, and the next read starts at that size. */
  private last = new Set<string>();

  constructor(private readonly path: string, from: number = journalSize(path)) {
    this.offset = from;
  }

  /** The events added since the last call. Never throws: a journal that is missing or cannot be read has nothing new. */
  poll(): JournalEvent[] {
    try {
      const size = journalSize(this.path);
      // Shorter than it was: not the journal we were following. Go on from its end.
      if (size < this.offset) this.offset = size;
      // A journal that does not end with a line break is in the middle of a write; the whole line is there next time.
      if (size === this.offset || !endsWithLineBreak(this.path, size)) return [];
      const read = readEventsFrom(this.path, this.offset);
      const fresh = read.filter((e) => !this.last.has(e.id));
      this.last = new Set(read.map((e) => e.id));
      this.offset = size;
      return fresh;
    } catch {
      return [];
    }
  }
}

/** How far back the history shown on attaching looks. The journal can be any size; this much of its end is read. */
const HISTORY_BYTES = 256_000;
/** The longest a typed line or a reply is shown in the history. */
const HISTORY_TEXT = 2000;

function clipped(text: string): string {
  if (text.length <= HISTORY_TEXT) return text;
  return `${text.slice(0, HISTORY_TEXT)}\n[... ${text.length - HISTORY_TEXT} more characters]\n`;
}

/**
 * The last few exchanges, for an owner who has just attached: what was said to the agent, what it
 * said, and what the kernel did. Tool calls are left out and long texts are cut, so this stays
 * short whatever the journal holds.
 */
export function recent(events: JournalEvent[], exchanges = 3, most = 40): string[] {
  let start = 0;
  let found = 0;
  for (let i = events.length - 1; i >= 0 && found < exchanges; i--) {
    if (events[i]!.type !== 'stimulus') continue;
    found += 1;
    start = i;
  }
  const lines: string[] = [];
  for (const e of events.slice(start)) {
    if (e.type === 'tool.intent') continue;
    const line = show(e);
    if (line !== null) lines.push(clipped(line));
  }
  return lines.slice(-most);
}

/** `render`, for a caller that must go on whatever one event holds. */
function show(e: JournalEvent): string | null {
  try {
    return render(e);
  } catch {
    return null;
  }
}

export interface TalkOptions {
  journal: string;
  /** The directory the body reads its owner's lines from. */
  owner: string;
  lines: AsyncIterable<string>;
  /** The conversation: replies, tool calls, kernel notes. */
  write: (text: string) => void;
  /** Everything said by this program itself rather than by the agent. */
  note: (text: string) => void;
  /** A person is typing. Otherwise the lines come from a pipe or a file. */
  interactive: boolean;
  /** Said once, first, to a person who is typing: for instance whose plan the agent's requests use. */
  banner?: string | null;
  pollMs?: number;
  /** Piped input only: how long the journal may stay silent while a line waits to be sent or answered. Default 5 minutes. */
  waitMs?: number;
}

/**
 * Attach to the agent until the input ends. Returns the exit status.
 *
 * With a person typing: the last few exchanges are shown, every line goes to the agent the moment
 * it is entered, and everything journaled from then on is shown as it happens, except the lines
 * typed here. `/quit` or the end of input (Ctrl-D) ends this program, at once. The agent goes on.
 *
 * With piped input, the rule is made for scripts:
 * - Lines are sent one at a time. A line is sent when the agent is at rest; the next one, or the
 *   exit, waits until that line is in the journal and the agent has finished a reply that saw it
 *   (a reply with no tool calls; see `track`). So each line gets its own turn, and everything the
 *   agent did for it is printed before the exit.
 * - After the reply to the last line the exit status is 0.
 * - If nothing at all is journaled for `waitMs` while a line waits to be sent or answered, it
 *   gives up with status 1 and says so on stderr. Lines not yet sent are dropped.
 * - `/quit` as a line ends it at once with status 0, without waiting for anything.
 * - No history is shown, so the output holds only what happened after the first line. Input with
 *   no lines in it is the exception: then the history is all that is shown, and the exit is at once.
 */
export async function talk(o: TalkOptions): Promise<number> {
  const pollMs = o.pollMs ?? 250;
  const waitMs = o.waitMs ?? 300_000;

  if (o.interactive && o.banner) o.note(o.banner);
  const size = journalSize(o.journal);
  let before: JournalEvent[] = [];
  try {
    before = readEventsFrom(o.journal, Math.max(0, size - HISTORY_BYTES));
  } catch { /* a journal that cannot be read has no history to show */ }
  // That read may have gone past `size`, where the follower starts.
  const shown = new Set(before.map((e) => e.id));
  const follower = new Follower(o.journal, size);
  let turn = before.reduce(track, AT_REST);
  const history = () => {
    const lines = recent(before);
    for (const line of lines) o.write(`${line}\n`);
    if (lines.length === 0) o.note('(the journal is empty: nothing has been said yet)');
  };

  /** Lines sent from here and not yet seen in the journal. */
  const mine: string[] = [];
  const send = (text: string): boolean => {
    try {
      tell(o.owner, text);
      mine.push(text);
      return true;
    } catch (err) {
      o.note(`could not send that line: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  /** Ends the wait between two looks at the journal, when a line was typed or the input ended. */
  let nudge: () => void = () => {};
  const nap = () => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, pollMs);
    nudge = () => { clearTimeout(timer); resolve(); };
  });

  const queue: string[] = [];
  let ended = false;
  let quit = false;
  void (async () => {
    try {
      for await (const raw of o.lines) {
        const text = raw.trim();
        if (text === '') continue;
        if (text === '/quit') { quit = true; return; }
        if (o.interactive) send(text);
        else queue.push(text);
        nudge();
      }
    } catch { /* an input that fails has ended */ } finally {
      ended = true;
      nudge();
    }
  })();

  if (o.interactive) {
    history();
    o.note('--- attached. Type to talk. /quit, Ctrl-D or Ctrl-C leaves; the agent goes on without you. ---');
    if (turn.busy) o.note('(the agent is in the middle of a turn)');
  }

  /** The piped line now waiting for its answer, and whether the journal has it yet. */
  let current: string | null = null;
  let journaled = false;
  let sent = 0;
  let activity = Date.now();

  for (;;) {
    for (const e of follower.poll()) {
      if (shown.has(e.id)) continue;
      activity = Date.now();
      turn = track(turn, e);
      if (e.type === 'stimulus' && (e as { source?: unknown }).source === 'terminal') {
        const at = mine.indexOf(asText((e as { text?: unknown }).text));
        if (at !== -1) {
          // The owner's own line: it is on their screen already.
          mine.splice(at, 1);
          if (current !== null) journaled = true;
          continue;
        }
      }
      const line = show(e);
      if (line !== null) o.write(`${line}\n`);
    }
    if (quit) return 0;
    if (o.interactive) {
      if (ended) return 0;
    } else {
      if (current !== null && journaled && !turn.busy) current = null;
      if (current === null) {
        if (queue.length > 0) {
          if (!turn.busy) {
            current = queue.shift()!;
            journaled = false;
            if (!send(current)) return 1;
            sent += 1;
            activity = Date.now();
          }
        } else if (ended) {
          if (sent === 0) history();
          return 0;
        }
      }
      if ((current !== null || queue.length > 0) && Date.now() - activity > waitMs) {
        const waiting = current === null ? 'the agent has not come to rest' : 'the agent has not finished a reply';
        const dropped = queue.length > 0 ? `; ${queue.length} line(s) not sent` : '';
        o.note(`talk: nothing journaled for ${Math.round(waitMs / 1000)} s and ${waiting}; giving up${dropped}`);
        return 1;
      }
    }
    await nap();
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let waitMs: number | undefined;
  let plainText = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--plain') {
      plainText = true;
    } else if (args[i] === '--wait' && Number(args[i + 1]) > 0) {
      waitMs = Number(args[i + 1]) * 1000;
      i += 1;
    } else {
      console.error('usage: bun kernel/talk.ts [--plain] [--wait <seconds>]');
      console.error('  --plain  at a terminal: plain text, without the panel and the input box. Piped input is always plain');
      console.error('  --wait   with piped input: how long the journal may stay silent before giving up (default 300)');
      process.exit(2);
    }
  }
  const p = paths(join(import.meta.dir, '..'));
  // A person at a terminal gets the client with its panel and input box (kernel/tui/). Everything else is as it always was.
  if (!plainText && process.stdin.isTTY === true && process.stdout.isTTY === true && process.env.TERM !== 'dumb') {
    const { runTalkScreen } = await import('./tui/talk');
    process.exit(await runTalkScreen(p, process.env, planNotice(process.env)));
  }
  // Ctrl-C ends this program, quietly. It is not passed on to anything.
  process.on('SIGINT', () => process.exit(0));
  const status = await talk({
    journal: p.journal,
    owner: p.owner,
    lines: console,
    write: (text) => { process.stdout.write(text); },
    // Not console.error, which colours what it prints on a terminal.
    note: (text) => { process.stderr.write(`${text}\n`); },
    interactive: process.stdin.isTTY === true,
    banner: planNotice(process.env),
    waitMs,
  });
  process.exit(status);
}
