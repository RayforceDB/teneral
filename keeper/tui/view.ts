import { usage, type Command } from '../commands';
import { placed, type Edit } from './editor';
import { describe, type Attachment } from './images';
import { markdown } from './markdown';
import { inQueue, type Entry } from './model';
import { mark, windowStart } from './slash';
import { clip, detab, fit, lineWidth, width, wrap, type Line, type Span } from './text';
import type { Glyphs, Style } from './theme';

// What the talk client shows, as rows: each transcript entry at a given width, the welcome panel
// and the status lines under it, and the live region (what is still under way, the input box and
// the footer). Pure: the same state gives the same rows. Nothing here writes to a terminal.

const DIM: Style = { fg: 'dim' };
const FAINT: Style = { fg: 'faint' };
const BRAND: Style = { fg: 'brand' };
/** Tool lines are not stretched over a very wide screen: the outcome stays near its call. */
const TOOL_WIDTH = 100;
/** Rows of a tool's output shown under it, and of a stem notice's output. */
const OUTPUT_ROWS = 6;
const NOTICE_ROWS = 14;
/** Commands offered at once under the input box; of more, the ones around the chosen one. */
const LIST_ROWS = 6;

export interface Look {
  g: Glyphs;
  /** Whether tool output is shown under each call. */
  tools: boolean;
  /** What a kept image is, by the path a line names it with; null when it is not there. */
  image: (path: string) => Attachment | null;
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

/** A count of tokens in a few characters: 840, 71.9k, 500k, 1.05M. */
export function tokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
}

/** How much of the model's context the last request used: `context 8% (71.9k/1.05M)`, or the count alone when the window is not known. */
export function contextUse(used: number, window: number | null): string {
  if (window === null || window <= 0) return `context ${tokens(used)}`;
  return `context ${Math.min(100, Math.round((used / window) * 100))}% (${tokens(used)}/${tokens(window)})`;
}

/** How much of the last request's input the provider read from its cache: `cached 87%`. Empty when the body does not journal it. */
export function cacheUse(input: number, cached: number | null): string {
  if (cached === null || input <= 0) return '';
  return `cached ${Math.min(100, Math.round((cached / input) * 100))}%`;
}

/** A directory in little room: its last two parts, with a mark for what was left out. */
export function shortDir(path: string, g: Glyphs): string {
  const parts = path.split('/').filter((part) => part !== '');
  return parts.length <= 2 ? path : `${g.ellipsis}/${parts.slice(-2).join('/')}`;
}

/** Text of several lines, wrapped, every row behind the same indent. */
export function block(text: string, max: number, style: Style | undefined, indent: number): Line[] {
  const lead: Line = [{ text: ' '.repeat(indent) }];
  return text.split('\n').flatMap((line) => wrap([{ text: detab(line), style }], max, lead));
}

/** An image as the owner sees it in a line: `[image 1 · png · 1280×720 · 240 KB]`. */
export function chip(n: number, image: Attachment | null, path: string, g: Glyphs): string {
  const what = image !== null ? describe(image, g.sep, g.times) : `${/\.([a-z]+)$/.exec(path)?.[1] ?? 'image'} ${g.sep} not in memory/images`;
  return `[image ${n} ${g.sep} ${what}]`;
}

/** Chips one after the other, on as many rows as they need, behind `indent` columns. */
function chipRows(chips: string[], max: number, indent: number): Line[] {
  const rows: Line[] = [];
  let row = '';
  for (const text of chips) {
    if (row !== '' && indent + width(row) + 2 + width(text) > max) {
      rows.push([{ text: ' '.repeat(indent) }, { text: row, style: BRAND }]);
      row = '';
    }
    row += row === '' ? text : `  ${text}`;
  }
  if (row !== '') rows.push(clip([{ text: ' '.repeat(indent) }, { text: row, style: BRAND }], max));
  return rows;
}

