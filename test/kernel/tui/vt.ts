import { charWidth } from '../../../kernel/tui/text';
import type { Term } from '../../../kernel/tui/screen';
import type { Caps } from '../../../kernel/tui/theme';

// A terminal for tests: it takes what a program writes and keeps the grid of characters a person
// would be looking at. Styling is dropped, so a frame reads like the screen. It knows the
// sequences the screens use and the common ones around them; it is no complete emulator.

type Grid = string[][];

export class Vt {
  cols: number;
  rows: number;
  /** On the alternate screen. */
  alt = false;
  cursorVisible = true;
  /** Private modes switched on and not off again: 1000 and 1006 for the mouse, 2004 for bracketed paste. */
  modes = new Set<number>();
  /** Where the terminal's own answers go: a status request is answered here, as long as `answers` is set. */
  reply: ((bytes: string) => void) | null = null;
  answers = true;
  /** Every hyperlink target that was opened. */
  links: string[] = [];
  /** Rows whose text ran on into the next row without a line break: what a selection copies as one line. */
  private wrapped = new Set<number>();
  private grid: Grid;
  private saved: { grid: Grid; x: number; y: number } | null = null;
  private x = 0;
  private y = 0;
  /** The cursor is past the last column: the next character starts the next row. */
  private overflow = false;
  private pending = '';

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.grid = this.blank();
  }

  private blank(): Grid {
    return Array.from({ length: this.rows }, () => Array.from({ length: this.cols }, () => ' '));
  }

  resize(cols: number, rows: number): void {
    const old = this.grid;
    this.cols = cols;
    this.rows = rows;
    this.grid = this.blank();
    for (let y = 0; y < Math.min(rows, old.length); y++) {
      for (let x = 0; x < Math.min(cols, old[y]!.length); x++) this.grid[y]![x] = old[y]![x]!;
    }
    this.x = Math.min(this.x, cols - 1);
    this.y = Math.min(this.y, rows - 1);
  }

  /** The screen as text: one line per row, without the spaces at the end of each. */
  text(): string {
    return this.grid.map((row) => row.join('').trimEnd()).join('\n');
  }

  /** The rows from `from` on that the terminal holds as one wrapped line, joined as a selection would copy them. */
  logicalLine(from: number): string {
    let out = '';
    for (let y = from; y < this.rows; y++) {
      out += this.grid[y]!.join('');
      if (!this.wrapped.has(y)) break;
    }
    return out.trimEnd();
  }

  get cursor(): { row: number; col: number } {
    return { row: this.y, col: this.x };
  }

  write(data: string): void {
    const s = this.pending + data;
    this.pending = '';
    for (let i = 0; i < s.length;) {
      const c = s[i]!;
      if (c === '\x1b') {
        const used = this.escape(s.slice(i));
        if (used === 0) {
          this.pending = s.slice(i);
          return;
        }
        i += used;
        continue;
      }
      if (c === '\r') { this.x = 0; this.overflow = false; i += 1; continue; }
      if (c === '\n') { this.lineFeed(); i += 1; continue; }
      if (c === '\b') { this.x = Math.max(0, this.x - 1); this.overflow = false; i += 1; continue; }
      if (c < ' ') { i += 1; continue; }
      const ch = String.fromCodePoint(s.codePointAt(i)!);
      this.put(ch);
      i += ch.length;
    }
  }

  private lineFeed(): void {
    this.overflow = false;
    if (this.y < this.rows - 1) {
      this.y += 1;
      return;
    }
    this.grid.shift();
    this.grid.push(Array.from({ length: this.cols }, () => ' '));
    this.wrapped = new Set([...this.wrapped].map((y) => y - 1).filter((y) => y >= 0));
  }

  private put(ch: string): void {
    const w = charWidth(ch.codePointAt(0)!);
    if (w === 0) {
      // A combining mark joins the character before it.
      const x = this.overflow ? this.cols - 1 : this.x - 1;
      if (x >= 0) {
        const at = this.grid[this.y]![x] === '' && x > 0 ? x - 1 : x;
        this.grid[this.y]![at] += ch;
      }
      return;
    }
    if (this.overflow || this.x + w > this.cols) {
      this.wrapped.add(this.y);
      this.x = 0;
      this.lineFeed();
    }
    this.wrapped.delete(this.y);
    this.grid[this.y]![this.x] = ch;
    // The second half of a wide character holds nothing of its own.
    if (w === 2) this.grid[this.y]![this.x + 1] = '';
    this.x += w;
    if (this.x >= this.cols) {
      this.x = this.cols - 1;
      this.overflow = true;
    }
  }

  /** Handles the escape sequence at the start of `s`. Returns how much of `s` it was, or 0 when it is not whole yet. */
  private escape(s: string): number {
    if (s.length < 2) return 0;
    if (s[1] === ']' || s[1] === 'P' || s[1] === '_' || s[1] === '^') {
      const bel = s.indexOf('\x07');
      const st = s.indexOf('\x1b\\');
      const end = st !== -1 && (bel === -1 || st < bel) ? st + 2 : bel !== -1 ? bel + 1 : 0;
      if (end === 0) return 0;
      const link = /^\x1b\]8;[^;]*;(.+?)(?:\x07|\x1b\\)$/.exec(s.slice(0, end));
      if (link) this.links.push(link[1]!);
      return end;
    }
    if (s[1] !== '[') return 2;
    const m = /^\x1b\[([0-?]*)([ -/]*)([@-~])/.exec(s);
    if (!m) return /^\x1b\[[0-?]*[ -/]*$/.test(s) ? 0 : 2;
    const params = m[1]!;
    const n = params.replace(/^\?/, '').split(';').map((p) => Number(p) || 0);
    const first = n[0] || 1;
    this.overflow = false;
    switch (m[3]) {
      case 'H': case 'f':
        this.y = Math.min(this.rows - 1, Math.max(0, (n[0] || 1) - 1));
        this.x = Math.min(this.cols - 1, Math.max(0, (n[1] || 1) - 1));
        break;
      case 'A': this.y = Math.max(0, this.y - first); break;
      case 'B': this.y = Math.min(this.rows - 1, this.y + first); break;
      case 'C': this.x = Math.min(this.cols - 1, this.x + first); break;
      case 'D': this.x = Math.max(0, this.x - first); break;
      case 'G': this.x = Math.min(this.cols - 1, first - 1); break;
      case 'K': {
        const from = n[0] === 1 || n[0] === 2 ? 0 : this.x;
        const to = n[0] === 1 ? this.x + 1 : this.cols;
        for (let x = from; x < to; x++) this.grid[this.y]![x] = ' ';
        this.wrapped.delete(this.y);
        break;
      }
      case 'J': {
        for (let y = 0; y < this.rows; y++) {
          if (n[0] === 2 || n[0] === 3 || (n[0] === 0 && y > this.y) || (n[0] === 1 && y < this.y)) {
            this.grid[y] = Array.from({ length: this.cols }, () => ' ');
            this.wrapped.delete(y);
          }
        }
        if (n[0] === 0) for (let x = this.x; x < this.cols; x++) this.grid[this.y]![x] = ' ';
        break;
      }
      case 'n':
        if (params === '5' && this.answers) this.reply?.('\x1b[0n');
        break;
      case 'h': case 'l':
        if (params.startsWith('?')) for (const mode of n) this.mode(mode, m[3] === 'h');
        break;
      default: // colours, and whatever else: nothing to keep
    }
    return m[0].length;
  }

  private mode(mode: number, on: boolean): void {
    if (mode === 25) {
      this.cursorVisible = on;
    } else if (mode === 1049) {
      if (on && !this.alt) {
        this.saved = { grid: this.grid, x: this.x, y: this.y };
        this.grid = this.blank();
      } else if (!on && this.alt && this.saved) {
        ({ grid: this.grid, x: this.x, y: this.y } = this.saved);
        this.saved = null;
      }
      this.alt = on;
    } else if (on) {
      this.modes.add(mode);
    } else {
      this.modes.delete(mode);
    }
  }
}

