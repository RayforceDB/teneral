import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { BODY_SIZE_LIMIT, runGates } from '../../kernel/gates';
import { commitAll, makeRepo, writeFiles } from './helpers';

const NO_CHECKS: never[] = [];

test('a change inside body/ passes', () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'export const a = 1;\n' });
  writeFiles(dir, { 'body/a.ts': 'export const a = 2;\n' });
  const next = commitAll(dir, 'change');
  expect(runGates(dir, seed, next, NO_CHECKS)).toEqual({ ok: true, gate: 'all', output: '' });
});

test('a change to a protected path is rejected and named', () => {
  const { dir, seed } = makeRepo({ 'kernel/k.ts': 'export const k = 1;\n' });
  writeFiles(dir, { 'kernel/k.ts': 'export const k = 2;\n' });
  const next = commitAll(dir, 'touch kernel');
  const result = runGates(dir, seed, next, NO_CHECKS);
  expect(result.ok).toBe(false);
  expect(result.gate).toBe('protected');
  expect(result.output).toContain('kernel/k.ts');
});

test('moving a protected file away is rejected', () => {
  const { dir, seed } = makeRepo({ 'kernel/k.ts': 'export const k = 1;\n' });
  writeFiles(dir, { 'body/k.ts': 'export const k = 1;\n' });
  rmSync(join(dir, 'kernel/k.ts'));
  const next = commitAll(dir, 'move');
  expect(runGates(dir, seed, next, NO_CHECKS).gate).toBe('protected');
});

test('a name outside ASCII is matched and reported as it is, not as git quotes it', () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'export const a = 1;\n', 'kernel/k.ts': 'export const k = 1;\n' });
  writeFiles(dir, { 'body/é.ts': 'export const e = 1;\n' });
  const allowed = commitAll(dir, 'add body/é.ts');
  expect(runGates(dir, seed, allowed, NO_CHECKS)).toEqual({ ok: true, gate: 'all', output: '' });

  writeFiles(dir, { 'kernel/é.ts': 'export const e = 1;\n' });
  const forbidden = commitAll(dir, 'add kernel/é.ts');
  const result = runGates(dir, seed, forbidden, NO_CHECKS);
  expect(result.ok).toBe(false);
  expect(result.gate).toBe('protected');
  expect(result.output).toContain('kernel/é.ts');
  expect(result.output).not.toContain('\\303');
  expect(result.output).not.toContain('"');
});

test('a name that only looks changeable once whitespace is trimmed is rejected', () => {
  const spaced = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(spaced.dir, { ' body/x.ts': 'x\n' });
  expect(runGates(spaced.dir, spaced.seed, commitAll(spaced.dir, 'space'), NO_CHECKS).gate).toBe('protected');

  const tabbed = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(tabbed.dir, { '\tBACKLOG.md': 'x\n' });
  expect(runGates(tabbed.dir, tabbed.seed, commitAll(tabbed.dir, 'tab'), NO_CHECKS).gate).toBe('protected');
});

test('uncommitted work in the candidate is rejected', () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(dir, { 'body/a.ts': 'b\n' });
  const next = commitAll(dir, 'change');
  writeFiles(dir, { 'body/stray.ts': 'x\n' });
  expect(runGates(dir, seed, next, NO_CHECKS).gate).toBe('head');
});

test('a commit other than the checked-out one is rejected', () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  expect(runGates(dir, seed, '0'.repeat(40), NO_CHECKS).gate).toBe('head');
});

test('an body/ larger than the limit is rejected', () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(dir, { 'body/big.ts': 'x'.repeat(BODY_SIZE_LIMIT + 1) });
  const next = commitAll(dir, 'grow');
  expect(runGates(dir, seed, next, NO_CHECKS).gate).toBe('size');
});

test('the first failing check is reported with its output', () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(dir, { 'body/a.ts': 'b\n' });
  const next = commitAll(dir, 'change');
  const result = runGates(dir, seed, next, [
    { gate: 'types', cmd: ['bash', '-c', 'exit 0'] },
    { gate: 'tests', cmd: ['bash', '-c', 'echo boom; exit 1'] },
  ]);
  expect(result.ok).toBe(false);
  expect(result.gate).toBe('tests');
  expect(result.output).toContain('boom');
});
