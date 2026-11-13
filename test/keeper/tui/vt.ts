import { charWidth } from '../../../keeper/tui/text';
import type { Term } from '../../../keeper/tui/screen';
import type { Caps } from '../../../keeper/tui/theme';

// A terminal for tests: it takes what a program writes and keeps the grid of characters a person
// would be looking at, and, on the normal screen, the rows that scrolled off its top. Colours are
// dropped, so a frame reads like the screen. It knows the sequences the owner's programs use and
// the common ones around them; it is no complete emulator.

interface Row {
  /** One string per column; the second half of a wide character is ''. */
  cells: string[];
  /** The text ran on into the next row without a line break: what a selection copies as one line. */
  wrapped: boolean;
  /** Columns written with foreground and background swapped. */
  inverse: Set<number>;
}

const text = (row: Row): string => row.cells.join('').trimEnd();

export class Vt {
  cols: number;
  rows: number;
  /** On the alternate screen. */
  alt = false;
  cursorVisible = true;
  /** Private modes switched on and not off again: 2004 for bracketed paste, and any mouse mode. */
  modes = new Set<number>();
  /** Where the terminal's own answers go: a status request is answered here, as long as `answers` is set. */
  reply: ((bytes: string) => void) | null = null;
  answers = true;
  /** Every hyperlink target that was opened. */
  links: string[] = [];
  /**
   * What a change of size does to the rows. False: they are cut or padded where they stand, as
   * xterm does. True: every line is wrapped again at the new width and the cursor stays with its
   * text, as most terminals of today do.
   */
  reflow = false;
  /** Rows of the normal screen that scrolled off its top, oldest first. */
  private off: Row[] = [];
  private grid: Row[];
  private saved: { grid: Row[]; x: number; y: number } | null = null;
  private x = 0;
  private y = 0;
  /** The cursor is past the last column: the next character starts the next row. */
  private overflow = false;
  private inverse = false;
  private pending = '';

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.grid = Array.from({ length: rows }, () => this.blank());
  }

  private blank(cols = this.cols): Row {
    return { cells: Array.from({ length: cols }, () => ' '), wrapped: false, inverse: new Set() };
  }

  resize(cols: number, rows: number): void {
    if (this.reflow && !this.alt) return this.rewrap(cols, rows);
    for (const row of this.grid) {
      row.cells = Array.from({ length: cols }, (_, x) => row.cells[x] ?? ' ');
      row.inverse = new Set([...row.inverse].filter((x) => x < cols));
    }
    this.cols = cols;
    // Fewer rows: the ones under the cursor go first, then the top ones scroll off.
    while (this.grid.length > rows) {
      if (this.y < this.grid.length - 1) {
        this.grid.pop();
      } else {
        const gone = this.grid.shift()!;
        if (!this.alt) this.off.push(gone);
        this.y -= 1;
      }
    }
    while (this.grid.length < rows) this.grid.push(this.blank());
    this.rows = rows;
    this.x = Math.min(this.x, cols - 1);
    this.overflow = false;
  }

  /** Every line wrapped again at the new width, the cursor kept with the cell it was on, and the last rows kept in view. */
  private rewrap(cols: number, rows: number): void {
    const all = [...this.off, ...this.grid];
    const cursorRow = this.off.length + this.y;
    let end = all.length;
    while (end > cursorRow + 1 && text(all[end - 1]!) === '' && !all[end - 2]!.wrapped) end -= 1;
    const out: Row[] = [];
    let at = { y: 0, x: 0 };
    for (let i = 0; i < end;) {
      // One logical line: rows chained by `wrapped`.
      const cells: string[] = [];
      const inverse = new Set<number>();
      let cursor = -1;
      let j = i;
      for (; j < end; j++) {
        const row = all[j]!;
        const length = row.wrapped ? row.cells.length : Math.max(row.cells.join('').trimEnd() === '' ? 0 : row.cells.findLastIndex((c) => c !== ' ' && c !== '') + 1, j === cursorRow ? this.x : 0);
        if (j === cursorRow) cursor = cells.length + this.x;
        for (const x of row.inverse) if (x < length) inverse.add(cells.length + x);
        cells.push(...row.cells.slice(0, length));
        if (!row.wrapped) break;
      }
      i = j + 1;
      const first = out.length;
      let row = this.blank(cols);
      let x = 0;
      const next = () => {
        row.wrapped = true;
        out.push(row);
        row = this.blank(cols);
        x = 0;
      };
      for (let k = 0; k < cells.length; k++) {
        const wide = cells[k + 1] === '' ? 2 : 1;
        if (cells[k] === '') continue;
        if (x + wide > cols) next();
        if (k === cursor) at = { y: out.length, x };
        row.cells[x] = cells[k]!;
        if (inverse.has(k)) row.inverse.add(x);
        if (wide === 2) row.cells[x + 1] = '';
        x += wide;
      }
      if (cursor >= cells.length) {
        if (x >= cols) next();
        at = { y: out.length, x };
      }
      out.push(row);
      void first;
    }
    while (out.length < rows) out.push(this.blank(cols));
    const top = Math.max(0, out.length - rows);
    this.off = out.slice(0, top);
    this.grid = out.slice(top);
    this.cols = cols;
    this.rows = rows;
    this.y = Math.max(0, at.y - top);
    this.x = Math.min(at.x, cols - 1);
    this.overflow = false;
  }

  /** The screen as text: one line per row, without the spaces at the end of each. */
  text(): string {
    return this.grid.map(text).join('\n');
  }

  /** What scrolled off the top of the normal screen, oldest first. */
  get scrollback(): string[] {
    return this.off.map(text);
  }

  /** Everything a person can scroll through: what scrolled off, then the screen, without the blank rows at its end. */
  all(): string {
    return [...this.off, ...this.grid].map(text).join('\n').trimEnd();
  }

  /** The rows from `from` on that the terminal holds as one wrapped line, joined as a selection would copy them. */
  logicalLine(from: number): string {
    let out = '';
    for (let y = from; y < this.rows; y++) {
      out += this.grid[y]!.cells.join('');
      if (!this.grid[y]!.wrapped) break;
    }
    return out.trimEnd();
  }

  get cursor(): { row: number; col: number } {
    return { row: this.y, col: this.x };
  }

  /** The first cell drawn with its colours swapped, which is how the talk client shows where the owner types; null when there is none. */
  get block(): { row: number; col: number } | null {
    for (let y = 0; y < this.grid.length; y++) {
      const cols = [...this.grid[y]!.inverse];
      if (cols.length > 0) return { row: y, col: Math.min(...cols) };
    }
    return null;
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
    const gone = this.grid.shift()!;
    if (!this.alt) this.off.push(gone);
    this.grid.push(this.blank());
  }

  private put(ch: string): void {
    const w = charWidth(ch.codePointAt(0)!);
    if (w === 0) {
      // A combining mark joins the character before it.
      const x = this.overflow ? this.cols - 1 : this.x - 1;
      if (x >= 0) {
        const cells = this.grid[this.y]!.cells;
        const at = cells[x] === '' && x > 0 ? x - 1 : x;
        cells[at] += ch;
      }
      return;
    }
    if (this.overflow || this.x + w > this.cols) {
      this.grid[this.y]!.wrapped = true;
      this.x = 0;
      this.lineFeed();
    }
    const row = this.grid[this.y]!;
    row.wrapped = false;
    row.cells[this.x] = ch;
    if (this.inverse) row.inverse.add(this.x);
    else row.inverse.delete(this.x);
    // The second half of a wide character holds nothing of its own.
    if (w === 2) row.cells[this.x + 1] = '';
    this.x += w;
    if (this.x >= this.cols) {
      this.x = this.cols - 1;
      this.overflow = true;
    }
  }

  private erase(y: number, from: number, to: number): void {
    const row = this.grid[y]!;
    for (let x = from; x < to; x++) {
      row.cells[x] = ' ';
      row.inverse.delete(x);
    }
    if (to >= this.cols) row.wrapped = false;
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
    if (m[3] !== 'm') this.overflow = false;
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
      case 'K':
        this.erase(this.y, n[0] === 1 || n[0] === 2 ? 0 : this.x, n[0] === 1 ? this.x + 1 : this.cols);
        break;
      case 'J': {
        for (let y = 0; y < this.rows; y++) {
          if (n[0] === 2 || n[0] === 3 || (n[0] === 0 && y > this.y) || (n[0] === 1 && y < this.y)) this.erase(y, 0, this.cols);
        }
        if (n[0] === 0) this.erase(this.y, this.x, this.cols);
        break;
      }
      case 'm': {
        // Colours are not kept; only whether the cell is drawn swapped.
        for (let i = 0; i < n.length; i++) {
          if (n[i] === 38 || n[i] === 48) { i += n[i + 1] === 2 ? 4 : 2; continue; }
          if (n[i] === 7) this.inverse = true;
          else if (n[i] === 0 || n[i] === 27) this.inverse = false;
        }
        break;
      }
      case 'n':
        if (params === '5' && this.answers) this.reply?.('\x1b[0n');
        break;
      case 'h': case 'l':
        if (params.startsWith('?')) for (const mode of n) this.mode(mode, m[3] === 'h');
        break;
      default: // whatever else: nothing to keep
    }
    return m[0].length;
  }

  private mode(mode: number, on: boolean): void {
    if (mode === 25) {
      this.cursorVisible = on;
    } else if (mode === 1049) {
      if (on && !this.alt) {
        this.saved = { grid: this.grid, x: this.x, y: this.y };
        this.grid = Array.from({ length: this.rows }, () => this.blank());
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
