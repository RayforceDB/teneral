import { writeSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { clip, lineWidth, type Line } from './text';
import { capsOf, sgr, type Caps } from './theme';

// The terminal itself, in the two ways the owner's programs use it. `Screen` takes the alternate
// screen and paints whole frames onto it: the setup. `Inline` stays on the normal screen, prints
// what is finished once, to scroll away as any output does, and keeps a few live rows redrawn in
// place under it: the talk client. Either way only what differs is written, all in one write.

/** What a screen needs of a terminal. The real one is `terminal()`; tests give a made-up one. */
export interface Term {
  size: () => { cols: number; rows: number };
  write: (data: string) => void;
  /** Starts delivering what is typed, raw and unechoed. Returns how to stop. */
  listen: (onData: (text: string) => void, onEnd: () => void) => () => void;
  onResize: (handler: () => void) => () => void;
  caps: Caps;
}

/**
 * One long line the terminal wraps by itself, such as an address to copy: written in one piece
 * from the first column, so that selecting it gives one line back. `link` makes it a hyperlink
 * where the terminal knows how. It must be plain ASCII.
 */
export interface Flow {
  flow: string;
  link?: string;
}
export type Row = Line | Flow;

const isFlow = (row: Row): row is Flow => !Array.isArray(row);
/** The rows a flow takes on a screen `cols` wide. */
export const flowHeight = (flow: Flow, cols: number): number => Math.max(1, Math.ceil(flow.flow.length / Math.max(1, cols)));

export interface Frame {
  rows: Row[];
  /** Where the terminal's cursor is shown, counted from 0; null hides it. */
  cursor: { row: number; col: number } | null;
}

const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?2004h';
/** Everything `ENTER` changed, put back. Safe to send twice. */
const LEAVE = '\x1b[?2004l\x1b[0m\x1b[?25h\x1b[?1049l';

/** A row with its colours, cut to `max` columns. */
function encode(row: Line, max: number, depth: Caps['depth']): string {
  const line = lineWidth(row) > max ? clip(row, max) : row;
  let text = '';
  for (const span of line) {
    const code = sgr(span.style, depth);
    text += code === '' || span.text === '' ? span.text : `\x1b[${code}m${span.text}\x1b[0m`;
  }
  return text;
}

export class Screen {
  private shown: string[] = [];
  private cursor = '';
  private size = { cols: 0, rows: 0 };
  private inside = false;

  constructor(private readonly term: Term) {}

  get active(): boolean {
    return this.inside;
  }

  enter(): void {
    this.inside = true;
    this.term.write(ENTER);
    this.invalidate();
  }

  /** Back to the screen that was there before. `keep`: stay on the alternate screen, for a program that takes over at once. */
  leave(keep = false): void {
    if (!this.inside) return;
    this.inside = false;
    this.term.write(keep ? '\x1b[?2004l\x1b[0m' : LEAVE);
  }

  /** The next frame is painted whole. */
  invalidate(): void {
    this.shown = [];
    this.cursor = '';
  }

  paint(frame: Frame): void {
    if (!this.inside) return;
    const { cols, rows } = this.term.size();
    const depth = this.term.caps.depth;
    let out = '';
    if (cols !== this.size.cols || rows !== this.size.rows || this.shown.length === 0) {
      this.size = { cols, rows };
      this.shown = [];
      out += '\x1b[0m\x1b[2J';
    }
    const next: string[] = [];
    for (const row of frame.rows) {
      if (next.length >= rows) break;
      const y = next.length;
      if (isFlow(row)) {
        const height = Math.min(flowHeight(row, cols), rows - y);
        const text = row.flow.slice(0, height * cols);
        const link = row.link !== undefined && this.term.caps.links;
        const body = `${link ? `\x1b]8;;${row.link}\x1b\\` : ''}\x1b[${sgr({ underline: true }, depth)}m${text}\x1b[0m${link ? '\x1b]8;;\x1b\\' : ''}`;
        next.push(`\x00${body}`);
        for (let i = 1; i < height; i++) next.push('\x00');
        if (next.slice(y, y + height).some((cell, i) => cell !== this.shown[y + i])) {
          for (let i = 0; i < height; i++) out += `\x1b[${y + i + 1};1H\x1b[2K`;
          out += `\x1b[${y + 1};1H${body}`;
        }
        continue;
      }
      let text = encode(row, cols, depth);
      // Erasing to the end of a row that is full to its last column would take that column's character with it.
      if (lineWidth(row) < cols) text += '\x1b[K';
      next.push(text);
      if (this.shown[y] !== text) out += `\x1b[${y + 1};1H${text}`;
    }
    for (let y = next.length; y < rows; y++) {
      next.push('\x1b[K');
      if (this.shown[y] !== '\x1b[K') out += `\x1b[${y + 1};1H\x1b[K`;
    }
    this.shown = next;
    const c = frame.cursor;
    const cursor = c === null ? '\x1b[?25l' : `\x1b[${Math.min(rows, c.row + 1)};${Math.min(cols, c.col + 1)}H\x1b[?25h`;
    if (out === '' && cursor === this.cursor) return;
    this.cursor = cursor;
    // Between these two marks a terminal that knows them shows nothing half-drawn; one that does not ignores them.
    this.term.write(`\x1b[?2026h\x1b[?25l${out}${cursor}\x1b[?2026l`);
  }
}

