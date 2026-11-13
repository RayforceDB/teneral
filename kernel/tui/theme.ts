// The look of the owner's screens, in one place: change a colour or a glyph here and every
// screen follows. Nothing else in kernel/tui/ names a colour code or draws a glyph of its own.

/** How many colours the terminal has. `none`: NO_COLOR is set; weight and slant are still used. */
export type Depth = 'none' | '16' | '256' | 'true';

/** A colour three ways: 24-bit, the nearest of the 256, and the SGR code to fall back on with 16 colours. */
type Colour = readonly [rgb: readonly [number, number, number], indexed: number, basic: string];

// Every colour is of middle lightness, so that it reads on a dark background and on a light one.
// A reply has no colour at all: it is the terminal's own foreground. The owner's words are in
// the owner's colour, so that the two are told apart at a glance.
export const PALETTE = {
  /** teneral's own: the mark, the frame of the welcome panel, the individual's name. The pale green of a creature just out of its old skin. */
  brand: [[88, 186, 148], 72, '36'],
  /** The warm one, for the owner: their prompt mark and their words in the transcript, and the mark at the input. */
  accent: [[226, 156, 72], 179, '33'],
  /** Machinery: tool lines, hints, quiet stimuli, the model's reasoning. With 16 colours it is the faint attribute. */
  dim: [[138, 134, 128], 245, '2'],
  /** Rules, frames and the least important marks. */
  faint: [[108, 105, 100], 242, '2'],
  /** Code, inline and in blocks. */
  code: [[104, 160, 200], 74, '35'],
  /** The footer's segments: text on a ground of its own, so these three do not depend on the terminal's colours. */
  ink: [[22, 22, 20], 233, '30'],
  paper: [[232, 229, 220], 254, '37'],
  slab: [[78, 76, 71], 240, '90'],
  deep: [[104, 101, 95], 242, '90'],
  good: [[110, 180, 104], 71, '32'],
  warn: [[222, 110, 88], 167, '31'],
} as const satisfies Record<string, Colour>;

export type ColourName = keyof typeof PALETTE;

export interface Style {
  fg?: ColourName;
  /** The ground under the text: the segments of the footer. */
  bg?: ColourName;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Foreground and background swapped: the cell the owner's cursor is on. */
  inverse?: boolean;
}

/** The SGR parameters for a style at a colour depth; empty when it needs none. */
export function sgr(style: Style | undefined, depth: Depth): string {
  if (style === undefined) return '';
  const codes: string[] = [];
  if (style.bold) codes.push('1');
  if (style.italic) codes.push('3');
  if (style.underline) codes.push('4');
  if (style.inverse) codes.push('7');
  if (style.fg !== undefined) {
    const [rgb, indexed, basic] = PALETTE[style.fg];
    if (depth === 'true') codes.push(`38;2;${rgb[0]};${rgb[1]};${rgb[2]}`);
    else if (depth === '256') codes.push(`38;5;${indexed}`);
    else if (depth === '16') codes.push(basic);
    // Without colour, what was dim is still set back, by weight.
    else if (basic === '2') codes.push('2');
  }
  if (style.bg !== undefined && depth !== 'none') {
    const [rgb, indexed, basic] = PALETTE[style.bg];
    if (depth === 'true') codes.push(`48;2;${rgb[0]};${rgb[1]};${rgb[2]}`);
    else if (depth === '256') codes.push(`48;5;${indexed}`);
    // With 16 colours the ground is the same colour's own code, ten higher; the faint attribute has none.
    else if (basic !== '2') codes.push(String(Number(basic) + 10));
  }
  return codes.join(';');
}

const UTF8 = {
  /** Before the owner's words, in the transcript and at the input. */
  prompt: '›',
  /** Before a reply, and before the model's reasoning. */
  reply: '●',
  reasoning: '○',
  /** Before a status line under the welcome panel. */
  status: '◆',
  /** Before a tool call in the conversation; `tool` is the setup's mark for a step. */
  call: '▪',
  tool: '·',
  ok: '✓',
  failed: '✗',
  quiet: '◦',
  rule: '─',
  ellipsis: '…',
  bullet: '•',
  bar: '│',
  /** The edge of a kernel notice. */
  edge: '┃',
  pointer: '▸',
  arrow: '→',
  sep: '·',
  times: '×',
  hidden: '•',
  warn: '!',
  /** Between two segments of the footer. Empty: the grounds meet. `glyphs` puts the Powerline arrows here when the owner's font has them. */
  seg: '',
  segBack: '',
  /** The corners of a panel: top left, top right, bottom left, bottom right. */
  corners: ['╭', '╮', '╰', '╯'],
  /**
   * teneral's mark: a creature just out of its old skin. Wings still opening, the body under
   * them, and below, drawn in shade, the skin it left. Each row is as wide as the others.
   */
  mark: ['▚▖  ▗▞', ' ▜██▛ ', ' ░▒▒░ '],
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
};

export type Glyphs = typeof UTF8;

/** The same marks for a terminal whose locale is not UTF-8. */
const ASCII: Glyphs = {
  prompt: '>',
  reply: '*',
  reasoning: 'o',
  status: '*',
  call: '-',
  tool: '-',
  ok: 'ok',
  failed: 'x',
  quiet: '.',
  rule: '-',
  ellipsis: '...',
  bullet: '*',
  bar: '|',
  edge: '|',
  pointer: '>',
  arrow: '->',
  sep: '|',
  times: 'x',
  hidden: '*',
  warn: '!',
  seg: '',
  segBack: '',
  corners: ['+', '+', '+', '+'],
  mark: ['\\\\  //', ' (oo) ', ' \'::\' '],
  spinner: ['|', '/', '-', '\\'],
};

/** `powerline`: the owner's font has the Powerline arrows (TENERAL_POWERLINE=1); no terminal says so itself. */
export const glyphs = (utf8: boolean, powerline = false): Glyphs => (utf8 ? (powerline ? { ...UTF8, seg: '\ue0b0', segBack: '\ue0b2' } : UTF8) : ASCII);

/** Milliseconds each spinner frame is shown. */
export const SPIN_MS = 120;

export interface Caps {
  depth: Depth;
  utf8: boolean;
  /** Whether an OSC 8 hyperlink is safe to send: unknown to the terminal, it is ignored; a few print it. */
  links: boolean;
}

/** What the terminal can show, as far as the environment says. */
export function capsOf(env: Record<string, string | undefined>): Caps {
  const term = env.TERM ?? '';
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  let depth: Depth = '16';
  if (env.NO_COLOR) depth = 'none';
  else if (/truecolor|24bit/i.test(env.COLORTERM ?? '')) depth = 'true';
  else if (/256/.test(term)) depth = '256';
  return { depth, utf8: /utf-?8/i.test(locale), links: term !== 'linux' && term !== '' };
}
