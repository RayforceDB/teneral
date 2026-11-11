import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tell } from '../../kernel/owner';

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