/** One tool call: what was called, and how it ended. With `output`, a few rows of what it returned. */
function toolRows(e: Extract<Entry, { kind: 'tool' }>, max: number, g: Glyphs, output: boolean): Line[] {
  const w = Math.min(max, TOOL_WIDTH);
  const took = e.ms === null ? '' : ` ${duration(e.ms)}`;
  const said = e.status === 'running' ? 'running' : e.status === 'ok' ? `${g.ok}${took}` : e.status === 'failed' ? `${g.failed} failed${took}` : e.status;
  const right: Span = { text: said, style: e.status === 'failed' ? { fg: 'warn' } : e.status === 'ok' ? { fg: 'good' } : DIM };
  const left = clip([{ text: `  ${g.call} `, style: FAINT }, { text: e.name, style: DIM }, { text: e.args === '' ? '' : `  ${e.args}`, style: FAINT }], Math.max(4, w - width(said) - 2), { text: g.ellipsis, style: DIM });
  const rows: Line[] = [[...fit(left, Math.max(lineWidth(left), w - width(said))), right]];
  if (output && e.output !== '') {
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

/** A rule with a title in it: `── title ─────`. */
function titled(title: string, max: number, g: Glyphs, style: Style, indent = 0): Line {
  const head = clip([{ text: `${' '.repeat(indent)}${g.rule.repeat(2)} `, style }, { text: title, style: { ...style, bold: true } }], Math.max(1, max - 1), { text: g.ellipsis, style });
  return [...head, { text: ` ${g.rule.repeat(Math.max(0, Math.min(max, 72) - lineWidth(head) - 1))}`, style }];
}

/**
 * The rows of one entry, `max` columns wide. Everything someone else wrote starts in the third
 * column or further in; the first two belong to this client's own marks, which no reply can forge.
 */
/** The owner's own words once the agent has read them: on a ground of their own, so that they are never taken for a reply. */
const OWNER: Style = { fg: 'paper', bg: 'slab', bold: true };
/** The same words while they wait, in this client or on their way: faint, and with no ground. */
const WAITING: Style = { fg: 'dim' };

export function entryRows(e: Entry, max: number, look: Look): Line[] {
  const { g } = look;
  switch (e.kind) {
    case 'owner': {
      const waits = inQueue(e);
      const mark: Line = [{ text: `${g.prompt} `, style: waits ? WAITING : { fg: 'accent', bold: true } }];
      const rows = e.text === '' ? [] : e.text.split('\n').flatMap((line, i) => wrap([{ text: detab(line), style: waits ? WAITING : OWNER }], max, i === 0 ? mark : [{ text: '  ' }], [{ text: '  ' }]));
      const chips = chipRows(e.images.map((path, i) => chip(i + 1, look.image(path), path, g)), max, 2);
      // A message of images only: the mark stands before the first of them.
      if (rows.length === 0 && chips.length > 0) chips[0] = [...mark, ...chips[0]!.slice(1)];
      rows.push(...chips);
      if (rows.length === 0) rows.push(mark);
      const tag = e.held ? '' : e.pending ? 'on its way' : e.queued ? 'sent, not read yet' : e.elsewhere ? 'from another terminal' : '';
      if (tag !== '') {
        const last = rows.at(-1)!;
        if (lineWidth(last) + tag.length + 2 <= max) last.push({ text: `  ${tag}`, style: DIM });
        else rows.push([{ text: `  ${tag}`, style: DIM }]);
      }
      return rows;
    }
    case 'reasoning': {
      const style: Style = { fg: 'dim', italic: true };
      const mark: Line = [{ text: `${g.reasoning} `, style: FAINT }];
      const lines = e.text.split('\n').filter((line) => line.trim() !== '');
      // Folded to one row: that it thought, how much, and how it began. Ctrl-R or /reasoning prints the latest in full; with tool output shown (Tab), all of it is here.
      if (!look.tools) {
        const head = `thought${lines.length > 1 ? `, ${lines.length} lines` : ''} ${g.pointer} `;
        return [clip([...mark, { text: head, style: FAINT }, { text: detab((lines[0] ?? '').trim()), style }], max, { text: g.ellipsis, style: FAINT })];
      }
      return lines.flatMap((line, i) => wrap([{ text: detab(line.trim()), style }], max, i === 0 ? mark : [{ text: '  ' }], [{ text: '  ' }]));
    }
    case 'reply': {
      if (e.aside && !e.first) {
        // Words between two tool calls: the work's own commentary, set back like the calls around it, so that the answer stands out when it comes.
        const dim = markdown(e.text, Math.max(1, max - 2), g).map((line): Line => (line.length === 0 ? [] : [{ text: '  ' }, ...line.map((span): Span => ({ ...span, style: { ...span.style, fg: 'dim', bold: false } }))]));
        if (dim.length > 0 && dim[0]!.length > 0) dim[0] = [{ text: `${g.quiet} `, style: FAINT }, ...dim[0]!.slice(1)];
        return dim;
      }
      const rows = markdown(e.text, Math.max(1, max - 2), g).map((line): Line => (line.length === 0 ? [] : [{ text: '  ' }, ...line]));
      // The client's own mark stands before the first row of what was said.
      if (rows.length > 0 && rows[0]!.length > 0) rows[0] = [{ text: `${g.reply} `, style: { fg: 'brand', bold: true } }, ...rows[0]!.slice(1)];
      // The first words this individual ever said get a line of their own before them. Once.
      if (e.first) rows.unshift([{ text: '  ' }, { text: g.rule.repeat(Math.max(1, Math.min(24, max - 2))), style: BRAND }], []);
      return rows;
    }
    case 'tool':
      return toolRows(e, max, g, look.tools);
    case 'notice': {
      const tone: Style = { fg: e.tone };
      const edge: Line = [{ text: `${g.edge} `, style: tone }];
      const title: Span[] = [{ text: e.title, style: { ...tone, bold: true } }, ...(e.move ? [{ text: `  ${e.move[0]} ${g.arrow} ${e.move[1]}`, style: tone }] : [])];
      const rows: Line[] = wrap(title, max, edge);
      const under = (text: string, style: Style | undefined): Line[] => text.split('\n').flatMap((line) => wrap([{ text: detab(line), style }], max, [...edge, { text: '  ' }]));
      if (e.lead !== '') rows.push(...under(e.lead, undefined));
      if (e.body !== '') {
        const body = under(e.body, DIM);
        const hidden = body.length - NOTICE_ROWS;
        if (hidden > 0) rows.push([...edge, { text: `  ${g.ellipsis} ${hidden} earlier ${hidden === 1 ? 'row' : 'rows'}; the journal has all of it`, style: FAINT }]);
        rows.push(...body.slice(-NOTICE_ROWS));
      }
      return rows;
    }
    case 'quiet':
      return [clip([{ text: `  ${g.quiet} `, style: FAINT }, { text: e.label, style: DIM }, { text: e.text === '' ? '' : `  ${e.text}`, style: FAINT }], max, { text: g.ellipsis, style: FAINT })];
    case 'warning':
      return [
        [{ text: `${g.warn} `, style: { fg: 'warn', bold: true } }, { text: 'not from the model', style: { fg: 'warn', bold: true } }],
        ...block(e.text, max, { fg: 'warn' }, 2),
      ];
    case 'note':
      return block(e.text, max, DIM, 2);
    case 'page':
      return [
        titled(e.title, max, g, BRAND, 2),
        ...e.text.flatMap((text) => block(text, max, undefined, 2)),
        ...(e.tools ?? []).flatMap((tool) => toolRows(tool, max, g, true)),
      ];
    default:
      return [];
  }
}

/** Blank rows between two entries: none inside a run of tool calls or of quiet lines, one otherwise. */
export function gap(before: Entry | undefined, e: Entry): number {
  if (before === undefined) return 0;
  return (before.kind === 'tool' && e.kind === 'tool') || (before.kind === 'quiet' && e.kind === 'quiet') ? 0 : 1;
}

/** Rows in a thin frame with round corners, `max` columns wide over all. */
export function panel(rows: Line[], max: number, g: Glyphs, style: Style): Line[] {
  const inner = Math.max(1, max - 4);
  const [tl, tr, bl, br] = g.corners;
  const edge: Span = { text: g.bar, style };
  return [
    [{ text: `${tl}${g.rule.repeat(inner + 2)}${tr}`, style }],
    ...rows.map((row): Line => [edge, { text: ' ' }, ...fit(row, inner), { text: ' ' }, edge]),
    [{ text: `${bl}${g.rule.repeat(inner + 2)}${br}`, style }],
  ];
}

export interface Welcome {
  /** The individual's own name, when its soul gives one. */
  name: string | null;
  /** What is true of this individual and cheap to know: a label, and what there is to say. */
  facts: [label: string, value: string][];
}

/** The panel the client starts with: teneral's mark, who is being talked to, and the facts as a table. */
export function welcome(w: Welcome, max: number, g: Glyphs): Line[] {
  const inner = Math.max(1, max - 4);
  const greeting: Line = w.name
    ? [{ text: 'Talking with ', style: { bold: true } }, { text: w.name, style: { fg: 'brand', bold: true } }]
    : [{ text: 'Talking with your teneral agent', style: { bold: true } }];
  const help: Line = [{ text: 'Type to talk, Enter sends. /help lists the keys and commands.', style: DIM }];
  const rows: Line[] = [[]];
  const markWidth = width(g.mark[0]!);
  if (inner >= markWidth + 28) {
    const beside: Line[] = [greeting, help, []];
    g.mark.forEach((row, i) => {
      // The creature in teneral's own colour; the skin it left, under it, set back.
      rows.push([{ text: '  ' }, { text: row, style: i === g.mark.length - 1 ? FAINT : BRAND }, { text: '   ' }, ...clip(beside[i] ?? [], inner - markWidth - 5, { text: g.ellipsis, style: DIM })]);
    });
  } else {
    rows.push(...wrap(greeting, inner), ...wrap(help, inner));
  }
  rows.push([]);
  const label = Math.max(0, ...w.facts.map(([name]) => width(name))) + 3;
  for (const [name, value] of w.facts) {
    const lead: Line = [{ text: `  ${name.padEnd(label)}`, style: DIM }];
    rows.push(...wrap([{ text: value }], inner, lead, [{ text: ' '.repeat(label + 2) }]));
  }
  rows.push([]);
  return panel(rows, max, g, BRAND);
}

/** One status line under the panel: this client's accent mark, what it says, and under it what there is to add. */
export function status(head: Span[], more: string[], max: number, g: Glyphs, tone: Style = BRAND): Line[] {
  return [
    ...wrap(head, max, [{ text: `${g.status} `, style: tone }], [{ text: '  ' }]),
    ...more.flatMap((text) => block(text, max, DIM, 2)),
  ];
}

export interface Live {
  cols: number;
  rows: number;
  g: Glyphs;
  /** What is still under way, laid out: tool calls without a result, lines not yet in the journal. */
  pending: Line[];
  /** What the agent is doing, while it is doing something. */
  activity: Line | null;
  edit: Edit;
  /** The footer's left side, the most needed first: the model, the directory, the generation. */
  about: string[];
  /** The footer's right side: one thing worth knowing, and how full the model's context is. Either may be empty. */
  tip: string;
  context: string;
  /** Under the footer's left side: what is attached, or what is being waited for. May be empty. */
  hint: string;
  /** The commands offered for what is being typed, while they are: under the box, where the footer otherwise is. */
  list?: Offered | null;
}

export interface Offered {
  /** At least one, in the order shown. */
  matches: readonly Command[];
  /** Which of them the keys act on. */
  chosen: number;
  /** What the keys do now, the most needed first. */
  keys: string[];
}

/** `left` and `right` at the two ends of a row; when both do not fit, the right gives way. */
function ends(left: Line, right: Line, max: number): Line {
  const room = max - lineWidth(left) - lineWidth(right);
  if (room < 3) return clip(left, max);
  return [...left, { text: ' '.repeat(room) }, ...right];
}

/**
 * One row of the input. With `col`, the owner's cursor is on it: the cell there has its colours
 * swapped. With `word`, the part of the row from `from` to `to` is a command's name, in `style`.
 */
function inputRow(text: string, col: number | null, word: { from: number; to: number; style: Style } | null): Line {
  let at = -1;
  let under = '';
  if (col !== null) {
    at = 0;
    let w = 0;
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const { segment, index } of seg.segment(text)) {
      if (w >= col) break;
      at = index + segment.length;
      w += width(segment);
    }
    under = seg.segment(text.slice(at))[Symbol.iterator]().next().value?.segment ?? '';
  }
  const from = word === null ? 0 : Math.max(0, Math.min(text.length, word.from));
  const to = word === null ? 0 : Math.max(from, Math.min(text.length, word.to));
  const cuts = [...new Set([0, from, to, ...(col !== null ? [at, at + under.length] : []), text.length])].sort((a, b) => a - b);
  const row: Line = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const [a, b] = [cuts[i]!, cuts[i + 1]!];
    const style: Style = { ...(a >= from && b <= to ? word!.style : {}), ...(col !== null && under !== '' && a === at ? { inverse: true } : {}) };
    row.push(Object.keys(style).length > 0 ? { text: text.slice(a, b), style } : { text: text.slice(a, b) });
  }
  if (col !== null && under === '') row.push({ text: ' ', style: { inverse: true } });
  return row;
}

