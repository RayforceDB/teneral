import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { formatList, generations } from '../back';
import { journalSize, readEvents, readEventsFrom, type JournalEvent } from '../journal';
import { tell } from '../owner';
import { holder, readState, type Paths } from '../supervisor';
import { Follower } from '../talk';
import { EMPTY, edit, sent, type Edit } from './editor';
import { KeyParser, type Key } from './keys';
import { Transcript, UNBORN, shortSha, stand, stateWord, type Alive, type Entry, type Standing } from './model';
import { Lifeline, Screen, terminal, type Term } from './screen';
import { clean, type Line } from './text';
import { SPIN_MS, glyphs } from './theme';
import { Scroller, block, elapsed, regions, talkFrame } from './view';

// The talk screen: `./box talk` at a terminal. The owner's lines go out through the owner channel
// (kernel/owner.ts) and everything shown is read back from the journal, exactly as the plain
// client does it, so any number of these can be attached and leaving one ends nothing else.
// Nothing here can stop the agent or change it.

/** How far back the history shown on attaching looks, as in the plain client. */
const HISTORY_BYTES = 256_000;
const TICK_MS = 125;
/** A lone ESC is the Escape key once this long has passed with nothing after it. */
const ESCAPE_MS = 40;

const HELP = [
  'Enter sends what you typed to the agent, as its owner. Alt+Enter, or Ctrl-J, starts a new line. Up and Down walk through what you sent before. Ctrl-U, Ctrl-K and Ctrl-W delete to the start of the line, to its end, and the word before the cursor.',
  '',
  'PageUp and PageDown, Shift+Up and Shift+Down, and the mouse wheel scroll. End, Esc or typing comes back to the newest. While the wheel is read here, hold Shift to select text with the mouse, or give the mouse back with /mouse.',
  '',
  '  /help          this',
  '  /generations   the generations this individual has lived in',
  '  /tools         show or hide what each tool call returned (also Tab)',
  '  /mouse         give the mouse back to the terminal, or take the wheel again',
  '  /plain         how to get the plain text client',
  '  /quit          leave (also Ctrl-D on an empty line, and Ctrl-C)',
  '',
  'Leaving ends this screen only. Nothing here stops the agent or changes it.',
  '',
  'The word at the top right says where the agent stands: waking (its first start, before its first words), thinking, running <tool>, molting (it asked for a new body and the kernel is checking it), starting (between two runs), resting, not running, and waiting for you: its last finished reply ended with a question mark and nothing has arrived since.',
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

/**
 * The individual's own name, from its SOUL.md: a line `name: ...` (or `имя: ...`), else the first
 * first-level heading unless that is only the page's title. Null when neither gives a short name.
 */
export function soulName(text: string): string | null {
  const t = clean(text);
  const tidy = (raw: string | undefined): string | null => {
    const name = (raw ?? '').replace(/[*_`#[\]]/g, '').replace(/\s+/g, ' ').replace(/[.,;:!]+$/, '').trim();
    return name !== '' && [...name].length <= 32 ? name : null;
  };
  const line = /^[ \t]*(?:[-*+][ \t]+)?[*_]{0,2}(?:my[ \t]+)?(?:name|имя)[*_]{0,2}[ \t]*[:：—–-][ \t]*(.+)$/imu.exec(t);
  if (line) return tidy(line[1]);
  const heading = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(t);
  if (heading && !/^(soul(\.md)?|who i am|about me|me|душа|кто я)$/iu.test(heading[1]!.trim())) return tidy(heading[1]);
  return null;
}

export interface TalkScreenOptions {
  term: Term;
  paths: Paths;
  env: Record<string, string | undefined>;
  /** Said once, on attaching: for instance whose plan the agent's requests use. */
  banner?: string | null;
  now?: () => number;
  /** Whether the kernel and the body are there. Default: what the lock and the child record under `.teneral/` say. */
  alive?: () => Alive;
  /** How often the terminal is asked whether it is still there. Default 15 s. */
  lifelineMs?: number;
}

export class TalkScreen {
  private readonly screen: Screen;
  private readonly keys = new KeyParser();
  private readonly transcript = new Transcript();
  private readonly scroller = new Scroller();
  private readonly now: () => number;
  private readonly alive: () => Alive;
  private follower!: Follower;
  private shown = new Set<string>();
  private standing: Standing = UNBORN;
  private edit: Edit = EMPTY;
  /** A page shown over the transcript: its title, its text by paragraphs, and how far it is scrolled. */
  private overlay: { title: string; text: string[]; top: number } | null = null;
  /** The note that nothing has been said yet, for as long as that is so. */
  private silence: Entry | null = null;
  private tools = false;
  private mouse = true;
  private name: string | null = null;
  private soulStamp = -1;
  private ticks = 0;
  /** What the last frame was made from, to tell whether another is due. */
  private painted = '';
  private dirty = true;
  private stops: (() => void)[] = [];
  private finish: ((status: number) => void) | null = null;
  private escape: ReturnType<typeof setTimeout> | undefined;
  private readonly lifeline: Lifeline;
  closed = false;

  constructor(private readonly o: TalkScreenOptions) {
    this.screen = new Screen(o.term);
    // A terminal that went away without a word: the client ends, as if the owner had left.
    this.lifeline = new Lifeline(o.term, () => this.close(0), o.lifelineMs);
    this.now = o.now ?? Date.now;
    const p = o.paths;
    this.alive = o.alive ?? (() => {
      try {
        return { supervisor: holder(p.lock) !== null, body: existsSync(p.child) };
      } catch {
        return { supervisor: false, body: false };
      }
    });
  }

  /** Take the screen and show where things stand. */
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
      this.transcript.older();
    }
    if (before.length === 0) this.silence = this.transcript.note('Nothing has been said yet.');
    for (const e of before) this.take(e, false);
    // Under the history, where it is read on attaching, not above it and out of view.
    if (this.o.banner) this.transcript.note(this.o.banner);
    // That read may have gone past `size`, where the follower starts.
    this.shown = new Set(before.map((e) => e.id));
    this.follower = new Follower(journal, size);
    if (this.standing.current === null) {
      try {
        const current = readState(this.o.paths).current;
        this.standing = { ...this.standing, current, known: this.standing.known.includes(current) ? this.standing.known : [...this.standing.known, current] };
      } catch { /* never started here */ }
    }
    const said = this.transcript.entries.flatMap((e) => (e.kind === 'owner' ? [e.text] : []));
    this.edit = said.reduce((e, text) => sent(e, text), EMPTY);
    this.screen.enter(this.mouse);
    this.stops.push(
      this.o.term.listen((text) => this.input(text), () => this.close(0)),
      this.o.term.onResize(() => { this.dirty = true; this.paint(); }),
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

  /** Give the terminal back. Safe to call twice, and from a signal handler. */
  close(status = 0): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.escape);
    for (const stop of this.stops) stop();
    this.screen.leave();
    this.finish?.(status);
  }

  private take(e: JournalEvent, live: boolean): void {
    if (this.silence !== null) {
      this.transcript.drop(this.silence);
      this.silence = null;
    }
    this.transcript.add(e, this.standing, live);
    try {
      this.standing = stand(this.standing, e);
    } catch { /* an event of a shape nobody foresaw changes nothing */ }
  }

  /** Look at the journal and at the records under `.teneral/` once, and paint if anything shows differently. */
  tick(): void {
    if (this.closed) return;
    this.ticks += 1;
    for (const e of this.follower.poll()) {
      if (this.shown.has(e.id)) continue;
      this.take(e, true);
      this.dirty = true;
    }
    if (this.ticks % 8 === 1) this.readName();
    this.paint();
  }

  private readName(): void {
    const file = join(this.o.paths.soul, 'SOUL.md');
    let stamp = 0;
    try {
      stamp = statSync(file).mtimeMs;
    } catch { /* no soul yet */ }
    if (stamp === this.soulStamp) return;
    this.soulStamp = stamp;
    try {
      this.name = stamp === 0 ? null : soulName(readFileSync(file, 'utf8').slice(0, 20_000));
    } catch {
      this.name = null;
    }
    this.dirty = true;
  }

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
  settle(): void {
    clearTimeout(this.escape);
    for (const key of this.keys.flush()) this.key(key);
    this.paint();
  }

  private height(): number {
    const { cols, rows } = this.o.term.size();
    return regions(cols, rows, this.edit.text, this.edit.cursor).height;
  }

  private key(key: Key): void {
    if (this.closed) return;
    if (key.kind === 'alive') return this.lifeline.heard();
    this.dirty = true;
    const ctrl = (name: string): boolean => key.kind === 'key' && key.ctrl === true && key.name === name;
    if (ctrl('c')) return this.close(0);
    if (this.overlay !== null) {
      // The scrolling keys move it; any other key puts it away.
      const by = key.kind === 'wheel' ? (key.up ? -3 : 3)
        : key.kind !== 'key' ? null
          : key.name === 'up' ? -1 : key.name === 'down' ? 1 : key.name === 'pageup' ? -this.height() : key.name === 'pagedown' ? this.height() : null;
      if (by === null) this.overlay = null;
      else this.overlay.top = Math.max(0, this.overlay.top + by);
      return;
    }
    if (ctrl('d') && this.edit.text === '') return this.close(0);
    if (key.kind === 'wheel') return this.scroller.scroll(key.up ? -3 : 3, this.height());
    if (key.kind === 'key') {
      const page = Math.max(1, this.height() - 2);
      if (key.name === 'pageup') return this.scroller.scroll(-page, this.height());
      if (key.name === 'pagedown') return this.scroller.scroll(page, this.height());
      if (key.shift && key.name === 'up') return this.scroller.scroll(-1, this.height());
      if (key.shift && key.name === 'down') return this.scroller.scroll(1, this.height());
      if (key.name === 'tab') { this.tools = !this.tools; return; }
      if (key.name === 'escape') return this.scroller.follow();
      if (ctrl('l')) return this.screen.invalidate();
      if (ctrl('d')) { this.edit = edit(this.edit, { kind: 'key', name: 'delete' }) ?? this.edit; return; }
      if (key.name === 'enter' && !key.alt && !key.shift) return this.submit();
    }
    const next = edit(this.edit, key);
    if (next === null) return;
    this.edit = next;
    if (key.kind !== 'key' || key.name === 'end') this.scroller.follow();
  }

  private submit(): void {
    const text = this.edit.text.trim();
    if (text === '') return;
    this.scroller.follow();
    if (/^\/[a-z]+$/.test(text)) {
      this.edit = { ...this.edit, text: '', cursor: 0, at: null };
      return this.command(text);
    }
    try {
      tell(this.o.paths.owner, text);
      this.transcript.say(text);
      this.edit = sent(this.edit, text);
    } catch (err) {
      this.transcript.note(`That line could not be sent: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private command(name: string): void {
    switch (name) {
      case '/quit':
        return this.close(0);
      case '/help':
        this.overlay = { title: 'teneral talk', text: HELP, top: 0 };
        return;
      case '/tools':
        this.tools = !this.tools;
        return;
      case '/mouse':
        this.mouse = !this.mouse;
        this.screen.setMouse(this.mouse);
        this.transcript.note(this.mouse
          ? 'The mouse wheel scrolls here again. Hold Shift to select text.'
          : 'The mouse is the terminal\'s again: select and copy as usual. PageUp and PageDown still scroll; /mouse takes the wheel back.');
        return;
      case '/plain':
        this.overlay = { title: 'the plain client', top: 0, text: [
          './box talk --plain is the same conversation as plain text, without this screen. With its input from a pipe, ./box talk is always plain:',
          '',
          '    echo "What are you working on?" | ./box talk',
        ] };
        return;
      case '/generations': {
        let list: string;
        try {
          const events = readEvents(this.o.paths.journal);
          const current = this.standing.current ?? readState(this.o.paths).current;
          list = formatList(generations(events, current));
        } catch (err) {
          list = `They could not be read: ${err instanceof Error ? err.message : String(err)}`;
        }
        // The newest are at the end of the list, so that is where it opens.
        this.overlay = { title: 'generations, oldest first', text: clean(list).split('\n'), top: Number.MAX_SAFE_INTEGER };
        return;
      }
      default:
        this.transcript.note(`${name} is not a command here, and was not sent. /help lists them.`);
    }
  }

  private paint(): void {
    if (this.closed) return;
    const { cols, rows } = this.o.term.size();
    const g = glyphs(this.o.term.caps.utf8);
    const s = this.standing;
    const alive = this.alive();
    const word = stateWord(s, alive);
    const now = this.now();
    // The line at the foot of the transcript while something is under way.
    const active = ['waking', 'thinking', 'molting', 'starting'].includes(word) || word.startsWith('running ');
    const spin = active ? Math.floor(now / SPIN_MS) % g.spinner.length : 0;
    const clock = active && s.since !== null ? elapsed(now - s.since) : '';
    const tool = word === 'waking' && s.tool !== null ? ` ${g.sep} running ${s.tool.name}` : '';
    const stamp = `${cols}x${rows}|${word}|${spin}|${clock}|${tool}|${this.name}|${s.current}`;
    if (!this.dirty && stamp === this.painted) return;
    this.dirty = false;
    this.painted = stamp;

    const tail: Line[] = active
      ? [[], [{ text: `  ${g.spinner[spin]} `, style: { fg: 'accent' } }, { text: `${word}${tool}` }, { text: clock === '' ? '' : ` ${g.sep} ${clock}`, style: { fg: 'dim' } }]]
      : [];
    const r = regions(cols, rows, this.edit.text, this.edit.cursor);
    this.scroller.set(this.transcript.entries, tail, cols, { g, tools: this.tools });
    let overlay: { title: string; rows: Line[]; top: number } | null = null;
    if (this.overlay !== null) {
      const laid = this.overlay.text.flatMap((text) => block(text, cols, undefined, 2));
      this.overlay.top = Math.max(0, Math.min(this.overlay.top, laid.length - (r.height - 2)));
      overlay = { title: this.overlay.title, rows: laid, top: this.overlay.top };
    }
    const ordinal = s.current === null ? 0 : s.known.indexOf(s.current) + 1;
    this.screen.paint(talkFrame({
      cols, rows, g,
      name: this.name,
      generation: ordinal > 0 ? `generation ${ordinal}` : '',
      commit: shortSha(s.current),
      model: clean(this.o.env.TENERAL_MODEL ?? '').slice(0, 40),
      state: word,
      transcript: this.scroller.rows(r.height),
      more: !this.scroller.following,
      overlay,
      edit: this.edit,
    }));
  }
}

/** The model's name where the environment does not have it: the one line of `.env` that names it. */
function modelIn(root: string): string | undefined {
  try {
    return /^TENERAL_MODEL=(.*)$/m.exec(readFileSync(join(root, '.env'), 'utf8'))?.[1]?.trim();
  } catch {
    return undefined;
  }
}

/**
 * The talk screen at the process's own terminal, until the owner leaves. However it ends (a key,
 * a signal, the terminal closing, an error in this program) the terminal is given back first.
 */
export async function runTalkScreen(p: Paths, env: Record<string, string | undefined>, banner: string | null): Promise<number> {
  const app = new TalkScreen({ term: terminal(env), paths: p, env: { ...env, TENERAL_MODEL: env.TENERAL_MODEL ?? modelIn(p.root) }, banner });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => app.close(0));
  const failed = (err: unknown) => {
    app.close(1);
    console.error(`talk: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
  };
  process.on('uncaughtException', failed);
  process.on('unhandledRejection', failed);
  // Whatever else ends the process, the terminal is not left on the alternate screen.
  process.on('exit', () => app.close(0));
  return app.run();
}
