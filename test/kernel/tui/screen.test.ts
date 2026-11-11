import { expect, test } from 'bun:test';
import { KeyParser } from '../../../kernel/tui/keys';
import { Lifeline, Screen, flowHeight, type Frame } from '../../../kernel/tui/screen';
import type { Line } from '../../../kernel/tui/text';
import { fakeTerm, sequences } from './vt';

const line = (text: string): Line => [{ text }];
const frame = (rows: string[], cursor: Frame['cursor'] = null): Frame => ({ rows: rows.map(line), cursor });
const moves = (written: string[]): string[] => written.join('').match(/\x1b\[\d+;1H/g) ?? [];

// --- painting ---

test('a frame is one write; the next frame writes only the rows that differ, and the same frame writes nothing', () => {
  const term = fakeTerm(20, 5);
  const screen = new Screen(term);
  screen.enter(false);
  const start = term.written.length;
  screen.paint(frame(['one', 'two', 'three', 'four', 'five']));
  expect(term.written.length).toBe(start + 1);
  expect(term.vt.text()).toBe('one\ntwo\nthree\nfour\nfive');

  screen.paint(frame(['one', 'TWO', 'three', 'four', 'five!']));
  expect(term.written.length).toBe(start + 2);
  expect(moves(term.written.slice(-1))).toEqual(['\x1b[2;1H', '\x1b[5;1H']);
  expect(term.vt.text()).toBe('one\nTWO\nthree\nfour\nfive!');

  screen.paint(frame(['one', 'TWO', 'three', 'four', 'five!']));
  expect(term.written.length).toBe(start + 2);

  // A row that got shorter leaves nothing of the longer one behind; rows no longer in the frame are cleared.
  screen.paint(frame(['o', 'TWO']));
  expect(term.vt.text()).toBe('o\nTWO\n\n\n');
  // Moving the cursor alone is a write, with no row in it.
  screen.paint(frame(['o', 'TWO'], { row: 1, col: 3 }));
  expect(moves(term.written.slice(-1))).toEqual([]);
  expect(term.vt.cursor).toEqual({ row: 1, col: 3 });
  expect(term.vt.cursorVisible).toBe(true);
  screen.paint(frame(['o', 'TWO']));
  expect(term.vt.cursorVisible).toBe(false);
});

test('rows are cut to the width, a row full to the last column keeps its last character, and more rows than the screen has are dropped', () => {
  const term = fakeTerm(10, 3);
  const screen = new Screen(term);
  screen.enter(false);
  screen.paint(frame(['0123456789', '0123456789abc', '日本語日本語', 'beyond', 'the screen']));
  expect(term.vt.text()).toBe('0123456789\n0123456789\n日本語日本');
  // Rewriting a full row over itself leaves it whole.
  screen.invalidate();
  screen.paint(frame(['0123456789', 'x', 'y']));
  expect(term.vt.text()).toBe('0123456789\nx\ny');
});

test('a resize paints everything again at the new size', () => {
  const term = fakeTerm(20, 4);
  const screen = new Screen(term);
  screen.enter(false);
  screen.paint(frame(['a', 'b', 'c', 'd']));
  term.resize(12, 3);
  screen.paint(frame(['a', 'b', 'c', 'd']));
  expect(moves(term.written.slice(-1))).toHaveLength(3);
  expect(term.vt.text()).toBe('a\nb\nc');
});

test('entering takes the alternate screen and leaving gives everything back; nothing is painted outside of that', () => {
  const term = fakeTerm(20, 4);
  term.vt.write('$ before\r\n');
  const screen = new Screen(term);
  screen.paint(frame(['never shown']));
  expect(term.written).toEqual([]);
  screen.enter(true);
  expect([term.vt.alt, term.vt.cursorVisible, term.vt.modes.has(1000), term.vt.modes.has(1006), term.vt.modes.has(2004)]).toEqual([true, false, true, true, true]);
  screen.paint(frame(['inside'], { row: 0, col: 2 }));
  screen.setMouse(false);
  expect(term.vt.modes.has(1000)).toBe(false);
  screen.setMouse(true);
  screen.leave();
  expect([term.vt.alt, term.vt.cursorVisible, [...term.vt.modes].filter((mode) => mode !== 2026)]).toEqual([false, true, []]);
  expect(term.vt.text().startsWith('$ before')).toBe(true);
  const count = term.written.length;
  screen.paint(frame(['after']));
  screen.leave();
  expect(term.written.length).toBe(count);

  // Leaving for a program that takes over at once: still on the alternate screen, with input back to normal.
  const next = new Screen(term);
  next.enter(true);
  next.paint(frame(['handing over']));
  next.leave(true);
  expect(term.vt.alt).toBe(true);
  expect(term.vt.text().startsWith('handing over')).toBe(true);
  expect([...term.vt.modes].filter((mode) => mode !== 2026)).toEqual([]);
});

test('a long line for copying is written in one piece from the first column, so the terminal holds it as one line', () => {
  const term = fakeTerm(20, 8);
  const screen = new Screen(term);
  screen.enter(false);
  const url = `https://example.com/${'a'.repeat(30)}?state=${'b'.repeat(15)}`;
  expect(flowHeight({ flow: url }, 20)).toBe(4);
  screen.paint({ rows: [line('above'), { flow: url, link: url }, line('below')], cursor: null });
  expect(term.vt.text().split('\n').slice(0, 6)).toEqual(['above', url.slice(0, 20), url.slice(20, 40), url.slice(40, 60), url.slice(60), 'below']);
  expect(term.vt.logicalLine(1)).toBe(url);
  expect(term.vt.links).toEqual([url]);
  // Unchanged, it is not written again, whatever changes around it.
  const count = term.written.length;
  screen.paint({ rows: [line('above!'), { flow: url, link: url }, line('below')], cursor: null });
  expect(term.written.length).toBe(count + 1);
  expect(term.written.at(-1)).not.toContain('example.com');
  // Replaced by ordinary rows, nothing of it is left.
  screen.paint(frame(['above!', 'gone']));
  expect(term.vt.text()).toBe('above!\ngone\n\n\n\n\n\n');
  expect(term.vt.logicalLine(1)).toBe('gone');

  // A terminal that might print the hyperlink sequence instead of obeying it is not sent one.
  const plain = fakeTerm(20, 8, { links: false });
  const other = new Screen(plain);
  other.enter(false);
  other.paint({ rows: [{ flow: url, link: url }], cursor: null });
  expect(plain.vt.logicalLine(0)).toBe(url);
  expect(sequences(plain.written).some((sequence) => sequence.startsWith('\x1b]'))).toBe(false);
});

test('a terminal that stops answering is taken for gone after two requests; one that never answered is not', async () => {
  const term = fakeTerm(20, 4);
  let gone = 0;
  const line = new Lifeline(term, () => { gone += 1; }, 10);
  const parser = new KeyParser();
  term.listen((text) => { if (parser.feed(text).some((key) => key.kind === 'alive')) line.heard(); }, () => {});
  line.start();
  await Bun.sleep(80);
  expect(gone).toBe(0);
  expect(term.written.filter((data) => data === '\x1b[5n').length).toBeGreaterThan(3);
  term.vt.answers = false;
  await Bun.sleep(60);
  expect(gone).toBeGreaterThan(0);
  line.stop();
  const after = term.written.length;
  await Bun.sleep(30);
  expect(term.written.length).toBe(after);

  // Silence from the start may be a terminal that never answers such a request: no conclusion is drawn.
  const mute = fakeTerm(20, 4);
  mute.vt.answers = false;
  let lost = 0;
  const other = new Lifeline(mute, () => { lost += 1; }, 5);
  other.start();
  await Bun.sleep(60);
  other.stop();
  expect(lost).toBe(0);
});
