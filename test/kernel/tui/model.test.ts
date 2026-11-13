import { expect, test } from 'bun:test';
import { OWNER_REASON } from '../../../kernel/back';
import type { EventBody, JournalEvent } from '../../../kernel/journal';
import { ENTRY_LIMIT, Transcript, UNBORN, endsWithQuestion, isMutationTool, stand, stateWord, unfinished, type Entry, type Standing } from '../../../kernel/tui/model';
import { soulName, soulNameIn } from '../../../kernel/tui/talk';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
let serial = 0;

/** An event as the journal would hold it, `at` milliseconds into the story. */
function ev(body: EventBody, at = 0, gen = A): JournalEvent {
  serial += 1;
  return { ...body, v: 1, id: `e${serial}`, ts: new Date(1_800_000_000_000 + at).toISOString(), gen } as JournalEvent;
}
const said = (text: string, at = 0) => ev({ type: 'stimulus', source: 'terminal', text }, at);
const reply = (text: string, at = 0) => ev({ type: 'assistant', text, toolCalls: [] }, at);
const calling = (at = 0, text = '') => ev({ type: 'assistant', text, toolCalls: [{ id: 'c', name: 'bash', args: {} }] }, at);
const intent = (callId: string, name: string, args: unknown, at = 0) => ev({ type: 'tool.intent', callId, name, args }, at);
const result = (callId: string, ok: boolean, output: string, at = 0) => ev({ type: 'tool.result', callId, ok, output }, at);
const started = (commit = A, at = 0) => ev({ type: 'generation.started', commit }, at, commit);
const ready = (commit = A, at = 0) => ev({ type: 'generation.ready', commit }, at, commit);
const birth = (at = 0) => ev({ type: 'stimulus', source: 'birth', text: 'Hello. '.repeat(500) }, at);

const after = (...events: JournalEvent[]): Standing => events.reduce(stand, UNBORN);
const UP = { supervisor: true, body: true };
const word = (...events: JournalEvent[]): string => stateWord(after(...events), UP);

/** A transcript built from events as the screen builds it. */
function built(events: JournalEvent[], live = false): { t: Transcript; s: Standing } {
  const t = new Transcript();
  let s = UNBORN;
  for (const e of events) {
    t.add(e, s, live);
    s = stand(s, e);
  }
  return { t, s };
}
const kinds = (t: Transcript): string[] => t.entries.map((e) => e.kind);
const of = <K extends Entry['kind']>(t: Transcript, kind: K) => t.entries.filter((e): e is Extract<Entry, { kind: K }> => e.kind === kind);

// --- the state word ---

test('waking: the first start, from before the letter until the first words', () => {
  expect(word()).toBe('waking');
  expect(word(started(), ready())).toBe('waking');
  expect(word(started(), ready(), birth())).toBe('waking');
  expect(word(started(), ready(), birth(), calling(), intent('c', 'read', {}))).toBe('waking');
  expect(word(started(), ready(), birth(), calling(), intent('c', 'read', {}), result('c', true, ''), reply('Hello. Who are you?'))).toBe('waiting for you');
});

test('thinking while a reply is owed, running <tool> while a call has no result, resting when nothing is owed', () => {
  const born = [started(), ready(), birth(), reply('I am here.')];
  expect(word(...born)).toBe('resting');
  expect(word(...born, said('hi'))).toBe('thinking');
  expect(word(...born, said('hi'), calling(), intent('c', 'bash', {}))).toBe('running bash');
  expect(word(...born, said('hi'), calling(), intent('c', 'bash', {}), result('c', true, 'ok'))).toBe('thinking');
  expect(word(...born, said('hi'), calling(), intent('c', 'bash', {}), result('c', true, 'ok'), reply('Done.'))).toBe('resting');
  // The result of some other call does not end this one.
  expect(word(...born, said('hi'), calling(), intent('c', 'bash', {}), result('other', true, 'ok'))).toBe('running bash');
  // A hostile tool name cannot write anything but its letters into the header.
  expect(word(...born, said('hi'), calling(), intent('c', 'ba\x1b[31msh\nmore', {}))).toBe('running bash more');
});

