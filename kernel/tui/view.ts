import { layout, type Edit } from './editor';
import { describe, type Attachment } from './images';
import { markdown } from './markdown';
import type { Entry } from './model';
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
/** Rows of a tool's output shown under it, and of a kernel notice's output. */
const OUTPUT_ROWS = 6;
const NOTICE_ROWS = 14;

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
export function entryRows(e: Entry, max: number, look: Look): Line[] {
  const { g } = look;
  switch (e.kind) {
    case 'owner': {
      const mark: Line = [{ text: `${g.prompt} `, style: { fg: 'accent', bold: true } }];
      const rows = e.text === '' ? [] : e.text.split('\n').flatMap((line, i) => wrap([{ text: detab(line), style: { bold: true } }], max, i === 0 ? mark : [{ text: '  ' }], [{ text: '  ' }]));
      const chips = chipRows(e.images.map((path, i) => chip(i + 1, look.image(path), path, g)), max, 2);
      // A message of images only: the mark stands before the first of them.
      if (rows.length === 0 && chips.length > 0) chips[0] = [...mark, ...chips[0]!.slice(1)];
      rows.push(...chips);
      if (rows.length === 0) rows.push(mark);
      const tag = e.pending ? 'on its way' : e.elsewhere ? 'from another terminal' : '';
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
      return e.text.split('\n').filter((line) => line.trim() !== '').flatMap((line, i) => wrap([{ text: detab(line.trim()), style }], max, i === 0 ? mark : [{ text: '  ' }], [{ text: '  ' }]));
    }
    case 'reply': {
      const rows = markdown(e.text, Math.max(1, max - 2), g).map((line): Line => (line.length === 0 ? [] : [{ text: '  ' }, ...line]));
      // The client's own mark stands before the first row of what was said.
      if (rows.length > 0 && rows[0]!.length > 0) rows[0] = [{ text: `${g.reply} `, style: { bold: true } }, ...rows[0]!.slice(1)];
      // The first words this individual ever said get a line of their own before them. Once.
      if (e.first) rows.unshift([{ text: '  ' }, { text: g.rule.repeat(Math.max(1, Math.min(24, max - 2))), style: BRAND }], []);
      if (e.early) rows.push(...block('(written before the line above had arrived)', max, DIM, 2));
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
}

/** `left` and `right` at the two ends of a row; when both do not fit, the right gives way. */
function ends(left: Line, right: Line, max: number): Line {
  const room = max - lineWidth(left) - lineWidth(right);
  if (room < 3) return clip(left, max);
  return [...left, { text: ' '.repeat(room) }, ...right];
}

/** One row of the input with the owner's cursor on it: the cell at `col` with its colours swapped. */
function withCursor(text: string, col: number): Line {
  let at = 0;
  let w = 0;
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const { segment, index } of seg.segment(text)) {
    if (w >= col) break;
    at = index + segment.length;
    w += width(segment);
  }
  const under = seg.segment(text.slice(at))[Symbol.iterator]().next().value?.segment ?? '';
  return [{ text: text.slice(0, at) }, { text: under === '' ? ' ' : under, style: { inverse: true } }, { text: text.slice(at + under.length) }];
}

/**
 * The live region: what is under way, the input box with its attachments, and the footer. It
 * never takes more than half of the screen's rows: a small screen gives up the footer's second
 * row, rows of what is under way, the spacing, and at last the frame of the box.
 *
 * Half, because of what a terminal does when its window is made narrower: most wrap every row
 * that no longer fits in two, the rows of this region with them. As long as the region, so
 * doubled, still fits the screen, its first row (where the cursor rests) stays in view and the
 * next frame can erase all of it. Wrapped beyond the height of the screen, by a window made much
 * narrower and lower in one step, its first rows scroll away, and are then out of reach.
 */
export function liveRows(v: Live): Line[] {
  const { g } = v;
  const max = Math.max(8, v.cols - 1);
  const room = Math.max(3, Math.min(v.rows - 1, Math.floor(v.rows / 2)));
  const inner = Math.max(4, max - 4);
  const chips = chipRows(v.edit.chips.map((image, i) => chip(i + 1, image, image.path, g)), inner, 0);
  const text = layout(v.edit.text, v.edit.cursor, Math.max(2, inner - 2), Math.max(1, Math.min(8, room - 5 - chips.length)));
  const typed = text.rows.map((row, i): Line => [
    { text: i === 0 && text.above === 0 ? `${g.prompt} ` : '  ', style: { fg: 'accent', bold: true } },
    ...(i === text.row ? withCursor(row, text.col) : [{ text: row }]),
  ]);
  const box = panel([...chips, ...typed], max, g, FAINT);
  const bare = panel(typed, max, g, FAINT);

  const sep = ` ${g.sep} `;
  let about = v.about.filter((part) => part !== '');
  while (about.length > 1 && width(about.join(sep)) + 1 > max) about = about.slice(0, -1);
  const left: Line = [{ text: ` ${about.join(sep)}`, style: DIM }];
  const footer: Line[] = [ends(left, v.tip === '' ? [] : [{ text: v.tip, style: FAINT }], max)];
  if (v.hint !== '' || v.context !== '') footer.push(ends([{ text: v.hint === '' ? '' : ` ${v.hint}`, style: BRAND }], v.context === '' ? [] : [{ text: v.context, style: DIM }], max));

  // What a small screen gives up, in this order, until the region fits.
  let pending = v.pending;
  let blank = true;
  let second = footer.length > 1;
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
    ...(first ? footer.slice(0, second ? 2 : 1) : []),
  ];
  const fits = (): boolean => build().length <= room;
  if (!fits()) second = false;
  while (!fits() && pending.length > 0) pending = pending.slice(1);
  if (!fits()) blank = false;
  if (!fits()) first = false;
  if (!fits()) activity = null;
  if (!fits()) chipped = false;
  if (!fits()) framed = false;
  return build();
}
