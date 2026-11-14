import { expect, test } from 'bun:test';
import { EPISODE_CHARS, EPISODE_HARD_CHARS, GAP_MS, episodes, eventChars, thin } from '../../brain/episodes';
import type { EventBody, JournalEvent } from '../../brain/journal';

let n = 0;
let clock = Date.parse('2026-11-11T00:00:00.000Z');
/** An event `afterMs` later than the one before it. */
function ev(body: EventBody, afterMs = 1000): JournalEvent {
  n += 1;
  clock += afterMs;
  return { v: 1, id: `e${n}`, ts: new Date(clock).toISOString(), gen: 'g1', ...body } as JournalEvent;
}
const LONG = GAP_MS + 1000;
const said = (text: string, afterMs?: number, source = 'terminal') => ev({ type: 'stimulus', source, text }, afterMs);
const replied = (text: string) => ev({ type: 'assistant', text, toolCalls: [] });
const called = (id: string) => ev({ type: 'assistant', text: '', toolCalls: [{ id, name: 'bash', args: {} }] });
const result = (id: string, output = 'ok', afterMs?: number) => ev({ type: 'tool.result', callId: id, ok: true, output }, afterMs);
const spans = (events: JournalEvent[], kept = [] as { from: string; to: string }[]) =>
  episodes(events, kept).map((e) => [e.first, e.last, e.why, e.closed]);

test('an empty journal has no episodes', () => {
  expect(episodes([])).toEqual([]);
});

test('one conversation without a long silence is one episode, still open', () => {
  const events = [said('hi'), replied('hello'), said('more'), replied('sure')];
  expect(spans(events)).toEqual([[events[0]!.id, events[3]!.id, 'start', false]]);
});

test('silence longer than the gap, before something new, ends the episode', () => {
  const a = [said('hi'), replied('hello')];
  const b = [said('later', LONG), replied('yes')];
  expect(spans([...a, ...b])).toEqual([
    [a[0]!.id, a[1]!.id, 'start', true],
    [b[0]!.id, b[1]!.id, 'gap', false],
  ]);
});

test('every event is in exactly one episode, in order', () => {
  const events = [said('a'), replied('b'), said('c', LONG), replied('d'), said('e', LONG), replied('f')];
  const cut = episodes(events);
  expect(cut.map((e) => [e.from, e.to])).toEqual([[0, 2], [2, 4], [4, 6]]);
  expect(cut.map((e) => e.id)).toEqual([events[0]!.id, events[2]!.id, events[4]!.id]);
});

test('a tool that ran for longer than the gap does not split its call from its result', () => {
  const events = [said('go'), called('c1'), result('c1', 'done', LONG), replied('finished')];
  expect(episodes(events)).toHaveLength(1);
});

test('something that arrives while a turn is owed never starts an episode, however late', () => {
  // The call has no result yet: the turn is in progress, and the late stimulus belongs to it.
  const events = [said('go'), called('c1'), said('are you there?', LONG), result('c1'), replied('yes')];
  expect(episodes(events)).toHaveLength(1);
});

test('an unanswered stimulus keeps the episode open across a silence', () => {
  const events = [said('hi'), said('hello?', LONG), replied('here')];
  expect(episodes(events)).toHaveLength(1);
});

test('a turn the owner interrupted is over: a later stimulus may start an episode', () => {
  const events = [said('go'), called('c1'), ev({ type: 'turn.interrupted' }), said('new thing', LONG), replied('ok')];
  expect(spans(events).map((s) => s[2])).toEqual(['start', 'gap']);
});

test('a new generation starts an episode, with no silence needed', () => {
  const before = [said('mutate'), replied('asked')];
  const promoted = ev({ type: 'generation.promoted', commit: 'c2', previous: 'c1' });
  const after = [replied('I am the new one')];
  expect(spans([...before, promoted, ...after])).toEqual([
    [before[0]!.id, before[1]!.id, 'start', true],
    [promoted.id, after[0]!.id, 'generation', false],
  ]);
});

