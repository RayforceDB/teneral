import type { Key } from './keys';
import { charWidth, width } from './text';

// The line the owner types in, as a value and a function from one key to the next value.
// Nothing here draws; `layout` says where the text and the cursor fall for whoever does.

export interface Edit {
  text: string;
  /** An index into `text`, always between two whole characters. */
  cursor: number;
  /** What was sent before, oldest first. */
  history: readonly string[];
  /** The history entry being shown, or null when the line is the owner's own draft. */
  at: number | null;
  /** The draft set aside while the history is walked. */
  draft: string;
}

export const EMPTY: Edit = { text: '', cursor: 0, history: [], at: null, draft: '' };

/** The longest history kept. */
const HISTORY = 200;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Where the character before (`-1`) or after (`1`) the cursor ends: a letter with its marks, or a joined emoji, is one. */
function step(text: string, cursor: number, dir: -1 | 1): number {
  if (dir === 1) {
    if (cursor >= text.length) return text.length;
    const first = segmenter.segment(text.slice(cursor, cursor + 64))[Symbol.iterator]().next().value;
    return cursor + (first?.segment.length ?? 1);
  }
  if (cursor <= 0) return 0;
  const from = Math.max(0, cursor - 64);
  let last = cursor - 1;
  for (const s of segmenter.segment(text.slice(from, cursor))) last = from + s.index;
  return last;
}

const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);

function wordLeft(text: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && isSpace(text[i - 1])) i -= 1;
  while (i > 0 && !isSpace(text[i - 1])) i -= 1;
  return i;
}

function wordRight(text: string, cursor: number): number {
  let i = cursor;
  while (i < text.length && isSpace(text[i])) i += 1;
  while (i < text.length && !isSpace(text[i])) i += 1;
  return i;
}

const lineStart = (text: string, cursor: number): number => text.lastIndexOf('\n', cursor - 1) + 1;
const lineEnd = (text: string, cursor: number): number => {
  const end = text.indexOf('\n', cursor);
  return end === -1 ? text.length : end;
};

const set = (e: Edit, text: string, cursor: number): Edit => ({ ...e, text, cursor, at: text === e.text ? e.at : null });
const move = (e: Edit, cursor: number): Edit => ({ ...e, cursor });

/** What is typed or pasted becomes text the line can hold: no control characters, tabs as spaces. */
const typed = (text: string): string => text.replace(/\t/g, '    ').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '');

export function insert(e: Edit, text: string): Edit {
  const t = typed(text);
  return t === '' ? e : set(e, e.text.slice(0, e.cursor) + t + e.text.slice(e.cursor), e.cursor + t.length);
}

/** The line after it was sent: empty, with what was sent at the end of the history. */
export function sent(e: Edit, text: string): Edit {
  const history = e.history.at(-1) === text ? e.history : [...e.history, text].slice(-HISTORY);
  return { ...EMPTY, history };
}

/** Up or down: within a text of several lines it moves between them; at the first or the last, it walks the history. */
function vertical(e: Edit, dir: -1 | 1): Edit {
  const start = lineStart(e.text, e.cursor);
  const end = lineEnd(e.text, e.cursor);
  const col = width(e.text.slice(start, e.cursor));
  const inLine = (from: number, to: number): number => {
    let i = from;
    let w = 0;
    while (i < to) {
      const next = step(e.text, i, 1);
      w += width(e.text.slice(i, next));
      if (w > col) break;
      i = next;
    }
    return i;
  };
  if (dir === -1 && start > 0) return move(e, inLine(lineStart(e.text, start - 1), start - 1));
  if (dir === 1 && end < e.text.length) return move(e, inLine(end + 1, lineEnd(e.text, end + 1)));
  if (dir === -1) {
    const at = e.at === null ? e.history.length - 1 : e.at - 1;
    if (at < 0) return e;
    const text = e.history[at]!;
    return { ...e, text, cursor: text.length, at, draft: e.at === null ? e.text : e.draft };
  }
  if (e.at === null) return e;
  const at = e.at + 1;
  const text = at < e.history.length ? e.history[at]! : e.draft;
  return { ...e, text, cursor: text.length, at: at < e.history.length ? at : null };
}

