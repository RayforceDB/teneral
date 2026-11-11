import { expect, test } from 'bun:test';
import { EMPTY, attach, edit, insert, layout, sent, type Edit } from '../../../kernel/tui/editor';
import type { Attachment } from '../../../kernel/tui/images';
import { KeyParser, type Key } from '../../../kernel/tui/keys';

// --- what the terminal sends, read back as keys ---

/** The keys one terminal's bytes give, fed in the pieces listed. */
function keys(...chunks: string[]): Key[] {
  const parser = new KeyParser();
  const out = chunks.flatMap((chunk) => parser.feed(chunk));
  return [...out, ...parser.flush()];
}
const key = (name: string, mods: { ctrl?: true; alt?: true; shift?: true } = {}): Key => ({ kind: 'key', name, ...mods });

test('typed characters come as text, whole, whatever the script', () => {
  expect(keys('hello')).toEqual([{ kind: 'text', text: 'hello' }]);
  expect(keys('привет 🙂 日本')).toEqual([{ kind: 'text', text: 'привет 🙂 日本' }]);
  expect(keys('a', 'b')).toEqual([{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }]);
});

test('the keys that are single bytes: Enter, Tab, Backspace, and letters held with Ctrl', () => {
  expect(keys('\r')).toEqual([key('enter')]);
  expect(keys('\t')).toEqual([key('tab')]);
  expect(keys('\x7f')).toEqual([key('backspace')]);
  expect(keys('\b')).toEqual([key('backspace')]);
  expect(keys('\x03\x04\x15\x0b\x17\x01\x05\x0c')).toEqual(['c', 'd', 'u', 'k', 'w', 'a', 'e', 'l'].map((name) => key(name, { ctrl: true })));
  expect(keys('\n')).toEqual([key('j', { ctrl: true })]);
  expect(keys('a\rb')).toEqual([{ kind: 'text', text: 'a' }, key('enter'), { kind: 'text', text: 'b' }]);
});

test('arrows, Home, End, Delete and the page keys, in each spelling terminals use', () => {
  expect(keys('\x1b[A\x1b[B\x1b[C\x1b[D')).toEqual([key('up'), key('down'), key('right'), key('left')]);
  expect(keys('\x1bOA\x1bOB\x1bOC\x1bOD')).toEqual([key('up'), key('down'), key('right'), key('left')]);
  expect(keys('\x1b[H\x1b[F\x1bOH\x1bOF\x1b[1~\x1b[4~\x1b[7~\x1b[8~')).toEqual(['home', 'end', 'home', 'end', 'home', 'end', 'home', 'end'].map((name) => key(name)));
  expect(keys('\x1b[3~\x1b[5~\x1b[6~')).toEqual([key('delete'), key('pageup'), key('pagedown')]);
});

test('what was held with a key is told: Shift, Alt and Ctrl with arrows, Alt with Enter, Backspace and letters', () => {
  expect(keys('\x1b[1;2A\x1b[1;2B')).toEqual([key('up', { shift: true }), key('down', { shift: true })]);
  expect(keys('\x1b[1;5C\x1b[1;5D')).toEqual([key('right', { ctrl: true }), key('left', { ctrl: true })]);
  expect(keys('\x1b[1;3C\x1b[1;3D')).toEqual([key('right', { alt: true }), key('left', { alt: true })]);
  expect(keys('\x1b\r')).toEqual([key('enter', { alt: true })]);
  expect(keys('\x1b\x7f')).toEqual([key('backspace', { alt: true })]);
  expect(keys('\x1bb\x1bf')).toEqual([key('b', { alt: true }), key('f', { alt: true })]);
  expect(keys('\x1b[13;2u')).toEqual([key('enter', { shift: true })]);
  expect(keys('\x1b[27;2;13~')).toEqual([key('enter', { shift: true })]);
  expect(keys('\x1b[Z')).toEqual([key('tab', { shift: true })]);
});

test('an escape sequence split across two reads is one key, wherever it is split', () => {
  for (const sequence of ['\x1b[A', '\x1b[1;5C', '\x1b[5~', '\x1bOH', '\x1b\r']) {
    const whole = keys(sequence);
    expect(whole).toHaveLength(1);
    for (let at = 1; at < sequence.length; at++) {
      const parser = new KeyParser();
      const first = parser.feed(sequence.slice(0, at));
      expect(first).toEqual([]);
      expect(parser.pending).toBe(true);
      expect(parser.feed(sequence.slice(at))).toEqual(whole);
      expect(parser.pending).toBe(false);
    }
  }
});

