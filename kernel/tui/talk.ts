import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { formatList, generations } from '../back';
import { helpRows, takes, type Command } from '../commands';
import { formatUsage, usageReport } from '../usage';
import { journalSize, readEvents, readEventsFrom, type JournalEvent } from '../journal';
import { ownerCommand } from '../offer';
import { accept, acceptedLine, interrupt, tell } from '../owner';
import * as providers from '../providers';
import { chooseAccept } from '../species';
import { holder, readState, type Paths } from '../supervisor';
import { Follower } from '../talk';
import { EMPTY, attach, edit, insert, sent, type Edit } from './editor';
import {
  Clip, IMAGES_PER_MESSAGE, IMAGE_MAX_BYTES, NotKept, keep, look, namedLikeImage, pathsIn, sizeText, whyNoClipboard, withMarkers,
  type Attachment,
} from './images';
import { KeyParser, type Key } from './keys';
import { Transcript, UNBORN, isMutationTool, shortSha, stand, stateWord, inQueue, unfinished, type Alive, type Entry, type Standing } from './model';
import { Inline, Lifeline, terminal, type Term } from './screen';
import { complete, entered, offer, type Typed } from './slash';
import { clean, type Line, type Span } from './text';
import { SPIN_MS, glyphs, type Glyphs } from './theme';
import { cacheUse, contextUse, elapsed, entryRows, gap, liveRows, shortDir, status, welcome, type Look, type Offered } from './view';

// The talk client: `./box talk` at a terminal. The owner's lines go out through the owner channel
// (kernel/owner.ts) and everything shown is read back from the journal, exactly as the plain
// client does it, so any number of these can be attached and leaving one ends nothing else.
// Esc asks the agent, over that same channel, to stop the turn it is in. Nothing else here can stop
// the agent or change it.
//
// It does not take the screen. What is finished (the welcome panel, a line, a reply, a tool call
// with its outcome, a notice) is printed once and scrolls away into the terminal's own
// scrollback; only the live region at the bottom is redrawn (see `Inline` in screen.ts).

/** How far back the journal is read on attaching, as in the plain client. */
const HISTORY_BYTES = 256_000;
/** How much of that is shown at once: the last few things the owner said, and what came of them. */
const SHOWN_EXCHANGES = 3;
const SHOWN_ENTRIES = 40;
const TICK_MS = 125;
/** A lone ESC is the Escape key once this long has passed with nothing after it. */
const ESCAPE_MS = 40;
/** How long an interrupt sent from here may go unanswered before the client says so and lets it be sent again. */
const INTERRUPT_MS = 5000;
/** How long each tip stays in the footer. */
const TIP_MS = 20_000;
/** Entries still under way that the live region lays out; older ones wait unseen. */
const PENDING_SHOWN = 12;

const HELP = [
  'Enter sends what you typed to the agent, as its owner. Alt+Enter, or Ctrl-J, starts a new line. Up and Down walk through what you sent before. Ctrl-U, Ctrl-K and Ctrl-W delete to the start of the line, to its end, and the word before the cursor.',
  '',
  'A line that begins with a slash and a word is a command. Type / and the commands are listed under the box, fewer with each letter: Up and Down (or Ctrl-P and Ctrl-N) choose one, Tab completes it, Enter runs it, or completes it when something has to follow, and Esc closes the list. The name is coloured once it is whole; one that is no command is coloured as a mistake, and Enter neither runs nor sends it. To send the agent a line that begins with a slash, begin it with two: //like this arrives as /like this. A path, such as /home/you/notes.txt, is no command and needs none of that.',
  '',
  'The conversation is ordinary output of your terminal: its scrollbar, PageUp and PageDown, selection, copy and search all work on it. Only the box you type in and the lines around it are redrawn.',
  '',
  'Images: Ctrl+V attaches the image in your clipboard; dragging an image file into the terminal, or pasting its path, attaches that file; so does /image <path>. An attached image is a chip in the input box, and Backspace at the start of the line removes the last one. A message carries at most 4 images of at most 10 MB each (PNG, JPEG, GIF, WebP). They are kept in memory/images/. The agent sees them once its own body knows how; until then it sees one line of text naming each file.',
  '',
  ...helpRows('screen'),
  '',
  'Esc, or /stop, interrupts the agent in the middle of a turn: the request to the model is cancelled, a command that is running is killed with everything it started, and the agent waits for what you say next. It is told that you interrupted it. When it is doing nothing, Esc does nothing. A mutation the kernel is already checking is not stopped by it. While commands are listed under the box, Esc closes the list and interrupts nothing; press it again for the agent.',
  '',
  '/accept is your word to the kernel, not to the agent. A mutation from the species brings the agent a new kernel, and with TENERAL_SPECIES=ask, the default, the kernel lets none through until you have accepted the species commit it stands on, or a later one. The agent asks you; /accept answers for the commit it asked about, /accept <commit> for another. Then tell the agent to ask for its mutation again.',
  '',
  'Leaving ends this client only. Nothing else here stops the agent or changes it.',
  '',
  'A line you send stands over the input box, faint, until the agent has read it. While the agent is in the middle of a step this client keeps the line and sends it when the step ends: the footer says how many are queued, and Up in an empty box takes the last one back into the box, to change it, or to drop it by clearing the box. Leaving sends what is queued. "on its way": sent, and not taken by the agent yet; when nobody is running, it waits for the next start. "sent, not read yet": the agent has it and reads it with its next step. Once read, the line moves up into the conversation and stands there on a ground of its own.',
  '',
  'While the agent is doing something, the line over the input box says what: waking (its first start, before its first words), thinking, running <tool>, mutating (it proposed a change to its own body and the kernel is checking it), starting (between two runs). At other times it is resting, not running, or waiting for you: its last finished reply ended with a question mark and nothing has arrived since.',
];

/**
 * What the part of the journal before `upTo` says of the things that outlive any window onto it:
 * the generations it names, and whether this individual has ever spoken. Read in pieces; only
 * lines that can matter are parsed.
 */
