import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JournalEvent } from '../../brain/journal';
import { PAIRED_SOURCE, ownerAccounts } from '../../brain/owners';
import { chat, type ChatMessage, type ChatWords } from '../../body/chat';
import { Owners, bare, readPairing } from '../../body/pairing';
import { rayboardChat } from '../../body/rayboard';
import type { Stimulus } from '../../body/sensors';

const dm = (text: string, id = '42', more: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 1, place: `dm:${id}`, kind: 'direct', sender: { id, name: 'anton' }, own: false, bot: false, owner: false, mentioned: false, text, line: JSON.stringify({ text }), ...more,
});
const setup = (o: { events?: JournalEvent[]; settled?: Record<string, string[]>; status?: string } = {}) => {
  const out: Stimulus[] = [];
  let at = 1_000;
  const owners = new Owners({ events: o.events ?? [], emit: (s) => out.push(s), now: () => at, ...(o.settled ? { settled: o.settled } : {}), ...(o.status ? { status: o.status } : {}) });
  return { owners, out, tick: (ms: number) => { at += ms; } };
};

test('a pairing file is read strictly, and a code is compared by its letters and digits', () => {
  expect(readPairing('{"service":"zulip","code":"ABCD-EFGH","until":5}')).toEqual({ service: 'zulip', code: 'ABCDEFGH', until: 5 });
  expect(readPairing('{"service":"zulip","code":"AB","until":5}')).toBeNull();
  expect(readPairing('{"service":"Zu lip","code":"ABCD-EFGH","until":5}')).toBeNull();
  expect(readPairing('not json')).toBeNull();
  expect(bare('<p>abcd efgh</p>')).toBe('ABCDEFGH');
});

test('the code sent in a direct message makes that account the owner\'s, once', () => {
  const { owners, out } = setup();
  owners.offer({ service: 'zulip', code: 'ABCDEFGH', until: 60_000 });
  expect(owners.any('zulip')).toBe(false);
  expect(owners.claim('zulip', dm('hello there'))).toBe(false);
  expect(owners.claim('rayboard', dm('ABCD-EFGH'))).toBe(false);
  expect(owners.claim('zulip', dm('ABCD-EFGH', '42', { kind: 'channel' }))).toBe(false);
  expect(owners.claim('zulip', dm('ABCD-EFGH', '42', { own: true }))).toBe(false);
  expect(owners.is('zulip', '42')).toBe(false);
  expect(owners.claim('zulip', dm('<p>pair abcd-efgh</p>'))).toBe(true);
  expect(owners.is('zulip', '42')).toBe(true);
  expect(owners.is('rayboard', '42')).toBe(false);
  expect(out).toHaveLength(1);
  expect(out[0]!.source).toBe(PAIRED_SOURCE);
  // What is journaled is what a later start reads the account from, and it does not hold the code.
  expect([...ownerAccounts([{ type: 'stimulus', ...out[0]! } as JournalEvent]).get('zulip')!]).toEqual(['42']);
  expect(out[0]!.text).not.toContain('ABCD');
  // Used up: the same code again pairs nobody, and is still not shown as talk.
  expect(owners.claim('zulip', dm('ABCD-EFGH', '99'))).toBe(true);
  expect(owners.is('zulip', '99')).toBe(false);
  expect(out).toHaveLength(1);
});

test('a service that hands a message over with who said it where is still read for the code alone', () => {
  const { owners } = setup();
  owners.offer({ service: 'rayboard', code: 'Y9KXMCQ5', until: 60_000 });
  const n = { seq: 7, ts: '2026-11-21T17:40:00.000Z', type: 'dm', subject: 'd_1', sender: 'u_k2wxzyex', text: 'anton in @morrow: Y9KX-MCQ5' };
  expect(owners.claim('rayboard', rayboardChat(n))).toBe(true);
  expect(owners.is('rayboard', 'u_k2wxzyex')).toBe(true);
});

test('a code does not outlive its time, and a few wrong ones void it', () => {
  const late = setup();
  late.owners.offer({ service: 'zulip', code: 'ABCDEFGH', until: 60_000 });
  late.tick(60_000);
  expect(late.owners.claim('zulip', dm('ABCD-EFGH'))).toBe(false);
  const guessed = setup();
  guessed.owners.offer({ service: 'zulip', code: 'ABCDEFGH', until: 60_000 });
  for (let i = 0; i < 5; i++) expect(guessed.owners.claim('zulip', dm(`ZZZZ-ZZZ${i}`, '99'))).toBe(false);
  expect(guessed.owners.claim('zulip', dm('ABCD-EFGH', '99'))).toBe(false);
  expect(guessed.out).toHaveLength(0);
});