/** The commands offered, one to a row: the chosen one marked, each with what may follow it and what it does. At most `rows` of them, the ones around the chosen. */
function offeredRows(list: Offered, max: number, rows: number, g: Glyphs): Line[] {
  const wide = Math.max(...list.matches.map((c) => width(usage(c))));
  const start = windowStart(list.matches.length, list.chosen, rows);
  return list.matches.slice(start, start + rows).map((c, i): Line => {
    const on = start + i === list.chosen;
    return clip([
      { text: on ? `  ${g.pointer} ` : '    ', style: { fg: 'accent', bold: true } },
      { text: c.name, style: on ? { fg: 'accent', bold: true } : undefined },
      { text: c.hint === '' ? '' : ` ${c.hint}`, style: on ? { fg: 'accent' } : DIM },
      { text: ' '.repeat(wide - width(usage(c)) + 2) },
      { text: c.about, style: on ? undefined : DIM },
    ], max, { text: g.ellipsis, style: DIM });
  });
}

/**
 * The live region: what is under way, the input box with its attachments, and the footer. It
 * never takes more than half of the screen's rows: a small screen gives up the footer's second
 * row, rows of what is under way, the spacing, and at last the frame of the box.
 *
 * While commands are offered they stand under the box, and under them, in place of the footer,
 * one row saying what the keys do. A small screen shows fewer of them, down to the chosen one.
 *
 * Half, because of what a terminal does when its window is made narrower: most wrap every row
 * that no longer fits in two, the rows of this region with them. As long as the region, so
 * doubled, still fits the screen, its first row (where the cursor rests) stays in view and the
 * next frame can erase all of it. Wrapped beyond the height of the screen, by a window made much
 * narrower and lower in one step, its first rows scroll away, and are then out of reach.
 */