test('a lone ESC is the Escape key once nothing follows it, and typed text after an ESC is not eaten', () => {
  const parser = new KeyParser();
  expect(parser.feed('\x1b')).toEqual([]);
  expect(parser.flush()).toEqual([key('escape')]);
  expect(parser.flush()).toEqual([]);
  expect(keys('\x1b\x1b')).toEqual([key('escape'), key('escape')]);
  // Half a sequence that never finished is noise, and what comes later is read afresh.
  expect(parser.feed('\x1b[1;')).toEqual([]);
  expect(parser.flush()).toEqual([]);
  expect(parser.feed('ok')).toEqual([{ kind: 'text', text: 'ok' }]);
});

test('a bracketed paste comes whole, line breaks and all, even when it arrives in pieces', () => {
  expect(keys('\x1b[200~one\r\ntwo\rthree\x1b[201~')).toEqual([{ kind: 'paste', text: 'one\ntwo\nthree' }]);
  expect(keys('a\x1b[200~b\x1b[201~c')).toEqual([{ kind: 'text', text: 'a' }, { kind: 'paste', text: 'b' }, { kind: 'text', text: 'c' }]);
  const pasted = '\x1b[200~first line\nsecond \x1b[31m line\x1b[201~';
  for (let at = 1; at < pasted.length; at++) {
    const parser = new KeyParser();
    const got = [...parser.feed(pasted.slice(0, at)), ...parser.feed(pasted.slice(at))];
    expect(got).toEqual([{ kind: 'paste', text: 'first line\nsecond \x1b[31m line' }]);
  }
  // Nothing in a paste is taken as a key: an Enter in it sends nothing.
  expect(keys('\x1b[200~\r\x03\x1b[A\x1b[201~')).toEqual([{ kind: 'paste', text: '\n\x03\x1b[A' }]);
});

test('the mouse is the terminal\'s own: a report from a terminal left in a mouse mode is swallowed whole, in both formats, and nothing is made of it', () => {
  expect(keys('\x1b[<64;10;5M\x1b[<65;10;5M')).toEqual([]);
  expect(keys('\x1b[<0;10;5M\x1b[<0;10;5m')).toEqual([]);
  expect(keys('\x1b[M`!!\x1b[Ma!!')).toEqual([]);
  expect(keys('\x1b[M !!x')).toEqual([{ kind: 'text', text: 'x' }]);
});

test('Ctrl+V arrives as the byte it is, a key of its own and no text', () => {
  expect(keys('a\x16b')).toEqual([{ kind: 'text', text: 'a' }, { kind: 'key', name: 'v', ctrl: true }, { kind: 'text', text: 'b' }]);
  expect(edit(at('a'), key('v', { ctrl: true }))).toBeNull();
});

test('sequences that mean nothing here are swallowed whole, not typed', () => {
  expect(keys('\x1b[I\x1b[O')).toEqual([]);
  expect(keys('\x1b[?1;2c')).toEqual([]);
  expect(keys('\x1b[15~\x1bOP')).toEqual([]);
  expect(keys('\x1b[1;1R')).toEqual([]);
  expect(keys('\x1b[3n')).toEqual([]);
  expect(keys('\x00\x1c\x1f')).toEqual([]);
  expect(keys('a\u{9b}b')).toEqual([{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }]);
});

test('the terminal\'s answer to a status request is no key, and says only that the terminal is there', () => {
  expect(keys('\x1b[0n')).toEqual([{ kind: 'alive' }]);
  expect(keys('a\x1b[0nb')).toEqual([{ kind: 'text', text: 'a' }, { kind: 'alive' }, { kind: 'text', text: 'b' }]);
  expect(edit(EMPTY, { kind: 'alive' })).toBeNull();
});

// --- the line editor ---

const type = (e: Edit, ...what: (Key | string)[]): Edit => what.reduce<Edit>((line, k) => edit(line, typeof k === 'string' ? { kind: 'text', text: k } : k) ?? line, e);
const at = (text: string, cursor = text.length): Edit => ({ ...EMPTY, text, cursor });

test('text is inserted where the cursor is, and the cursor moves by whole characters', () => {
  let e = type(EMPTY, 'helo');
  expect(e).toMatchObject({ text: 'helo', cursor: 4 });
  e = type(e, key('left'), 'l');
  expect(e).toMatchObject({ text: 'hello', cursor: 4 });
  e = type(e, key('home'), 'X', key('end'), '!');
  expect(e).toMatchObject({ text: 'Xhello!', cursor: 7 });
  expect(type(at('ab', 0), key('left')).cursor).toBe(0);
  expect(type(at('ab'), key('right')).cursor).toBe(2);
  expect(type(at('ab', 1), key('a', { ctrl: true })).cursor).toBe(0);
  expect(type(at('ab', 1), key('e', { ctrl: true })).cursor).toBe(2);
});

