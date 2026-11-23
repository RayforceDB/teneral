import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptanceNotes } from '../../body/acceptance';
import { acceptedSince, frameProjection, namesBefore } from '../../brain/frame-table';
import { episodesFrom, memoryProjection } from '../../brain/memory-table';
import { standing } from '../../brain/owned';
import { remembered } from '../../brain/remembered';
import { frameFrom } from '../../brain/frame';
import { idleStart, idleStep, idleOf } from '../../brain/idle';
import { journalPast, projections, storePast } from '../../brain/past';
import { openStore } from '../../brain/store';
import { library, ray } from './rayforce';
import { GAP_MS, episodes } from '../../brain/episodes';
import type { EventBody, JournalEvent } from '../../brain/journal';
import { swapped } from '../../brain/logbook';
import { assemble, buildMessages, counted, frameOf, narrow, wireNames, type Sight } from '../../brain/memory';
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

const real = test.skipIf(library === null);
const line = (e: JournalEvent): string => `${JSON.stringify(e)}\n`;
const COMMIT = 'c'.repeat(40);

/** The life above with a stretch taken back in it and an acceptance of a species commit after a refusal. */
function fuller(): JournalEvent[] {
  const events = life(40, 30);
  const calls = events.reduce((sum, e) => sum + (e.type === 'assistant' ? e.toolCalls.length : 0), 0);
  const forget = ev({ type: 'stimulus', source: 'terminal', text: 'forget the last of it' }, LONG);
  clock -= LONG;
  return [
    ...events,
    // An id that is the name the next call's place would give it, and then a call that needs that name.
    ev({ type: 'assistant', text: 'Two more.', toolCalls: [{ id: `call_${calls + 2}`, name: 'bash', args: {} }, { id: 'call_0', name: 'bash', args: {} }] }),
    ev({ type: 'assistant', text: 'I will try that.', toolCalls: [{ id: 'call_3', name: 'look', args: {} }] }),
    ev({ type: 'tool.intent', callId: 'call_3', name: 'look', args: {} }),
    ev({ type: 'tool.result', callId: 'call_3', ok: true, output: `there\n${image(1)}` }),
    ev({ type: 'mutation.rejected', gate: 'species', commit: 'd'.repeat(40), output: `Your owner has not accepted that commit: it moves the species to ${COMMIT}, and with that its kernel.` } as unknown as EventBody),
    ev({ type: 'species.accepted', commit: COMMIT } as unknown as EventBody),
    { ...forget, ts: new Date(clock += LONG).toISOString() },
    ev({ type: 'assistant', text: 'As you say.', toolCalls: [{ id: 'gone1', name: 'bash', args: {} }] }),
    ev({ type: 'note', kind: 'memory.back.v1', data: { to: forget.id } }),
    ev({ type: 'stimulus', source: 'terminal', text: `and this ${image(2)}` }, LONG),
    ev({ type: 'assistant', text: 'Seen.', toolCalls: [{ id: 'call_1', name: 'bash', args: {} }] }),
  ];
}

/** What the whole journal gives, for the events up to `upTo`. */
function reference(all: JournalEvent[], upTo: number) {
  const stands = standing(all.slice(0, upTo));
  const names: string[] = [];
  const name = wireNames();
  for (const e of stands) if (e.type === 'assistant') for (const call of e.toolCalls as { id?: unknown }[]) names.push(name(call.id));
  return { stands, names, episodes: counted(stands, episodes(stands, remembered(stands).spans)), accepted: acceptanceNotes(stands) };
}

test('fed event by event, the tables hold what a request counts of every episode, the names of the calls and the acceptance notes', () => {
  const all = fuller();
  for (const upTo of [30, 111, 240, all.length - 9, all.length - 8, all.length - 7, all.length - 5, all.length - 2, all.length]) {
    const want = reference(all, upTo);
    const stands = new Set(want.stands);
    const [memory, frame] = [memoryProjection(), frameProjection()];
    all.slice(0, upTo).forEach((e, seq) => { if (stands.has(e)) { memory.step(e, seq); frame.step(e, seq); } });
    const episodesTable = memory.tables().episodes!;
    for (const column of ['chars', 'shown', 'calls', 'slots'] as const) {
      expect([...(episodesTable[column]!.data as BigInt64Array)].map(Number)).toEqual(want.episodes.map((e) => e[column]));
    }
    expect(frame.tables().names!.name!.data).toEqual(want.names);
    expect(frame.tables().accepted!.id!.data).toEqual([...want.accepted.keys()]);
    expect(frame.tables().accepted!.note!.data).toEqual([...want.accepted.values()]);
  }
  const whole = reference(all, all.length);
  // The life has what is being counted: images in both kinds of place, names that had to be made, and an acceptance.
  expect(whole.episodes.reduce((sum, e) => sum + e.slots, 0)).toBeGreaterThan(10);
  expect(whole.names.some((name) => /^call_\d+_\d+$/.test(name))).toBe(true);
  expect(whole.accepted.size).toBe(1);
  expect(whole.names).not.toContain('gone1');
});

