import type { Style } from './theme';

// Text as a terminal shows it: how wide it is, where it may break, and what of it may be shown
// at all. Everything the screens wrap, clip or place a cursor in goes through this file.

/** A run of text in one style. */
export interface Span {
  text: string;
  style?: Style;
}
/** One row of the screen, before it is given its colours. */
export type Line = Span[];

const ZERO = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
const EMOJI = /^\p{Emoji_Presentation}$/u;

/** East Asian wide and fullwidth, as inclusive ranges. Emoji are found by their Unicode property instead. */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4], [0x17000, 0x18cff], [0x1b000, 0x1b2ff], [0x1f200, 0x1f2ff],
  [0x20000, 0x3fffd],
];

/**
 * The columns one code point takes: 0 for combining marks, joiners and variation selectors, 2 for
 * East Asian wide characters and emoji, 1 for the rest. This is the rule of wcwidth, which is
 * what most terminals follow; a terminal that draws a joined emoji sequence as one glyph will
 * disagree about that sequence, and only there.
 */
export function charWidth(cp: number): 0 | 1 | 2 {
  if (cp < 0x300) return cp < 0x20 || (cp >= 0x7f && cp < 0xa0) ? 0 : 1;
  // The second and third parts of a Hangul syllable written out in parts.
  if (cp >= 0x1160 && cp <= 0x11ff) return 0;
  // Two regional indicators make one flag, two columns wide.
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return 1;
  if (cp >= 0x1100) {
    for (const [from, to] of WIDE) {
      if (cp < from) break;
      if (cp <= to) return 2;
    }
  }
  const ch = String.fromCodePoint(cp);
  if (ZERO.test(ch)) return 0;
  return EMOJI.test(ch) ? 2 : 1;
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** The columns `text` takes. It must hold no line break and no tab. */
export function width(text: string): number {
  if (PRINTABLE_ASCII.test(text)) return text.length;
  let w = 0;
  for (const ch of text) w += charWidth(ch.codePointAt(0)!);
  return w;
}

export const lineWidth = (line: Line): number => line.reduce((w, span) => w + width(span.text), 0);
export const plain = (line: Line): string => line.map((span) => span.text).join('');

// A whole escape sequence goes, not only its first byte: CSI with its parameters, and OSC, DCS,
// APC, PM and SOS strings up to their terminator, in the 7-bit and the 8-bit spelling.
const SEQUENCES = /\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|(?:\x1b[\]PX^_]|[\x90\x98\x9d\x9e\x9f])[^\x07\x1b\x9c\n]*(?:\x07|\x1b\\|\x9c)|\x1b[ -/]*[0-~]/g;
// What is left of the control characters (line breaks and tabs stay), then what would reorder
// or hide text: the bidi overrides and isolates, invisible operators, tags, the byte-order mark.
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u{61c}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2060}-\u{206f}\u{feff}\u{fff9}-\u{fffb}\u{e0000}-\u{e007f}]/gu;

/**
 * Text someone else wrote (the model, a tool, another agent), made safe to show: no escape
 * sequence and no control character is left in it, so it cannot move the cursor, set the title,
 * colour itself or reorder what is beside it. Line breaks and tabs stay.
 */
export function clean(text: string): string {
  return text.toWellFormed()
    .replace(SEQUENCES, '')
    .replace(/\r\n?|[\u{2028}\u{2029}]/gu, '\n')
    .replace(CONTROLS, '');
}

/** Tabs as spaces, to the next multiple of `size` columns. For one line. */
export function detab(line: string, size = 4): string {
  if (!line.includes('\t')) return line;
  let out = '';
  let col = 0;
  for (const part of line.split(/(\t)/)) {
    if (part === '\t') {
      const n = size - (col % size);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += part;
      col += width(part);
    }
  }
  return out;
}

/** `text` cut into pieces that each fit `max` columns, never inside a character and its marks. */
function pieces(text: string, max: number): string[] {
  const out: string[] = [];
  let piece = '';
  let w = 0;
  for (const ch of text) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > max && piece !== '' && cw > 0) {
      out.push(piece);
      piece = '';
      w = 0;
    }
    piece += ch;
    w += cw;
  }
  if (piece !== '') out.push(piece);
  return out;
}

