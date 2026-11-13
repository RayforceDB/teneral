import { expect, test } from 'bun:test';
import { FREE, HELD, isProtected, protectedChanges } from '../../immune/protected';

const free = [
  'body/main.ts',
  'brain/loop.ts',
  'test/brain/loop.test.ts',
  'body/deep/x.ts',
  'test/body/loop.test.ts',
  'BACKLOG.md',
  'body/é.ts',
];

const protectedPaths = [
  'immune/gates.ts',
  'brain/journal.ts',
  'test/stem/a.test.ts',
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
  'Brain/x.ts',
  'brain',
  'brains/x.ts',
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
  'body/../stem/x.ts',
  'body/./x.ts',
  '"body/\\303\\251.ts"', // how git spells body/é.ts when it quotes paths
  'body\\x.ts',
  'body/a\tb.ts',
  'body/a\nb.ts',
  '',
];

test('the allowlist is the agent, its tests and its notes', () => {
  expect(FREE).toEqual(['body/', 'brain/', 'test/body/', 'test/brain/', 'BACKLOG.md']);
});

test('the form of memory is held for the owner inside the brain, and nothing else there is', () => {
  expect(HELD).toEqual(['brain/journal.ts']);
  for (const path of ['brain/journal.ts.bak', 'brain/journal/x.ts', 'brain/memory.ts', 'body/journal.ts']) expect(isProtected(path)).toBe(false);
});

test.each(free)('free: %j', (path) => {
  expect(isProtected(path)).toBe(false);
});

test.each(protectedPaths)('protected: %j', (path) => {
  expect(isProtected(path)).toBe(true);
});

test('protectedChanges keeps only the protected ones', () => {
  expect(protectedChanges(['body/a.ts', 'stem/main.ts', 'README.md', 'BACKLOG.md', 'bun.lock']))
    .toEqual(['stem/main.ts', 'README.md', 'bun.lock']);
});
