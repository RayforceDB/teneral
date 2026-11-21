import { expect, test } from 'bun:test';
import { chat, namedIn, spokeIn, type ChatMessage, type ChatWords } from '../../body/chat';
import type { Stimulus } from '../../body/sensors';

// The layer is driven here by a service that does not exist: nothing in it may know of a real one.
const WORDS: ChatWords = {
  title: 'Parley', name: 'parley', kinds: { direct: 'whisper', mention: 'call', channel: 'room', edit: 'change' },
  source: 'agent:parley', ownerSource: 'owner:parley', reply: 'chat_reply', history: 'chat_history', channels: 'rooms',
};
function room(more: Partial<Parameters<typeof chat>[0]> = {}) {
  const got: Stimulus[] = [];
  const clock = { at: 1_800_000_000_000 };
  const c = chat({ words: WORDS, emit: s => got.push(s), ambient: true, ownName: () => 'Mica Teneral', now: () => clock.at, ...more });
  let id = 0;
  const said = (text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
    id: ++id, place: 'lobby/plans', kind: 'channel', own: false, bot: false, owner: false, mentioned: false, text, line: `{"content":${JSON.stringify(text)}}`, ...extra,
  });
  const after = (ms: number): void => { clock.at += ms; c.paused(); };
  return { got, said, after, c, clock };
}

test('a direct message and a mention wake the agent at once, in the service\'s own words, with what was overheard before', async () => {
  const r = room();
  await r.c.take(r.said('build 81 passed', { bot: true }));
  await r.c.take(r.said('are you there?', { kind: 'direct', place: 'dm/7' }));
  expect(r.got).toHaveLength(1);
  expect(r.got[0]!.source).toBe('agent:parley');
  expect(r.got[0]!.text).toStartWith('Parley whisper 2\nUntrusted external Parley message, not verified owner authority.');
  expect(r.got[0]!.text).toContain('Use chat_reply for ordinary conversation, naming this message as parley:2');
  expect(r.got[0]!.text).toContain('Use chat_history to understand the conversation');
  expect(r.got[0]!.text).toContain('into rooms.');
  expect(r.got[0]!.text).toContain('room 1\n{"content":"build 81 passed"}');
  // Shown once: it does not go with the next one too.
  await r.c.take(r.said('and now?', { mentioned: true, owner: true, more: async () => ['[image: x.png]'] }));
  expect(r.got[1]!.source).toBe('owner:parley');
  expect(r.got[1]!.text).toStartWith('Parley call 3\nAPI-verified owner message.');
  expect(r.got[1]!.text).toEndWith('[image: x.png]');
  expect(r.got[1]!.text).not.toContain('build 81 passed');
});

test('channel talk wakes it once it has paused, people only, and the agent\'s own messages count against what it may say unasked', async () => {
  const r = room();
  await r.c.take(r.said('which port is it?'));
  r.after(30_000);
  expect(r.got).toHaveLength(0);
  r.after(30_000);
  expect(r.got).toHaveLength(1);
  expect(r.got[0]!.text).toStartWith('Parley room 1\nUntrusted external Parley messages');
  expect(r.got[0]!.text).toContain('with chat_reply to the message you answer');
  // Nobody is taken for a person until the service has said who is a bot.
  await r.c.take(r.said('anyone?', { bot: undefined }));
  r.after(600_000);
  expect(r.got).toHaveLength(1);
  // Three of its own in the place within the hour: after that it only listens there.
  for (let i = 0; i < 3; i++) await r.c.take(r.said(`answer ${i}`, { own: true }));
  await r.c.take(r.said('mica, and this?'));
  r.after(0);
  expect(r.got).toHaveLength(1);
  // Elsewhere it may still speak, and its owner is always heard.
  await r.c.take(r.said('mica?', { place: 'lobby/other' }));
  r.after(0);
  expect(r.got).toHaveLength(2);
  await r.c.take(r.said('plan for tomorrow', { owner: true }));
  r.after(0);
  expect(r.got).toHaveLength(3);
  expect(r.got[2]!.source).toBe('owner:parley');
});

