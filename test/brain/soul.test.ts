import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOUL_CAP, birth, composeSystem, loadSoul } from '../../brain/soul';
import type { EventBody, JournalEvent } from '../../brain/journal';

function soulDir(files: Record<string, string> = {}): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'teneral-soul-')), 'soul');
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const ev = (body: EventBody) => ({ v: 1, id: 'e', ts: 't', gen: 'g', ...body }) as JournalEvent;

test('a soul directory that does not exist yet is an empty soul', () => {
  expect(loadSoul(join(tmpdir(), 'teneral-no-such-soul'))).toBe('');
});

test('soul files are joined in name order, each under its file name; other files are ignored', () => {
  const dir = soulDir({ 'SOUL.md': 'I am Wren.\n', 'OWNER.md': 'Anton. Prefers Russian.', 'notes.txt': 'ignored' });
  expect(loadSoul(dir)).toBe('### OWNER.md\n\nAnton. Prefers Russian.\n\n### SOUL.md\n\nI am Wren.');
});

test('before birth the system prompt says the soul is empty and where it goes', () => {
  const dir = soulDir();
  const system = composeSystem('PROMPT\n', dir, '/data/memory/journal.jsonl');
  expect(system.startsWith('PROMPT\n\n## Who you are')).toBe(true);
  expect(system).toContain(dir);
  expect(system).toContain('Your journal is the file /data/memory/journal.jsonl.');
  expect(system).toContain('not been born yet');
});

test('after birth the system prompt carries the soul', () => {
  const system = composeSystem('PROMPT', soulDir({ 'SOUL.md': 'I am Wren.' }), '/j.jsonl');
  expect(system).toContain('Your journal is the file /j.jsonl.');
  expect(system).toContain('### SOUL.md\n\nI am Wren.');
  expect(system).not.toContain('not been born yet');
});

test('an oversized soul is cut with a note, so it cannot crowd out the conversation', () => {
  const system = composeSystem('P', soulDir({ 'SOUL.md': 'x'.repeat(SOUL_CAP + 500) }), '/j.jsonl');
  expect(system.length).toBeLessThan(SOUL_CAP + 1000);
  expect(system).toContain('soul is longer than');
});

test('the birth letter is the first stimulus and is never sent twice', () => {
  const started = [ev({ type: 'generation.started', commit: 'a' }), ev({ type: 'generation.ready', commit: 'a' })];
  expect(birth([], ' LETTER \n')).toEqual({ source: 'birth', text: 'LETTER' });
  expect(birth(started, 'LETTER')).toEqual({ source: 'birth', text: 'LETTER' });
  expect(birth([...started, ev({ type: 'stimulus', source: 'birth', text: 'LETTER' })], 'LETTER')).toBeNull();
  expect(birth([ev({ type: 'stimulus', source: 'terminal', text: 'hi' })], 'LETTER')).toBeNull();
});

test('a soul entry that cannot be read is named, not fatal: the agent must stay able to fix it', () => {
  const dir = soulDir({ 'SOUL.md': 'I am Wren.' });
  mkdirSync(join(dir, 'broken.md'));
  const soul = loadSoul(dir);
  expect(soul).toContain('### SOUL.md\n\nI am Wren.');
  expect(soul).toMatch(/### broken\.md\n\n\[could not be read: .+\]/);
});