test('waiting for you: the last finished reply ended with a question mark, and nothing has arrived since', () => {
  const born = [started(), ready(), birth()];
  expect(word(...born, reply('What should I call you?'))).toBe('waiting for you');
  expect(word(...born, reply('What should I call you?'), said('Anton'))).toBe('thinking');
  expect(word(...born, reply('What should I call you?'), said('Anton'), reply('Thank you, Anton.'))).toBe('resting');
  expect(word(...born, reply('Is that right?'), ev({ type: 'stimulus', source: 'clock', text: 'tick' }), reply('Nothing new.'))).toBe('resting');
  // A question in the middle is not one the reply ends with.
  expect(word(...born, reply('Why? Because it works.'))).toBe('resting');
  // A reply that goes on to call tools has not finished.
  expect(word(...born, calling(0, 'Shall I look?'), intent('c', 'read', {}))).toBe('running read');
  for (const text of ['Ready?', 'Ready? ', '**Ready?**', 'Готов ли ты?', '"Ready?"', '(ready?)', 'それでいい？', 'Ready?\n']) expect(endsWithQuestion(text)).toBe(true);
  for (const text of ['Ready.', '', 'Why? No.', '?!', 'a ? b']) expect(endsWithQuestion(text)).toBe(false);
});

test('mutating from the request until the kernel answers, whichever way', () => {
  const born = [started(), ready(), birth(), reply('I am here.'), said('mutate'), calling(), intent('c', 'mutate', {})];
  const asked = [...born, ev({ type: 'mutation.requested', commit: B, motive: 'm' }), result('c', true, 'requested')];
  expect(word(...asked)).toBe('mutating');
  expect(word(...asked, ev({ type: 'mutation.rejected', commit: B, gate: 'tests', output: '' }))).toBe('thinking');
  expect(word(...asked, ev({ type: 'generation.promoted', commit: B, previous: A }))).toBe('thinking');
  expect(word(...asked, ev({ type: 'generation.promoted', commit: B, previous: A }), started(B), ready(B), reply('New body.'))).toBe('resting');
  expect(word(...asked, ev({ type: 'generation.rolledback', commit: B, to: A, reason: 'r' }))).toBe('thinking');
});

test('not running when no supervisor holds the lock, starting when the kernel is there and no body runs', () => {
  const s = after(started(), ready(), birth(), reply('Hi.'), said('hello'));
  expect(stateWord(s, { supervisor: false, body: false })).toBe('not running');
  expect(stateWord(s, { supervisor: false, body: true })).toBe('not running');
  expect(stateWord(s, { supervisor: true, body: false })).toBe('starting');
  expect(stateWord(s, UP)).toBe('thinking');
  expect(stateWord(UNBORN, { supervisor: false, body: false })).toBe('not running');
});

test('the generation it is in, and its place among those it has lived in', () => {
  let s = after(started(A), ready(A));
  expect([s.current, s.known]).toEqual([A, [A]]);
  s = [ev({ type: 'generation.promoted', commit: B, previous: A }), started(B), ready(B)].reduce(stand, s);
  expect([s.current, s.known]).toEqual([B, [A, B]]);
  s = [ev({ type: 'generation.promoted', commit: C, previous: B }), ev({ type: 'generation.rolledback', commit: C, to: B, reason: 'r' }), started(B)].reduce(stand, s);
  expect([s.current, s.known]).toEqual([B, [A, B, C]]);
  // Back to the first: it is generation 1 again, not a fourth.
  s = [ev({ type: 'generation.rolledback', commit: B, to: A, reason: OWNER_REASON }), started(A)].reduce(stand, s);
  expect([s.current, s.known.indexOf(s.current!) + 1]).toEqual([A, 1]);
});