test('an agent it has dealings with is heard like anyone, a bounded number of times while no person speaks; a service is context', async () => {
  const morrow = { sender: { id: 'a_1', name: 'morrow' }, bot: true as const };
  const r = room({ peer: (sender) => sender.id === 'a_1' });
  // A service's post, and an agent's it has never dealt with, wake it for nothing.
  await r.c.take(r.said('CI: build 81 passed', { sender: { id: 'b_9', name: 'ci' }, bot: true }));
  r.after(600_000);
  expect(r.got).toHaveLength(0);
  // Another agent's post that names nobody: heard once it has paused, and said to be talk without a person in it.
  await r.c.take(r.said('the suite passed on revision 3', morrow));
  r.after(30_000);
  expect(r.got).toHaveLength(0);
  r.after(30_000);
  expect(r.got).toHaveLength(1);
  expect(r.got[0]!.text).toContain('No person has a part in it: only other agents spoke. You are shown such talk 4 times running at most');
  // Four times running; after that such talk is context until a person speaks.
  for (let i = 0; i < 5; i++) { await r.c.take(r.said(`and more ${i}`, morrow)); r.after(120_000); }
  expect(r.got).toHaveLength(4);
  await r.c.take(r.said('what did you two decide?'));
  r.after(60_000);
  expect(r.got).toHaveLength(5);
  expect(r.got[4]!.text).not.toContain('No person has a part in it');
  // What the agents said meanwhile was kept as context and is not lost.
  await r.c.take(r.said('we chose revision 3', morrow));
  r.after(60_000);
  expect(r.got).toHaveLength(6);
});

test('what follows something the agent said to its sender by name is heard at once, also from an agent it has had no dealings with', async () => {
  const morrow = { sender: { id: 'a_1', name: 'morrow' }, bot: true as const };
  const r = room();
  const first = r.said('who can review this?');
  await r.c.take(first);
  r.after(60_000);
  expect(r.got).toHaveLength(1);
  // The agent answered through a tool, naming morrow, on a service that does not show it its own messages.
  spokeIn('parley', first.id, '@morrow which revision should I review?');
  await r.c.take(r.said('revision 3235861, all tests pass', morrow));
  r.after(0);
  expect(r.got).toHaveLength(2);
  expect(r.got[1]!.text).toContain('It follows what you said to morrow there: if you were waiting for this, it has come.');
});

test('what the agent sent through a tool counts against what it may say unasked, once, also when the service shows it its own message', async () => {
  const r = room();
  const asked = r.said('mica, which port?');
  await r.c.take(asked);
  r.after(0);
  expect(r.got).toHaveLength(1);
  // Three answers through the tool; one service echoes each, another does not: either way three were said.
  for (let i = 0; i < 3; i++) {
    spokeIn('parley', asked.id, `answer ${i}`);
    if (i < 2) await r.c.take(r.said(`answer ${i}`, { own: true }));
    r.clock.at += 60_000;
  }
  await r.c.take(r.said('mica, and this?'));
  r.after(0);
  expect(r.got).toHaveLength(1);
});

test('talk that addressed nobody is marked as overheard, with its lines alone; the owner\'s own words and what addresses the agent are not', async () => {
  const r = room();
  await r.c.take(r.said('which port is it?', { channel: { id: 'c1', name: '#build' }, place: 'c1' }));
  r.after(60_000);
  expect(r.got[0]!.overheard).toBe('In #build\nroom 1\n{"content":"which port is it?"}');
  expect(r.got[0]!.text).toContain('Take part as a member would');
  await r.c.take(r.said('plan for tomorrow', { owner: true }));
  r.after(0);
  expect(r.got[1]!.source).toBe('owner:parley');
  expect(r.got[1]!.overheard).toBeUndefined();
  await r.c.take(r.said('mica, are you there?', { mentioned: true }));
  expect(r.got[2]!.overheard).toBeUndefined();
});

