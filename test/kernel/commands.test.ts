import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMANDS, closest, commandNamed, helpRows, takes, usage } from '../../kernel/commands';
import { ownerCommand } from '../../kernel/offer';

// --- the owner's commands, as one table ---

test('every command is a slash and lower-case letters, named once, with one line on what it does and a hint of the two shapes there are', () => {
  expect(new Set(COMMANDS.map((c) => c.name)).size).toBe(COMMANDS.length);
  for (const c of COMMANDS) {
    expect(c.name).toMatch(/^\/[a-z]+$/);
    expect(c.hint).toMatch(/^(|<[a-z]+>|\[[a-z]+\])$/);
    expect(c.about).toMatch(/^[a-z][^\n]{2,80}[^.\s]$/);
  }
  // No name begins another: a name typed out in full is one command, whatever else is listed.
  for (const a of COMMANDS) for (const b of COMMANDS) if (a !== b) expect(b.name.startsWith(a.name)).toBe(false);
});

test('whether something follows a command is read from its hint: it has to, it may, or nothing does', () => {
  const by = (name: string) => takes(commandNamed(name)!);
  expect([by('/image'), by('/approve'), by('/accept'), by('/help'), by('/quit')]).toEqual(['required', 'required', 'optional', 'none', 'none']);
  expect(usage(commandNamed('/image')!)).toBe('/image <path>');
  expect(usage(commandNamed('/accept')!)).toBe('/accept [commit]');
  expect(usage(commandNamed('/stop')!)).toBe('/stop');
  expect(commandNamed('/nonsense')).toBeNull();
  expect(commandNamed('help')).toBeNull();
});

test('/help prints the table: every command for the screen client, with the key that does the same; for the plain client the ones it has, and no keys', () => {
  const screen = helpRows('screen');
  expect(screen).toHaveLength(COMMANDS.length);
  expect(screen).toContain('  /image <path>      attach an image file from your machine');
  expect(screen).toContain('  /stop              interrupt what the agent is doing now (also Esc)');
  expect(screen).toContain('  /tools             show or hide what each tool call returned (also Tab)');
  // What each does starts in the same column.
  expect(new Set(screen.map((row) => /^ {2}\S+(?: [<[]\S+)? +/.exec(row)![0].length)).size).toBe(1);
  expect(helpRows('plain')).toEqual([
    '  /help              the keys and commands',
    '  /stop              interrupt what the agent is doing now',
    '  /accept [commit]   accept the species commit the agent asked about, or the one named',
    '  /offers            what waits for your approval before it goes out to the species',
    '  /approve <commit>  let exactly that commit go out',
    '  /quit              leave',
  ]);
});

test('the commands the kernel answers for both clients are in the table under the names it answers to', () => {
  const root = mkdtempSync(join(tmpdir(), 'teneral-commands-'));
  for (const c of COMMANDS) {
    const answered = ownerCommand(root, c.name) !== null;
    expect(answered).toBe(c.name === '/offers' || c.name === '/approve');
  }
});

test('the command a mistyped name most likely meant: the one it begins, else the one a letter or two away; none for a name that is near nothing', () => {
  const near = (name: string) => closest(name)?.name ?? null;
  expect(near('/he')).toBe('/help');
  expect(near('/hlep')).toBe('/help');
  expect(near('/hepl')).toBe('/help');
  expect(near('/halp')).toBe('/help');
  expect(near('/quite')).toBe('/quit');
  expect(near('/exit')).toBe('/quit');
  expect(near('/images')).toBe('/image');
  expect(near('/aprove')).toBe('/approve');
  expect(near('/generation')).toBe('/generations');
  expect(near('/nonsense')).toBeNull();
  expect(near('/home')).toBeNull();
  expect(near('/usr')).toBeNull();
  expect(near('/')).toBeNull();
});