test('when the turn began is kept for as long as it lasts', () => {
  const t0 = 1_800_000_000_000;
  expect(after(started(), ready(), birth(5000)).since).toBe(t0 + 5000);
  expect(after(started(), ready(), birth(5000), calling(6000), intent('c', 'read', {}, 6100)).since).toBe(t0 + 5000);
  expect(after(started(), ready(), birth(5000), reply('Hi.', 9000)).since).toBeNull();
  expect(after(started(), ready(), birth(5000), reply('Hi.', 9000), said('x', 12_000)).since).toBe(t0 + 12_000);
});

test('events of a shape nobody foresaw change nothing and throw nothing', () => {
  const odd = [{ type: 'assistant' }, { type: 'assistant', text: 7, toolCalls: 'x' }, { type: 'tool.intent', args: null }, { type: 'stimulus' },
    { type: 'mutation.rejected' }, { type: 'generation.promoted', commit: {} }, { type: 'generation.rolledback', reason: [1] }, { type: 'something.new' }, { type: 'tool.result' }];
  let s = UNBORN;
  const t = new Transcript();
  for (const body of odd) {
    const e = { ...ev(said('x')), text: undefined, source: undefined, ...body } as unknown as JournalEvent;
    expect(() => { t.add(e, s, true); s = stand(s, e); }).not.toThrow();
  }
  expect(typeof stateWord(s, UP)).toBe('string');
});

test('a note the body keeps for itself is no entry on the screen and leaves where the agent stands as it was', () => {
  const note = (at = 0) => ev({ type: 'note', kind: 'memory.fact', data: { text: 'not for the screen', n: 1 } }, at);
  const plain = built([started(), ready(), said('go', 100), calling(200), intent('c1', 'bash', {}, 300), result('c1', true, 'ok', 400), reply('Done.', 500)], true);
  const noted = built([note(), started(), note(1), ready(), said('go', 100), note(150), calling(200), intent('c1', 'bash', {}, 300), note(350),
    result('c1', true, 'ok', 400), reply('Done.', 500), note(600)], true);
  expect(kinds(noted.t)).toEqual(kinds(plain.t));
  expect(noted.s).toEqual(plain.s);
  expect(stateWord(noted.s, UP)).toBe('resting');
  // In the middle of a turn the word stays what it was.
  expect(word(started(), ready(), said('go', 100), note(150))).toBe(word(started(), ready(), said('go', 100)));
  expect(word(started(), ready(), said('go', 100), calling(200), intent('c1', 'bash', {}, 300), note(350)))
    .toBe(word(started(), ready(), said('go', 100), calling(200), intent('c1', 'bash', {}, 300)));
  // One of a shape the kernel would not have written throws nothing either.
  const odd = { ...note(), kind: {}, data: undefined } as unknown as JournalEvent;
  expect(() => built([said('x'), odd], true)).not.toThrow();
});

// --- the transcript ---

test('a tool call is one entry, completed by its result: outcome, duration, and the output kept for showing', () => {
  const { t } = built([said('go'), calling(100), intent('c1', 'bash', { command: 'ls -la\n  /tmp' }, 200), result('c1', true, 'a\nb\n', 1450),
    intent('c2', 'read', { path: 'x.ts' }, 1500), result('c2', false, 'error: no such file', 1510), reply('Done.', 2000)]);
  expect(kinds(t)).toEqual(['owner', 'tool', 'tool', 'reply']);
  const [first, second] = of(t, 'tool');
  expect(first).toMatchObject({ name: 'bash', args: 'command: ls -la /tmp', status: 'ok', ms: 1250, output: 'a\nb' });
  expect(second).toMatchObject({ name: 'read', args: 'path: x.ts', status: 'failed', ms: 10, output: 'error: no such file' });
  expect(first!.rev).toBe(1);
});

