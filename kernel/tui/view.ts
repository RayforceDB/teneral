import { layout, type Edit } from './editor';
import { markdown } from './markdown';
import type { Entry } from './model';
import type { Frame } from './screen';
import { clip, detab, fit, lineWidth, width, wrap, type Line, type Span } from './text';
import type { Glyphs, Style } from './theme';

// The talk screen as rows: what each transcript entry looks like at a given width, which rows of
// the transcript are in view, and the header, the input and the hint around them. Pure: the same
// state gives the same rows.

const DIM: Style = { fg: 'dim' };
const FAINT: Style = { fg: 'faint' };
/** Tool lines are not stretched over a very wide screen: the outcome stays near its call. */
const TOOL_WIDTH = 100;
/** Rows of a tool's output shown under it, and of a kernel notice's output. */
const OUTPUT_ROWS = 6;
const NOTICE_ROWS = 14;

export interface Look {
  g: Glyphs;
  /** Whether tool output is shown under each call. */
  tools: boolean;
}

/** How long something took, to the precision that matters at its size: 40ms, 2.5s, 48s, 3m07s. */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

/** Elapsed time as a clock: 0:07, 12:40, 1:02:03. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n: number) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
}

/** Text of several lines, wrapped, every row behind the same indent. */
export function block(text: string, max: number, style: Style | undefined, indent: number): Line[] {
  const lead: Line = [{ text: ' '.repeat(indent) }];
  return text.split('\n').flatMap((line) => wrap([{ text: detab(line), style }], max, lead));
}

/**
 * The rows of one entry, `max` columns wide. Everything someone else wrote starts in the third
 * column or further in; the first two belong to this screen's own marks, which no reply can forge.
 */
export function entryRows(e: Entry, max: number, look: Look): Line[] {
  const { g } = look;
  switch (e.kind) {
    case 'owner': {
      const mark: Line = [{ text: `${g.prompt} `, style: { fg: 'accent', bold: true } }];
      const rows = e.text.split('\n').flatMap((line, i) => wrap([{ text: detab(line), style: { fg: 'owner' } }], max, i === 0 ? mark : [{ text: '  ' }], [{ text: '  ' }]));
      const tag = e.pending ? 'on its way' : e.elsewhere ? 'from another terminal' : '';
      if (tag !== '') {
        const last = rows.at(-1)!;
        if (lineWidth(last) + tag.length + 2 <= max) last.push({ text: `  ${tag}`, style: DIM });
        else rows.push([{ text: `  ${tag}`, style: DIM }]);
      }
      return rows;
    }
    case 'reply': {
      const rows = markdown(e.text, Math.max(1, max - 2), g).map((line): Line => (line.length === 0 ? [] : [{ text: '  ' }, ...line]));
      // The first words this individual ever said get a line of their own before them. Once.
      if (e.first) rows.unshift([{ text: '  ' }, { text: g.rule.repeat(Math.max(1, Math.min(24, max - 2))), style: { fg: 'accent' } }], []);
      if (e.early) rows.push(...block('(written before the line above had arrived)', max, DIM, 2));
      return rows;
    }
    case 'tool': {
      const w = Math.min(max, TOOL_WIDTH);
      const said = e.status === 'running' ? 'running' : e.ms === null ? e.status : `${e.status} ${duration(e.ms)}`;
      const right: Span = { text: said, style: e.status === 'failed' ? { fg: 'warn' } : DIM };
      const left = clip([{ text: `  ${g.tool} `, style: FAINT }, { text: e.name, style: DIM }, { text: e.args === '' ? '' : `  ${e.args}`, style: DIM }], Math.max(4, w - said.length - 2), { text: g.ellipsis, style: DIM });
      const rows: Line[] = [[...fit(left, Math.max(lineWidth(left), w - said.length)), right]];
      if (look.tools && e.output !== '') {
        const lines = e.output.split('\n');
        const few = e.status === 'failed' ? lines.slice(-OUTPUT_ROWS) : lines.slice(0, OUTPUT_ROWS);
        const more = lines.length - few.length;
        const cut = (line: string): Line => [{ text: '      ' }, ...clip([{ text: detab(line), style: FAINT }], Math.max(1, max - 6), { text: g.ellipsis, style: DIM })];
        const note: Line = [{ text: `      ${g.ellipsis} ${more} more ${more === 1 ? 'line' : 'lines'}`, style: FAINT }];
        // Of a failure the end is shown, which is where it says what went wrong.
        rows.push(...(more > 0 && e.status === 'failed' ? [note] : []), ...few.map(cut), ...(more > 0 && e.status !== 'failed' ? [note] : []));
      }
      return rows;
    }
    case 'notice': {
      const tone: Style = { fg: e.tone };
      const title = `${e.title}${e.move ? `  ${e.move[0]} ${g.arrow} ${e.move[1]}` : ''}`;
      const head = clip([{ text: `${g.rule.repeat(2)} `, style: tone }, { text: title, style: { ...tone, bold: true } }], Math.max(1, max - 1), { text: g.ellipsis, style: tone });
      const rows: Line[] = [[...head, { text: ` ${g.rule.repeat(Math.max(0, max - lineWidth(head) - 1))}`, style: tone }]];
      if (e.lead !== '') rows.push(...block(e.lead, max, undefined, 3));
      if (e.body !== '') {
        const body = block(e.body, max, DIM, 3);
        const hidden = body.length - NOTICE_ROWS;
        if (hidden > 0) rows.push([{ text: `   ${g.ellipsis} ${hidden} earlier ${hidden === 1 ? 'row' : 'rows'}; the journal has all of it`, style: FAINT }]);
        rows.push(...body.slice(-NOTICE_ROWS));
      }
      return rows;
    }
    case 'quiet':
      return [clip([{ text: `  ${g.quiet} `, style: FAINT }, { text: e.label, style: DIM }, { text: e.text === '' ? '' : `  ${e.text}`, style: FAINT }], max, { text: g.ellipsis, style: FAINT })];
    case 'warning':
      return [
        [{ text: `${g.warn} `, style: { fg: 'warn', bold: true } }, { text: 'not from the model', style: { fg: 'warn' } }],
        ...block(e.text, max, undefined, 2),
      ];
    case 'note':
      return block(e.text, max, DIM, 2);
    default:
      return [];
  }
}