/** The grounds of the footer's left segments, in order: the first is teneral's own, the rest alternate. */
const GROUNDS: Style[] = [{ fg: 'ink', bg: 'brand', bold: true }, { fg: 'paper', bg: 'slab' }, { fg: 'paper', bg: 'deep' }];
const groundOf = (i: number): Style => GROUNDS[i === 0 ? 0 : 1 + ((i - 1) % 2)]!;

/** The ground of a segment at the right: how much came from the cache is green when nearly all did, red when nearly none. */
function contextGround(text: string): Style {
  const cached = /^cached (\d+)%$/.exec(text);
  if (cached === null) return { fg: 'paper', bg: 'slab' };
  const share = Number(cached[1]);
  return { fg: 'ink', bg: share >= 70 ? 'good' : share < 30 ? 'warn' : 'accent', bold: true };
}

/** Segments side by side, each on its ground; where the font has them, an arrow of the left one's colour leads into the next. */
function segments(parts: { text: string; style: Style }[], g: Glyphs, side: 'left' | 'right'): Line {
  const out: Line = [];
  parts.forEach((part, i) => {
    if (side === 'right' && g.segBack !== '') out.push({ text: g.segBack, style: { fg: part.style.bg, ...(i > 0 ? { bg: parts[i - 1]!.style.bg } : {}) } });
    out.push({ text: ` ${part.text} `, style: part.style });
    if (side === 'left' && g.seg !== '') out.push({ text: g.seg, style: { fg: part.style.bg, ...(i + 1 < parts.length ? { bg: parts[i + 1]!.style.bg } : {}) } });
  });
  return out;
}

