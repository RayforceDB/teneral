import { expect, test } from 'bun:test';
import { isProtected, protectedChanges } from '../../kernel/protected';

test('the kernel, its tests and the project files are protected', () => {
  for (const path of ['kernel/gates.ts', 'kernel/deep/x.ts', 'test/kernel/a.test.ts', 'probes/p1.json', 'package.json', '.gitignore']) {
    expect(isProtected(path)).toBe(true);
  }
});

test('the agent, its tests and its notes are not', () => {
  for (const path of ['body/loop.ts', 'test/body/loop.test.ts', 'BACKLOG.md', 'kernel.md', 'package.json.bak']) {
    expect(isProtected(path)).toBe(false);
  }
});

test('protectedChanges keeps only the protected ones', () => {
  expect(protectedChanges(['body/a.ts', 'kernel/main.ts', 'README.md', 'bun.lock'])).toEqual(['kernel/main.ts', 'bun.lock']);
});
