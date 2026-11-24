import { expect, test } from 'bun:test';
import type { JournalEvent } from '../../brain/journal';
import { SAME_MS, TROUBLE_KIND, teller, troubleOf, troubles } from '../../brain/trouble';

test('a line that says something failed is a trouble; one that tells what the body is doing is not', () => {
  for (const line of [
    '[memory] the database failed, the journal is read through from here on: rayforce: io: connection closed',
    '[memory] the database could not be used, the journal is read through instead: no library',
    '[memory] the store could not be written: disk full',
    "[memory] the database's process failed: it ended by itself, killed by SIGKILL, 73 s after it started",
    '[turn failed] the provider said no',
    '[giving up] 3 turns in a row failed in this generation\'s own code; exiting so the stem can act',
    '[skills] the built-in skills were not seeded: bad manifest',
    '[owner] a word about memory that could not be read was dropped',
  ]) expect(troubleOf(line)).not.toBeNull();
  for (const line of [
    '[memory] formed a memory', '[memory] the database runs in a process of its own (12), on port 4000', '[tool] bash', '[thinking]', '[interrupted]',
    '[retry] 1 in a row; trying again in 10 s, or when the owner writes', '[chat] zulip was not sending the talk of general; asked it to',
    '[glance] overheard talk: could not decide', 'no bracket at all failed', '',
  ]) expect(troubleOf(line)).toBeNull();
  expect(troubleOf('[memory] the store could not be written: disk full')).toEqual({ where: 'memory', text: 'the store could not be written: disk full' });
});

test('what is said is said as ever, a trouble is also set down, and the same one not again for a while', () => {
  const out: string[] = [];
  const notes: { where: string; text: string }[] = [];
  let now = 1_000_000;
  const say = teller((data) => { notes.push(data); }, (line) => { out.push(line); }, () => now);
  say('[tool] bash');
  say('[memory] the store could not be written: disk full');
  say('[memory] the store could not be written: disk full');
  now += SAME_MS + 1;
  say('[memory] the store could not be written: disk full');
  say('[turn failed] other');
  expect(out).toHaveLength(5);
  expect(notes).toEqual([
    { where: 'memory', text: 'the store could not be written: disk full' }, { where: 'memory', text: 'the store could not be written: disk full' }, { where: 'turn failed', text: 'other' },
  ]);
  // A journal that cannot be written does not stop the line from being said, nor the body.
  const failing = teller(() => { throw new Error('no journal'); }, (line) => { out.push(line); });
  expect(() => failing('[turn failed] x')).not.toThrow();
});

test('the troubles of a day are the same one once, with how often, the latest first', () => {
  const note = (ts: string, where: string, text: string): JournalEvent => ({ v: 1, id: ts, ts, gen: 'g', type: 'note', kind: TROUBLE_KIND, data: { where, text } }) as JournalEvent;
  const events = [
    note('2026-11-24T08:00:00.000Z', 'memory', 'the database failed'), note('2026-11-24T09:00:00.000Z', 'turn failed', 'the provider said no'),
    note('2026-11-24T09:30:00.000Z', 'memory', 'the database failed'), note('2026-11-20T09:30:00.000Z', 'memory', 'long ago it failed'),
  ];
  expect(troubles(events, Date.parse('2026-11-23T10:00:00.000Z'))).toEqual([
    { where: 'memory', text: 'the database failed', times: 2, first: '2026-11-24T08:00:00.000Z', last: '2026-11-24T09:30:00.000Z' },
    { where: 'turn failed', text: 'the provider said no', times: 1, first: '2026-11-24T09:00:00.000Z', last: '2026-11-24T09:00:00.000Z' },
  ]);
});