test('a call still running says so; one cut off by a restart never gets a result and is marked', () => {
  const running = built([said('go'), calling(), intent('c1', 'bash', {})]).t;
  expect(of(running, 'tool')[0]).toMatchObject({ status: 'running', ms: null, args: '' });
  const cut = built([said('go'), calling(), intent('c1', 'bash', {}), started(A), ready(A)]).t;
  expect(of(cut, 'tool')[0]!.status).toBe('cut short');
  // A result for a call this screen never saw starting is not shown at all.
  expect(kinds(built([result('unknown', true, 'x')]).t)).toEqual([]);
});

test('call ids may repeat: each result completes the latest call with that id', () => {
  const { t } = built([intent('same', 'a', {}, 0), result('same', true, 'one', 10), intent('same', 'b', {}, 20), result('same', false, 'two', 50)]);
  expect(of(t, 'tool').map((e) => [e.name, e.status, e.output])).toEqual([['a', 'ok', 'one'], ['b', 'failed', 'two']]);
});

test('long arguments and long output are kept short: both ends of the output, with the middle counted', () => {
  const { t } = built([intent('c', 'write', { path: 'a.ts', content: 'x'.repeat(50_000) }), result('c', true, `START${'y'.repeat(100_000)}END`)]);
  const [tool] = of(t, 'tool');
  expect(tool!.args.length).toBeLessThanOrEqual(400);
  expect(tool!.args.startsWith('path: a.ts, content: xxx')).toBe(true);
  expect(tool!.output.length).toBeLessThan(4200);
  expect(tool!.output.startsWith('START')).toBe(true);
  expect(tool!.output.endsWith('END')).toBe(true);
  expect(tool!.output).toContain('characters left out');
});

test('the kernel\'s notes: promoted with both commits, rejected with the gate and the end of its output, rolled back with its reason and the end of the error', () => {
  const { t } = built([
    ev({ type: 'generation.promoted', commit: B, previous: A }),
    ev({ type: 'mutation.rejected', commit: C, gate: 'tests', output: `${'noise\n'.repeat(5000)}1 fail\nexpected 2` }),
    ev({ type: 'generation.rolledback', commit: B, to: A, reason: `crashed 3 times without a reply. Its stderr ended with:\n${'at frame\n'.repeat(50)}TypeError: x is not a function` }),
    ev({ type: 'generation.rolledback', commit: B, to: A, reason: OWNER_REASON }),
  ]);
  const [promoted, rejected, rolled, sentBack] = of(t, 'notice');
  expect(promoted).toMatchObject({ tone: 'good', title: 'mutation accepted', move: ['aaaaaaa', 'bbbbbbb'], body: '' });
  expect(rejected).toMatchObject({ tone: 'warn', title: 'mutation to ccccccc rejected at gate "tests"' });
  expect(rejected!.body.endsWith('1 fail\nexpected 2')).toBe(true);
  expect(rejected!.body.length).toBeLessThanOrEqual(6000);
  expect(rejected!.body.startsWith('noise')).toBe(true); // cut at a line, not in the middle of one
  expect(rolled).toMatchObject({ title: 'rolled back', move: ['bbbbbbb', 'aaaaaaa'], lead: 'crashed 3 times without a reply. Its stderr ended with:' });
  expect(rolled!.body.endsWith('TypeError: x is not a function')).toBe(true);
  expect(sentBack).toMatchObject({ title: 'sent back by you', move: ['bbbbbbb', 'aaaaaaa'], lead: '', body: '' });
});

test('other stimuli are one quiet entry each: the clock, a message with its sender, and the birth letter without its text', () => {
  const { t } = built([birth(), ev({ type: 'stimulus', source: 'clock', text: 'It is 12:00.\nNothing arrived.' }), ev({ type: 'stimulus', source: 'agent:alice', text: '(message m1) hello\nthere' })]);
  expect(of(t, 'quiet')).toMatchObject([
    { label: 'the birth letter', text: '' },
    { label: 'clock', text: 'It is 12:00. Nothing arrived.' },
    { label: 'from alice', text: '(message m1) hello there' },
  ]);
});