/**
 * The footer, in one row. At the left, segments: the model, the state, the directory, the
 * generation. At the right: what is attached or waited for, else a tip, and the context. What
 * does not fit gives way in this order: the tip, the segments from the last down to two, the
 * context, the second segment; what is attached or waited for is said to the end.
 */
function footerRow(v: Live, max: number): Line {
  const { g } = v;
  let about = v.about.filter((part) => part !== '');
  let tip = v.hint === '' ? v.tip : '';
  let context = v.context;
  const build = (): { left: Line; right: Line } => {
    const left = segments(about.map((text, i) => ({ text, style: groundOf(i) })), g, 'left');
    const gap = context === '' ? '' : ' ';
    const said: Line = v.hint !== '' ? [{ text: `${v.hint}${gap}`, style: BRAND }] : tip !== '' ? [{ text: `${tip}${gap}`, style: FAINT }] : [];
    return { left, right: [...said, ...(context === '' ? [] : segments(context.split(` ${g.sep} `).map((text) => ({ text, style: contextGround(text) })), g, 'right'))] };
  };
  const fits = (): boolean => { const { left, right } = build(); return lineWidth(left) + (right.length > 0 ? 3 : 0) + lineWidth(right) <= max; };
  if (!fits()) tip = '';
  while (!fits() && about.length > 2) about = about.slice(0, -1);
  if (!fits()) context = '';
  while (!fits() && about.length > 1) about = about.slice(0, -1);
  if (!fits() && v.hint !== '') about = [];
  const { left, right } = build();
  return ends(left, right, max);
}

