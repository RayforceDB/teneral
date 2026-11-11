import { expect, test } from 'bun:test';
import { markdown, inline } from '../../../kernel/tui/markdown';
import { charWidth, clean, clip, detab, fit, lineWidth, plain, width, wrap, type Line } from '../../../kernel/tui/text';
import { capsOf, glyphs, sgr } from '../../../kernel/tui/theme';

const cp = (ch: string): number => ch.codePointAt(0)!;
const texts = (lines: Line[]): string[] => lines.map(plain);
const G = glyphs(true);

// --- how wide text is ---

test('a character is as wide as a terminal draws it: Latin and Cyrillic one column, CJK and emoji two, marks none', () => {
  expect(charWidth(cp('a'))).toBe(1);
  expect(charWidth(cp('ж'))).toBe(1);
  expect(charWidth(cp('é'))).toBe(1);
  expect(charWidth(cp('日'))).toBe(2);
  expect(charWidth(cp('한'))).toBe(2);
  expect(charWidth(cp('Ａ'))).toBe(2);
  expect(charWidth(cp('🙂'))).toBe(2);
  expect(charWidth(0x1f680)).toBe(2);
  expect(charWidth(0x0301)).toBe(0); // a combining acute accent
  expect(charWidth(0xfe0f)).toBe(0); // the variation selector that asks for the emoji form
  expect(charWidth(0x200d)).toBe(0); // the zero-width joiner
  expect(charWidth(0x1b)).toBe(0);
});

test('the width of a text is the sum over its characters', () => {
  expect(width('')).toBe(0);
  expect(width('hello')).toBe(5);
  expect(width('привет')).toBe(6);
  expect(width('日本語')).toBe(6);
  expect(width('e\u{301}')).toBe(1);
  expect(width('й')).toBe(1);
  expect(width('и\u{306}')).toBe(1); // the same letter, written as и and a breve
  expect(width('ok 🙂!')).toBe(6);
  expect(width('❤\u{fe0f}')).toBe(1);
  expect(width('🇫🇷')).toBe(2);
});

test('tabs become spaces up to the next stop, counted in columns', () => {
  expect(detab('a\tb')).toBe('a   b');
  expect(detab('\tx')).toBe('    x');
  expect(detab('日\tx')).toBe('日  x');
  expect(detab('abcd\tx')).toBe('abcd    x');
  expect(detab('no tabs')).toBe('no tabs');
});

// --- what may be shown at all ---

test('nothing someone else wrote can reach the terminal as a command: escape sequences go whole', () => {
  expect(clean('red \x1b[31malert\x1b[0m done')).toBe('red alert done');
  expect(clean('move\x1b[2J\x1b[1;1Hhome')).toBe('movehome');
  expect(clean('title\x1b]0;you are hacked\x07after')).toBe('titleafter');
  expect(clean('title\x1b]2;x\x1b\\after')).toBe('titleafter');
  expect(clean('link \x1b]8;;http://evil.example\x1b\\text\x1b]8;;\x1b\\ end')).toBe('link text end');
  expect(clean('dcs\x1bP1$r0m\x1b\\after')).toBe('dcsafter');
  expect(clean('apc\x1b_payload\x1b\\after')).toBe('apcafter');
  expect(clean('c1 \x9b31mred\x9b0m')).toBe('c1 red');
  expect(clean('c1osc \x9d0;title\x9cafter')).toBe('c1osc after');
  expect(clean('alt\x1b(0screen')).toBe('altscreen');
  expect(clean('save\x1b7 restore\x1b8')).toBe('save restore');
});

test('a sequence that never ends loses its start and nothing else', () => {
  expect(clean('before \x1b]0;never closed')).toBe('before 0;never closed');
  expect(clean('before \x1b[')).toBe('before ');
  expect(clean('before \x1bPnever closed')).toBe('before never closed');
  expect(clean('lone \x1b')).toBe('lone ');
});