test('a letter with its accent, an emoji and a joined emoji are each one step and one Backspace', () => {
  const family = '👨\u{200d}👩\u{200d}👧';
  for (const ch of ['й', 'e\u{301}', '🙂', family, '日', '🇫🇷']) {
    const e = at(`a${ch}b`, 1 + ch.length);
    expect(type(e, key('left')).cursor).toBe(1);
    expect(type(at(`a${ch}b`, 1), key('right')).cursor).toBe(1 + ch.length);
    expect(type(e, key('backspace'))).toMatchObject({ text: 'ab', cursor: 1 });
    expect(type(at(`a${ch}b`, 1), key('delete'))).toMatchObject({ text: 'ab', cursor: 1 });
  }
});

test('word jumps with Ctrl or Alt and an arrow, and with Alt-B and Alt-F', () => {
  const e = at('один два  три');
  expect(type(e, key('left', { ctrl: true })).cursor).toBe(10);
  expect(type(e, key('left', { alt: true }), key('left', { alt: true })).cursor).toBe(5);
  expect(type(e, key('b', { alt: true }), key('b', { alt: true }), key('b', { alt: true })).cursor).toBe(0);
  expect(type(at('один два  три', 0), key('right', { ctrl: true })).cursor).toBe(4);
  expect(type(at('один два  три', 4), key('f', { alt: true })).cursor).toBe(8);
});

test('Ctrl-U deletes to the start of the line, Ctrl-K to its end, Ctrl-W and Alt-Backspace the word before', () => {
  expect(type(at('one two three', 7), key('u', { ctrl: true }))).toMatchObject({ text: ' three', cursor: 0 });
  expect(type(at('one two three', 7), key('k', { ctrl: true }))).toMatchObject({ text: 'one two', cursor: 7 });
  expect(type(at('one two three'), key('w', { ctrl: true }))).toMatchObject({ text: 'one two ', cursor: 8 });
  expect(type(at('one two  '), key('backspace', { alt: true }))).toMatchObject({ text: 'one ', cursor: 4 });
  // In a text of several lines, they stay within the line the cursor is on.
  expect(type(at('first\nsecond line', 12), key('u', { ctrl: true }))).toMatchObject({ text: 'first\n line', cursor: 6 });
  expect(type(at('first\nsecond', 2), key('k', { ctrl: true }))).toMatchObject({ text: 'fi\nsecond', cursor: 2 });
});

test('Alt+Enter, Shift+Enter and Ctrl-J start a new line; a paste keeps its line breaks; plain Enter is not the editor\'s', () => {
  expect(type(at('a'), key('enter', { alt: true }), 'b').text).toBe('a\nb');
  expect(type(at('a'), key('enter', { shift: true })).text).toBe('a\n');
  expect(type(at('a'), key('j', { ctrl: true })).text).toBe('a\n');
  expect(type(EMPTY, { kind: 'paste', text: 'one\ntwo\tthree\x1b[31m\x07' }).text).toBe('one\ntwo    three[31m');
  expect(edit(at('a'), key('enter'))).toBeNull();
  expect(edit(at('a'), key('tab'))).toBeNull();
  expect(edit(at('a'), key('c', { ctrl: true }))).toBeNull();
  expect(edit(at('a'), key('up', { shift: true }))).toBeNull();
  expect(edit(at('a'), key('pageup'))).toBeNull();
});

test('Up and Down move between the lines of a text, keeping the column', () => {
  const e = at('first line\nвторая\nthird one', 10 + 1 + 6 + 1 + 7);
  const up = type(e, key('up'));
  expect(up.cursor).toBe(11 + 6); // the second line is shorter: its end
  expect(type(up, key('up')).cursor).toBe(6);
  expect(type(up, key('down')).cursor).toBe(18 + 6);
  expect(type(at('ab\n日本語', 1), key('down')).cursor).toBe(3); // one column in: before the first wide character
});

test('Up and Down at the first and last line walk through what was sent, and come back to the draft', () => {
  let e = sent(sent(sent(EMPTY, 'one'), 'two'), 'three');
  expect(e).toMatchObject({ text: '', history: ['one', 'two', 'three'] });
  e = type(e, 'draft', key('up'));
  expect(e).toMatchObject({ text: 'three', cursor: 5 });
  e = type(e, key('up'), key('up'), key('up'));
  expect(e.text).toBe('one');
  e = type(e, key('down'));
  expect(e.text).toBe('two');
  e = type(e, key('down'), key('down'));
  expect(e).toMatchObject({ text: 'draft', at: null });
  expect(type(e, key('down')).text).toBe('draft');
  // An entry that was edited is the owner's own line from then on.
  const edited = type(type(sent(EMPTY, 'old'), key('up')), '!');
  expect(edited).toMatchObject({ text: 'old!', at: null });
  // The same line twice in a row is kept once.
  expect(sent(sent(EMPTY, 'x'), 'x').history).toEqual(['x']);
});