test('an episode that has grown past the limit ends at the next quiet moment', () => {
  const big = 'x'.repeat(EPISODE_CHARS);
  const events = [said('one'), replied(big), said('two'), replied('short'), said('three'), replied('short')];
  expect(spans(events)).toEqual([
    [events[0]!.id, events[1]!.id, 'start', true],
    [events[2]!.id, events[5]!.id, 'size', false],
  ]);
});

test('a turn that never goes quiet is cut between two of its rounds once it is twice too large', () => {
  const big = 'x'.repeat(EPISODE_HARD_CHARS);
  const events = [said('go'), called('c1'), result('c1', big), called('c2'), result('c2'), replied('done')];
  expect(spans(events)).toEqual([
    [events[0]!.id, events[2]!.id, 'start', true],
    [events[3]!.id, events[5]!.id, 'size', false],
  ]);
});

test('such a cut never falls between a call and its result', () => {
  const big = 'x'.repeat(EPISODE_HARD_CHARS);
  // The stimulus arrives while c2 is still running: no boundary before it, although the episode is far too large.
  const events = [said('go'), called('c1'), result('c1', big), called('c2'), said('hurry', 1000, 'clock'), result('c2'), replied('done')];
  expect(spans(events).map((s) => s[0])).toEqual([events[0]!.id, events[3]!.id]);
});

test('events nobody is shown do not start an episode and count nothing', () => {
  const note = ev({ type: 'note', kind: 'x.v1', data: { a: 'y'.repeat(1000) } }, LONG);
  const events = [said('hi'), replied('hello'), note, ev({ type: 'generation.ready', commit: 'c' }, LONG)];
  expect(episodes(events)).toHaveLength(1);
  expect(eventChars(note)).toBe(0);
});

test('a span that was remembered stays one episode, and the rules cut only what follows it', () => {
  // By the rules this would be three episodes; the first two were remembered as one.
  const events = [said('a'), replied('b'), said('c', LONG), replied('d'), said('e', LONG), replied('f')];
  expect(spans(events, [{ from: events[0]!.id, to: events[3]!.id }])).toEqual([
    [events[0]!.id, events[3]!.id, 'kept', true],
    [events[4]!.id, events[5]!.id, 'start', false],
  ]);
});

test('a remembered span that reaches the end of the journal is closed, and nothing is open', () => {
  const events = [said('a'), replied('b')];
  expect(spans(events, [{ from: events[0]!.id, to: events[1]!.id }])).toEqual([[events[0]!.id, events[1]!.id, 'kept', true]]);
});

test('a span that names unknown events, or does not follow the one before, is passed over', () => {
  const events = [said('a'), replied('b'), said('c', LONG), replied('d')];
  const kept = [{ from: 'nowhere', to: events[1]!.id }, { from: events[2]!.id, to: events[3]!.id }];
  expect(spans(events, kept).map((s) => s[2])).toEqual(['start', 'gap']);
});

test('the same journal, grown, keeps the episodes it had', () => {
  const events = [said('a'), replied('b'), said('c', LONG), replied('d')];
  const before = episodes(events);
  const after = episodes([...events, said('e', LONG), replied('f')]);
  expect(after.slice(0, 1)).toEqual(before.slice(0, 1));
  expect(after[1]).toEqual({ ...before[1]!, closed: true });
});

test('an episode knows its times and its size', () => {
  const events = [said('12345'), replied('678')];
  const [only] = episodes(events);
  expect(only).toMatchObject({ start: events[0]!.ts, end: events[1]!.ts, chars: 8 });
});

test('a clock tick answered in a line is thin; a word from the owner or a tool is not', () => {
  expect(thin([said('tick', 0, 'clock'), replied('Nothing to do.')])).toBe(true);
  expect(thin([said('hi'), replied('Nothing to do.')])).toBe(false);
  expect(thin([said('tick', 0, 'clock'), called('c1'), result('c1')])).toBe(false);
  expect(thin([said('tick', 0, 'clock'), replied('z'.repeat(500))])).toBe(false);
});

test('a time that cannot be read never cuts an episode', () => {
  const events = [said('a'), replied('b'), { ...said('c'), ts: 'not a time' }, replied('d')];
  expect(episodes(events)).toHaveLength(1);
});