export function lineage(path: string, upTo: number): Pick<Standing, 'spoke' | 'known' | 'current'> {
  let s = UNBORN;
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return s;
  }
  try {
    const chunk = Buffer.alloc(1 << 20);
    let rest = Buffer.alloc(0);
    for (let offset = 0; offset < upTo;) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, upTo - offset), offset);
      if (n === 0) break;
      offset += n;
      const data = Buffer.concat([rest, chunk.subarray(0, n)]);
      const end = data.lastIndexOf(0x0a);
      rest = Buffer.from(data.subarray(end + 1));
      for (const line of data.toString('utf8', 0, end + 1).split('\n')) {
        if (!line.includes('"generation.') && (s.spoke || !line.includes('"assistant"'))) continue;
        try {
          const e = JSON.parse(line) as JournalEvent;
          if (typeof e?.type === 'string' && (e.type.startsWith('generation.') || e.type === 'assistant')) s = stand(s, e);
        } catch { /* a torn line */ }
      }
    }
  } catch { /* what was read so far stands */ } finally {
    closeSync(fd);
  }
  return { spoke: s.spoke, known: s.known, current: s.current };
}

const tidyName = (raw: string | undefined): string | null => {
  const name = (raw ?? '').replace(/[*_`#[\]]/g, '').replace(/\s+/g, ' ').replace(/[.,;:!]+$/, '').trim();
  return name !== '' && [...name].length <= 32 ? name : null;
};
const nameLine = (text: string): string | null => tidyName(/^[ \t]*(?:[-*+][ \t]+)?[*_]{0,2}(?:my[ \t]+)?(?:name|имя)[*_]{0,2}[ \t]*[:：—–-][ \t]*(.+)$/imu.exec(text)?.[1]);
/** A first-level heading is taken for a name only when it could be one: a word or two, and not the page's own title. */
const nameHeading = (text: string): string | null => {
  const heading = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(text);
  if (!heading || /^(soul(\.md)?|identity|who i am|about me|me|notes?|душа|кто я)$/iu.test(heading[1]!.trim())) return null;
  const name = tidyName(heading[1]);
  return name !== null && name.split(' ').length <= 2 ? name : null;
};

/**
 * The individual's own name, from one file of its soul: a line `name: ...` (or `имя: ...`), else
 * the first first-level heading unless that is only the page's title. Null when neither gives a
 * short name.
 */
export function soulName(text: string): string | null {
  const t = clean(text);
  return /^[ \t]*(?:[-*+][ \t]+)?[*_]{0,2}(?:my[ \t]+)?(?:name|имя)[*_]{0,2}[ \t]*[:：—–-]/imu.test(t) ? nameLine(t) : nameHeading(t);
}

/**
 * The name the soul gives, whatever its files are called: every `.md` file there is looked at,
 * `SOUL.md` and `identity.md` first. A `name:` line in any of them wins over a heading in any.
 */
export function soulNameIn(texts: string[]): string | null {
  const cleaned = texts.map(clean);
  for (const text of cleaned) {
    const name = nameLine(text);
    if (name !== null) return name;
  }
  for (const text of cleaned) {
    const name = nameHeading(text);
    if (name !== null) return name;
  }
  return null;
}

/** The soul's `.md` files, the likeliest to name the individual first, with the newest change among them. */
function soulFiles(dir: string): { files: string[]; stamp: string } {
  try {
    const rank = (name: string): number => (/^soul\.md$/i.test(name) ? 0 : /^identity\.md$/i.test(name) ? 1 : 2);
    const names = readdirSync(dir).filter((name) => /\.md$/i.test(name)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, 24);
    const files = names.map((name) => join(dir, name));
    return { files, stamp: files.map((file) => `${file}:${statSync(file).mtimeMs}`).join('|') };
  } catch {
    return { files: [], stamp: '' };
  }
}

const ordinal = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

/** How long ago, in the one unit that matters. */
export function ago(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} h ago`;
  return `${Math.floor(min / 60 / 24)} days ago`;
}

/** A value from `.env`, for the few settings worth showing where the environment does not have them. Never a secret. */
function envLine(root: string, key: 'TENERAL_MODEL' | 'TENERAL_PROVIDER' | 'TENERAL_HEARTBEAT_MINUTES'): string | undefined {
  try {
    return new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(join(root, '.env'), 'utf8'))?.[1]?.trim();
  } catch {
    return undefined;
  }
}

export interface TalkScreenOptions {
  term: Term;
  paths: Paths;
  env: Record<string, string | undefined>;
  /** Said once, on attaching: for instance whose plan the agent's requests use. */
  banner?: string | null;
  /** Said with it, when the species has other cage files than this install (kernel/species.ts). */
  cage?: string | null;
  now?: () => number;
  /** Whether the kernel and the body are there. Default: what the lock and the child record under `.teneral/` say. */
  alive?: () => Alive;
  /** How often the terminal is asked whether it is still there. Default 15 s. */
  lifelineMs?: number;
}

/** Something asked of the helper on the owner's machine, and what to do with the answer. */
interface Ask {
  n: number | null;
  /** `key`: Ctrl+V. `paste`: a path was pasted. `enter`: a path was the whole line sent. `command`: /image. */
  origin: 'key' | 'paste' | 'enter' | 'command';
  path: string;
  /** What was pasted or typed, to put back as text when it turns out to be no image. */
  raw: string;
}

export class TalkScreen {
  private readonly inline: Inline;
  private readonly keys = new KeyParser();
  private readonly transcript = new Transcript();
  private readonly clip: Clip;
  private readonly now: () => number;
  private readonly alive: () => Alive;
  private readonly g: Glyphs;
  private readonly root: string;
  private follower!: Follower;
  private shown = new Set<string>();
  private standing: Standing = UNBORN;
  private edit: Edit = EMPTY;
  /** The last entry printed, and the id of the last one from the journal that was: everything up to it is in the scrollback. */
  private last: Entry | null = null;
  private printed = 0;
  /** Entries read from the journal on attaching and not shown: `/history` prints them. */
  private earlier: Entry[] = [];
  private tools = false;
  private name: string | null = null;
  private soulStamp = '?';
  private ticks = 0;
  private readonly asks: Ask[] = [];
  /** Keys pressed while a line that may be a file's path is looked up: they are taken once it is known. */
  private held: Key[] | null = null;
  /** Lines typed while the agent was in the middle of a step: kept here, not sent yet, and the owner's to take back with Up. */
  private readonly queue: { message: string; typed: string; chips: Edit['chips']; entry: Entry }[] = [];
  private readonly images = new Map<string, Attachment | null>();
  /** The text the owner closed the list of commands on with Esc: it stays closed until the text is another. */
  private dismissed: string | null = null;
  /** The command chosen in the list with the arrows, and the word it was chosen for: another word starts from the top. */
  private pick = { name: '', index: 0 };
  /** What the last frame was made from, to tell whether another is due. */
  private painted = '';
  private dirty = true;
  private stops: (() => void)[] = [];
  private finish: ((status: number) => void) | null = null;
  private escape: ReturnType<typeof setTimeout> | undefined;
  /** When an interrupt was sent from here that the journal has not answered yet, by this client's clock; null otherwise. */
  private interrupting: number | null = null;
  private readonly lifeline: Lifeline;
  closed = false;

  constructor(private readonly o: TalkScreenOptions) {
    this.inline = new Inline(o.term);
    this.g = glyphs(o.term.caps.utf8, /^(1|true|yes|on)$/i.test(o.env.TENERAL_POWERLINE ?? ''));
    // A terminal that went away without a word: the client ends, as if the owner had left.
    this.lifeline = new Lifeline(o.term, () => this.close(0), o.lifelineMs);
    this.now = o.now ?? Date.now;
    const p = o.paths;
    this.root = dirname(dirname(p.journal));
    const id = o.env.TENERAL_CLIP ?? '';
    this.clip = new Clip(/^[A-Za-z0-9_-]{1,64}$/.test(id) ? join(p.owner, '.clip', id) : null, this.now);
    this.alive = o.alive ?? (() => {
      try {
        return { supervisor: holder(p.lock) !== null, body: existsSync(p.child) };
      } catch {
        return { supervisor: false, body: false };
      }
    });
  }

  private get who(): string {
    return this.name ?? 'the agent';
  }

  private get look(): Look {
    return { g: this.g, tools: this.tools, image: (path) => this.image(path) };
  }

  /** What a kept image is; looked at once. */
  private image(path: string): Attachment | null {
    if (!this.images.has(path)) {
      if (this.images.size > 500) this.images.clear();
      this.images.set(path, look(this.root, path));
    }
    return this.images.get(path) ?? null;
  }

  /** Print the welcome panel, where things stand and the recent history, then keep the live region under it. */
  open(): void {
    const { journal } = this.o.paths;
    const size = journalSize(journal);
    const from = Math.max(0, size - HISTORY_BYTES);
    let before: JournalEvent[] = [];
    try {
      before = readEventsFrom(journal, from);
    } catch { /* a journal that cannot be read has no history to show */ }
    if (from > 0) {
      this.standing = { ...UNBORN, ...lineage(journal, from) };
      this.transcript.truncated = true;
    }
    for (const e of before) this.take(e, false);
    // That read may have gone past `size`, where the follower starts.
    this.shown = new Set(before.map((e) => e.id));
    this.follower = new Follower(journal, size);
    if (this.standing.current === null) {
      try {
        const current = readState(this.o.paths).current;
        this.standing = { ...this.standing, current, known: this.standing.known.includes(current) ? this.standing.known : [...this.standing.known, current] };
      } catch { /* never started here */ }
    }
    const entries = this.transcript.entries;
    this.edit = entries.reduce((e, entry) => (entry.kind === 'owner' && entry.text !== '' ? sent(e, entry.text) : e), EMPTY);
    this.readName();

    // The last few things the owner said and what came of them; the rest stays in the journal.
    let start = entries.length;
    for (let said = 0; start > 0 && entries.length - start < SHOWN_ENTRIES && said < SHOWN_EXCHANGES;) {
      start -= 1;
      if (entries[start]!.kind === 'owner') said += 1;
    }
    this.earlier = entries.slice(0, start);
    this.printed = start > 0 ? entries[start - 1]!.id : 0;

    this.inline.start();
    const max = this.inline.width;
    this.inline.print(welcome({ name: this.name, facts: this.facts() }, max, this.g));
    // Where things stand, on its own; then what else is worth knowing, together.
    this.statusLines(max).forEach((rows, i) => this.inline.print(i < 2 ? [[], ...rows] : rows));
    if (entries.length === 0) this.inline.print([[], [{ text: '  Nothing has been said yet.', style: { fg: 'dim' } }]]);
    this.stops.push(
      this.o.term.listen((text) => this.input(text), () => this.close(0)),
      this.o.term.onResize(() => {
        this.inline.invalidate();
        this.dirty = true;
        this.paint();
      }),
    );
    this.tick();
  }

  /** Until the owner leaves. Returns the exit status. */
  run(): Promise<number> {
    this.open();
    const timer = setInterval(() => this.tick(), TICK_MS);
    this.lifeline.start();
    this.stops.push(() => clearInterval(timer), () => this.lifeline.stop());
    return new Promise<number>((resolve) => {
      if (this.closed) resolve(0);
      else this.finish = resolve;
    });
  }

  /** Take the live region away and give the terminal back: the conversation stays in its scrollback. Safe to call twice, and from a signal handler. */
  close(status = 0): void {
    if (this.closed) return;
    // Nothing typed for the agent is lost by leaving.
    this.sendQueued();
    this.closed = true;
    clearTimeout(this.escape);
    for (const stop of this.stops) stop();
    this.inline.print([[], [{ text: `  You left. ${this.who === 'the agent' ? 'The agent' : this.who} goes on; ./box talk attaches again.`, style: { fg: 'dim' } }]]);
    this.inline.stop();
    this.finish?.(status);
  }

  // --- what there is to say on attaching ---

  private facts(): [string, string][] {
    const { paths: p, env } = this.o;
    const s = this.standing;
    const sep = ` ${this.g.sep} `;
    const facts: [string, string][] = [['Directory', clean(env.TENERAL_HOST_DIR || p.root)]];
    let id = '';
    try {
      id = clean(readFileSync(join(p.root, '.teneral', 'id'), 'utf8')).trim().slice(0, 8);
    } catch { /* never started here */ }
    if (id !== '') facts.push(['Individual', id]);
    const at = s.current === null ? 0 : s.known.indexOf(s.current) + 1;
    if (s.current !== null) {
      const lived = s.known.length;
      facts.push(['Generation', [...(at > 0 ? [ordinal(at)] : []), shortSha(s.current), ...(lived > 0 ? [`has lived in ${lived}`] : [])].join(sep)]);
    }
    const model = clean(env.TENERAL_MODEL ?? '').slice(0, 60);
    const provider = providers.providerFor(env.TENERAL_PROVIDER).name.replace(/\s*\(.*\)$/, '').replace(/^Another /, '');
    facts.push(['Model', model === '' ? `not set${sep}${provider}` : `${model}${sep}${provider}`]);
    facts.push(['Version', providers.userAgent().replace('/', ' ')]);
    const born = this.born();
    if (born !== null) facts.push(['Born', `${new Date(born).toISOString().slice(0, 16).replace('T', ' ')} UTC${sep}${ago(this.now() - born)}`]);
    const minutes = Number(env.TENERAL_HEARTBEAT_MINUTES ?? '30');
    const clock = minutes > 0 ? `clock every ${minutes} min` : minutes === 0 ? 'clock off' : null;
    facts.push(['Sensors', [...(clock ? [clock] : []), 'inbox', 'your terminal'].join(sep)]);
    try {
      const peers = Object.keys(JSON.parse(readFileSync(p.peers, 'utf8')) as Record<string, unknown>).map((name) => clean(name).slice(0, 24)).filter((name) => name !== '');
      if (peers.length > 0) facts.push(['Peers', `${peers.slice(0, 6).join(', ')}${peers.length > 6 ? ` and ${peers.length - 6} more` : ''}`]);
    } catch { /* no peers */ }
    return facts;
  }

  /** When the first event was journaled, in ms; null for a journal without one. */
  private born(): number | null {
    try {
      const fd = openSync(this.o.paths.journal, 'r');
      try {
        const head = Buffer.alloc(4096);
        const n = readSync(fd, head, 0, head.length, 0);
        const at = Date.parse(/"ts":"([^"]+)"/.exec(head.toString('utf8', 0, n).split('\n')[0] ?? '')?.[1] ?? '');
        return Number.isNaN(at) ? null : at;
      } finally {
        closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  private statusLines(max: number): Line[][] {
    const g = this.g;
    const lines: Line[][] = [];
    const word = stateWord(this.standing, this.alive());
    const name: Span = { text: this.who === 'the agent' ? 'The agent' : this.who, style: { fg: 'brand', bold: true } };
    if (word === 'not running') {
      lines.push(status([{ text: 'Nobody is running here.', style: { fg: 'warn', bold: true } }], ['./box up starts the agent. What you send now waits for it.'], max, g, { fg: 'warn' }));
    } else {
      lines.push(status([name, { text: ' is awake', style: { bold: true } }, { text: ` ${g.sep} ${word}`, style: { fg: 'dim' } }], [`Leaving this client stops nothing: ${this.who} goes on.`], max, g));
    }
    if (this.o.banner) {
      // The address stands out, and in one piece, so that it can be opened or copied.
      const parts = clean(this.o.banner).split(/(https?:\/\/\S+)/);
      lines.push(status(parts.filter((part) => part !== '').map((text): Span => (/^https?:\/\//.test(text) ? { text, style: { underline: true } } : { text })), [], max, g));
    }
    if (this.o.cage) lines.push(status([{ text: clean(this.o.cage), style: { fg: 'warn' } }], [], max, g, { fg: 'warn' }));
    const tool = this.clip.tool();
    const images = !this.clip.there ? 'Images: /image <path> attaches a file this client can read. The clipboard and files of your machine need ./box talk.'
      : tool === null || tool.startsWith('none') ? `Images: drag a file in, or /image <path>. Ctrl+V needs ${tool === 'none wayland' ? 'wl-clipboard' : tool === 'none x11' ? 'xclip' : 'a display'} on your machine.`
        : 'Images: Ctrl+V attaches the clipboard\'s image; drag a file in, or /image <path>.';
    lines.push(status([{ text: images, style: { fg: 'dim' } }], [], max, g, { fg: 'faint' }));
    if (this.earlier.length > 0 || this.transcript.truncated) {
      const what = this.earlier.length > 0 ? 'Showing the last of the conversation. /history prints what came before; ' : 'Earlier conversation is not shown: ';
      lines.push(status([{ text: `${what}memory/journal.jsonl has all of it.`, style: { fg: 'dim' } }], [], max, g, { fg: 'faint' }));
    }
    return lines;
  }

  // --- the journal ---

  private take(e: JournalEvent, live: boolean): void {
    this.transcript.add(e, this.standing, live);
    try {
      this.standing = stand(this.standing, e);
    } catch { /* an event of a shape nobody foresaw changes nothing */ }
    // A step ended: what was kept goes out now, and the agent reads it with its next one.
    if (live && ['assistant', 'tool.result', 'turn.interrupted', 'generation.ready'].includes(e.type)) this.sendQueued();
  }

  /** Whether a line typed now is kept here rather than sent: the agent is in the middle of a step, and would not read it before the next anyway. */
  private holding(): boolean {
    const alive = this.alive();
    return alive.supervisor && alive.body && this.standing.turn.busy && this.standing.mutation === null;
  }

  /** Send every line that was kept, in the order it was typed. */
  private sendQueued(): void {
    for (const line of this.queue.splice(0)) {
      this.transcript.drop(line.entry);
      try {
        tell(this.o.paths.owner, line.message);
        this.transcript.say(line.message);
      } catch (err) {
        this.say(`That line could not be sent: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.dirty = true;
    }
  }

  /** Up in an empty box: the last line that was kept comes back into it, with its images, to be changed or dropped. */
  private takeBack(): void {
    const line = this.queue.pop()!;
    this.transcript.drop(line.entry);
    this.edit = { ...this.edit, text: line.typed, cursor: line.typed.length, chips: line.chips, at: null };
  }

  /** Look at the journal, the helper's answers and the soul once, print what is finished, and paint if the live region shows differently. */
  tick(): void {
    if (this.closed) return;
    this.ticks += 1;
    for (const e of this.follower.poll()) {
      if (this.shown.has(e.id)) continue;
      this.take(e, true);
      if (e.type === 'turn.interrupted') this.interrupting = null;
      this.dirty = true;
    }
    if (this.queue.length > 0 && !this.holding()) this.sendQueued();
    this.interrupted();
    this.answers();
    if (this.ticks % 8 === 1) this.readName();
    this.paint();
  }

  private readName(): void {
    const { files, stamp } = soulFiles(this.o.paths.soul);
    if (stamp === this.soulStamp) return;
    this.soulStamp = stamp;
    const texts: string[] = [];
    for (const file of files) {
      try {
        texts.push(readFileSync(file, 'utf8').slice(0, 20_000));
      } catch { /* a file that went away */ }
    }
    this.name = soulNameIn(texts);
    this.dirty = true;
  }

  /** Print one entry above the live region, for good. */
  private print(e: Entry): void {
    const blank = this.last === null ? 1 : gap(this.last, e);
    this.inline.print([...Array.from({ length: blank }, (): Line => []), ...entryRows(e, this.inline.width, this.look)]);
    this.last = e;
    this.dirty = true;
  }

  /** Something this client says itself: printed at once, whatever else is still under way. */
  private say(text: string): void {
    this.print({ kind: 'note', text, id: 0, rev: 0 });
  }

  /** The same, unless it is what was said last: a key pressed again does not fill the scrollback. */
  private sayOnce(text: string): void {
    if (this.last?.kind !== 'note' || this.last.text !== text) this.say(text);
  }

  private page(title: string, text: string[], tools?: Extract<Entry, { kind: 'tool' }>[]): void {
    this.print({ kind: 'page', title, text, ...(tools ? { tools } : {}), id: 0, rev: 0 });
  }

  /**
   * Print every entry that will not change any more, in the journal's order, and return the rest:
   * from the first tool call still without its result on, and the owner's lines the agent has not read yet.
   */
  private settle(): Entry[] {
    const pending: Entry[] = [];
    const mine: Entry[] = [];
    let blocked = false;
    for (const e of this.transcript.entries) {
      if (inQueue(e)) {
        mine.push(e);
      } else if (e.id <= this.printed) {
        continue;
      } else if (blocked || unfinished(e)) {
        blocked = true;
        pending.push(e);
      } else {
        this.print(e);
        this.printed = e.id;
      }
    }
    return [...pending, ...mine];
  }

  // --- keys ---

  private input(text: string): void {
    clearTimeout(this.escape);
    for (const key of this.keys.feed(text)) this.key(key);
    if (this.keys.pending) {
      this.escape = setTimeout(() => {
        for (const key of this.keys.flush()) this.key(key);
        this.paint();
      }, ESCAPE_MS);
    }
    this.paint();
  }

  /** For a caller that feeds keys itself: what is still held back counts as pressed. */
  settleKeys(): void {
    clearTimeout(this.escape);
    for (const key of this.keys.flush()) this.key(key);
    this.paint();
  }

  private key(key: Key): void {
    this.press(key);
    // A list closed with Esc stays closed until the owner's own line is another; looking through the history in between changes nothing.
    if (this.edit.at === null && this.edit.text !== this.dismissed) this.dismissed = null;
  }

  /**
   * The commands offered for what is typed, and which of them is chosen: the one the arrows last
   * moved to, else the one typed out in full, else the first. Null while there is no list: the
   * text is no command still being named (see `offer`), it is a line brought back from the
   * history, or the owner closed the list on this very text.
   */
  private offered(): { typed: Typed; matches: Command[]; chosen: number } | null {
    if (this.held !== null || this.edit.at !== null || this.edit.text === this.dismissed) return null;
    const o = offer(this.edit.text, this.edit.cursor);
    if (o === null) return null;
    const chosen = this.pick.name === o.typed.name ? Math.min(this.pick.index, o.matches.length - 1) : Math.max(0, o.matches.findIndex((c) => c.name === o.typed.name));
    return { ...o, chosen };
  }

  private press(key: Key): void {
    if (this.closed) return;
    if (key.kind === 'alive') return this.lifeline.heard();
    this.dirty = true;
    const ctrl = (name: string): boolean => key.kind === 'key' && key.ctrl === true && key.name === name;
    if (ctrl('c')) return this.close(0);
    const list = this.offered();
    if (key.kind === 'key' && key.name === 'escape' && !key.ctrl && !key.alt && !key.shift) {
      // Esc belongs to what is nearest the owner's hands: an open list is closed by it, and only with none open does it reach the agent.
      if (list === null) return this.interrupt();
      this.dismissed = this.edit.text;
      return;
    }
    if (list !== null && key.kind === 'key' && !key.alt && !key.shift) {
      // While the list is open these keys are its own; at any other time they are what they were.
      const step = key.name === 'up' || ctrl('p') ? -1 : key.name === 'down' || ctrl('n') ? 1 : 0;
      if (step !== 0) {
        this.pick = { name: list.typed.name, index: (list.chosen + step + list.matches.length) % list.matches.length };
        return;
      }
      const command = list.matches[list.chosen]!;
      if (key.name === 'tab' || key.name === 'enter') {
        // Enter on a name typed out in full is that command, as it always was. On part of a name it is the chosen command at once when nothing follows one, and no more than Tab when something does or may: what follows is the owner's to type or to leave out.
        const whole = list.typed.name === command.name;
        if (key.name === 'tab' || !whole) this.edit = { ...this.edit, ...complete(this.edit.text, list.typed, command), at: null };
        if (key.name === 'enter' && (whole || takes(command) === 'none')) this.submit();
        return;
      }
    }
    if (this.held !== null) {
      this.held.push(key);
      return;
    }
    if (ctrl('d') && this.edit.text === '' && this.edit.chips.length === 0) return this.close(0);
    if (ctrl('v')) return this.fromClipboard();
    if (key.kind === 'paste' && this.pasted(key.text)) return;
    if (key.kind === 'key') {
      if (key.name === 'tab') return this.toggleTools();
      if (ctrl('l')) return this.inline.invalidate();
      if (ctrl('d')) { this.edit = edit(this.edit, { kind: 'key', name: 'delete' }) ?? this.edit; return; }
      if (key.name === 'enter' && !key.alt && !key.shift) return this.submit();
      if (key.name === 'up' && this.queue.length > 0 && this.edit.text === '' && this.edit.chips.length === 0) return this.takeBack();
    }
    const next = edit(this.edit, key);
    if (next !== null) this.edit = next;
  }

  private submit(): void {
    const text = this.edit.text.trim();
    if (text === '' && this.edit.chips.length === 0) return;
    const line = entered(text);
    if (line.kind === 'command') {
      this.edit = { ...this.edit, text: '', cursor: 0, at: null };
      return this.command(line.command.name, line.arg);
    }
    // What has the shape of a command and is none is not sent as if it were words: it stays in the box, to be put right.
    if (line.kind === 'refused') return this.sayOnce(line.why);
    // A line that is a file's path and nothing else, as a terminal types it when a file is dragged in: an image is attached, anything else is sent as the words it is.
    const paths = line.text === text ? pathsIn(text) : null;
    if (paths !== null && paths.length === 1 && (this.clip.there || this.readable(paths[0]!))) {
      this.held = [];
      return this.bring(paths[0]!, text, 'enter');
    }
    this.send(line.text, text);
  }

  /** Send `text` to the agent. `typed` is what the owner typed for it, where that differs: it is what Up brings back. */
  private send(text: string, typed = text): void {
    try {
      const message = withMarkers(text, this.edit.chips.map((chip) => chip.path));
      if (this.holding()) {
        this.queue.push({ message, typed, chips: this.edit.chips, entry: this.transcript.hold(message) });
      } else {
        tell(this.o.paths.owner, message);
        this.transcript.say(message);
      }
      this.edit = sent(this.edit, typed);
    } catch (err) {
      this.say(`That line could not be sent: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Esc, or /stop: ask the agent to stop the turn it is in (kernel/owner.ts). Asked only when the
   * journal shows a turn under way, or a line from here is still on its way to start one, and a
   * body is there to hear it; otherwise the owner is told why nothing was done. Asked once: a
   * second press while the first is unanswered does nothing.
   */
  private interrupt(): void {
    const who = this.who === 'the agent' ? 'The agent' : this.who;
    const word = stateWord(this.standing, this.alive());
    if (!this.standing.turn.busy && !this.transcript.waiting) return this.sayOnce(`${who} is not in the middle of anything: there is nothing to interrupt.`);
    if (word === 'not running') return this.sayOnce('Nobody is running here: there is nothing to interrupt.');
    if (word === 'mutating') return this.sayOnce('The kernel is checking a mutation, and that is not interrupted from here. Its answer comes when the checks end.');
    if (word === 'starting') return this.sayOnce(`${who} is between two runs: no body is there to interrupt at this moment.`);
    if (this.interrupting !== null) return;
    try {
      interrupt(this.o.paths.owner);
      this.interrupting = this.now();
    } catch (err) {
      this.say(`The interrupt could not be sent: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Whether an interrupt sent from here has been answered: by the journal, by the turn ending anyway, or by nothing in time. */
  private interrupted(): void {
    if (this.interrupting === null) return;
    if (!this.standing.turn.busy && !this.transcript.waiting) {
      this.interrupting = null;
    } else if (this.now() - this.interrupting > INTERRUPT_MS) {
      this.interrupting = null;
      this.say(`${this.who === 'the agent' ? 'The agent' : this.who} has not stopped. A body from before interruptions does not hear them. Esc asks again; ./box down stops it for certain.`);
    } else return;
    this.dirty = true;
  }

  private toggleTools(): void {
    this.tools = !this.tools;
    if (!this.tools) return this.say('What tool calls return is no longer shown. Tab or /tools shows it again.');
    // What is printed stays as it is: the calls since the owner last spoke are shown once more, with what they returned.
    const entries = this.transcript.entries.filter((e) => e.id <= this.printed);
    const since = entries.findLastIndex((e) => e.kind === 'owner');
    const calls = entries.slice(since + 1).filter((e): e is Extract<Entry, { kind: 'tool' }> => e.kind === 'tool').slice(-8);
    const from = 'From now on each tool call is shown with a few rows of what it returned. Tab or /tools hides that again.';
    if (calls.length === 0) return this.say(from);
    this.page(`what the last ${calls.length === 1 ? 'tool call' : `${calls.length} tool calls`} returned`, [from, ''], calls);
  }

  private command(name: string, arg: string): void {
    switch (name) {
      case '/quit':
        return this.close(0);
      case '/help':
        return this.page('teneral talk', HELP);
      case '/tools':
        return this.toggleTools();
      case '/stop':
        return this.interrupt();
      case '/accept': {
        // The owner's word to the kernel, as a file of its own kind in the owner's channel (kernel/owner.ts). The agent is not told by it.
        try {
          const chosen = chooseAccept(this.o.paths.root, arg);
          if ('why' in chosen) return this.say(`Not accepted: ${chosen.why}.`);
          accept(this.o.paths.owner, chosen.commit);
          tell(this.o.paths.owner, acceptedLine(chosen.commit));
          return this.say(`Accepted species commit ${shortSha(chosen.commit)}${chosen.subject === '' ? '' : `, "${clean(chosen.subject).slice(0, 80)}"`}, and every one before it. The kernel takes that in when ${this.who} next asks for its mutation, and it was told to ask again.`);
        } catch (err) {
          return this.say(`That could not be accepted: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      case '/image': {
        if (arg === '') return this.say('/image <path> attaches an image file from your machine: /image ~/Pictures/plan.png');
        const paths = pathsIn(arg) ?? (arg.startsWith('/') || arg.startsWith('~/') ? [arg] : null);
        if (paths === null) return this.say(`${arg} is not a path this client can ask for: give the whole path, from / or from ~/.`);
        for (const path of paths) this.bring(path, path, 'command');
        return;
      }
      case '/plain':
        return this.page('the plain client', [
          './box talk --plain is the same conversation as plain text. With its input from a pipe, ./box talk is always plain:',
          '',
          '    echo "What are you working on?" | ./box talk',
        ]);
      case '/history': {
        if (this.earlier.length === 0) return this.say('Nothing earlier was read from the journal. memory/journal.jsonl has all of it.');
        const earlier = this.earlier;
        this.earlier = [];
        this.page('earlier, from the journal', [`The ${earlier.length} entries before what was shown when you attached.${this.transcript.truncated ? ' What is older still is in memory/journal.jsonl.' : ''}`]);
        const last = this.last;
        this.last = null;
        for (const e of earlier) if (!unfinished(e)) this.print(e);
        this.page('back to now', []);
        this.last = last ?? this.last;
        return;
      }
      case '/generations': {
        let list: string;
        try {
          const events = readEvents(this.o.paths.journal);
          const current = this.standing.current ?? readState(this.o.paths).current;
          list = formatList(generations(events, current));
        } catch (err) {
          list = `They could not be read: ${err instanceof Error ? err.message : String(err)}`;
        }
        return this.page('generations, oldest first', clean(list).split('\n'));
      }
      case '/usage': {
        let lines: string[];
        try {
          lines = formatUsage(usageReport(readEvents(this.o.paths.journal), this.now(), this.standing.current));
        } catch (err) {
          lines = [`It could not be read: ${err instanceof Error ? err.message : String(err)}`];
        }
        return this.page('what the model was asked for', lines);
      }
      case '/offers':
      case '/approve':
        return this.page(name === '/offers' ? 'waiting for your approval' : 'approval', clean((ownerCommand(this.o.paths.root, `${name} ${arg}`) ?? []).join('\n')).split('\n'));
      default:
        // A command in the table (kernel/commands.ts) that nothing above carries out.
        this.say(`${name} is not a command here, and was not sent. /help lists them.`);
    }
  }

  // --- images ---

  /** Whether this client can read `path` itself: it can when it runs on the owner's machine, or the file is in the repo. */
  private readable(path: string): boolean {
    try {
      return statSync(this.local(path)).isFile();
    } catch {
      return false;
    }
  }

  private local(path: string): string {
    return path.startsWith('~/') ? join(this.o.env.HOME ?? '/', path.slice(2)) : path;
  }

  private full(): boolean {
    if (this.edit.chips.length + this.asks.filter((ask) => ask.origin === 'key' || ask.origin === 'command').length < IMAGES_PER_MESSAGE) return false;
    this.say(`A message carries at most ${IMAGES_PER_MESSAGE} images. Backspace at the start of the line removes the last one.`);
    return true;
  }

  /** Ctrl+V: the image in the clipboard of the owner's machine, which only the helper there can reach. */
  private fromClipboard(): void {
    if (this.full()) return;
    const why = whyNoClipboard(this.clip.tool(), this.clip.there);
    if (why !== null) return this.say(why);
    const n = this.clip.ask('clipboard');
    if (n === null) return this.say('The request could not be left for the helper on your machine. ./box talk starts a new one.');
    this.asks.push({ n, origin: 'key', path: '', raw: '' });
  }

  /** A paste that names files and nothing else: each is asked for. Returns false for any other paste, which is text. */
  private pasted(text: string): boolean {
    const paths = pathsIn(text);
    if (paths === null) return false;
    if (!this.clip.there && !paths.some((path) => this.readable(path))) {
      if (!paths.some(namedLikeImage)) return false;
      this.say(`This client was started without its helper on your machine (./box talk starts one), so it cannot read ${paths.join(', ')} there. It was left as the text you pasted.`);
      return false;
    }
    for (const path of paths) this.bring(path, paths.length === 1 ? text.trim() : path, 'paste');
    return true;
  }

  /** Ask for the file at `path`: of the helper when there is one, else of this client's own disk. */
  private bring(path: string, raw: string, origin: Ask['origin']): void {
    const ask: Ask = { n: null, origin, path, raw };
    if (origin === 'command' && this.full()) return;
    if (this.clip.there) {
      ask.n = this.clip.ask('file', path);
      if (ask.n === null) return this.failed(ask, 'gone', '');
      this.asks.push(ask);
      return;
    }
    try {
      const file = this.local(path);
      const stat = statSync(file);
      if (!stat.isFile()) return this.failed(ask, 'not-file', '');
      if (stat.size > IMAGE_MAX_BYTES) return this.failed(ask, 'too-large', String(stat.size));
      this.arrived(ask, readFileSync(file));
    } catch (err) {
      const here = 'This client was started without its helper on your machine (./box talk starts one), and the file is not where this client can read it.';
      this.failed(ask, (err as { code?: unknown }).code === 'ENOENT' ? 'not-found' : 'not-file', here);
    }
  }

  /** Take the helper's answers that have come. */
  private answers(): void {
    for (let i = 0; i < this.asks.length;) {
      const ask = this.asks[i]!;
      const reply = this.clip.answer(ask.n!);
      if (reply === null) {
        i += 1;
        continue;
      }
      this.asks.splice(i, 1);
      this.dirty = true;
      if (reply.ok) this.arrived(ask, reply.bytes);
      else this.failed(ask, reply.code, clean(reply.detail).slice(0, 300));
    }
  }

  private arrived(ask: Ask, bytes: Uint8Array): void {
    const what = ask.origin === 'key' ? 'The clipboard\'s image' : ask.path;
    let image: Attachment;
    try {
      image = keep(this.root, bytes);
    } catch (err) {
      if (err instanceof NotKept && err.message.startsWith('it is not')) return this.failed(ask, 'not-image', '');
      this.say(`${what} was not attached: ${err instanceof Error ? err.message : String(err)}.`);
      return this.release(ask, false);
    }
    this.images.set(image.path, image);
    if (this.edit.chips.some((chip) => chip.path === image.path)) this.say('That image is attached already.');
    else if (this.edit.chips.length >= IMAGES_PER_MESSAGE) this.say(`A message carries at most ${IMAGES_PER_MESSAGE} images, so ${what === ask.path ? what : 'that one'} was not attached. Backspace at the start of the line removes the last one.`);
    else this.edit = attach(this.edit, image);
    this.release(ask, true);
  }

  private failed(ask: Ask, code: string, detail: string): void {
    const limit = `the limit is ${IMAGE_MAX_BYTES / 1024 / 1024} MB for one image`;
    const size = Number(detail) > 0 ? sizeText(Number(detail)) : 'too large';
    if (ask.origin === 'key') {
      this.say(code === 'no-image' ? 'There is no image in the clipboard.'
        : code === 'too-large' ? `The clipboard's image is ${size}, and ${limit}. It was not attached.`
          : code === 'no-tool' ? whyNoClipboard(this.clip.tool(), true) ?? 'Your machine has no tool to read the clipboard with.'
            : code === 'gone' ? 'The helper on your machine did not answer. Leave and run ./box talk again to start a new one.'
              : `The clipboard could not be read${detail === '' ? '' : `: ${detail}`}.`);
      return;
    }
    // A path that was pasted or sent as a line and is no picture is the owner's words after all; only what was named as a picture, or asked for outright, gets an explanation.
    if (ask.origin === 'command' || namedLikeImage(ask.path)) {
      this.say(code === 'not-found' ? `No such file${this.clip.there ? ' on your machine' : ''}: ${ask.path}${!this.clip.there && detail !== '' ? `. ${detail}` : ''}`
        : code === 'not-image' ? `${ask.path} is not a PNG, JPEG, GIF or WebP image, so it was not attached.`
          : code === 'too-large' ? `${ask.path} is ${size}, and ${limit}. It was not attached.`
            : code === 'gone' ? 'The helper on your machine did not answer. Leave and run ./box talk again to start a new one.'
              : `${ask.path} is not a file that can be read.`);
    }
    this.release(ask, false);
  }

  /** What becomes of the text that named a file, once it is known whether the file was attached. */
  private release(ask: Ask, attached: boolean): void {
    if (ask.origin === 'paste' && !attached) this.edit = insert(this.edit, ask.raw);
    if (ask.origin !== 'enter') return;
    const held = this.held ?? [];
    this.held = null;
    if (attached) this.edit = { ...this.edit, text: '', cursor: 0, at: null };
    else if (!namedLikeImage(ask.path)) this.send(this.edit.text.trim());
    for (const key of held) this.key(key);
  }

  // --- the live region ---

  private paint(): void {
    if (this.closed) return;
    const pending = this.settle();
    const { cols, rows } = this.o.term.size();
    const g = this.g;
    const s = this.standing;
    const word = stateWord(s, this.alive());
    const now = this.now();
    const active = ['waking', 'thinking', 'mutating', 'starting'].includes(word) || word.startsWith('running ');
    const spin = active ? Math.floor(now / SPIN_MS) % g.spinner.length : 0;
    const clock = active && s.since !== null ? elapsed(now - s.since) : '';
    const tip = Math.floor(now / TIP_MS);
    const stamp = `${cols}x${rows}|${word}|${spin}|${clock}|${this.name}|${s.current}|${tip}|${s.tool?.name}|${this.interrupting !== null}`;
    if (!this.dirty && stamp === this.painted) return;
    this.dirty = false;
    this.painted = stamp;

    const max = this.inline.width;
    const laid: Line[] = [];
    let before: Entry | undefined;
    for (const e of pending.slice(-PENDING_SHOWN)) {
      laid.push(...Array.from({ length: gap(before, e) }, (): Line => []), ...entryRows(e, max, this.look));
      before = e;
    }
    const doing = word === 'waking' && s.tool !== null ? `waking ${g.sep} running ${s.tool.name}`
      : s.tool !== null && isMutationTool(s.tool.name) && word.startsWith('running ') ? 'asking for a mutation' : word;
    // What Esc would do now, where it would do anything: between two runs, or while the kernel checks a mutation, there is no turn to stop.
    const stoppable = word === 'waking' || word === 'thinking' || word.startsWith('running ');
    // While the list of commands is open, Esc closes that and interrupts nothing, so the line does not say it would.
    const offered = this.offered();
    let list: Offered | null = null;
    if (offered !== null) {
      const chosen = offered.matches[offered.chosen]!;
      const runs = chosen.name === offered.typed.name || takes(chosen) === 'none';
      list = { matches: offered.matches, chosen: offered.chosen, keys: ['Tab completes', runs ? 'Enter runs' : 'Enter completes', 'Esc closes', 'Up/Down choose'] };
    }
    const esc = this.interrupting !== null ? `interrupting ${g.ellipsis}` : stoppable && list === null ? 'esc to interrupt' : '';
    const activity: Line | null = active
      ? [{ text: `${g.spinner[spin]} `, style: { fg: 'brand' } }, { text: `${this.who === 'the agent' ? 'The agent' : this.who} is ${doing}`, style: { bold: true } }, { text: clock === '' ? '' : ` ${g.sep} ${clock}`, style: { fg: 'dim' } }, { text: esc === '' ? '' : ` ${g.sep} ${esc}`, style: { fg: 'faint' } }]
      : null;

    const model = clean(this.o.env.TENERAL_MODEL ?? '').slice(0, 40);
    const effort = clean(this.o.env.TENERAL_REASONING_EFFORT ?? '').slice(0, 16);
    const at = s.current === null ? 0 : s.known.indexOf(s.current) + 1;
    const generation = s.current === null ? '' : `${at > 0 ? `gen ${at} ` : ''}${shortSha(s.current)}`;
    const state = active ? '' : word;
    const waiting = this.asks.length > 0 ? (this.asks.some((ask) => ask.origin === 'key') ? 'asking your machine for the clipboard\'s image' : 'asking your machine for the file') : '';
    const chips = this.edit.chips.length;
    const hint = waiting !== '' ? `${waiting} ${g.ellipsis}`
      : chips > 0 ? `attached: ${this.edit.chips.map((_, i) => `image ${i + 1}`).join(', ')} ${g.sep} Backspace at the start removes the last`
      : this.queue.length > 0 ? `${this.queue.length} queued ${g.sep} Up takes the last back` : '';
    let context = '';
    if (s.usage !== null) {
      const window = (providers as { contextWindow?: unknown }).contextWindow;
      let known: number | null = null;
      try {
        const said: unknown = typeof window === 'function' ? window(this.o.env.TENERAL_PROVIDER ?? providers.DEFAULT_PROVIDER, this.o.env.TENERAL_MODEL ?? '') : null;
        known = typeof said === 'number' && said > 0 ? said : null;
      } catch { /* not known */ }
      context = [cacheUse(s.usage.input, s.usage.cached), contextUse(s.usage.input + s.usage.output, known)].filter((part) => part !== '').join(` ${g.sep} `);
    }
    this.inline.paint(liveRows({
      cols, rows, g,
      pending: laid,
      activity,
      edit: this.edit,
      about: [model, effort === '' ? '' : `effort ${effort}`, state, shortDir(clean(this.o.env.TENERAL_HOST_DIR || this.o.paths.root), g), generation],
      tip: this.tips()[tip % this.tips().length]!,
      context,
      hint,
      list,
    }));
  }

  /** Things worth knowing, one at a time in the footer. Every one names a real key or command. */
  private tips(): string[] {
    return [
      '/help lists the keys and commands',
      'Alt+Enter starts a new line',
      'Tab shows what the tool calls returned',
      'Esc interrupts what it is doing',
      ...(this.clip.there ? ['Ctrl+V attaches the clipboard\'s image', 'drag an image file in to attach it'] : []),
      '/image <path> attaches an image file',
      'Up brings back what you sent before',
      '/generations lists the bodies it has lived in',
      '/history prints the earlier conversation',
      `Ctrl-C leaves; ${this.who} goes on`,
      './box talk --plain is this as plain text',
    ];
  }
}

/**
 * The talk client at the process's own terminal, until the owner leaves. However it ends (a key,
 * a signal, the terminal closing, an error in this program) the terminal is given back first.
 */
export async function runTalkScreen(p: Paths, env: Record<string, string | undefined>, banner: string | null, cage: string | null = null): Promise<number> {
  const filled = { ...env };
  for (const key of ['TENERAL_MODEL', 'TENERAL_PROVIDER', 'TENERAL_HEARTBEAT_MINUTES'] as const) filled[key] ??= envLine(p.root, key);
  const app = new TalkScreen({ term: terminal(env), paths: p, env: filled, banner, cage });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => app.close(0));
  const failed = (err: unknown) => {
    app.close(1);
    console.error(`talk: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
  };
  process.on('uncaughtException', failed);
  process.on('unhandledRejection', failed);
  // Whatever else ends the process, the live region is not left on the terminal.
  process.on('exit', () => app.close(0));
  return app.run();
}
