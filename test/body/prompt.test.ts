import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const prompt = readFileSync(join(import.meta.dir, '..', '..', 'body', 'prompt.md'), 'utf8');

test('the prompt says how to start something in the background, since bash waits for whatever holds its output', () => {
  expect(prompt).toContain('>/dev/null 2>&1 &');
  expect(prompt).toMatch(/background/);
  expect(prompt).toMatch(/two-minute limit/);
});