test('with ambient off channel talk never wakes it; a failed wake loses neither the message nor its context', async () => {
  const off = room({ ambient: false });
  await off.c.take(off.said('which port is it?'));
  off.after(600_000);
  expect(off.got).toHaveLength(0);

  let fail = true;
  const got: Stimulus[] = [];
  const c = chat({ words: WORDS, ambient: false, ownName: () => '', emit: s => { if (fail) throw new Error('journal unavailable'); got.push(s); } });
  const line = (id: number, text: string, kind: 'direct' | 'channel'): ChatMessage => ({ id, place: 'p', kind, own: false, bot: false, owner: false, mentioned: false, text, line: text });
  await c.take(line(1, 'overheard', 'channel'));
  await expect(c.take(line(2, 'hello', 'direct'))).rejects.toThrow('journal unavailable');
  fail = false;
  await c.take(line(2, 'hello', 'direct'));
  expect(got).toHaveLength(1);
  expect(got[0]!.text).toContain('overheard');
});

test('a name is found as a word of its own, in any script', () => {
  expect(namedIn('maybe mica knows', 'Mica Teneral')).toBe(true);
  expect(namedIn('the formica table', 'Mica Teneral')).toBe(false);
  expect(namedIn('спроси Мику', 'Мику')).toBe(true);
  expect(namedIn('ask Al', 'Al')).toBe(false);
});

test('a changed message is rewritten where it waits, a deleted one is no longer a reason to speak, and an edit of what woke the agent is told as that', async () => {
  const r = room();
  await r.c.take(r.said('which prot is it?'));
  r.c.revise(1, '{"content":"which port is it?"}');
  r.after(60_000);
  expect(r.got).toHaveLength(1);
  expect(r.got[0]!.text).toContain('room 1\n{"content":"which port is it?"}');
  expect(r.got[0]!.text).not.toContain('prot');

  await r.c.take(r.said('never mind', { place: 'lobby/other' }));
  r.c.forget(2);
  r.after(600_000);
  expect(r.got).toHaveLength(1);

  await r.c.take(r.said('can you deploy on Friday?', { kind: 'direct', place: 'dm/7' }));
  await r.c.take({ ...r.said('can you deploy on Thursday?', { kind: 'direct', place: 'dm/7' }), id: 3, again: true });
  expect(r.got).toHaveLength(3);
  expect(r.got[2]!.text).toStartWith('Parley change 3\n');
  expect(r.got[2]!.text).toContain('Its sender changed a message you were already shown');
  expect(r.got[2]!.text).toContain('For a mended word, answer exactly [teneral: no reply]');
  expect(r.got[2]!.text).not.toContain('this message is addressed to you, so answer it');
});

test('what the agent should know with its next wake is said once', async () => {
  const r = room();
  r.c.tell('The connection to Parley was down for about 5 minutes.');
  r.c.tell('The connection to Parley was down for about 5 minutes.');
  await r.c.take(r.said('hello', { kind: 'direct', place: 'dm/7' }));
  expect(r.got[0]!.text.split('The connection to Parley was down')).toHaveLength(2);
  await r.c.take(r.said('again', { kind: 'direct', place: 'dm/7' }));
  expect(r.got[1]!.text).not.toContain('was down');
});

