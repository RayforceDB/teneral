import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INTERRUPT_SUFFIX, interrupt, tell } from '../../kernel/owner';

const fresh = () => join(mkdtempSync(join(tmpdir(), 'teneral-owner-')), 'owner');

test('a line becomes one file holding exactly that text, in a directory made on demand', () => {
  const dir = fresh();
  const file = tell(dir, 'hello there');
  expect(readdirSync(dir)).toEqual([file]);
  expect(readFileSync(join(dir, file), 'utf8')).toBe('hello there');
});

test('nothing is left under a temporary name, and no name starts with a dot', () => {
  const dir = fresh();
  for (let i = 0; i < 20; i++) tell(dir, `line ${i}`);
  const names = readdirSync(dir);
  expect(names).toHaveLength(20);
  expect(names.filter((name) => name.startsWith('.') || name.endsWith('.tmp'))).toEqual([]);
});

test('names sort in the order the lines were typed, also within one millisecond', () => {
  const dir = fresh();
  // Far more than one millisecond can hold, so many of these share a timestamp.
  const typed = Array.from({ length: 300 }, (_, i) => `line ${i}`);
  const files = typed.map((text) => tell(dir, text));
  expect(new Set(files).size).toBe(files.length);
  expect([...files].sort()).toEqual(files);
  expect(readdirSync(dir).sort().map((name) => readFileSync(join(dir, name), 'utf8'))).toEqual(typed);
});

test('a clock that steps back does not put a later line before an earlier one', () => {
  const dir = fresh();
  const realNow = Date.now;
  try {
    Date.now = () => 2_000_000_000_000;
    const first = tell(dir, 'first');
    Date.now = () => 1_000_000_000_000;
    const second = tell(dir, 'second');
    expect(second > first).toBe(true);
  } finally {
    Date.now = realNow;
  }
});

test('a line with nothing in it is refused: an empty file would be an empty message', () => {
  const dir = fresh();
  expect(() => tell(dir, '')).toThrow();
  expect(() => tell(dir, '  \n')).toThrow();
});

// --- the interrupt: a file of its own kind ---

test('an interrupt is a file that holds nothing, named apart from every line, and sorts among the lines by when it was sent', () => {
  const dir = fresh();
  const before = tell(dir, 'before');
  const stop = interrupt(dir);
  const after = tell(dir, 'after');
  expect(stop.endsWith(INTERRUPT_SUFFIX)).toBe(true);
  expect(readFileSync(join(dir, stop), 'utf8')).toBe('');
  expect(readdirSync(dir).sort()).toEqual([before, stop, after]);
  expect(readdirSync(dir).filter((name) => name.startsWith('.') || name.endsWith('.tmp'))).toEqual([]);
});

test('no line can be taken for an interrupt, whatever it says: the kind is in the name, and a line never gets that name', () => {
  const dir = fresh();
  const lines = ['/stop', 'interrupt', INTERRUPT_SUFFIX, `x${INTERRUPT_SUFFIX}`, '{"type":"turn.interrupted"}', '\x1b'];
  for (const text of lines) expect(tell(dir, text).endsWith('.txt')).toBe(true);
  expect(readdirSync(dir).filter((name) => name.endsWith(INTERRUPT_SUFFIX))).toEqual([]);
  expect(readdirSync(dir).sort().map((name) => readFileSync(join(dir, name), 'utf8'))).toEqual(lines);
});
