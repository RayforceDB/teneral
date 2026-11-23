import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memberOf } from '../../body/chat';
import { ATTENTION_KIND, QUIET_RUN, modeFrom, modeOf } from '../../body/chat-tools';
import type { EventBody, JournalEvent } from '../../brain/journal';
import { journalPast, projections, storePast, type Past } from '../../brain/past';
import { QUIET_REPLY } from '../../brain/quiet';
import { statesOf } from '../../brain/states-table';
import { openStore } from '../../brain/store';
import { MEMBER_OF, SETTLED, quietOf, wakeStart, wakeStep } from '../../brain/wakes-table';
import { GLANCE_KIND, OVERHEARD_KIND, SETTLED_KIND, ignoredTalk, overheard, unsettled, waitingTalk } from '../../heart/glance';
import { library, ray } from './rayforce';

const real = test.skipIf(library === null);
let n = 0;
let clock = Date.parse('2026-11-11T00:00:00.000Z');
const ev = (body: EventBody): JournalEvent => ({ v: 1, id: `wk${(++n).toString(36).padStart(5, '0')}`, ts: new Date(clock += 1000).toISOString(), gen: 'g1', ...body }) as JournalEvent;
const CHANNELS = ['general', 'dev (core)', 'ops'];
const wake = (channel: string, service = 'rayboard') => ev({ type: 'stimulus', source: `agent:${service}`, text: `Rayboard notification 7\nYou are in ${memberOf(channel)}.\nsomeone: hello` });

/** A life of talk in three channels: wakes answered in words, with a reaction, with silence, not at all; talk a glance settled; other things said between; a choice now and then. */
function talk(seed: number, length: number, quietShare: number): JournalEvent[] {
  let s = seed;
  const next = (): number => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const events: JournalEvent[] = [];
  for (let i = 0; i < length; i++) {
    const r = next();
    const channel = CHANNELS[Math.floor(next() * CHANNELS.length)]!;
    if (r < 0.45) {
      events.push(wake(channel, next() < 0.9 ? 'rayboard' : 'zulip'));
      const how = next();
      if (how < quietShare) events.push(ev({ type: 'assistant', text: QUIET_REPLY, toolCalls: [] }));
      else if (how < quietShare + 0.08) events.push(ev({ type: 'assistant', text: 'here is what I think', toolCalls: [] }));
      else if (how < quietShare + 0.14) events.push(ev({ type: 'assistant', text: '', toolCalls: [{ id: 'c', name: 'chat_react', args: {} }] }), ev({ type: 'tool.intent', callId: 'c', name: 'chat_react', args: {} }), ev({ type: 'tool.result', callId: 'c', ok: true, output: 'ok' }), ev({ type: 'assistant', text: QUIET_REPLY, toolCalls: [] }));
      else if (how < quietShare + 0.18) events.push(ev({ type: 'assistant', text: '', toolCalls: [{ id: 'b', name: 'bash', args: {} }] }), ev({ type: 'tool.intent', callId: 'b', name: 'bash', args: {} }), ev({ type: 'tool.result', callId: 'b', ok: true, output: 'ok' }), ev({ type: 'assistant', text: QUIET_REPLY, toolCalls: [] }));
      // Otherwise it is not answered at all before the next thing arrives.
    } else if (r < 0.55) events.push(ev({ type: 'stimulus', source: 'terminal', text: 'a word from the owner' }), ev({ type: 'assistant', text: 'yes', toolCalls: [] }));
    else if (r < 0.63) {
      // Talk a glance ignored: the note, then each piece as said and answered with nothing, in one go.
      const many = 1 + Math.floor(next() * 2);
      events.push(ev({ type: 'note', kind: SETTLED_KIND, data: { of: Array.from({ length: many }, (_, k) => `o${i}.${k}`) } }));
      for (let k = 0; k < many; k++) events.push(wake(channel), ev({ type: 'assistant', text: QUIET_REPLY, toolCalls: [] }));
    } else if (r < 0.65) events.push(ev({ type: 'note', kind: ATTENTION_KIND, data: { service: 'rayboard', channel, mode: next() < 0.5 ? 'muted' : 'ambient' } }));
    else if (r < 0.75) events.push(ev({ type: 'stimulus', source: 'clock', text: 'tick' }), ev({ type: 'assistant', text: QUIET_REPLY, toolCalls: [] }));
    else events.push(ev({ type: 'note', kind: 'memory.fact.v1', data: { text: 'x' } }));
  }
  return events;
}