test('words the body journaled in the model\'s place are a warning, and do not count as the agent speaking', () => {
  const { t, s } = built([started(), ready(), birth(), reply('[not from the model] The provider refused the request 3 times in a row with status 400: too long\nWhat to do: shorten it.')]);
  expect(of(t, 'warning')[0]!.text).toBe('The provider refused the request 3 times in a row with status 400: too long\nWhat to do: shorten it.');
  expect(of(t, 'reply')).toEqual([]);
  expect(s.spoke).toBe(false);
  expect(stateWord(s, UP)).toBe('waking');
});

test('the first words ever said are marked as such, once', () => {
  const { t } = built([started(), ready(), birth(), calling(0, ''), intent('c', 'read', {}), result('c', true, ''), reply('Hello.'), said('hi'), reply('Hi again.')]);
  expect(of(t, 'reply').map((e) => [e.text, e.first])).toEqual([['Hello.', true], ['Hi again.', false]]);
  // A reply that only calls tools says nothing and is no entry.
  expect(kinds(t)).toEqual(['quiet', 'tool', 'reply', 'owner', 'reply']);
});

test('a line that arrives in the middle of a request is queued, and stands after the reply written without it once it is read', () => {
  const texts = (t: Transcript): string[] => t.entries.filter((e) => e.kind === 'owner' || e.kind === 'reply').map((e) => (e.kind === 'owner' && e.queued ? `${e.text} (queued)` : (e as { text: string }).text));
  expect(texts(built([said('one', 0), said('two', 500)]).t)).toEqual(['one', 'two (queued)']);
  expect(texts(built([said('one', 0), said('two', 500), said('three', 700)]).t)).toEqual(['one', 'two (queued)', 'three (queued)']);
  const { t } = built([said('one', 0), said('two', 500), reply('to one', 900), reply('to two', 1800)]);
  expect(texts(t)).toEqual(['one', 'to one', 'two', 'to two']);
  expect(t.entries.some(unfinished)).toBe(false);
  // Lines journaled together were read together: the reply saw both.
  expect(texts(built([said('one', 0), said('two', 8), reply('to both', 900)]).t)).toEqual(['one', 'two', 'to both']);
});

test('a line sent from this screen is shown at once, and moves to its place when the journal has it', () => {
  const t = new Transcript();
  let s = UNBORN;
  const add = (e: JournalEvent) => { t.add(e, s, true); s = stand(s, e); };
  add(reply('earlier'));
  t.say('my line');
  expect(t.entries.at(-1)).toMatchObject({ kind: 'owner', text: 'my line', pending: true });
  expect(t.waiting).toBe(true);
  add(reply('written meanwhile'));
  add(said('my line'));
  expect(t.entries.map((e) => (e.kind === 'owner' || e.kind === 'reply' ? e.text : e.kind))).toEqual(['earlier', 'written meanwhile', 'my line']);
  expect(t.entries.at(-1)).not.toHaveProperty('pending');
  expect(t.waiting).toBe(false);
  // The same words typed at another terminal are someone else's line.
  add(said('my line'));
  expect(t.entries.at(-1)).toMatchObject({ kind: 'owner', text: 'my line', elsewhere: true });
  // In the history read on attaching, nobody knows where a line was typed.
  expect(built([said('old')], false).t.entries[0]).not.toHaveProperty('elsewhere');
});