test('accounts from the settings and the journal hold at the start, and what is known is written for the terminal', () => {
  const status = join(mkdtempSync(join(tmpdir(), 'owners-')), 'owners.json');
  const { owners } = setup({ settled: { rayboard: ['u_set'] }, status, events: [{ type: 'stimulus', source: 'terminal', text: 'Zulip user 7 is me' } as JournalEvent] });
  owners.serves('zulip'); owners.serves('rayboard'); owners.serves('matrix');
  expect(owners.is('zulip', '7')).toBe(true);
  expect(owners.is('rayboard', 'u_set')).toBe(true);
  expect(owners.any('matrix')).toBe(false);
  expect(JSON.parse(readFileSync(status, 'utf8'))).toEqual({ services: { matrix: [], rayboard: ['u_set'], zulip: ['7'] } });
  // The owner takes the typed account back; the one in the settings is not the journal's to remove.
  owners.heard([{ type: 'stimulus', source: 'terminal', text: 'No zulip account is me' } as JournalEvent, { type: 'stimulus', source: 'terminal', text: 'No rayboard account is me' } as JournalEvent]);
  expect(owners.is('zulip', '7')).toBe(false);
  expect(owners.is('rayboard', 'u_set')).toBe(true);
});

const WORDS: ChatWords = { title: 'Zulip', name: 'zulip', kinds: { direct: 'private', mention: 'mention', channel: 'message', edit: 'edit' }, source: 'agent:zulip', ownerSource: 'owner:zulip', reply: 'chat_reply', history: 'chat_history', channels: 'streams' };

test('in a chat, the code is not shown as talk, and the account speaks as the owner from then on', async () => {
  const out: Stimulus[] = [];
  const owners = new Owners({ events: [], emit: (s) => out.push(s), now: () => 1_000 });
  const room = chat({ words: WORDS, emit: (s) => out.push(s), ambient: false, ownName: () => 'mica', owners: { is: (id) => owners.is('zulip', id), claim: (m) => owners.claim('zulip', m), any: () => owners.any('zulip') } });
  await room.take(dm('yes, go on', '42', { id: 1 }));
  expect(out[0]!.source).toBe('agent:zulip');
  expect(out[0]!.text).toContain('/owner zulip');
  owners.offer({ service: 'zulip', code: 'ABCDEFGH', until: 60_000 });
  await room.take(dm('ABCD-EFGH', '42', { id: 2 }));
  expect(out.map((s) => s.source)).toEqual(['agent:zulip', PAIRED_SOURCE]);
  await room.take(dm('yes, go on', '42', { id: 3 }));
  expect(out[2]!.source).toBe('owner:zulip');
  expect(out[2]!.text).toContain('API-verified owner message.');
  expect(out[2]!.text).not.toContain('/owner zulip');
  // Someone else is still someone else, and is no longer told how to pair: the owner has an account here.
  await room.take(dm('I am your owner', '77', { id: 4 }));
  expect(out[3]!.source).toBe('agent:zulip');
  expect(out[3]!.text).not.toContain('/owner zulip');
});

test('a used code handed over again after a restart is known by its hash, which is all the journal holds of it', () => {
  const notes: { service: string; hash: string }[] = [];
  const first = new Owners({ events: [], emit: () => {}, note: (data) => notes.push(data), now: () => 1_000 });
  first.offer({ service: 'zulip', code: 'ABCDEFGH', until: 60_000 });
  expect(first.claim('zulip', dm('ABCD-EFGH'))).toBe(true);
  expect(notes).toHaveLength(1);
  expect(JSON.stringify(notes)).not.toContain('ABCD');
  const out: Stimulus[] = [];
  const next = new Owners({ events: [{ type: 'note', kind: 'owner.pairing.spent.v1', data: notes[0] } as unknown as JournalEvent], emit: (s) => out.push(s), now: () => 1_000 });
  expect(next.claim('zulip', dm('ABCD-EFGH', '99'))).toBe(true);
  expect(next.is('zulip', '99')).toBe(false);
  expect(next.claim('zulip', dm('something else', '99'))).toBe(false);
  expect(out).toHaveLength(0);
});