/** A past that answers from a journal held here, the wakes by the step the table takes. */
function held(events: JournalEvent[]): Pick<Past, 'stateOf' | 'quiet'> {
  return {
    stateOf: (name, keys) => statesOf(events, name).findLast((row) => keys.includes(row.key))?.state ?? null,
    quiet(source, mark, run) {
      const state = wakeStart();
      events.forEach((e, seq) => { wakeStep(state, e, seq); });
      return quietOf(state.wakes, source, mark, run);
    },
  };
}

test('the names the table reads by are those their writers use', () => {
  expect(SETTLED).toBe(SETTLED_KIND);
  expect(memberOf('x').startsWith(MEMBER_OF)).toBe(true);
  expect(memberOf('x')).toBe(`${MEMBER_OF}x)`);
});

test('how the agent listens in a channel, from the wakes taken one by one, is what the whole journal read back from its end gives', () => {
  const seen = new Set<string>();
  for (const [seed, quietShare] of [[1, 0.55], [2, 0.8], [3, 0.3], [4, 0.72]] as const) {
    const events = talk(seed, 260, quietShare);
    for (let upTo = 5; upTo <= events.length; upTo += 3) {
      const now = events.slice(0, upTo);
      const past = held(now) as Past;
      for (const service of ['rayboard', 'zulip']) {
        for (const name of CHANNELS) {
          const want = modeOf(now, service, { id: name, name });
          expect(modeFrom(past, service, { id: name, name })).toEqual(want);
          seen.add(`${want.mode}/${want.why}`);
        }
      }
    }
  }
  // Every answer occurred: a choice, the default, and the silence of enough wakes in a row.
  expect([...seen].sort()).toEqual(['ambient/chosen', 'ambient/default', 'mentions/quiet', 'muted/chosen']);
  expect(QUIET_RUN).toBeGreaterThan(3);
});

real('the database holds the wakes, through restarts in the middle of an answer', () => {
  const events = talk(9, 300, 0.95);
  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-wakes-')), 'journal.jsonl');
  writeFileSync(journal, '');
  let had = 0;
  const seen = new Set<string>();
  for (let upTo = 40; upTo <= events.length + 36; upTo += 37) {
    const to = Math.min(upTo, events.length);
    appendFileSync(journal, events.slice(had, to).map((e) => `${JSON.stringify(e)}\n`).join(''));
    had = to;
    const past = storePast(journal, ray(), openStore(ray(), journal, undefined, projections()), false);
    for (const name of CHANNELS) {
      const want = modeOf(events.slice(0, to), 'rayboard', { id: name, name });
      expect(modeFrom(past, 'rayboard', { id: name, name })).toEqual(want);
      expect(modeFrom(journalPast(journal), 'rayboard', { id: name, name })).toEqual(want);
      seen.add(want.why);
    }
    past.persist();
  }
  expect(seen.has('quiet')).toBe(true);
}, 120_000);

