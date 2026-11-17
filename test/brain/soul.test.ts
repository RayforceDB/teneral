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

test('fresh setups receive reusable follow-through guidance without personal notes', async () => {
  const prompt = await Bun.file(new URL('../../brain/prompt.md', import.meta.url)).text();
  const system = composeSystem(prompt, soulDir(), '/tmp/fresh-journal');
  expect(system).toContain('Before promising future work, record it with work');
  expect(system).toContain('Start that action before yielding');
  expect(system).toContain("milestone, not necessarily the owner's outcome");
  expect(system).toContain('Do not infer authorization from your own generated promises');
  expect(system).toContain('Do not invent tasks to stay busy');
  expect(system).toContain('It is empty');
  expect(system).not.toContain('Mica');
  expect(system).toContain('I am a teneral');
  expect(system).toContain('it is not inherited from another individual');
});

test('fresh discovery guidance is bounded and does not confer owner permission', async () => {
 const prompt=await Bun.file(new URL('../../brain/prompt.md',import.meta.url)).text();
 const system=composeSystem(prompt,soulDir(),'/tmp/discovery-journal');
 for(const phrase of ['Advance queued commitments before discovering new work', 'not itself standing permission', 'at most three candidates', 'at most one bounded outcome', 'work.evidence', 'small exploration budget', 'do not retry blocked tasks without new evidence', 'do not create recursive tasks']) expect(system).toContain(phrase);
});

test('a fresh seed gets no personal identity, while its own soul may choose one', async () => {
  const prompt = await Bun.file(new URL('../../brain/prompt.md', import.meta.url)).text();
  expect(prompt).not.toMatch(/\bMica\b/);
  expect(composeSystem(prompt, soulDir(), '/tmp/fresh')).not.toContain('Mica');
  expect(composeSystem(prompt, soulDir({ 'SOUL.md': '# Wren\nI am Wren.' }), '/tmp/named')).toContain('I am Wren.');
});

test('birth is a short dialogue, not autonomous repository work', async () => {
  const prompt = await Bun.file(new URL('../../brain/prompt.md', import.meta.url)).text();
  expect(prompt).toContain('Birth is a conversation, not an autonomous work session');
  expect(prompt).toContain('ask what my owner may call me');
  expect(prompt).toContain('stop for their answer');
  expect(prompt).toContain('No clock tick, sensor notification or general initiative rule overrides');
});
