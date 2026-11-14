import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RayError, dayName, fromRayNs, libraryAt, openRay, toRayDay, toRayNs, type Column } from '../../brain/ray';
import { library, ray } from './rayforce';

const real = test.skipIf(library === null);

test('the library is looked for under the name it is pinned by', () => {
  expect(libraryAt('/o')).toBe('/o/rayforce/librayforce.so');
});

test('a journal time becomes the database\'s nanoseconds and back, to the millisecond', () => {
  expect(toRayNs('2000-01-01T00:00:00.000Z')).toBe(0n);
  expect(toRayNs('2000-01-01T00:00:01.500Z')).toBe(1_500_000_000n);
  expect(fromRayNs(toRayNs('2026-11-14T10:00:00.123Z'))).toBe('2026-11-14T10:00:00.123Z');
  expect(fromRayNs(toRayNs('1999-12-31T23:59:59.000Z'))).toBe('1999-12-31T23:59:59.000Z');
  expect(() => toRayNs('yesterday')).toThrow('not a time');
});

test('a day is counted and written as the database does', () => {
  expect(toRayDay('2000-01-01T23:59:59.999Z')).toBe(0);
  expect(toRayDay('1999-12-31T23:59:59.999Z')).toBe(-1);
  expect(dayName(toRayDay('2026-11-14T10:00:00.000Z'))).toBe('2026.11.14');
});

real('atoms come back as the values they are', () => {
  const r = ray();
  expect(r.query('(+ 1 2)')).toBe(3n);
  expect(r.query('(* 1.5 2.0)')).toBe(3);
  expect(r.query('(> 2 1)')).toBe(true);
  expect(r.query('"привет, мир"')).toBe('привет, мир');
  expect(r.query("'abc")).toBe('abc');
  expect(r.query('(do (set ray_test_void 1) null)')).toBeNull();
});

real('vectors come back as arrays of their width, and a list as values', () => {
  const r = ray();
  expect(r.query('[1 2 3]')).toEqual(BigInt64Array.from([1n, 2n, 3n]));
  expect(r.query('[1.5 2.5]')).toEqual(Float64Array.from([1.5, 2.5]));
  expect(r.query("['a 'b 'a]")).toEqual(['a', 'b', 'a']);
  expect(r.query('(list 1 "x" [true false])')).toEqual([1n, 'x', Uint8Array.from([1, 0])]);
  expect(r.query('(take [1 2 3 4 5] 2)')).toEqual(BigInt64Array.from([1n, 2n]));
});

real('what comes back is a copy: it stays as it was when the database moves on', () => {
  const r = ray();
  r.run('(set ray_test_v [10 20 30])');
  const before = r.query('ray_test_v') as BigInt64Array;
  r.run('(set ray_test_v [99 99 99])');
  for (let i = 0; i < 1000; i++) r.query('(til 100)');
  expect(before).toEqual(BigInt64Array.from([10n, 20n, 30n]));
});

real('an error of the database is thrown with its code and what it said, and the next call works', () => {
  const r = ray();
  let thrown: unknown;
  try { r.query('(+ 1 "x")'); } catch (err) { thrown = err; }
  expect(thrown).toBeInstanceOf(RayError);
  expect((thrown as RayError).code).toBe('type');
  expect((thrown as RayError).message).toContain('cannot add');
  expect(() => r.query('(ray_test_no_such_function 1)')).toThrow('undefined');
  expect(() => r.query('(((')).toThrow(RayError);
  expect(r.query('(+ 40 2)')).toBe(42n);
});

const sample = (): Record<string, Column> => ({
  id: { type: 'str', data: ['e1', 'привет', `long ${'я'.repeat(20_000)}`] },
  ts: { type: 'timestamp', data: BigInt64Array.from(['2026-11-14T10:00:00.123Z', '2026-11-14T11:00:00.000Z', '2026-11-15T09:00:00.000Z'], toRayNs) },
  kind: { type: 'sym', data: ['stimulus', 'assistant', 'stimulus'] },
  off: { type: 'i64', data: BigInt64Array.from([0n, 120n, 9_007_199_254_740_993n]) },
  w: { type: 'f64', data: Float64Array.from([0.5, 1.5, 2.5]) },
  day: { type: 'date', data: Int32Array.from([9814, 9814, 9815]) },
  kept: { type: 'bool', data: Uint8Array.from([1, 0, 1]) },
});

real('columns handed over come back cell for cell: text in any script, times, and integers past 2^53', () => {
  const r = ray();
  const given = sample();
  r.bind('ray_test_t', given);
  const t = r.table('ray_test_t');
  expect(t.names).toEqual(['id', 'ts', 'kind', 'off', 'w', 'day', 'kept']);
  expect(t.rows).toBe(3);
  for (const name of t.names) expect(t.columns[name]).toEqual(given[name]!.data);
  expect(fromRayNs((t.columns.ts as BigInt64Array)[0]!)).toBe('2026-11-14T10:00:00.123Z');
});