/** Blank rows between two entries: none inside a run of tool calls or of quiet lines, one otherwise. */
function gap(before: Entry | undefined, e: Entry): number {
  if (before === undefined) return 0;
  return (before.kind === 'tool' && e.kind === 'tool') || (before.kind === 'quiet' && e.kind === 'quiet') ? 0 : 1;
}

/** A place in the transcript: a row of an entry's block, the blank rows before the entry included. */
interface Place {
  index: number;
  row: number;
}

/**
 * Which rows of the transcript are in view. Only the entries in view, and those scrolled past, are
 * ever laid out; what was laid out is kept while it stays near the window.
 */
export class Scroller {
  /** The row at the bottom of the window, by the entry it belongs to; null while following the newest. */
  private anchor: { id: number; row: number } | null = null;
  private cache = new Map<number, { key: string; rows: Line[]; frame: number }>();
  private frame = 0;
  private entries: readonly Entry[] = [];
  private tail: Line[] = [];
  private max = 0;
  private look!: Look;

  get following(): boolean {
    return this.anchor === null;
  }

  follow(): void {
    this.anchor = null;
  }

  /** Before anything else each frame: what there is to show. `tail` is rows after the last entry, such as the activity line. */
  set(entries: readonly Entry[], tail: Line[], max: number, look: Look): void {
    this.entries = entries;
    this.tail = tail;
    this.max = max;
    this.look = look;
    this.frame += 1;
    if (this.cache.size > 300) {
      for (const [id, laid] of this.cache) if (laid.frame < this.frame - 1) this.cache.delete(id);
    }
  }

  private block(index: number): Line[] {
    if (index >= this.entries.length) return this.tail;
    const e = this.entries[index]!;
    const blank = gap(this.entries[index - 1], e);
    const key = `${this.max}|${e.rev}|${this.look.tools}|${blank}|${this.look.g.rule}`;
    let laid = this.cache.get(e.id);
    if (laid === undefined || laid.key !== key) {
      laid = { key, rows: [...Array.from({ length: blank }, (): Line => []), ...entryRows(e, this.max, this.look)], frame: this.frame };
      this.cache.set(e.id, laid);
    }
    laid.frame = this.frame;
    return laid.rows;
  }

