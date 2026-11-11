import { expect, test } from 'bun:test';
import { CHANGEABLE, isProtected, protectedChanges } from '../../kernel/protected';

const changeable = [
  'body/loop.ts',
  'body/deep/x.ts',
  'test/body/loop.test.ts',
  'BACKLOG.md',
  'body/é.ts',
];

const protectedPaths = [
  'kernel/gates.ts',
  'test/kernel/a.test.ts',
  'probes/p1.json',
  'package.json',
  'bun.lock',
  'tsconfig.json',
  '.gitignore',
  'bunfig.toml',
  '.gitattributes',
  '.npmrc',
  'BIRTH.md',
  'README.md',
  'newfile.ts',
  'Body/x.ts',
  'BODY/x.ts',
  'backlog.md',
  'BACKLOG.md.bak',
  'body',
  'body/',
  'test/body',
  'bodyguard/x.ts',
  './body/x.ts',
  '/body/x.ts',
  'body//x.ts',
  'body/../kernel/x.ts',
  'body/./x.ts',
  '"body/\\303\\251.ts"', // how git spells body/é.ts when it quotes paths
  'body\\x.ts',
  'body/a\tb.ts',
  'body/a\nb.ts',
  '',
];

test('the allowlist is the agent, its tests and its notes', () => {
  expect(CHANGEABLE).toEqual(['body/', 'test/body/', 'BACKLOG.md']);
});

test.each(changeable)('changeable: %j', (path) => {
  expect(isProtected(path)).toBe(false);
});

test.each(protectedPaths)('protected: %j', (path) => {
  expect(isProtected(path)).toBe(true);
});

test('protectedChanges keeps only the protected ones', () => {
  expect(protectedChanges(['body/a.ts', 'kernel/main.ts', 'README.md', 'BACKLOG.md', 'bun.lock']))
    .toEqual(['kernel/main.ts', 'README.md', 'bun.lock']);
});