/** The first `max` columns of a line. When something was cut and a marker is given, the marker ends it. */
export function clip(line: Line, max: number, marker?: Span): Line {
  if (lineWidth(line) <= max) return line;
  const room = Math.max(0, max - (marker ? width(marker.text) : 0));
  const out: Line = [];
  let used = 0;
  for (const span of line) {
    const w = width(span.text);
    if (used + w <= room) {
      out.push(span);
      used += w;
      continue;
    }
    const head = room - used > 0 ? pieces(span.text, room - used)[0] ?? '' : '';
    if (head !== '' && width(head) <= room - used) out.push({ ...span, text: head });
    break;
  }
  if (marker && width(marker.text) <= max) out.push(marker);
  return out;
}

/** A line padded with spaces to exactly `max` columns, or clipped to it. */
export function fit(line: Line, max: number): Line {
  const w = lineWidth(line);
  if (w > max) return clip(line, max);
  return w === max ? line : [...line, { text: ' '.repeat(max - w) }];
}

interface Atom {
  text: string;
  style?: Style;
  w: number;
  space: boolean;
  /** A line may be broken before this atom though no space is there: between two wide characters. */
  loose: boolean;
}

function atoms(spans: Span[]): Atom[] {
  const out: Atom[] = [];
  for (const span of spans) {
    for (const part of span.text.split(/( +)/)) {
      if (part === '') continue;
      if (part[0] === ' ') {
        out.push({ text: part, style: span.style, w: part.length, space: true, loose: false });
        continue;
      }
      // A run of wide characters has no spaces to break at: each may start a line.
      let run = '';
      const flush = () => {
        if (run !== '') out.push({ text: run, style: span.style, w: width(run), space: false, loose: false });
        run = '';
      };
      for (const ch of part) {
        const cw = charWidth(ch.codePointAt(0)!);
        if (cw === 2) {
          flush();
          out.push({ text: ch, style: span.style, w: 2, space: false, loose: true });
        } else if (cw === 0 && run === '' && out.length > 0 && out.at(-1)!.loose) {
          out.at(-1)!.text += ch;
        } else {
          run += ch;
        }
      }
      flush();
    }
  }
  return out;
}

/**
 * Spans wrapped to `max` columns at spaces; a word longer than a line is cut. `first` starts the
 * first line and `rest` every line after it, so a list item hangs under its own text. The spans
 * must hold no line break. A prefix that leaves no room for text is dropped rather than obeyed.
 */
export function wrap(spans: Span[], max: number, first: Line = [], rest: Line = first): Line[] {
  const roomy = (prefix: Line): Line => (max - lineWidth(prefix) >= 4 ? prefix : []);
  const lead = roomy(first);
  const hang = roomy(rest);
  const lines: Line[] = [];
  let line: Line = [...lead];
  let room = Math.max(1, max - lineWidth(lead));
  let used = 0;
  const push = (text: string, style: Style | undefined, w: number) => {
    const last = line.at(-1);
    if (last !== undefined && last.style === style && line.length > (lines.length === 0 ? lead.length : hang.length)) last.text += text;
    else line.push({ text, style });
    used += w;
  };
  const newline = () => {
    lines.push(line);
    line = [...hang];
    room = Math.max(1, max - lineWidth(hang));
    used = 0;
  };

  const all = atoms(spans);
  let gap: Atom | null = null;
  for (let i = 0; i < all.length;) {
    const a = all[i]!;
    if (a.space) {
      gap = a;
      i += 1;
      continue;
    }
    // A word: this atom and those glued to it, across spans.
    let end = i + 1;
    while (end < all.length && !all[end]!.space && !all[end]!.loose) end += 1;
    const word = all.slice(i, end);
    const w = word.reduce((sum, part) => sum + part.w, 0);
    i = end;
    const gapW = gap !== null && (used > 0 || lines.length === 0) ? gap.w : 0;
    if (used + gapW + w <= room) {
      if (gapW > 0) push(gap!.text, gap!.style, gapW);
    } else if (used > 0) {
      newline();
    } else if (gapW > 0 && gapW + w <= room) {
      push(gap!.text, gap!.style, gapW);
    }
    gap = null;
    if (w <= room - used) {
      for (const part of word) push(part.text, part.style, part.w);
      continue;
    }
    // Longer than a whole line: cut it wherever the line ends.
    for (const part of word) {
      for (const piece of pieces(part.text, room)) {
        const pw = width(piece);
        if (used > 0 && used + pw > room) newline();
        push(piece, part.style, pw);
      }
    }
  }
  lines.push(line);
  return lines;
}
