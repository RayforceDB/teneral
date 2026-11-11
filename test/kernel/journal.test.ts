import { expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { appendEvent, readEvents, SCHEMA_VERSION } from '../../kernel/journal';

function tmpJournal(): string {
  return join(mkdtempSync(join(tmpdir(), 'teneral-journal-')), 'data', 'journal.jsonl');
}

test('a missing journal reads as empty', () => {
  expect(readEvents(tmpJournal())).toEqual([]);
});

test('events come back in order with their envelope', () => {
  const path = tmpJournal();
  const first = appendEvent(path, 'gen-a', { type: 'stimulus', source: 'terminal', text: 'hello' });
  appendEvent(path, 'gen-b', { type: 'assistant', text: 'hi', toolCalls: [] });

  const events = readEvents(path);
  expect(events.map((e) => e.type)).toEqual(['stimulus', 'assistant']);
  expect(events.map((e) => e.gen)).toEqual(['gen-a', 'gen-b']);
  expect(events[0]).toEqual(first);
  expect(first.v).toBe(SCHEMA_VERSION);
  expect(first.id).not.toBe(events[1]!.id);
  expect(Number.isNaN(Date.parse(first.ts))).toBe(false);
});

test('a torn line is skipped and later appends stay readable', () => {
  const path = tmpJournal();
  appendEvent(path, 'g', { type: 'stimulus', source: 'terminal', text: 'a' });
  appendFileSync(path, '{"v":1,"type":"stim');
  appendEvent(path, 'g', { type: 'stimulus', source: 'terminal', text: 'b' });

  const texts = readEvents(path).map((e) => (e.type === 'stimulus' ? e.text : '?'));
  expect(texts).toEqual(['a', 'b']);
});

test('the envelope wins over same-named keys in the body', () => {
  const path = tmpJournal();
  const body = { type: 'stimulus', source: 'terminal', text: 'a', id: 'forged', gen: 'forged', v: 99, ts: 'forged' };
  const event = appendEvent(path, 'gen-real', body as unknown as Parameters<typeof appendEvent>[2]);

  expect(event.id).not.toBe('forged');
  expect(event.gen).toBe('gen-real');
  expect(event.v).toBe(SCHEMA_VERSION);
  expect(Number.isNaN(Date.parse(event.ts))).toBe(false);
  expect(readEvents(path)).toEqual([event]);
});

test('lines that are valid JSON but not events are skipped', () => {
  const path = tmpJournal();
  const first = appendEvent(path, 'g', { type: 'stimulus', source: 'terminal', text: 'a' });
  appendFileSync(path, ['null', '123', '"str"', '[1]', '{"a":1}'].map((line) => `${line}\n`).join(''));
  const second = appendEvent(path, 'g', { type: 'stimulus', source: 'terminal', text: 'b' });

  const events = readEvents(path);
  expect(events).toEqual([first, second]);
  expect(() => events.map((e) => e.type)).not.toThrow();
  expect(events.map((e) => e.type)).toEqual(['stimulus', 'stimulus']);
});

test('a journal holding only a torn line reads as empty', () => {
  const path = tmpJournal();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{"v":1,"type":"stim');

  expect(readEvents(path)).toEqual([]);
});

test('a torn tail with no later append reads as just the earlier events', () => {
  const path = tmpJournal();
  const first = appendEvent(path, 'g', { type: 'stimulus', source: 'terminal', text: 'a' });
  const second = appendEvent(path, 'g', { type: 'stimulus', source: 'terminal', text: 'b' });
  appendFileSync(path, '{"v":1,"type":"stim');

  expect(readEvents(path)).toEqual([first, second]);
});