export function liveRows(v: Live): Line[] {
  const { g } = v;
  const max = Math.max(8, v.cols - 1);
  const room = Math.max(3, Math.min(v.rows - 1, Math.floor(v.rows / 2)));
  const inner = Math.max(4, max - 4);
  const chips = chipRows(v.edit.chips.map((image, i) => chip(i + 1, image, image.path, g)), inner, 0);
  const text = placed(v.edit.text, v.edit.cursor, Math.max(2, inner - 2), Math.max(1, Math.min(8, room - 5 - chips.length)));
  const command = mark(v.edit.text);
  const typed = text.rows.map((row, i): Line => [
    { text: i === 0 && text.above === 0 ? `${g.prompt} ` : '  ', style: { fg: 'accent', bold: true } },
    ...inputRow(row, i === text.row ? text.col : null, command === null ? null : { ...command, from: command.from - text.starts[i]!, to: command.to - text.starts[i]! }),
  ]);
  const box = panel([...chips, ...typed], max, g, FAINT);
  const bare = panel(typed, max, g, FAINT);

  const sep = ` ${g.sep} `;
  const list = v.list ?? null;
  let listed = list === null ? 0 : Math.min(list.matches.length, LIST_ROWS);
  /** Under the commands: the keys, as many as fit, and at the right which of how many is chosen, when not all are shown. */
  const keys = (): Line => {
    let parts = list!.keys;
    while (parts.length > 1 && width(parts.join(sep)) + 1 > max) parts = parts.slice(0, -1);
    return ends([{ text: ` ${parts.join(sep)}`, style: FAINT }], list!.matches.length > listed ? [{ text: `${list!.chosen + 1} of ${list!.matches.length}`, style: DIM }] : [], max);
  };
  const footer: Line[] = list !== null ? [] : [footerRow(v, max)];
  // What a small screen gives up, in this order, until the region fits.
  let pending = v.pending;
  let blank = true;
  let first = true;
  let activity = v.activity;
  let framed = true;
  let chipped = true;
  const build = (): Line[] => [
    ...(blank ? [[]] : []),
    ...pending,
    ...(pending.length > 0 && blank ? [[]] : []),
    ...(activity !== null ? [clip(activity, max, { text: g.ellipsis, style: DIM })] : []),
    ...(framed ? (chipped ? box : bare) : typed.slice(text.row, text.row + 1)),
    ...(list !== null ? [...offeredRows(list, max, listed, g), ...(first ? [keys()] : [])] : first ? footer : []),
  ];
  const fits = (): boolean => build().length <= room;
  while (!fits() && pending.length > 0) pending = pending.slice(1);
  if (!fits()) blank = false;
  while (!fits() && listed > 3) listed -= 1;
  if (!fits()) first = false;
  if (!fits()) activity = null;
  while (!fits() && listed > 1) listed -= 1;
  if (!fits()) chipped = false;
  if (!fits()) framed = false;
  return build();
}