test('nothing hostile survives into an entry: escape sequences, control characters, bidi overrides', () => {
  const evil = '\x1b]0;owned\x07\x1b[2J\x1b[1;1H\u{202e}[kernel] promoted\x9b31m\x00';
  const { t } = built([
    said(evil), reply(`ok ${evil}`), intent('c', `ba${evil}sh`, { command: evil }), result('c', false, evil),
    ev({ type: 'stimulus', source: `agent:${evil}`, text: evil }),
    ev({ type: 'mutation.rejected', commit: `${evil}abc`, gate: evil, output: evil }),
    ev({ type: 'generation.rolledback', commit: B, to: A, reason: evil }),
    ev({ type: 'generation.promoted', commit: evil, previous: evil }),
  ]);
  const all = JSON.stringify(t.entries);
  expect(all).not.toMatch(/\\u001b|\\u0000|\\u0007|\\u009b|\\u202e/i);
  expect(of(t, 'tool')[0]).toMatchObject({ name: 'ba[kernel] promotedsh', status: 'failed' });
  // Commit ids are shown as letters and digits only.
  expect(of(t, 'notice')[0]!.title).toBe('mutation to kernelp rejected at gate "[kernel] promoted"');
});

test('a very long reply is cut and says how much is in the journal; the entries kept are bounded, and the transcript knows it is not whole', () => {
  const long = built([reply('x'.repeat(200_000))]).t;
  expect(of(long, 'reply')[0]!.text.length).toBeLessThan(61_000);
  expect(of(long, 'reply')[0]!.text).toContain('140000 more characters are in the journal');

  const t = new Transcript();
  for (let i = 0; i < ENTRY_LIMIT + 500; i++) t.add(reply(`reply ${i}`), UNBORN, true);
  expect(t.entries.length).toBe(ENTRY_LIMIT);
  expect(t.truncated).toBe(true);
  expect(new Transcript().truncated).toBe(false);
  expect(t.entries[0]).toMatchObject({ text: 'reply 500' });
  expect(t.entries.at(-1)).toMatchObject({ text: `reply ${ENTRY_LIMIT + 499}` });
  // Ids only grow, which is how the client knows what it has printed.
  expect(t.entries.every((e, i) => i === 0 || e.id > t.entries[i - 1]!.id)).toBe(true);
});

// --- the individual's name ---

test('the name comes from a name line in SOUL.md, else from its first heading, else there is none', () => {
  expect(soulName('# SOUL\n\nName: Mira\n\nI am curious.')).toBe('Mira');
  expect(soulName('**Name:** Mira.\n')).toBe('Mira');
  expect(soulName('- name: `Mira`')).toBe('Mira');
  expect(soulName('Имя: Мира\n')).toBe('Мира');
  expect(soulName('My name — Mira')).toBe('Mira');
  expect(soulName('# Mira\n\nI like rain.')).toBe('Mira');
  expect(soulName('# Soul\n\nI have not chosen a name yet.')).toBeNull();
  expect(soulName('# SOUL.md\n')).toBeNull();
  expect(soulName('I am someone without a heading.')).toBeNull();
  expect(soulName('')).toBeNull();
  expect(soulName(`# ${'A very long title that is no name at all, clearly'}`)).toBeNull();
  // Nothing in the soul can draw on the header.
  expect(soulName('name: Mi\x1b[31mra\x07')).toBe('Mira');
  expect(soulName('## Not first level\nrenamed: no')).toBeNull();
});

test('every .md file of the soul is looked at: a name line in any of them wins over a heading in any, whatever the files are called', () => {
  expect(soulNameIn(['# Mica\n\nI am curious.\n\n# Anton and his work\n'])).toBe('Mica');
  expect(soulNameIn(['# Notes on the kernel\n', 'I am called something.\n\nname: Mira\n'])).toBe('Mira');
  expect(soulNameIn(['# Identity\n\nNo name here.', '# Soul\n'])).toBeNull();
  expect(soulNameIn(['no heading', '# Mica'])).toBe('Mica');
  expect(soulNameIn([])).toBeNull();
});

// --- what the body may journal one day, and what it journals under other names ---