  private last(): number {
    return this.tail.length > 0 ? this.entries.length : this.entries.length - 1;
  }

  private above(p: Place): Place | null {
    if (p.row > 0) return { index: p.index, row: p.row - 1 };
    for (let i = p.index - 1; i >= 0; i--) {
      const n = this.block(i).length;
      if (n > 0) return { index: i, row: n - 1 };
    }
    return null;
  }

  private below(p: Place): Place | null {
    if (p.row + 1 < this.block(p.index).length) return { index: p.index, row: p.row + 1 };
    for (let i = p.index + 1; i <= this.last(); i++) {
      if (this.block(i).length > 0) return { index: i, row: 0 };
    }
    return null;
  }

  private end(): Place | null {
    for (let i = this.last(); i >= 0; i--) {
      const n = this.block(i).length;
      if (n > 0) return { index: i, row: n - 1 };
    }
    return null;
  }

  /** Where the bottom of the window is now. */
  private bottom(): Place | null {
    if (this.anchor === null) return this.end();
    const { id, row } = this.anchor;
    // Entries are in the order of their ids, so the anchor's is found by halving.
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.entries[mid]!.id < id) lo = mid + 1;
      else hi = mid;
    }
    if (lo >= this.entries.length) return this.end();
    // The entry itself, or, when it is gone, the one that came after it.
    const n = this.block(lo).length;
    return this.entries[lo]!.id === id ? { index: lo, row: Math.max(0, Math.min(row, n - 1)) } : { index: lo, row: 0 };
  }

  private hold(p: Place | null): void {
    const e = p === null ? undefined : this.entries[p.index];
    this.anchor = p === null || e === undefined || this.below(p) === null ? null : { id: e.id, row: p.row };
  }

  /** Move the window by `delta` rows, up when negative. A window of `height` rows never leaves the first row behind. */
  scroll(delta: number, height: number): void {
    let p = this.bottom();
    if (p === null) return;
    for (let n = delta; n < 0; n++) {
      const up = this.above(p);
      if (up === null) break;
      p = up;
    }
    for (let n = delta; n > 0; n--) {
      const down = this.below(p);
      if (down === null) break;
      p = down;
    }
    // Not further up than a full window: count the rows above, and come back down by what is missing.
    let have = 1;
    for (let q = this.above(p); q !== null && have < height; q = this.above(q)) have += 1;
    for (; have < height; have++) {
      const down = this.below(p);
      if (down === null) break;
      p = down;
    }
    this.hold(p);
  }

  /** The `height` rows in view, the newest at the bottom; a transcript shorter than the window sits at its bottom. */
  rows(height: number): Line[] {
    const out: Line[] = [];
    const bottom = this.bottom();
    for (let p = bottom; p !== null && out.length < height; p = this.above(p)) out.push(this.block(p.index)[p.row]!);
    out.reverse();
    // A window that grew, on a resize, while scrolled up near the start: it is filled from below, not left half empty.
    let last = bottom;
    while (last !== null && out.length < height) {
      const next = this.below(last);
      if (next === null) break;
      out.push(this.block(next.index)[next.row]!);
      last = next;
    }
    if (last !== bottom && this.anchor !== null) {
      this.hold(last);
      // Down to the last entry: from here on the window follows the newest again.
      if (this.anchor === null) return this.rows(height);
    }
    while (out.length < height) out.unshift([]);
    return out;
  }
}

export interface TalkView {
  cols: number;
  rows: number;
  g: Glyphs;
  /** The individual's own name, when it has one. */
  name: string | null;
  /** `generation 3`, a short commit, the model: any of them may be empty. */
  generation: string;
  commit: string;
  model: string;
  state: string;
  /** The transcript rows, as many as `transcriptHeight` says. */
  transcript: Line[];
  /** Scrolled up: the newest rows are out of view. */
  more: boolean;
  /** Shown instead of the transcript: a title, and as many of its rows as fit, from `top` on. */
  overlay: { title: string; rows: Line[]; top: number } | null;
  edit: Edit;
}

