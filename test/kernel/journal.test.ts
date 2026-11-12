import { expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  appendEvent, journalSize, readEvents, readEventsFrom, SCHEMA_VERSION,
} from '../../kernel/journal';

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

test('a missing journal has size 0 and nothing to read from any offset', () => {
  const path = tmpJournal();
  expect(journalSize(path)).toBe(0);
  expect(readEventsFrom(path, 0)).toEqual([]);
  expect(readEventsFrom(path, 100)).toEqual([]);
});

test('reading from an offset returns only what was appended after it', () => {
  const path = tmpJournal();
  appendEvent(path, 'gen-a', { type: 'stimulus', source: 'terminal', text: 'héllo' });
  const mark = journalSize(path);
  expect(readEventsFrom(path, mark)).toEqual([]);
  const second = appendEvent(path, 'gen-a', { type: 'assistant', text: 'hi', toolCalls: [] });
  const third = appendEvent(path, 'gen-a', { type: 'stimulus', source: 'clock', text: 'tick' });

  expect(readEventsFrom(path, mark)).toEqual([second, third]);
  expect(readEventsFrom(path, 0)).toEqual(readEvents(path));
  expect(readEventsFrom(path, journalSize(path))).toEqual([]);
  expect(readEventsFrom(path, journalSize(path) + 10)).toEqual([]);
});

test('an offset in the middle of a line skips the rest of that line', () => {
  const path = tmpJournal();
  // The nested object means a cut inside the first line can leave a tail that is itself event-shaped JSON.
  const inner = { type: 'stimulus', id: 'forged', gen: 'g', ts: 't', v: 1 };
  appendEvent(path, 'gen-a', { type: 'tool.intent', callId: 'c', name: 'n', args: [inner] });
  const second = appendEvent(path, 'gen-a', { type: 'stimulus', source: 'clock', text: 'tick' });
  const firstLineLength = journalSize(path) - Buffer.byteLength(`${JSON.stringify(second)}\n`);

  for (let offset = 1; offset < firstLineLength; offset++) {
    expect(readEventsFrom(path, offset)).toEqual([second]);
  }
  expect(readEventsFrom(path, firstLineLength)).toEqual([second]);
});

test('an offset at the end of a torn line reads the events appended after it', () => {
  const path = tmpJournal();
  appendEvent(path, 'gen-a', { type: 'stimulus', source: 'terminal', text: 'one' });
  appendFileSync(path, '{"type":"stimulus","te');
  const mark = journalSize(path);
  const next = appendEvent(path, 'gen-a', { type: 'stimulus', source: 'terminal', text: 'two' });
  expect(readEventsFrom(path, mark)).toEqual([next]);
});

test('a reply may carry its usage and a summary of the reasoning; one without them reads as it always did', () => {
  const path = tmpJournal();
  const old = appendEvent(path, 'gen-a', { type: 'assistant', text: 'before', toolCalls: [] });
  const full = appendEvent(path, 'gen-b', {
    type: 'assistant', text: 'after', toolCalls: [], usage: { input: 1200, output: 80, cached: 1000 }, reasoning: 'Thought about it.',
  });
  const partial = appendEvent(path, 'gen-b', { type: 'assistant', text: 'no cache', toolCalls: [], usage: { input: 5, output: 1 } });
  // A line as a generation from before the fields wrote it, byte for byte.
  appendFileSync(path, '{"type":"assistant","text":"older still","toolCalls":[],"v":1,"id":"x","ts":"2026-01-01T00:00:00.000Z","gen":"gen-0"}\n');

  const events = readEvents(path);
  expect(events).toHaveLength(4);
  expect(events[0]).toEqual(old);
  expect('usage' in events[0]! || 'reasoning' in events[0]!).toBe(false);
  expect(events[1]).toEqual(full);
  expect(events[1]).toMatchObject({ usage: { input: 1200, output: 80, cached: 1000 }, reasoning: 'Thought about it.' });
  expect(events[2]).toEqual(partial);
  expect(events[3]).toMatchObject({ type: 'assistant', text: 'older still' });
  // The fields are an addition to version 1, not a new version.
  expect(SCHEMA_VERSION).toBe(1);
  expect(events.every((e) => e.v === 1)).toBe(true);
  expect(readEventsFrom(path, 0)).toEqual(events);
});

test('a turn the owner interrupted is an event of its own; a journal without one, or with a kind not known here, reads as before', () => {
  const path = tmpJournal();
  const said = appendEvent(path, 'gen-a', { type: 'stimulus', source: 'terminal', text: 'go' });
  const stopped = appendEvent(path, 'gen-a', { type: 'turn.interrupted' });
  // A line a later version might write: kept as it is, for the readers that know it.
  appendFileSync(path, '{"type":"something.later","v":1,"id":"y","ts":"2027-01-01T00:00:00.000Z","gen":"gen-z"}\n');
  const events = readEvents(path);
  expect(events.slice(0, 2)).toEqual([said, stopped]);
  expect(Object.keys(stopped).sort()).toEqual(['gen', 'id', 'ts', 'type', 'v']);
  expect(events.map((e) => e.type as string)).toEqual(['stimulus', 'turn.interrupted', 'something.later']);
  expect(SCHEMA_VERSION).toBe(1);
});