test('control characters go, line breaks and tabs stay, and every kind of line break becomes one', () => {
  expect(clean('a\x00b\x07c\x08d\x7fe')).toBe('abcde');
  expect(clean('one\r\ntwo\rthree\nfour')).toBe('one\ntwo\nthree\nfour');
  expect(clean('tab\there')).toBe('tab\there');
  expect(clean('a\u{2028}b\u{2029}c')).toBe('a\nb\nc');
  expect(clean('c1\u{85}\u{9f}x')).toBe('c1x');
});

test('what would reorder or hide text goes: bidi overrides and isolates, tags, the byte-order mark', () => {
  expect(clean('abc\u{202e}dcba\u{202c}')).toBe('abcdcba');
  expect(clean('\u{2066}x\u{2069}\u{200e}\u{200f}\u{61c}')).toBe('x');
  expect(clean('\u{feff}start')).toBe('start');
  expect(clean('tag\u{e0041}\u{e007f}s')).toBe('tags');
  // A joiner inside an emoji or a word is part of the text.
  expect(clean('👩\u{200d}🚀')).toBe('👩\u{200d}🚀');
  expect(clean(`half ${'\u{d83d}'} pair`)).toBe('half \u{fffd} pair');
});

// --- wrapping and clipping ---

test('text wraps at spaces to the width, and a word too long for a line is cut', () => {
  expect(texts(wrap([{ text: 'the quick brown fox jumps' }], 10))).toEqual(['the quick', 'brown fox', 'jumps']);
  expect(texts(wrap([{ text: 'abcdefghijklmno' }], 6))).toEqual(['abcdef', 'ghijkl', 'mno']);
  expect(texts(wrap([{ text: 'ab abcdefghij' }], 6))).toEqual(['ab', 'abcdef', 'ghij']);
  expect(texts(wrap([{ text: '' }], 10))).toEqual(['']);
  expect(texts(wrap([{ text: 'exactly ten' }], 11))).toEqual(['exactly ten']);
});

test('Cyrillic wraps by its letters, CJK may break between any two characters, and no row is wider than asked', () => {
  expect(texts(wrap([{ text: 'привет мир как дела' }], 10))).toEqual(['привет мир', 'как дела']);
  expect(texts(wrap([{ text: '日本語のテキスト' }], 6))).toEqual(['日本語', 'のテキ', 'スト']);
  expect(texts(wrap([{ text: '日本語のテキスト' }], 7))).toEqual(['日本語', 'のテキ', 'スト']);
  const mixed = wrap([{ text: 'слово 🙂🙂🙂 ещё слово 日本語 and more words here' }], 9);
  for (const line of mixed) expect(lineWidth(line)).toBeLessThanOrEqual(9);
  expect(texts(mixed).join(' ').replace(/\s+/g, '')).toBe('слово🙂🙂🙂ещёслово日本語andmorewordshere');
});

test('a first-line prefix and a hanging indent are kept on every row', () => {
  const rows = wrap([{ text: 'one two three four five' }], 12, [{ text: '• ' }], [{ text: '  ' }]);
  expect(texts(rows)).toEqual(['• one two', '  three four', '  five']);
  // A prefix that leaves no room for text is dropped, not obeyed.
  expect(texts(wrap([{ text: 'abc def' }], 5, [{ text: '    ' }]))).toEqual(['abc', 'def']);
});

test('a word in two styles stays together, and each part keeps its style', () => {
  const rows = wrap([{ text: 'aaa bb' }, { text: 'cc', style: { bold: true } }, { text: ' dd' }], 6);
  expect(texts(rows)).toEqual(['aaa', 'bbcc', 'dd']);
  expect(rows[1]).toEqual([{ text: 'bb', style: undefined }, { text: 'cc', style: { bold: true } }]);
});

test('indentation at the start is kept, and spaces at a break are not carried over', () => {
  expect(texts(wrap([{ text: '  indented text here' }], 12))).toEqual(['  indented', 'text here']);
  expect(texts(wrap([{ text: 'a    b' }], 3))).toEqual(['a', 'b']);
});

