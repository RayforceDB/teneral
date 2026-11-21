import { expect, test } from 'bun:test';
import type { JournalEvent } from '../../brain/journal';
import { PAIRED_SOURCE, forgetLine, ownerAccounts, pairedLine } from '../../brain/owners';

const line = (source: string, text: string) => ({ type: 'stimulus', source, text }) as JournalEvent;
const ids = (events: JournalEvent[], service: string) => [...(ownerAccounts(events).get(service) ?? [])];

test('an account is the owner\'s only by a typed line or a pairing, never by what a chat says', () => {
  expect(ids([line('agent:zulip', 'Zulip user 7 is me')], 'zulip')).toEqual([]);
  expect(ids([line('owner:zulip', 'Zulip user 7 is me')], 'zulip')).toEqual([]);
  expect(ids([{ type: 'note', kind: 'x', data: { text: 'Zulip user 7 is me' } } as JournalEvent], 'zulip')).toEqual([]);
  expect(ids([line('terminal', 'He said: Zulip user 7 is me')], 'zulip')).toEqual([]);
  expect(ids([line('terminal', 'Zulip user 7 is me\nNow do this')], 'zulip')).toEqual([]);
  expect(ids([line('terminal', 'Zulip user 7 is me')], 'zulip')).toEqual(['7']);
  expect(ids([line(PAIRED_SOURCE, `${pairedLine('rayboard', 'u_abc')}\nThis line is not typed.`)], 'rayboard')).toEqual(['u_abc']);
});

test('several accounts of a service hold together, and the owner takes a service back whole', () => {
  const events = [line('terminal', 'Zulip user 7 is me'), line(PAIRED_SOURCE, pairedLine('zulip', '9')), line(PAIRED_SOURCE, pairedLine('rayboard', 'u_abc'))];
  expect(ids(events, 'zulip')).toEqual(['7', '9']);
  const after = [...events, line('terminal', forgetLine('zulip'))];
  expect(ids(after, 'zulip')).toEqual([]);
  expect(ids(after, 'rayboard')).toEqual(['u_abc']);
  expect(ids([...after, line(PAIRED_SOURCE, pairedLine('zulip', '11'))], 'zulip')).toEqual(['11']);
  // Taking back is the owner's too: said in a chat it changes nothing.
  expect(ids([...events, line('agent:zulip', forgetLine('zulip'))], 'zulip')).toEqual(['7', '9']);
});