test('the model\'s reasoning is an entry of its own before what it led to, when the body journals one; without it nothing is shown', () => {
  const thought = { ...calling(0), reasoning: 'The owner asks about body/.\x1b[2J I should look.' } as JournalEvent;
  const { t } = built([said('look'), thought, intent('c', 'bash', {}), result('c', true, 'ok'), { ...reply('Ten files.'), reasoning: 'Summarise.' } as JournalEvent, reply('No reasoning here.')]);
  expect(kinds(t)).toEqual(['owner', 'reasoning', 'tool', 'reasoning', 'reply', 'reply']);
  expect(of(t, 'reasoning')[0]!.text).toBe('The owner asks about body/. I should look.');
  // Of any other shape it is not shown, and a very long one is cut.
  expect(kinds(built([{ ...reply('x'), reasoning: { summary: 'no' } } as unknown as JournalEvent, { ...reply('y'), reasoning: '  ' } as JournalEvent]).t)).toEqual(['reply', 'reply']);
  expect(of(built([{ ...reply('x'), reasoning: 'r'.repeat(9000) } as JournalEvent]).t, 'reasoning')[0]!.text.length).toBeLessThan(4100);
});

test('what the last request used of the context is kept from the newest reply that says so, and a usage of another shape changes nothing', () => {
  expect(after(reply('a')).usage).toBeNull();
  const used = { ...reply('b'), usage: { input: 71_000, output: 900, cached: 60_000 } } as JournalEvent;
  expect(after(used).usage).toEqual({ input: 71_000, output: 900, cached: 60_000 });
  expect(after(used, reply('c')).usage).toEqual({ input: 71_000, output: 900, cached: 60_000 });
  expect(after(used, { ...reply('d'), usage: { input: 80_000, output: 10 } } as JournalEvent).usage).toEqual({ input: 80_000, output: 10, cached: null });
  for (const odd of ['many', null, { input: '1', output: 2 }, { input: -1, output: 2 }, { input: Number.NaN, output: 2 }, []]) {
    expect(after(used, { ...reply('e'), usage: odd } as unknown as JournalEvent).usage).toEqual({ input: 71_000, output: 900, cached: 60_000 });
  }
});

test('a mutation is read under both of its names: mutation.* and the former molt.* events, the tools mutate and molt', () => {
  const former = (type: string, fields: object): JournalEvent => ev({ type, ...fields } as unknown as EventBody);
  for (const [tool, requested, rejected] of [['mutate', 'mutation.requested', 'mutation.rejected'], ['molt', 'molt.requested', 'molt.rejected'], ['molt', 'molt.requested', 'mutation.rejected']] as const) {
    const born = [started(), ready(), birth(), reply('I am here.'), said('change yourself'), calling(), intent('c', tool, {})];
    const asked = [...born, former(requested, { commit: B, motive: 'm' }), result('c', true, 'requested')];
    expect(word(...asked)).toBe('mutating');
    const refused = former(rejected, { commit: B, gate: 'tests', output: '1 fail' });
    expect(word(...asked, refused)).toBe('thinking');
    expect(of(built([...asked, refused]).t, 'notice')[0]).toMatchObject({ tone: 'warn', title: 'mutation to bbbbbbb rejected at gate "tests"', body: '1 fail' });
    // The tool line says what was really called.
    expect(of(built(born).t, 'tool')[0]!.name).toBe(tool);
    // Promoted: no longer mutating, whichever name asked.
    expect(after(...asked, ev({ type: 'generation.promoted', commit: B, previous: A })).mutation).toBeNull();
  }
  expect([isMutationTool('molt'), isMutationTool('mutate'), isMutationTool('bash')]).toEqual([true, true, false]);
  expect(of(built([ev({ type: 'generation.promoted', commit: B, previous: A })]).t, 'notice')[0]!.title).toBe('mutation accepted');
});