/**
 * The normal screen, used as any program's output is: what is finished is printed once and
 * scrolls away into the terminal's own scrollback, where the terminal's scrollbar, selection,
 * copy and search work on it; under it a live region of a few rows is redrawn in place.
 *
 * Between two writes the terminal's cursor always rests, hidden, on the first column of the live
 * region's first row, and it is only ever moved relative to there. That one rule is what keeps
 * the screen clean: whatever the terminal does to the rows when its window changes size (cut
 * them, or wrap them again and move them), the cursor stays with the row it was on, so erasing
 * from the cursor down takes exactly the live region, old shape and all, and nothing above it.
 * The cursor the owner sees in the input is drawn, as a cell with its colours swapped.
 *
 * No row is ever written into the last column: a full row would leave the cursor waiting to
 * wrap, and terminals differ on what happens next.
 */
export class Inline {
  /** The live rows as they were last written; null when the region has to be written whole. */
  private shown: string[] | null = null;
  private cols = 0;
  private queue: Line[] = [];
  private on = false;

  constructor(private readonly term: Term) {}

  get active(): boolean {
    return this.on;
  }

  /** The widest a row may be. */
  get width(): number {
    return Math.max(1, this.term.size().cols - 1);
  }

  start(): void {
    this.on = true;
    this.shown = null;
    // On a line of its own, whatever was printed before without a line break.
    this.term.write('\x1b[?25l\x1b[?2004h\r');
  }

  /** Rows that are finished: printed above the live region with the next `paint`, in order, never again. */
  print(rows: Line[]): void {
    this.queue.push(...rows);
  }

  /** The live region is written whole with the next `paint`: after the window changed, or when asked to. */
  invalidate(): void {
    this.shown = null;
  }

  /** Print what is queued and make the live region these rows. More rows than fit under one row of what was printed are dropped from the top. */
  paint(live: Line[]): void {
    if (!this.on) return;
    const { cols, rows } = this.term.size();
    const depth = this.term.caps.depth;
    const max = Math.max(1, cols - 1);
    const next = live.slice(-Math.max(1, rows - 1)).map((row) => encode(row, max, depth));
    let out = '';
    if (this.queue.length > 0 || this.shown === null || this.shown.length !== next.length || cols !== this.cols) {
      // From the first row of the region: the finished rows, then the region anew, then nothing below it.
      for (const row of this.queue) out += `${encode(row, max, depth)}\x1b[K\r\n`;
      out += next.map((row) => `${row}\x1b[K`).join('\r\n');
      out += '\x1b[J';
      if (next.length > 1) out += `\x1b[${next.length - 1}A`;
      out += '\r';
      this.queue = [];
    } else {
      for (let i = 0; i < next.length; i++) {
        if (next[i] === this.shown[i]) continue;
        out += `${i > 0 ? `\x1b[${i}B` : ''}${next[i]}\x1b[K${i > 0 ? `\x1b[${i}A` : ''}\r`;
      }
    }
    this.cols = cols;
    this.shown = next;
    if (out === '') return;
    // Between these two marks a terminal that knows them shows nothing half-drawn; one that does not ignores them.
    this.term.write(`\x1b[?2026h\r${out}\x1b[?2026l`);
  }

  /** Print what is queued, take the live region away and give the terminal back, its cursor under the last row printed. Safe to call twice. */
  stop(): void {
    if (!this.on) return;
    this.paint([]);
    this.on = false;
    this.term.write('\x1b[0m\x1b[?2004l\x1b[?25h');
  }
}

/**
 * Whether the terminal is still there. A program started with `docker exec` is not told when
 * the terminal that started it goes away: nothing is hung up, no input ends, and it would sit
 * there for good. So it asks. Every so often the terminal is sent a status request, which a
 * terminal answers at once (the answer comes in with the keys, as `alive`). Two requests in a
 * row without an answer, from a terminal that has answered before, and it is gone.
 */
export class Lifeline {
  /** A terminal that has never answered may be one that never does; it is not taken for gone. */
  private answered = false;
  private unanswered = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly term: Term, private readonly gone: () => void, private readonly everyMs = 15_000) {}

  start(): void {
    this.ask();
    this.timer = setInterval(() => {
      if (this.answered && this.unanswered >= 2) this.gone();
      else this.ask();
    }, this.everyMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  heard(): void {
    this.answered = true;
    this.unanswered = 0;
  }

  private ask(): void {
    this.unanswered += 1;
    this.term.write('\x1b[5n');
  }
}

/** The process's own terminal. Writes are synchronous, so the last frame and the way out are never lost at exit. */
export function terminal(env: Record<string, string | undefined> = process.env): Term {
  const { stdin, stdout } = process;
  return {
    size: () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 }),
    write: (data) => {
      const bytes = Buffer.from(data, 'utf8');
      for (let offset = 0; offset < bytes.length;) {
        try {
          offset += writeSync(1, bytes, offset);
        } catch (err) {
          // A terminal that is slow to take it all is waited for; one that is gone ends the program quietly.
          if ((err as NodeJS.ErrnoException).code !== 'EAGAIN') return;
        }
      }
    },
    listen: (onData, onEnd) => {
      const decoder = new StringDecoder('utf8');
      const data = (chunk: Buffer) => onData(decoder.write(chunk));
      stdin.setRawMode(true);
      stdin.on('data', data);
      stdin.on('end', onEnd);
      stdin.on('error', onEnd);
      stdin.resume();
      return () => {
        stdin.off('data', data);
        stdin.off('end', onEnd);
        stdin.off('error', onEnd);
        try { stdin.setRawMode(false); } catch { /* the terminal is gone */ }
        stdin.pause();
      };
    },
    onResize: (handler) => {
      stdout.on('resize', handler);
      return () => { stdout.off('resize', handler); };
    },
    caps: capsOf(env),
  };
}