/** How the rows of a screen are shared out. Small screens give up the spacing first, then input rows. */
export function regions(cols: number, rows: number, text: string, cursor: number): { top: number; height: number; rule: boolean; input: ReturnType<typeof layout> } {
  const airy = rows >= 14;
  const rule = rows >= 12;
  const fixed = 1 + (airy ? 1 : 0) + (rule ? 1 : 0) + 1;
  const input = layout(text, cursor, Math.max(2, cols - 2), Math.max(1, Math.min(5, rows - fixed - 3)));
  return { top: airy ? 2 : 1, height: Math.max(1, rows - fixed - input.rows.length), rule, input };
}

function header(v: TalkView): Line {
  const tone: Style = v.state === 'not running' ? { fg: 'warn' } : v.state === 'waiting for you' ? { fg: 'accent' } : DIM;
  const state: Span = { text: v.state, style: tone };
  const name: Line = [{ text: ' teneral', style: { fg: 'accent', bold: true } }];
  const own: Line = v.name ? [{ text: ` ${v.g.sep} `, style: FAINT }, { text: v.name, style: { bold: true } }] : [];
  const parts = [v.generation, v.commit, v.model].filter((part) => part !== '');
  // What does not fit goes, the least needed first: the model, the commit, the ordinal, then the name.
  for (let keep = parts.length; keep >= -1; keep--) {
    const about: Line = keep > 0 ? [{ text: `   ${parts.slice(0, keep).join(` ${v.g.sep} `)}`, style: DIM }] : [];
    const left = [...name, ...(keep >= 0 ? own : []), ...about];
    const room = v.cols - lineWidth(left) - width(state.text) - 1;
    if (room >= 2 || keep === -1) return [...fit(left, Math.max(lineWidth(left), v.cols - width(state.text) - 1)), state];
  }
  return name;
}

function hint(v: TalkView): Line {
  const who = v.name ?? 'the agent';
  // In the order shown; the number is which to give up first when the row is too narrow.
  const all: [text: string, rank: number][] = v.overlay !== null
    ? [['Esc closes', 0], ['Up/Down scroll', 1]]
    : [['Enter sends', 2], ['Alt+Enter new line', 5], ['PgUp/PgDn scroll', 4], ['Tab tool output', 6], ['/help', 3], [`Ctrl-C leaves; ${who} goes on`, 1]];
  const sep = ` ${v.g.sep} `;
  let shown = all;
  for (let rank = 6; rank > 1 && width(shown.map(([text]) => text).join(sep)) + 2 > v.cols; rank--) shown = all.filter(([, r]) => r < rank);
  return clip([{ text: ` ${shown.map(([text]) => text).join(sep)}`, style: DIM }], v.cols, { text: v.g.ellipsis, style: DIM });
}

/** The whole talk screen as one frame. */
export function talkFrame(v: TalkView): Frame {
  const r = regions(v.cols, v.rows, v.edit.text, v.edit.cursor);
  const rows: Line[] = [header(v)];
  if (r.top === 2) rows.push([]);
  let body = v.transcript.slice(-r.height);
  if (v.overlay !== null) {
    body = [[{ text: `  ${v.overlay.title}`, style: { bold: true } }], [], ...v.overlay.rows.slice(v.overlay.top)].slice(0, r.height);
  } else if (v.more && body.length > 0) {
    const mark = ` ${v.g.below} more below ${v.g.sep} End `;
    body = [...body.slice(0, -1), [{ text: ' '.repeat(Math.max(0, v.cols - width(mark))) }, { text: mark, style: { fg: 'accent' } }]];
  }
  while (body.length < r.height) body.push([]);
  rows.push(...body);
  if (r.rule) rows.push([{ text: v.g.rule.repeat(v.cols), style: FAINT }]);
  const inputTop = rows.length;
  r.input.rows.forEach((text, i) => {
    const first = i === 0 && r.input.above === 0;
    rows.push([{ text: first ? `${v.g.prompt} ` : '  ', style: { fg: 'accent', bold: true } }, { text }]);
  });
  rows.push(hint(v));
  return { rows, cursor: v.overlay !== null ? null : { row: inputTop + r.input.row, col: 2 + r.input.col } };
}