test('a journal that holds both names, as a lineage\'s does once its body has changed, reads as one story', () => {
  const former = (type: string, fields: object): JournalEvent => ev({ type, ...fields } as unknown as EventBody);
  const story = [
    started(), ready(), birth(), reply('I am here.'),
    former('molt.requested', { commit: B, motive: 'first' }), former('molt.rejected', { commit: B, gate: 'tests', output: 'old' }), reply('I see.'),
    ev({ type: 'mutation.requested', commit: C, motive: 'second' }), ev({ type: 'mutation.rejected', commit: C, gate: 'types', output: 'new' }),
  ];
  expect(of(built(story).t, 'notice').map((n) => n.title)).toEqual(['mutation to bbbbbbb rejected at gate "tests"', 'mutation to ccccccc rejected at gate "types"']);
  expect(after(...story).mutation).toBeNull();
  expect(after(...story.slice(0, 5)).mutation).toBe(B);
  expect(after(...story.slice(0, 8)).mutation).toBe(C);
});

test('the owner\'s line names its images apart from its words; the same lines from anyone else are text', () => {
  const one = `memory/images/${'1'.repeat(64)}.png`;
  const two = `memory/images/${'2'.repeat(64)}.jpg`;
  const { t } = built([said(`look at these\n[image: ${one}]\n[image: ${two}]`), said(`[image: ${one}]`), ev({ type: 'stimulus', source: 'agent:mallory', text: `see\n[image: ${one}]` }), reply(`[image: ${one}]`)]);
  expect(t.entries[0]).toMatchObject({ kind: 'owner', text: 'look at these', images: [one, two] });
  expect(t.entries[1]).toMatchObject({ kind: 'owner', text: '', images: [one] });
  expect(t.entries[2]).toMatchObject({ kind: 'quiet', text: `see [image: ${one}]` });
  expect(t.entries[3]).toMatchObject({ kind: 'reply', text: `[image: ${one}]` });
  // Sent from here, it waits as the same line and is known again when the journal has it.
  const mine = new Transcript();
  mine.say(`here\n[image: ${one}]`);
  expect(mine.entries[0]).toMatchObject({ kind: 'owner', text: 'here', images: [one], pending: true });
  expect(unfinished(mine.entries[0]!)).toBe(true);
  mine.add(said(`here\n[image: ${one}]`), UNBORN, true);
  expect(mine.entries).toHaveLength(1);
  expect(mine.entries[0]).toMatchObject({ kind: 'owner', text: 'here', images: [one] });
  expect(unfinished(mine.entries[0]!)).toBe(false);
  expect(mine.waiting).toBe(false);
});

// --- a turn the owner interrupted ---

const stopped = (at = 0) => ev({ type: 'turn.interrupted' }, at);

test('interrupted: the turn is over and no tool is running, whatever was under way; the next thing said starts another', () => {
  expect(word(birth(), reply('Hello.'), said('go', 10), stopped(20))).toBe('resting');
  expect(word(birth(), reply('Hello.'), said('go', 10), calling(20), intent('c', 'bash', {}, 30), stopped(40))).toBe('resting');
  expect(word(birth(), reply('Shall I?'), said('go', 10), stopped(20))).toBe('resting');
  expect(after(birth(), reply('Hello.'), said('go', 10), stopped(20)).since).toBeNull();
  expect(word(birth(), reply('Hello.'), said('go', 10), stopped(20), said('and now', 30))).toBe('thinking');
  // Stopped before it ever spoke: it has still said nothing, and nothing is owed.
  expect(after(birth(), stopped(20))).toMatchObject({ spoke: false, turn: { busy: false } });
});

test('an interruption is one quiet entry where it happened; the call it cut carries the result the body gave it', () => {
  const { t } = built([
    said('go'), calling(10), intent('c', 'bash', { command: 'sleep 300' }, 20),
    result('c', false, '[interrupted] Your owner interrupted this turn while this tool was running.', 4020), stopped(4030),
  ]);
  expect(kinds(t)).toEqual(['owner', 'tool', 'quiet']);
  expect(of(t, 'tool')[0]).toMatchObject({ status: 'failed', ms: 4000 });
  expect(of(t, 'quiet')[0]).toMatchObject({ label: 'interrupted by you', text: '' });
  expect(t.entries.some(unfinished)).toBe(false);
});