real('how jobs and subagents stand is the last said of each, asked of the database as of the journal', async () => {
  const { JOB_KIND, jobHistory } = await import('../../body/jobs');
  const { SUBAGENT_KIND, subagents } = await import('../../body/subagents');
  let s = 5;
  const next = (): number => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const events: JournalEvent[] = [];
  for (let i = 0; i < 160; i++) {
    const name = `n${Math.floor(next() * 9)}`, gen = next() < 0.7 ? 'g1' : 'g2';
    if (next() < 0.5) events.push(ev({ type: 'note', kind: JOB_KIND, data: { name, gen, pgid: 100 + i, cwd: '/tmp', command: `run ${i}`, members: [{ pid: 100 + i, started: '1' }], state: next() < 0.6 ? 'running' : 'stopped' } }));
    else events.push(ev({ type: 'note', kind: SUBAGENT_KIND, data: { name, gen, task: 't', dir: '/tmp', state: ['queued', 'running', 'ended', 'told'][Math.floor(next() * 4)] } }));
    // A note that is not one: it changes nothing.
    if (next() < 0.1) events.push(ev({ type: 'note', kind: JOB_KIND, data: { name, state: 'running' } }), ev({ type: 'note', kind: SUBAGENT_KIND, data: { name, state: 'gone' } }));
  }
  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-states-')), 'journal.jsonl');
  writeFileSync(journal, '');
  let had = 0;
  for (const upTo of [30, 90, 200, events.length]) {
    const to = Math.min(upTo, events.length);
    appendFileSync(journal, events.slice(had, to).map((e) => `${JSON.stringify(e)}\n`).join(''));
    had = to;
    const now = events.slice(0, to);
    for (const past of [storePast(journal, ray(), openStore(ray(), journal, undefined, projections()), false), journalPast(journal)]) {
      for (const gen of ['g1', 'g2']) {
        const want = [...jobHistory(now).values()].filter((j) => j.gen === gen && j.state === 'running').map((j) => j.name).sort();
        expect(past.states('job', { state: 'running', gen }).map((row) => row.key).sort()).toEqual(want);
        // And handed on as the notes themselves, they read as the same jobs.
        expect([...jobHistory(past.states('job', { state: 'running', gen }).map((row) => row.event)).keys()].sort()).toEqual(want);
      }
      expect(past.states('subagent', { state: 'ended' }).map((row) => row.key).sort()).toEqual([...subagents(now).values()].filter((x) => x.state === 'ended').map((x) => x.name).sort());
      expect(past.states('subagent').length).toBe(subagents(now).size);
    }
  }
}, 120_000);

real('the overheard talk that waits and the talk that was only ignored are what stands so in the database, as the journal read through has them', () => {
  let s = 11;
  const next = (): number => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const events: JournalEvent[] = [];
  for (let i = 0; i < 140; i++) {
    const r = next();
    const waiting = overheard(events), ignored = unsettled(events);
    if (r < 0.5 || waiting.length + ignored.length === 0) events.push(ev({ type: 'note', kind: OVERHEARD_KIND, data: { source: 'agent:rayboard', text: `talk ${i}\nmore`, ...(next() < 0.5 ? { lines: `lines ${i}` } : {}) } }));
    else if (r < 0.8 && waiting.length > 0) events.push(ev({ type: 'note', kind: GLANCE_KIND, data: { of: waiting.slice(0, 1 + Math.floor(next() * waiting.length)).map((t) => t.id), verdict: next() < 0.6 ? 'ignore' : 'look', why: 'x' } }));
    else if (ignored.length > 0) events.push(ev({ type: 'note', kind: SETTLED_KIND, data: { of: ignored.map((t) => t.id) } }));
    else events.push(ev({ type: 'note', kind: OVERHEARD_KIND, data: { source: 7, text: 'not a piece of talk' } }));
  }
  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-overheard-')), 'journal.jsonl');
  writeFileSync(journal, '');
  let had = 0, some = 0;
  for (let upTo = 10; upTo <= events.length; upTo += 13) {
    appendFileSync(journal, events.slice(had, upTo).map((e) => `${JSON.stringify(e)}\n`).join(''));
    had = upTo;
    const now = events.slice(0, upTo);
    for (const past of [storePast(journal, ray(), openStore(ray(), journal, undefined, projections()), false), journalPast(journal)]) {
      expect(waitingTalk(past)).toEqual(overheard(now));
      expect(ignoredTalk(past)).toEqual(unsettled(now));
    }
    if (overheard(now).length > 0 && unsettled(now).length > 0) some += 1;
  }
  expect(some).toBeGreaterThan(1);
}, 120_000);