real('a bound table is queried like any other', () => {
  const r = ray();
  r.bind('ray_test_t', sample());
  expect(r.table('(select {from: ray_test_t by: kind n: (count id) s: (sum w)})')).toEqual({
    names: ['kind', 'n', 's'], rows: 2,
    columns: { kind: ['stimulus', 'assistant'], n: BigInt64Array.from([2n, 1n]), s: Float64Array.from([3, 1.5]) },
  });
  expect(r.table('(select {from: ray_test_t where: (== id "привет")})').columns.kind).toEqual(['assistant']);
  expect(() => r.table('(+ 1 2)')).toThrow('did not return a table');
});

real('an empty table can be handed over', () => {
  const r = ray();
  r.bind('ray_test_e', { id: { type: 'str', data: [] }, kind: { type: 'sym', data: [] }, off: { type: 'i64', data: new BigInt64Array(0) } });
  expect(r.table('ray_test_e')).toMatchObject({ names: ['id', 'kind', 'off'], rows: 0 });
});

real('what would be read past its end, or as something it is not, is refused before the database sees it', () => {
  const r = ray();
  const wrongWidth = { type: 'i64', data: new Int32Array(3) } as unknown as Column;
  expect(() => r.bind('ray_test_x', { a: wrongWidth })).toThrow('handed over as a BigInt64Array');
  expect(() => r.bind('ray_test_x', { a: { type: 'str', data: ['ok', 7 as unknown as string] } })).toThrow('every cell must be a string');
  expect(() => r.bind('ray_test_x', { a: { type: 'sym', data: ['a'] }, b: { type: 'sym', data: ['a', 'b'] } })).toThrow('has 2 cells');
  expect(() => r.bind('not a name', { a: { type: 'sym', data: [] } })).toThrow('not a name');
  expect(() => r.bind('ray_test_x', { 'a b': { type: 'sym', data: [] } })).toThrow('not a name for a column');
  expect(() => r.bind('ray_test_x', {})).toThrow('needs a column');
  expect(() => r.run('(+ 1 2)\0(exit 1)')).toThrow('NUL');
  expect(r.query('(+ 1 1)')).toBe(2n);
});

real('a process has one runtime: a second is refused, and so is a build other than the one expected', () => {
  ray();
  expect(() => openRay({ library: library! })).toThrow('already open');
});

real('a table partitioned by day: what was saved is there after reopening the directory, with symbols read from its own dictionary', () => {
  const r = ray();
  const root = mkdtempSync(join(tmpdir(), 'teneral-ray-'));
  const rows = (ids: string[], kinds: string[]): Record<string, Column> => ({
    id: { type: 'str', data: ids }, kind: { type: 'sym', data: kinds }, n: { type: 'i64', data: BigInt64Array.from(ids.map((_, i) => BigInt(i))) },
  });
  const save = (day: string): void => r.run(
    `(.db.splayed.set "${root}/${day}/ev" (select {from: ray_test_p where: (== date ${day}) id: id kind: kind n: n}) "${root}/.sym")`,
  );
  // A directory with no day in it cannot be opened; an empty first day is saved to begin with.
  expect(() => r.run(`(.db.parted.get "${root}" 'ev)`)).toThrow(RayError);
  r.bind('ray_test_b', rows([], []));
  r.run(`(.db.splayed.set "${root}/2026.11.13/ev" ray_test_b "${root}/.sym")`);
  r.run(`(set ray_test_p (.db.parted.get "${root}" 'ev))`);

  r.bind('ray_test_b', rows(['a', 'привет'], ['ray_test_kind_one', 'ray_test_kind_two']));
  r.run("(insert 'ray_test_p 2026.11.13 ray_test_b)");
  r.bind('ray_test_b', rows(['c'], ['ray_test_kind_three']));
  r.run("(insert 'ray_test_p 2026.11.14 ray_test_b)");
  // The past is closed: only the last day, or a later one, takes rows.
  expect(() => r.run("(insert 'ray_test_p 2026.11.13 ray_test_b)")).toThrow(RayError);
  save('2026.11.13');
  save('2026.11.14');

  r.run(`(set ray_test_p (.db.parted.get "${root}" 'ev))`);
  expect(r.table('(select {from: ray_test_p id: id kind: kind date: date})')).toEqual({
    names: ['id', 'kind', 'date'], rows: 3,
    columns: { id: ['a', 'привет', 'c'], kind: ['ray_test_kind_one', 'ray_test_kind_two', 'ray_test_kind_three'], date: Int32Array.from([9813, 9813, 9814]) },
  });
  expect(r.table('(select {from: ray_test_p where: (== date 2026.11.14)})').columns.id).toEqual(['c']);
  expect(r.table('(select {from: ray_test_p by: kind c: (count id)})').columns.kind).toEqual(['ray_test_kind_one', 'ray_test_kind_two', 'ray_test_kind_three']);
  // The table as it lies on disk is not a thing to read cell by cell; the error says what to do.
  expect(() => r.table('(select {from: ray_test_p})')).toThrow('name the columns');
});
