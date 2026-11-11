// The look of the owner's screens, in one place: change a colour or a glyph here and every
// screen follows. Nothing else in kernel/tui/ names a colour code or draws a glyph of its own.

/** How many colours the terminal has. `none`: NO_COLOR is set; weight and slant are still used. */
export type Depth = 'none' | '16' | '256' | 'true';

/** A colour three ways: 24-bit, the nearest of the 256, and the SGR code to fall back on with 16 colours. */
type Colour = readonly [rgb: readonly [number, number, number], indexed: number, basic: string];

export const PALETTE = {
  /** The one accent: the name, the prompt mark, the owner's mark, the rule before the first words. */
  accent: [[217, 164, 92], 179, '33'],
  /** The owner's own words. With 16 colours only their mark sets them apart. */
  owner: [[204, 188, 160], 180, ''],
  /** Machinery: tool lines, hints, quiet stimuli. With 16 colours it is the faint attribute. */
  dim: [[138, 133, 126], 245, '2'],
  /** Rules and the least important marks. */
  faint: [[98, 94, 89], 240, '2'],
  /** Code, inline and in blocks. */
  code: [[150, 176, 170], 109, '36'],
  good: [[143, 174, 126], 108, '32'],
  warn: [[214, 132, 108], 173, '31'],
} as const satisfies Record<string, Colour>;

export type ColourName = keyof typeof PALETTE;

export interface Style {
  fg?: ColourName;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

/** The SGR parameters for a style at a colour depth; empty when it needs none. */
export function sgr(style: Style | undefined, depth: Depth): string {
  if (style === undefined) return '';
  const codes: string[] = [];
  if (style.bold) codes.push('1');
  if (style.italic) codes.push('3');
  if (style.underline) codes.push('4');
  if (style.fg !== undefined) {
    const [rgb, indexed, basic] = PALETTE[style.fg];
    if (depth === 'true') codes.push(`38;2;${rgb[0]};${rgb[1]};${rgb[2]}`);
    else if (depth === '256') codes.push(`38;5;${indexed}`);
    else if (depth === '16') { if (basic !== '') codes.push(basic); }
    // Without colour, what was dim is still set back, by weight.
    else if (basic === '2') codes.push('2');
  }
  return codes.join(';');
}

const UTF8 = {
  /** Before the owner's words, in the transcript and at the input. */
  prompt: '›',
  tool: '·',
  quiet: '◦',
  rule: '─',
  ellipsis: '…',
  below: '↓',
  bullet: '•',
  bar: '│',
  pointer: '▸',
  arrow: '→',
  sep: '·',
  hidden: '•',
  warn: '!',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
};

export type Glyphs = typeof UTF8;

/** The same marks for a terminal whose locale is not UTF-8. */
const ASCII: Glyphs = {
  prompt: '>',
  tool: '-',
  quiet: '.',
  rule: '-',
  ellipsis: '~',
  below: 'v',
  bullet: '*',
  bar: '|',
  pointer: '>',
  arrow: '->',
  sep: '|',
  hidden: '*',
  warn: '!',
  spinner: ['|', '/', '-', '\\'],
};

export const glyphs = (utf8: boolean): Glyphs => (utf8 ? UTF8 : ASCII);

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