real('the database holds them, through a restart in the middle of a reply and a conversation taken back', () => {
  const all = fuller();
  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-frame-')), 'journal.jsonl');
  const same = (upTo: number): void => {
    const want = reference(all, upTo);
    expect(episodesFrom(ray()).map(({ chars, shown, calls, slots }) => ({ chars, shown, calls, slots }))).toEqual(want.episodes.map(({ chars, shown, calls, slots }) => ({ chars, shown, calls, slots })));
    for (const calls of [0, 1, 7, Math.floor(want.names.length / 2), want.names.length]) {
      const before = new Set(want.names.slice(0, calls));
      const asked = ['call_0', 'call_1', 'call_3', 'c5x0', 'c7x1', 'never', '', 'with "quotes" in it'];
      const got = namesBefore(ray(), calls, asked);
      for (const id of asked) expect(got.has(id)).toBe(before.has(id));
      // And every journaled id that looks like a made name, asked about or not.
      for (const name of before) if (/^call_\d+(_\d+)?$/.test(name) && got.has(name) === false) expect(want.names.indexOf(name)).toBeGreaterThan(-1);
    }
    expect([...acceptedSince(ray(), 0)]).toEqual([...want.accepted]);
    expect(acceptedSince(ray(), upTo).size).toBe(0);
  };
  // It stops in the middle of a reply's results, and again between a refusal and its acceptance.
  const stops = [200, all.length - 9, all.length - 6, all.length - 3, all.length];
  writeFileSync(journal, all.slice(0, stops[0]!).map(line).join(''));
  let store = openStore(ray(), journal, undefined, [memoryProjection(), frameProjection()]);
  same(stops[0]!);
  for (let i = 1; i < stops.length; i++) {
    store.persist();
    appendFileSync(journal, all.slice(stops[i - 1]!, stops[i]!).map(line).join(''));
    store = openStore(ray(), journal, undefined, [memoryProjection(), frameProjection()]);
    store.settle();
    same(stops[i]!);
  }
}, 60_000);

real('the request assembled from what the database holds is the request assembled from the journal', () => {
  const all = fuller();
  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-frame-')), 'journal.jsonl');
  let narrowed = 0;
  const same = (events: JournalEvent[]): void => {
    const past = storePast(journal, ray(), openStore(ray(), journal, undefined, projections()), false);
    const read = journalPast(journal);
    for (const budget of [12_000, 30_000, 400_000]) {
      for (const view of [{}, { tailChars: 2_000 }, { tailChars: 9_000, logbookChars: 1_500 }, { tailChars: 0 }, { tailChars: 4_000, ask: 'What do you make of it?' }]) {
        for (const see of [undefined, sight]) {
          const frame = frameFrom(past, budget - 1, view, see !== undefined);
          if (frame.first > 0) narrowed += 1;
          const want = buildMessages(events, 'S', budget, see, view);
          expect(assemble(frame, 'S', budget, see, view)).toEqual(want);
          // And with no database at hand.
          expect(assemble(frameFrom(read, budget - 1, view, see !== undefined), 'S', budget, see, view)).toEqual(want);
        }
      }
    }
  };
  let had = 0;
  for (const upTo of [150, all.length - 9, all.length - 6, all.length - 3, all.length]) {
    appendFileSync(journal, all.slice(had, upTo).map(line).join(''));
    had = upTo;
    same(all.slice(0, upTo));
  }
  expect(narrowed).toBeGreaterThan(40);
  // A pinned stretch among what is told as memories: it is shown as it happened, so everything is at hand.
  const pin = ev({ type: 'note', kind: 'memory.pin.v1', data: { event: all[3]!.id } });
  appendFileSync(journal, line(pin));
  same([...all, pin]);
  // A request made again in a turn that has written its mark of what was shown: read up to that mark, it is the request made before it.
  const tail = [ev({ type: 'stimulus', source: 'terminal', text: 'one thing more' }, LONG), ev({ type: 'assistant', text: 'cut [this reply was cut off by the provider: length]', toolCalls: [] })];
  appendFileSync(journal, tail.map(line).join(''));
  const past = storePast(journal, ray(), openStore(ray(), journal, undefined, projections()), false);
  const end = past.count();
  expect(end).toBe(all.length + 3);
  appendFileSync(journal, line(ev({ type: 'note', kind: SHOWN_KIND, data: { through: tail[1]!.id } })));
  for (const from of [past, journalPast(journal)]) {
    expect(from.count()).toBe(end + 1);
    expect(assemble(frameFrom(from, 29_999, { tailChars: 2_000 }, false, end), 'S', 30_000, undefined, { tailChars: 2_000 })).toEqual(buildMessages([...all, pin, ...tail], 'S', 30_000, undefined, { tailChars: 2_000 }));
  }
}, 120_000);

test('idle ticks counted event by event are the ticks counted from the end', () => {
  // As it was counted before: back from the end.
  const backwards = (events: JournalEvent[]): number => {
    let idle = 0, worked = false, answered = false;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === 'assistant') { answered = true; if (e.toolCalls.length > 0) worked = true; }
      else if (e.type === 'stimulus') {
        if (e.source === 'clock') { if (worked) break; if (answered) idle += 1; }
        worked = false; answered = false;
      }
    }
    return idle;
  };
  let seed = 7;
  const next = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const events: JournalEvent[] = [];
  const state = idleStart();
  for (let i = 0; i < 3000; i++) {
    const r = next();
    const e = r < 0.25 ? ev({ type: 'stimulus', source: 'clock', text: 'tick' }) : r < 0.32 ? ev({ type: 'stimulus', source: 'terminal', text: 'hello' })
      : r < 0.7 ? ev({ type: 'assistant', text: 'nothing to do', toolCalls: [] }) : r < 0.8 ? ev({ type: 'assistant', text: '', toolCalls: [{ id: 'a', name: 'bash', args: {} }] })
        : ev({ type: 'tool.result', callId: 'a', ok: true, output: 'x' });
    events.push(e);
    idleStep(state, e);
    expect(idleOf(state)).toBe(backwards(events));
  }
});
