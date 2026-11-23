import { expect, test } from 'bun:test';
import { GAP_MS, episodes } from '../../brain/episodes';
import type { EventBody, JournalEvent } from '../../brain/journal';
import { swapped } from '../../brain/logbook';
import { assemble, buildMessages, frameOf, narrow, type Sight } from '../../brain/memory';
import { EPISODE_KIND } from '../../brain/remembered';
import { SHOWN_KIND } from '../../brain/shown';

let n = 0;
let clock = Date.parse('2026-11-11T00:00:00.000Z');
function ev(body: EventBody, afterMs = 1000): JournalEvent {
  clock += afterMs;
  return { v: 1, id: `fr${(++n).toString(36).padStart(5, '0')}`, ts: new Date(clock).toISOString(), gen: 'g1', ...body } as JournalEvent;
}
const LONG = GAP_MS + 1000;
const image = (k: number): string => `[image: memory/images/${String(k % 10).repeat(64)}.png]`;

/**
 * A life of `count` stretches with everything a request has to place: outputs long and short, calls whose ids repeat or
 * are no ids at all, images from the owner and from `look`, something that arrived while a reply was written, two replies
 * in a row, and a memory of every stretch but the last few.
 */
function life(count: number, remembered: number): JournalEvent[] {
  n = 0;
  clock = Date.parse('2026-11-11T00:00:00.000Z');
  const events: JournalEvent[] = [];
  for (let i = 0; i < count; i++) {
    const source = i % 7 === 3 ? 'clock' : i % 5 === 2 ? 'owner:zulip' : 'terminal';
    events.push(ev({ type: 'stimulus', source, text: `matter ${i} ${'m'.repeat(40 + (i % 9) * 30)}${i % 6 === 1 ? `\n${image(i)}` : ''}` }, LONG));
    const calls = i % 4 === 0 ? [] : Array.from({ length: 1 + (i % 2) }, (_, k) => ({
      // Ids that repeat from reply to reply, one that no provider would take, and ordinary ones.
      id: i % 3 === 0 ? `call_${k}` : i % 11 === 5 ? '' : `c${i}x${k}`, name: i % 8 === 6 && k === 0 ? 'look' : 'bash', args: { command: `step ${i}.${k}` },
    }));
    const shown = ev({ type: 'note', kind: SHOWN_KIND, data: { through: events.at(-1)!.id } });
    events.push(shown);
    // Something that arrives after the request was sent and before its reply is journaled.
    if (i % 9 === 4) events.push(ev({ type: 'stimulus', source: 'terminal', text: `and one thing more about ${i}` }));
    events.push(ev({ type: 'assistant', text: i % 10 === 7 ? '' : `working on ${i}`, toolCalls: calls }));
    for (const call of calls) {
      events.push(ev({ type: 'tool.intent', callId: call.id, name: call.name, args: call.args }));
      const output = call.name === 'look' ? `seen ${i}\n${image(i + 3)}\n${image(i + 4)}` : `${'o'.repeat(i % 5 === 3 ? 6000 : 300)} done ${i}`;
      events.push(ev({ type: 'tool.result', callId: call.id, ok: i % 13 !== 12, output }));
    }
    if (calls.length > 0) events.push(ev({ type: 'assistant', text: `settled matter ${i}`, toolCalls: [] }));
    // Two finished replies in a row.
    if (i % 6 === 5) events.push(ev({ type: 'assistant', text: `and a word after ${i}`, toolCalls: [] }));
  }
  // A memory of each of the first stretches, written afterwards, as memories are.
  const cut = episodes(events).filter((e) => e.closed).slice(0, remembered);
  for (const e of cut) {
    events.push(ev({ type: 'note', kind: EPISODE_KIND, data: { from: e.first, to: e.last, start: e.start, end: e.end, title: `Stretch at ${e.start}`, text: `I settled what began at ${e.first}.`, outcome: 'done' } }));
  }
  events.push(ev({ type: 'stimulus', source: 'terminal', text: 'and now?' }, LONG));
  return events;
}

const sight: Sight = { load: (path) => `not here: ${path}`, max: 4 };

test('the request made from the last part of a journal, with what lies before it counted, is the request made from the whole', () => {
  let narrowed = 0;
  for (const [count, remembered] of [[60, 50], [60, 12], [25, 20], [8, 3]] as const) {
    const events = life(count, remembered);
    const whole = frameOf(events);
    expect(whole.head.kept.length).toBe(remembered);
    for (const budget of [12_000, 30_000, 80_000, 400_000]) {
      for (const view of [{}, { tailChars: 2_000 }, { tailChars: 9_000, logbookChars: 1_500 }, { tailChars: 0 }, { tailChars: 9_000, resultsChars: 1_000 }, { tailChars: 4_000, ask: 'What do you make of it?' }]) {
        for (const see of [undefined, sight]) {
          const frame = narrow(whole, budget - 1, view, see !== undefined);
          if (frame.first > 0) narrowed += 1;
          expect(assemble(frame, 'S', budget, see, view)).toEqual(buildMessages(events, 'S', budget, see, view));
        }
      }
    }
  }
  // It was not the whole journal that was compared with itself.
  expect(narrowed).toBeGreaterThan(60);
});

test('what lies before the part at hand is counted as the assembly counts it', () => {
  const events = life(60, 50);
  const whole = frameOf(events);
  const frame = narrow(whole, 30_000, { tailChars: 4_000 }, true);
  const first = frame.first;
  expect(first).toBeGreaterThan(0);
  // It begins where a remembered stretch begins, a few stretches before the first that may be shown as it happened.
  const at = swapped(whole.head, 30_000, { tailChars: 4_000 });
  expect(whole.head.kept.map((e) => e.from)).toContain(first);
  expect(first).toBeLessThan(whole.head.kept[at - 1]!.to);
  const before = events.slice(0, first);
  expect(frame.before.calls).toBe(before.reduce((sum, e) => sum + (e.type === 'assistant' ? e.toolCalls.length : 0), 0));
  expect(frame.before.slots).toBeGreaterThan(0);
  // An id that went out before cannot go out again; one that never did, can.
  expect(frame.usedBefore('call_0')).toBe(true);
  expect(frame.usedBefore('never-used')).toBe(false);
  // Without images nothing holds a place for one.
  expect(narrow(whole, 30_000, { tailChars: 4_000 }, false).before.slots).toBe(0);
});

test('a journal with a pinned stretch, or with nothing to swap, is not narrowed', () => {
  const events = life(25, 20);
  const pinned = [...events, ev({ type: 'note', kind: 'memory.pin.v1', data: { event: events[0]!.id } })];
  expect(narrow(frameOf(pinned), 12_000, { tailChars: 2_000 }).first).toBe(0);
  expect(narrow(frameOf(events), 10_000_000, {}).first).toBe(0);
  expect(narrow(frameOf(life(8, 0)), 12_000, { tailChars: 2_000 }).first).toBe(0);
});