test('clipping cuts at the width, never through a wide character, and can say that it cut', () => {
  expect(plain(clip([{ text: 'hello world' }], 5))).toBe('hello');
  expect(plain(clip([{ text: 'hello world' }], 6, { text: '…' }))).toBe('hello…');
  expect(plain(clip([{ text: '日本語' }], 5))).toBe('日本');
  expect(plain(clip([{ text: '日本語' }], 5, { text: '…' }))).toBe('日本…');
  expect(plain(clip([{ text: 'short' }], 10, { text: '…' }))).toBe('short');
  expect(plain(clip([{ text: 'ab' }, { text: 'cd' }, { text: 'ef' }], 3))).toBe('abc');
  expect(lineWidth(fit([{ text: 'ab' }], 5))).toBe(5);
  expect(plain(fit([{ text: 'abcdef' }], 4))).toBe('abcd');
});

// --- the markdown subset ---

test('emphasis, code and links become styled spans, and the marks go', () => {
  expect(inline('plain')).toEqual([{ text: 'plain', style: {} }]);
  expect(inline('a **b** c')).toEqual([{ text: 'a ', style: {} }, { text: 'b', style: { bold: true } }, { text: ' c', style: {} }]);
  expect(inline('*i* and _j_').filter((s) => s.style?.italic).map((s) => s.text)).toEqual(['i', 'j']);
  expect(inline('***both***')).toEqual([{ text: 'both', style: { bold: true, italic: true } }]);
  expect(inline('run `bun test` now')[1]).toEqual({ text: 'bun test', style: { fg: 'code' } });
  expect(inline('``a ` b``')[0]).toEqual({ text: 'a ` b', style: { fg: 'code' } });
  expect(plain(inline('see [the docs](https://example.com/a_b) here'))).toBe('see the docs (https://example.com/a_b) here');
  expect(inline('see [the docs](https://example.com) here').find((s) => s.text.includes('example'))!.style).toEqual({ fg: 'dim' });
  expect(plain(inline('<https://example.com>'))).toBe('https://example.com');
  expect(plain(inline('**bold with `code` inside**'))).toBe('bold with code inside');
});

test('marks that open nothing, or are never closed, stay as the text they are', () => {
  expect(plain(inline('2 * 3 * 4'))).toBe('2 * 3 * 4');
  expect(plain(inline('**never closed'))).toBe('**never closed');
  expect(plain(inline('a `tick'))).toBe('a `tick');
  expect(plain(inline('snake_case_name and a_b_c'))).toBe('snake_case_name and a_b_c');
  expect(inline('snake_case_name').every((s) => !s.style?.italic)).toBe(true);
  expect(plain(inline('[not a link] (really)'))).toBe('[not a link] (really)');
  expect(plain(inline('\\*not emphasis\\*'))).toBe('*not emphasis*');
  expect(plain(inline('a < b > c'))).toBe('a < b > c');
  expect(plain(inline('*'))).toBe('*');
  expect(plain(inline('****'))).toBe('****');
});

test('a reply is laid out by blocks: headings, lists with hanging indents, quotes, rules, and code kept unwrapped', () => {
  const text = [
    '# Title', '', 'A paragraph that is long enough to wrap around.', '',
    '- first item which is long enough to wrap', '- second', '  1. nested one', '',
    '> quoted words', '', '---', '',
    '```ts', 'const answer = 42; // this line is far too long to fit', '  indented();', '```', 'after',
  ].join('\n');
  expect(texts(markdown(text, 24, G))).toEqual([
    'Title', '',
    'A paragraph that is long', 'enough to wrap around.', '',
    '• first item which is', '  long enough to wrap', '• second', '  1. nested one', '',
    '│ quoted words', '',
    '────────────────────────', '',
    '│ const answer = 42; //…', '│   indented();',
    'after',
  ]);
});