test('the text is laid out in rows of the width given, and the cursor is found in them', () => {
  expect(layout('', 0, 10, 5)).toEqual({ rows: [''], row: 0, col: 0, above: 0 });
  expect(layout('hello', 5, 10, 5)).toEqual({ rows: ['hello'], row: 0, col: 5, above: 0 });
  expect(layout('abcdefghij', 10, 10, 5)).toEqual({ rows: ['abcdefghij', ''], row: 1, col: 0, above: 0 });
  expect(layout('abcdefghijkl', 11, 10, 5)).toEqual({ rows: ['abcdefghij', 'kl'], row: 1, col: 1, above: 0 });
  expect(layout('one\ntwo', 5, 10, 5)).toEqual({ rows: ['one', 'two'], row: 1, col: 1, above: 0 });
  expect(layout('日本語日本語', 3, 6, 5)).toMatchObject({ rows: ['日本語', '日本語'], row: 1, col: 0 });
  expect(layout('привет', 3, 10, 5)).toMatchObject({ row: 0, col: 3 });
  expect(layout('a🙂b', 3, 10, 5)).toMatchObject({ col: 3 });
});

test('more rows than there is room for: the ones around the cursor are shown', () => {
  const text = 'l1\nl2\nl3\nl4\nl5\nl6';
  expect(layout(text, text.length, 10, 3)).toEqual({ rows: ['l4', 'l5', 'l6'], row: 2, col: 2, above: 3 });
  expect(layout(text, 0, 10, 3)).toEqual({ rows: ['l1', 'l2', 'l3'], row: 0, col: 0, above: 0 });
  expect(layout(text, 7, 10, 3)).toMatchObject({ rows: ['l3', 'l4', 'l5'], row: 0, above: 2 });
  expect(insert(at('ab', 1), 'X')).toMatchObject({ text: 'aXb', cursor: 2 });
});

// --- images attached to the line ---

const image = (n: number): Attachment => ({ path: `memory/images/${String(n).repeat(64)}.png`, ext: 'png', width: 10 * n, height: 10, bytes: 1000 * n });

test('an image is attached as a chip beside the text; Backspace at the very start takes the last chip, and anywhere else a character', () => {
  let e = attach(attach(type(EMPTY, 'look'), image(1)), image(2));
  expect(e.chips.map((chip) => chip.width)).toEqual([10, 20]);
  expect(e.text).toBe('look');
  // In the text, Backspace is Backspace.
  e = type(e, key('backspace'));
  expect([e.text, e.chips.length]).toEqual(['loo', 2]);
  // At the start of the text the last chip goes, one press each, and then nothing.
  e = type(e, key('home'), key('backspace'));
  expect([e.text, e.cursor, e.chips.map((chip) => chip.width)]).toEqual(['loo', 0, [10]]);
  e = type(e, key('backspace'), key('backspace'));
  expect([e.text, e.chips.length]).toEqual(['loo', 0]);
  // Other ways of deleting leave chips alone.
  e = attach(type(EMPTY, key('u', { ctrl: true }), key('w', { ctrl: true }), key('delete')), image(3));
  expect(type(e, key('u', { ctrl: true }), key('w', { ctrl: true }), key('delete'), key('backspace', { alt: true })).chips).toHaveLength(1);
});

test('a line carries at most four images, the same one only once, and sending it leaves no chip behind', () => {
  let e = EMPTY;
  for (let n = 1; n <= 6; n++) e = attach(e, image(n));
  expect(e.chips).toHaveLength(4);
  expect(attach(attach(EMPTY, image(1)), image(1)).chips).toHaveLength(1);
  // Walking the history keeps what is attached; what is remembered is the words.
  e = type({ ...attach(EMPTY, image(1)), history: ['earlier'] }, key('up'));
  expect([e.text, e.chips.length]).toEqual(['earlier', 1]);
  const after = sent(type(e, ' words'), 'earlier words');
  expect([after.text, after.chips.length, after.history]).toEqual(['', 0, ['earlier', 'earlier words']]);
  // A message of images only adds nothing to the history.
  expect(sent(attach({ ...EMPTY, history: ['x'] }, image(2)), '').history).toEqual(['x']);
});