/**
 * The line after one key, or null when the key is not the editor's: Enter, Tab, Escape, the
 * scrolling keys, and Ctrl-C and Ctrl-D, which the screen decides about.
 */
export function edit(e: Edit, key: Key): Edit | null {
  if (key.kind === 'text' || key.kind === 'paste') return insert(e, key.text);
  if (key.kind !== 'key') return null;
  const { text, cursor } = e;
  const word = key.ctrl === true || key.alt === true;
  if (key.name === 'enter') return key.alt || key.shift ? insert(e, '\n') : null;
  // Shift with an arrow scrolls the transcript.
  if (key.shift) return null;
  switch (key.name) {
    case 'left': return move(e, word ? wordLeft(text, cursor) : step(text, cursor, -1));
    case 'right': return move(e, word ? wordRight(text, cursor) : step(text, cursor, 1));
    case 'home': return move(e, lineStart(text, cursor));
    case 'end': return move(e, lineEnd(text, cursor));
    case 'up': return vertical(e, -1);
    case 'down': return vertical(e, 1);
    case 'backspace': {
      const from = key.alt ? wordLeft(text, cursor) : step(text, cursor, -1);
      return set(e, text.slice(0, from) + text.slice(cursor), from);
    }
    case 'delete': return set(e, text.slice(0, cursor) + text.slice(step(text, cursor, 1)), cursor);
    default:
  }
  if (key.alt) {
    if (key.name === 'b') return move(e, wordLeft(text, cursor));
    if (key.name === 'f') return move(e, wordRight(text, cursor));
    if (key.name === 'd') return set(e, text.slice(0, cursor) + text.slice(wordRight(text, cursor)), cursor);
    return null;
  }
  if (!key.ctrl) return null;
  switch (key.name) {
    case 'a': return move(e, lineStart(text, cursor));
    case 'e': return move(e, lineEnd(text, cursor));
    case 'b': return move(e, step(text, cursor, -1));
    case 'f': return move(e, step(text, cursor, 1));
    case 'j': return insert(e, '\n');
    case 'u': {
      const from = lineStart(text, cursor);
      return set(e, text.slice(0, from) + text.slice(cursor), from);
    }
    case 'k': return set(e, text.slice(0, cursor) + text.slice(lineEnd(text, cursor)), cursor);
    case 'w': {
      const from = wordLeft(text, cursor);
      return set(e, text.slice(0, from) + text.slice(cursor), from);
    }
    default: return null;
  }
}

export interface InputLayout {
  /** The rows to show, at most `maxRows` of them, each at most `max` columns. */
  rows: string[];
  /** Where the cursor is, within `rows`. */
  row: number;
  col: number;
  /** Rows of the text above the ones shown. */
  above: number;
}

/**
 * The text as rows of `max` columns: each of its lines cut where the row ends. When there are
 * more rows than `maxRows`, the ones around the cursor are shown.
 */
export function layout(text: string, cursor: number, max: number, maxRows: number): InputLayout {
  const cols = Math.max(2, max);
  const rows: string[] = [];
  let at = { row: 0, col: 0 };
  let offset = 0;
  for (const line of text.split('\n')) {
    let row = '';
    let w = 0;
    let i = 0;
    const here = () => { if (offset + i === cursor) at = { row: rows.length, col: w }; };
    for (const ch of line) {
      const cw = charWidth(ch.codePointAt(0)!);
      if (w + cw > cols) {
        rows.push(row);
        row = '';
        w = 0;
      }
      here();
      row += ch;
      w += cw;
      i += ch.length;
    }
    here();
    // A cursor after the last column of a full row belongs at the start of the next.
    if (offset + i === cursor && w >= cols) {
      rows.push(row);
      row = '';
      at = { row: rows.length, col: 0 };
    }
    rows.push(row);
    offset += line.length + 1;
  }
  const shown = Math.max(1, maxRows);
  const above = Math.max(0, Math.min(at.row, rows.length - shown));
  return { rows: rows.slice(above, above + shown), row: at.row - above, col: at.col, above };
}
