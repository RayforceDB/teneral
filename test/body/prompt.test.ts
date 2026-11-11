import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const prompt = readFileSync(join(import.meta.dir, '..', '..', 'body', 'prompt.md'), 'utf8');

test('the prompt says how to start something in the background, since a job that holds the output of bash loses what it prints', () => {
  expect(prompt).toContain('>/dev/null 2>&1 &');
  expect(prompt).toMatch(/background/);
  expect(prompt).toMatch(/two-minute limit/);
});

test('the prompt says that the owner comes and goes, and reads replies, not tool output', () => {
  expect(prompt).toMatch(/attaches a terminal to talk to you and detaches again/);
  expect(prompt).toMatch(/whether or not anyone is still watching/);
  expect(prompt).toMatch(/must be in your reply text/);
});