export interface FakeTerm extends Term {
  vt: Vt;
  /** Everything written, as it was written. */
  written: string[];
  /** The owner presses keys: the bytes a terminal would send. */
  type: (bytes: string) => void;
  resize: (cols: number, rows: number) => void;
  /** The terminal goes away. */
  hangUp: () => void;
}

export function fakeTerm(cols: number, rows: number, caps: Partial<Caps> = {}): FakeTerm {
  const vt = new Vt(cols, rows);
  const written: string[] = [];
  let onData: ((text: string) => void) | null = null;
  let onEnd: (() => void) | null = null;
  const resizers = new Set<() => void>();
  // An answer arrives after the write that asked for it has returned, as it does from a real terminal.
  vt.reply = (bytes) => queueMicrotask(() => onData?.(bytes));
  return {
    vt, written,
    size: () => ({ cols: vt.cols, rows: vt.rows }),
    write: (data) => {
      written.push(data);
      vt.write(data);
    },
    listen: (data, end) => {
      onData = data;
      onEnd = end;
      return () => { onData = null; onEnd = null; };
    },
    onResize: (handler) => {
      resizers.add(handler);
      return () => { resizers.delete(handler); };
    },
    caps: { depth: 'true', utf8: true, links: true, ...caps },
    type: (bytes) => onData?.(bytes),
    resize: (c, r) => {
      vt.resize(c, r);
      for (const handler of resizers) handler();
    },
    hangUp: () => onEnd?.(),
  };
}

/** Every escape sequence in what was written to the terminal. */
export function sequences(written: string[]): string[] {
  return written.join('').match(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[^[\]])/g) ?? [];
}