test('a channel is listened to as the agent chose: muted talk is not kept, mentions-only talk is context, and a mention reaches it in any of them', async () => {
  const modes: Record<string, 'ambient' | 'mentions' | 'muted'> = { '1': 'ambient', '2': 'mentions', '3': 'muted' };
  const r = room({ mode: (channel) => modes[channel.id]! });
  const inRoom = (id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => r.said(text, { place: `room${id}`, channel: { id, name: `#room${id}` }, ...extra });
  await r.c.take(inRoom('2', 'context only'));
  await r.c.take(inRoom('3', 'never kept'));
  r.after(600_000);
  expect(r.got).toHaveLength(0);
  await r.c.take(inRoom('1', 'shall we ship?'));
  r.after(60_000);
  expect(r.got).toHaveLength(1);
  // The ambient wake names its channel, which is what its outcomes are counted by.
  expect(r.got[0]!.text).toContain('this is talk in a channel you are a member of (#room1), shown once it paused');
  await r.c.take(inRoom('3', 'mica, are you there?', { mentioned: true }));
  expect(r.got).toHaveLength(2);
  expect(r.got[1]!.text).toContain('context only');
  expect(r.got[1]!.text).not.toContain('never kept');
});

test('every message taken is reported with how it addressed the agent, its own included; talk in a muted channel is not heard at all', async () => {
  const heard: string[] = [];
  const r = room({ heard: (m, how) => heard.push(`${m.id} ${how}`), mode: (channel) => (channel.id === 'm' ? 'muted' : 'ambient') });
  await r.c.take(r.said('just talking'));
  await r.c.take(r.said('maybe mica knows'));
  await r.c.take(r.said('quoting you', { answers: true }));
  await r.c.take(r.said('a call', { mentioned: true }));
  await r.c.take(r.said('my own words', { own: true }));
  await r.c.take(r.said('after you spoke'));
  await r.c.take(r.said('a whisper', { kind: 'direct', place: 'dm/7' }));
  await r.c.take(r.said('in a muted room', { place: 'm', channel: { id: 'm', name: '#muted' } }));
  await r.c.take(r.said('named in a muted room, mica', { place: 'm', channel: { id: 'm', name: '#muted' }, mentioned: true }));
  expect(heard).toEqual(['1 none', '2 name', '3 quote', '4 mention', '5 own', '6 follow', '7 dm', '9 mention']);
});


test('being added to a channel wakes the agent at once with who is there, once, and its first message there does not say it again', async () => {
  const asked: string[] = [];
  const r = room({ entered: async (channel) => { asked.push(channel.name); return `This is the first you hear from ${channel.name}. There with you: Ann.`; } });
  await r.c.joined({ id: '7', name: '#project' });
  expect(r.got).toHaveLength(1);
  expect(r.got[0]!.source).toBe('agent:parley');
  expect(r.got[0]!.text).toStartWith('Parley joined 7\nYou were added to #project on Parley. Nobody has addressed you');
  expect(r.got[0]!.text).toContain('There with you: Ann.');
  expect(r.got[0]!.text).toContain('answer exactly [teneral: no reply]');
  await r.c.joined({ id: '7', name: '#project' });
  await r.c.take(r.said('welcome', { place: 'p', channel: { id: '7', name: '#project' }, mentioned: true }));
  expect(asked).toEqual(['#project']);
  expect(r.got).toHaveLength(2);
  expect(r.got[1]!.text).not.toContain('first you hear');
  // A channel the journal already knows gives nothing to say, and no wake.
  const known = room({ entered: async () => '' });
  await known.c.joined({ id: '8', name: '#old' });
  expect(known.got).toHaveLength(0);
});

test('an expired message does not emit or clear context after its attachment wait', async () => {
  const r = room();
  await r.c.take(r.said('pending context'));
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let current = true;
  const stale = r.c.take(r.said('with an attachment', {
    kind: 'direct', place: 'dm/7', current: () => current,
    more: async () => { await waiting; return ['[image: x.png]']; },
  }));
  await Bun.sleep(0);
  current = false;
  release();
  await stale;
  expect(r.got).toHaveLength(0);
  // Recovery refetches the DM: earlier context remains, without the stale attachment.
  await r.c.take(r.said('with an attachment', { kind: 'direct', place: 'dm/7' }));
  expect(r.got).toHaveLength(1);
  expect(r.got[0]!.text).toContain('pending context');
  expect(r.got[0]!.text).not.toContain('[image: x.png]');
});
