import { expect, test } from 'bun:test';
import { KeyParser } from '../../../keeper/tui/keys';
import { Inline, Lifeline, Screen, flowHeight, type Frame } from '../../../keeper/tui/screen';
import type { Line } from '../../../keeper/tui/text';
import { fakeTerm, sequences } from './vt';

const line = (text: string): Line => [{ text }];
const frame = (rows: string[], cursor: Frame['cursor'] = null): Frame => ({ rows: rows.map(line), cursor });
const moves = (written: string[]): string[] => written.join('').match(/\x1b\[\d+;1H/g) ?? [];

// --- painting ---

test('a frame is one write; the next frame writes only the rows that differ, and the same frame writes nothing', () => {
  const term = fakeTerm(20, 5);
  const screen = new Screen(term);
  screen.enter();
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
  screen.enter();
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
  screen.enter();
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
  screen.enter();
  // The mouse is never asked for: selecting and copying stay the terminal's own.
  expect([term.vt.alt, term.vt.cursorVisible, term.vt.modes.has(1000), term.vt.modes.has(1006), term.vt.modes.has(2004)]).toEqual([true, false, false, false, true]);
  screen.paint(frame(['inside'], { row: 0, col: 2 }));
  screen.leave();
  expect([term.vt.alt, term.vt.cursorVisible, [...term.vt.modes].filter((mode) => mode !== 2026)]).toEqual([false, true, []]);
  expect(term.vt.text().startsWith('$ before')).toBe(true);
  const count = term.written.length;
  screen.paint(frame(['after']));
  screen.leave();
  expect(term.written.length).toBe(count);

  // Leaving for a program that takes over at once: still on the alternate screen, with input back to normal.
  const next = new Screen(term);
  next.enter();
  next.paint(frame(['handing over']));
  next.leave(true);
  expect(term.vt.alt).toBe(true);
  expect(term.vt.text().startsWith('handing over')).toBe(true);
  expect([...term.vt.modes].filter((mode) => mode !== 2026)).toEqual([]);
});

test('a long line for copying is written in one piece from the first column, so the terminal holds it as one line', () => {
  const term = fakeTerm(20, 8);
  const screen = new Screen(term);
  screen.enter();
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
  other.enter();
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

// --- the normal screen: finished rows printed once, a live region under them ---

const lines = (...rows: string[]): Line[] => rows.map(line);
/** A live region as the talk client has one: a box as wide as the screen allows, and a footer. */
const box = (cols: number, typed = ''): Line[] => lines('', `+${'-'.repeat(cols - 3)}+`, `| ${typed.padEnd(cols - 5)} |`, `+${'-'.repeat(cols - 3)}+`, ' footer');

test('finished rows are printed once and scroll away; the live region stays under them, and the cursor rests hidden on its first row', () => {
  const term = fakeTerm(30, 10);
  term.vt.write('$ ./one talk\r\n');
  const inline = new Inline(term);
  inline.paint(box(30));
  expect(term.written).toEqual([]);
  inline.start();
  expect([term.vt.alt, term.vt.cursorVisible, term.vt.modes.has(2004)]).toEqual([false, false, true]);
  inline.print(lines('one', 'two'));
  inline.paint(box(30));
  expect(term.vt.all()).toBe(['$ ./one talk', 'one', 'two', ...box(30).map((row) => row[0]!.text.trimEnd())].join('\n'));
  expect(term.vt.cursor).toEqual({ row: 3, col: 0 });

  // Nothing new: nothing written. One row of the region changed: that row only, one write, and the cursor is back.
  let count = term.written.length;
  inline.paint(box(30));
  expect(term.written.length).toBe(count);
  inline.paint(box(30, 'hello'));
  expect(term.written.length).toBe(count + 1);
  expect(term.written.at(-1)).toContain('hello');
  expect(term.written.at(-1)).not.toContain('footer');
  expect(term.written.at(-1)).not.toContain('\x1b[J');
  expect(term.vt.cursor).toEqual({ row: 3, col: 0 });
  expect(term.vt.text().split('\n')[5]).toBe(`| ${'hello'.padEnd(25)} |`);

  // More finished rows than the screen has: every one is in the scrollback, in order, and the region is whole under the last.
  const many = Array.from({ length: 40 }, (_, i) => `reply row ${i}`);
  inline.print(lines(...many));
  count = term.written.length;
  inline.paint(box(30, 'hello'));
  expect(term.written.length).toBe(count + 1);
  expect(term.vt.all()).toBe(['$ ./one talk', 'one', 'two', ...many, '', `+${'-'.repeat(27)}+`, `| ${'hello'.padEnd(25)} |`, `+${'-'.repeat(27)}+`, ' footer'].join('\n'));
  // The region ends on the last row of the screen, and the cursor is still on its first.
  expect(term.vt.cursor).toEqual({ row: 5, col: 0 });
  expect(term.vt.text().split('\n').at(-1)).toBe(' footer');

  // A region that shrinks leaves nothing of its old rows; one that grows at the bottom of the screen scrolls for itself.
  inline.paint(lines('', 'only this'));
  expect(term.vt.text().split('\n').slice(5)).toEqual(['', 'only this', '', '', '']);
  inline.paint(lines('', 'a', 'b', 'c', 'd', 'e', 'f'));
  expect(term.vt.text().split('\n').slice(-7)).toEqual(['', 'a', 'b', 'c', 'd', 'e', 'f']);
  expect(term.vt.cursor).toEqual({ row: 3, col: 0 });
  expect(term.vt.all().split('\n').filter((row) => row === 'reply row 39')).toHaveLength(1);
});

test('no row is written into the last column, and a live region taller than the screen keeps its last rows', () => {
  const term = fakeTerm(20, 6);
  const inline = new Inline(term);
  inline.start();
  expect(inline.width).toBe(19);
  inline.print(lines('x'.repeat(50)));
  inline.paint(lines('y'.repeat(50), ...Array.from({ length: 9 }, (_, i) => `live ${i}`)));
  const rows = term.vt.all().split('\n');
  expect(rows[0]).toBe('x'.repeat(19));
  for (const row of rows) expect(row.length).toBeLessThanOrEqual(19);
  expect(term.vt.text().split('\n')).toEqual(['x'.repeat(19), 'live 4', 'live 5', 'live 6', 'live 7', 'live 8']);
  expect(term.vt.cursor).toEqual({ row: 1, col: 0 });
});

test('a change of size leaves no debris, whether the terminal cuts its rows or wraps them again: the region is drawn anew where the cursor rests', () => {
  for (const reflow of [false, true]) {
    const term = fakeTerm(40, 12);
    term.vt.reflow = reflow;
    const inline = new Inline(term);
    inline.start();
    const said = ['first line of the conversation', 'second line of it'];
    inline.print(lines(...said));
    inline.paint(box(40, 'typed'));
    // Narrower, wider, shorter, taller, and narrower by more than half, where a terminal that wraps makes three rows of one.
    for (const [cols, rows] of [[30, 12], [58, 12], [58, 7], [58, 20], [17, 20], [40, 12], [40, 6], [80, 30]] as const) {
      term.resize(cols, rows);
      inline.invalidate();
      inline.paint(box(cols, 'typed'));
      const all = term.vt.all().split('\n');
      const live = box(cols, 'typed').map((row) => row[0]!.text.trimEnd());
      // The region is whole and is the last thing there; above it, no row of an old box survives.
      expect(all.slice(-live.length)).toEqual(live);
      const above = all.slice(0, -live.length);
      expect(above.filter((row) => /^[+|]|footer|typed/.test(row) || /[+|]$/.test(row))).toEqual([]);
      // What was said is still there, in order. A terminal that wraps keeps every character of it; one that cuts has cut the rows it cut.
      if (reflow) expect(above.join('').replace(/\s+/g, '')).toBe(said.join('').replace(/\s+/g, ''));
      expect(above).toHaveLength(reflow ? Math.ceil(said[0]!.length / cols) + Math.ceil(said[1]!.length / cols) : 2);
      expect(above.join('')).toContain('first line');
      expect(term.vt.cursor.col).toBe(0);
      expect(term.vt.text().split('\n')[term.vt.cursor.row + 1]).toBe(live[1]!);
    }
  }
});

test('stopping prints what is still queued, takes the live region away and gives the terminal back with its cursor under the last row', () => {
  const term = fakeTerm(30, 8);
  term.vt.write('$ ./one talk\r\n');
  const inline = new Inline(term);
  inline.start();
  inline.print(lines('a reply'));
  inline.paint(box(30, 'half typed'));
  inline.print(lines('', 'You left.'));
  inline.stop();
  expect(term.vt.all()).toBe('$ ./one talk\na reply\n\nYou left.');
  expect(term.vt.cursor).toEqual({ row: 4, col: 0 });
  expect([term.vt.alt, term.vt.cursorVisible, [...term.vt.modes].filter((mode) => mode !== 2026)]).toEqual([false, true, []]);
  // Nothing more is written once it has stopped; stopping twice is one stop.
  const count = term.written.length;
  inline.print(lines('late'));
  inline.paint(box(30));
  inline.stop();
  expect(term.written.length).toBe(count);
  // Only the sequences it needs: relative moves, erasing, colours and its three modes. It never names a row of the screen.
  const own = /^\x1b\[(\d*[ABKJ]|[\d;]*m|\?(25|2004|2026)[hl])$/;
  expect(sequences(term.written).filter((sequence) => !own.test(sequence))).toEqual([]);
});