test('line breaks in a reply are kept, blank lines do not pile up, and a numbered list hangs under its text', () => {
  expect(texts(markdown('one\ntwo\n\n\n\nthree', 20, G))).toEqual(['one', 'two', '', 'three']);
  expect(texts(markdown('10. a long numbered item here', 16, G))).toEqual(['10. a long', '    numbered', '    item here']);
  expect(texts(markdown('## Привет, мир ##', 20, G))).toEqual(['Привет, мир']);
  expect(markdown('# Head', 20, G)[0]![0]!.style).toEqual({ bold: true });
});

test('broken markdown comes out as text: an unclosed fence, a lone mark, a table', () => {
  expect(texts(markdown('```\nnever closed\nstill code', 30, G))).toEqual(['│ never closed', '│ still code']);
  expect(texts(markdown('-', 30, G))).toEqual(['-']);
  expect(texts(markdown('#hashtag', 30, G))).toEqual(['#hashtag']);
  expect(texts(markdown('| a | b |\n|---|---|\n| 1 | 2 |', 30, G))).toEqual(['| a | b |', '|---|---|', '| 1 | 2 |']);
  expect(texts(markdown('>', 30, G))).toEqual(['│ ']);
  expect(texts(markdown('', 30, G))).toEqual([]);
  // Whatever the width, nothing throws and no row is wider than asked.
  for (const max of [1, 2, 3, 5, 8]) {
    for (const line of markdown('# h\n- item one two\n> q\n```\ncode line\n```\n1. x **b** `c` [l](u)', max, G)) expect(lineWidth(line)).toBeLessThanOrEqual(max);
  }
});

// --- the look ---

test('a style becomes colour codes for the depth the terminal has, and none at all for no style', () => {
  expect(sgr(undefined, 'true')).toBe('');
  expect(sgr({}, 'true')).toBe('');
  expect(sgr({ bold: true }, 'none')).toBe('1');
  expect(sgr({ fg: 'accent' }, 'true')).toMatch(/^38;2;\d+;\d+;\d+$/);
  expect(sgr({ fg: 'accent' }, '256')).toMatch(/^38;5;\d+$/);
  expect(sgr({ fg: 'accent', bold: true }, '16')).toBe('1;33');
  // With 16 colours, and with none, dim text is set back by weight instead.
  expect(sgr({ fg: 'dim' }, '16')).toBe('2');
  expect(sgr({ fg: 'dim' }, 'none')).toBe('2');
  expect(sgr({ fg: 'accent' }, 'none')).toBe('');
  expect(sgr({ fg: 'warn', italic: true }, 'none')).toBe('3');
});

test('what the terminal can show is read from the environment', () => {
  expect(capsOf({ TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' })).toEqual({ depth: 'true', utf8: true, links: true });
  expect(capsOf({ TERM: 'xterm-256color', LANG: 'C.UTF-8' }).depth).toBe('256');
  expect(capsOf({ TERM: 'xterm', LANG: 'C' })).toEqual({ depth: '16', utf8: false, links: true });
  expect(capsOf({ TERM: 'xterm-256color', COLORTERM: 'truecolor', NO_COLOR: '1' }).depth).toBe('none');
  expect(capsOf({ TERM: 'linux', LC_ALL: 'ru_RU.utf8' })).toEqual({ depth: '16', utf8: true, links: false });
  expect(capsOf({ TERM: 'xterm', LC_ALL: 'C', LANG: 'en_US.UTF-8' }).utf8).toBe(false);
});

test('every glyph has an ASCII stand-in for a locale that is not UTF-8', () => {
  const ascii = glyphs(false);
  for (const [name, value] of Object.entries(ascii)) {
    for (const glyph of Array.isArray(value) ? value : [value]) expect(`${name}:${/^[\x20-\x7e]+$/.test(glyph)}`).toBe(`${name}:true`);
  }
  expect(Object.keys(ascii).sort()).toEqual(Object.keys(G).sort());
});
