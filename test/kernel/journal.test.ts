import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
