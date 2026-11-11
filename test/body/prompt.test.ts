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

// "What the kernel requires of you": each statement is pinned here by a phrase, so one cannot be dropped unnoticed.
// The numbers are checked against the kernel's own constants where it exports them.
import { BODY_SIZE_LIMIT } from '../../kernel/gates';
import { CHANGEABLE } from '../../kernel/protected';
import { CRASH_LIMIT, MOLT_EXIT, REJECTION_LIMIT, RESTART_DELAY_CAP_MS } from '../../kernel/supervisor';

const flat = prompt.replace(/\s+/g, ' ');

test('the prompt has the section on what the kernel requires', () => {
  expect(prompt).toContain('## What the kernel requires of you');
});

test('it says how the body is started and that the live checkout does not last', () => {
  expect(flat).toContain('`bun body/main.ts`');
  expect(flat).toMatch(/wipes it and resets it to your generation before every start/);
  expect(flat).toMatch(/edits there are lost/);
  expect(flat).not.toMatch(/read-only/);
});

test('it names every variable the kernel gives the body', () => {
  for (const name of ['GEN', 'JOURNAL', 'WORKSPACE', 'SOUL', 'PEERS', 'INBOX', 'OWNER', 'ID', 'BASE_URL', 'API_KEY', 'MODEL']) {
    expect(flat).toContain(`\`TENERAL_${name}\``);
  }
});

test('it says ready must be journaled in time, and that only a ready generation may molt', () => {
  expect(flat).toMatch(/Within 60 seconds of starting you must append a `generation\.ready` event with your own generation id/);
  expect(flat).toMatch(/rolled back at once/);
  expect(flat).toMatch(/Only a ready generation may molt/);
});

test('it says what each exit code means', () => {
  expect(flat).toContain(`${MOLT_EXIT} means`);
  expect(flat).toMatch(/must follow a `molt\.requested` event/);
  expect(flat).toMatch(/0 stops the whole agent until your owner starts it again/);
  expect(flat).toMatch(/Anything else is a crash/);
});

test('it says how crashes are counted and that a rollback is the last step back', () => {
  expect(CRASH_LIMIT).toBe(3);
  expect(REJECTION_LIMIT).toBe(3);
  expect(RESTART_DELAY_CAP_MS).toBe(30_000);
  expect(flat).toMatch(/Three crashes in a row with no reply/);
  expect(flat).toMatch(/ten restarts of one generation/);
  expect(flat).toMatch(/up to 30 seconds/);
  expect(flat).toMatch(/there is no further step back/);
  expect(flat).toMatch(/Three molts in a row rejected with no reply in between halt everything/);
});

test('it lists what a molt must pass, in the kernel\'s order', () => {
  const order = [
    'nothing uncommitted', 'changes only', 'only plain files', `${BODY_SIZE_LIMIT} bytes`, '`bun x tsc --noEmit`',
    '`bun test test/kernel`', '`bun test test/body`', 'at least one test and no failure', 'the smoke gate',
  ].map((phrase) => flat.indexOf(phrase));
  expect(order.every((at) => at !== -1)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  for (const path of CHANGEABLE) expect(flat).toContain(`\`${path}\``);
});

test('it describes the smoke gate and the bare environment the checks run in', () => {
  expect(flat).toMatch(/throwaway journal holding one message/);
  expect(flat).toMatch(/stub model on localhost/);
  expect(flat).toMatch(/`generation\.ready` and then a reply within 30 seconds/);
  expect(flat).toMatch(/OpenAI-compatible endpoint at `TENERAL_BASE_URL`/);
  expect(flat).toMatch(/fresh checkout of the commit/);
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'BUN_INSTALL']) expect(flat).toContain(`\`${name}\``);
  expect(flat).toMatch(/a file that is not committed fails there/);
});

test('it states the probation after a promotion', () => {
  expect(flat).toMatch(/must reply \(journal an `assistant` event\) within 10 minutes or it is rolled back/);
});

test('it says the kernel speaks only through three events, and what rewriting their handling costs', () => {
  for (const type of ['molt.rejected', 'generation.promoted', 'generation.rolledback']) expect(flat).toContain(`\`${type}\``);
  expect(flat).toMatch(/you stop hearing the kernel/);
});

test('it says the journal\'s event types are the kernel\'s and how to append', () => {
  expect(flat).toMatch(/defined in `kernel\/journal\.ts`, and a molt cannot add one/);
  expect(flat).toMatch(/only through the kernel's `appendEvent`/);
});

test('it says how to reproduce a start failure by hand', () => {
  expect(prompt).toMatch(/timeout 20 bun body\/main\.ts <\/dev\/null/);
  expect(prompt).toContain('TENERAL_GEN=$(git rev-parse HEAD)');
});

test('what the review found false is now said truly', () => {
  // The soul is not private from the provider.
  expect(flat).toMatch(/sent to your model provider with every request/);
  expect(flat).not.toMatch(/never committed or sent anywhere/);
  // A rollback note carries the end of what the failed body printed.
  expect(flat).toMatch(/the end of what the failed code printed/);
  // Both markers for a tool call the process did not finish.
  expect(flat).toContain('`[not started]`');
  expect(flat).toContain('`[interrupted]`');
  // The name on a message is the sender's own.
  expect(flat).toMatch(/whatever the sender calls itself/);
  expect(flat).toMatch(/not the name you know it by in `peers\.json`/);
  // A clock tick no longer means nobody is waiting.
  expect(flat).not.toMatch(/nobody is waiting/);
});
