import { expect, test } from 'bun:test';
import { buildMessages, needsTurn } from '../../body/context';
import type { EventBody, JournalEvent } from '../../kernel/journal';

let n = 0;
function ev(body: EventBody, gen = 'g1'): JournalEvent {
  n += 1;
  return { v: 1, id: `e${n}`, ts: '2026-11-11T00:00:00.000Z', gen, ...body } as JournalEvent;
}
const said = (text: string, source = 'terminal') => ev({ type: 'stimulus', source, text });
const replied = (text: string) => ev({ type: 'assistant', text, toolCalls: [] });
const called = (id: string) => ev({ type: 'assistant', text: '', toolCalls: [{ id, name: 'bash', args: { command: 'ls' } }] });

test('the system prompt comes first, then the conversation', () => {
  // Ends with something to answer, as every list the loop builds does; a list ending on a reply is tested below.
  expect(buildMessages([said('hi'), replied('hello'), said('and you?')], 'SYS')).toEqual([
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'and you?' },
  ]);
});

test('a stimulus from another sensor is labelled with its source', () => {
  expect(buildMessages([said('tick', 'clock')], 'S')[1]).toEqual({ role: 'user', content: '[clock] tick' });
});

test('a tool call is followed by its result', () => {
  const messages = buildMessages([
    said('go'), called('c1'),
    ev({ type: 'tool.intent', callId: 'c1', name: 'bash', args: {} }),
    ev({ type: 'tool.result', callId: 'c1', ok: true, output: 'exit 0' }),
  ], 'S');
  expect(messages[2]).toEqual({
    role: 'assistant', content: null,
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
  });
  expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'exit 0' });
  expect(messages).toHaveLength(4);
});

test('a call that started but never finished is reported as interrupted', () => {
  const messages = buildMessages([said('go'), called('c1'), ev({ type: 'tool.intent', callId: 'c1', name: 'bash', args: {} })], 'S');
  expect(messages[3]!.content).toContain('[interrupted]');
});

test('a call that never started is reported as safe to repeat', () => {
  const messages = buildMessages([said('go'), called('c1')], 'S');
  expect(messages[3]!.content).toContain('[not started]');
});

test('a stimulus that arrived while a tool ran is placed after the result', () => {
  const messages = buildMessages([
    said('go'), called('c1'), said('wait'),
    ev({ type: 'tool.result', callId: 'c1', ok: true, output: 'done' }),
  ], 'S');
  expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
});

test('kernel events become [kernel] messages', () => {
  const messages = buildMessages([
    ev({ type: 'molt.rejected', commit: 'bbb', gate: 'tests', output: '1 fail' }, 'aaa'),
    ev({ type: 'generation.promoted', commit: 'ccc', previous: 'aaa' }, 'ccc'),
    ev({ type: 'generation.rolledback', commit: 'ccc', to: 'aaa', reason: 'exited with 1 before it was ready' }, 'aaa'),
    ev({ type: 'generation.started', commit: 'aaa' }, 'aaa'),
    ev({ type: 'generation.ready', commit: 'aaa' }, 'aaa'),
  ], 'S');
  expect(messages).toHaveLength(4);
  expect(messages[1]!.content).toContain('rejected at gate "tests"');
  expect(messages[1]!.content).toContain('1 fail');
  expect(messages[2]!.content).toContain('now running generation ccc');
  expect(messages[3]!.content).toContain('rolled back');
});

test('over budget, the oldest messages go and no orphan tool result leads', () => {
  const events = [
    said('old '.repeat(50)), called('c1'),
    ev({ type: 'tool.result', callId: 'c1', ok: true, output: 'r'.repeat(100) }),
    said('new'), replied('answer'),
  ];
  // Room for 'new', 'answer' and the note that follows a closing reply, which counts like any message.
  const messages = buildMessages(events, 'S', 160);
  expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  expect(messages[1]!.content).toBe('new');
  expect(messages[2]!.content).toBe('answer');
  expect(messages[3]!.content).toBe(LATE);
});

test('needsTurn', () => {
  expect(needsTurn([])).toBe(false);
  expect(needsTurn([said('hi')])).toBe(true);
  expect(needsTurn([said('hi'), replied('hello')])).toBe(false);
  expect(needsTurn([said('hi'), called('c1')])).toBe(true);
  expect(needsTurn([said('hi'), called('c1'), ev({ type: 'tool.result', callId: 'c1', ok: true, output: '' })])).toBe(true);
  expect(needsTurn([replied('done'), ev({ type: 'generation.started', commit: 'a' }), ev({ type: 'generation.ready', commit: 'a' })])).toBe(false);
  expect(needsTurn([replied('done'), ev({ type: 'generation.promoted', commit: 'b', previous: 'a' })])).toBe(true);
});

const intent = (callId: string) => ev({ type: 'tool.intent', callId, name: 'bash', args: {} });
const result = (callId: string, output: string) => ev({ type: 'tool.result', callId, ok: true, output });
const toolContents = (events: JournalEvent[]) => buildMessages(events, 'S').filter((m) => m.role === 'tool').map((m) => m.content);

test('a model that reuses a call id gets each result with its own call', () => {
  expect(toolContents([
    said('go'), called('c'), intent('c'), result('c', 'first'),
    called('c'), intent('c'), result('c', 'second'),
  ])).toEqual(['first', 'second']);
});

test('an earlier result is never shown for a later interrupted call with the same id', () => {
  const contents = toolContents([said('go'), called('c'), intent('c'), result('c', 'first'), called('c'), intent('c')]);
  expect(contents[0]).toBe('first');
  expect(contents[1]).toContain('[interrupted]');
  const unstarted = toolContents([said('go'), called('c'), intent('c'), result('c', 'first'), called('c')]);
  expect(unstarted[1]).toContain('[not started]');
});

test('the same id twice in one reply: results are given out in the order the calls ran', () => {
  const twice = ev({ type: 'assistant', text: '', toolCalls: [{ id: 'c', name: 'bash', args: {} }, { id: 'c', name: 'bash', args: {} }] });
  expect(toolContents([said('go'), twice, intent('c'), result('c', 'first'), intent('c'), result('c', 'second')])).toEqual(['first', 'second']);
  const crashed = toolContents([said('go'), twice, intent('c'), result('c', 'first'), intent('c')]);
  expect(crashed[0]).toBe('first');
  expect(crashed[1]).toContain('[interrupted]');
  const early = toolContents([said('go'), twice, intent('c'), result('c', 'first')]);
  expect(early[1]).toContain('[not started]');
});

test('an exchange too large for the budget is replaced by a note, never an orphan tool result', () => {
  const huge = ev({ type: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'write', args: { content: 'x'.repeat(500) } }] });
  const messages = buildMessages([said('go'), huge, result('c1', 'wrote 500 characters')], 'S', 100);
  expect(messages).toHaveLength(2);
  expect(messages[1]!.role).toBe('user');
  expect(messages[1]!.content).toContain('too large');
});

test('trimming never leaves an assistant message first', () => {
  const messages = buildMessages([said('old '.repeat(50)), replied('answer one'), replied('answer two'), said('new')], 'S', 40);
  expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
  expect(messages[1]!.content).toBe('new');

  const onlyReplies = buildMessages([said('old '.repeat(50)), replied('answer')], 'S', 40);
  expect(onlyReplies.map((m) => m.role)).toEqual(['system', 'user']);
  expect(onlyReplies[1]!.content).toContain('too large');
});

test('a journal with nothing to show still gives a request a provider accepts, and does not claim anything was dropped', () => {
  for (const events of [[], [ev({ type: 'generation.started', commit: 'a' })], [replied('')]]) {
    const messages = buildMessages(events, 'S');
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[1]!.content).toContain('nothing');
    expect(messages[1]!.content).not.toContain('dropped');
  }
});

const LATE = '[context] Something arrived while you were writing your last reply; it is shown above, before that reply. Respond to it now.';

test('a list that would end with a plain reply ends with a note instead: what came before that reply is still unanswered', () => {
  // The journal order when a stimulus lands while the model is replying: both stimuli, then the reply to the first.
  expect(buildMessages([said('first'), said('second'), replied('answer to first')], 'S')).toEqual([
    { role: 'system', content: 'S' },
    { role: 'user', content: 'first' },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: 'answer to first' },
    { role: 'user', content: LATE },
  ]);
});

test('a reply that ends with tool calls, or a list that ends with a user message, gets no such note', () => {
  const texts = (events: JournalEvent[]) => buildMessages(events, 'S').map((m) => m.content);
  expect(texts([said('hi')])).not.toContain(LATE);
  expect(texts([said('hi'), replied('hello'), said('more')])).not.toContain(LATE);
  expect(texts([said('go'), called('c1'), intent('c1'), result('c1', 'out')])).not.toContain(LATE);
});

test('two plain replies in a row are shown as one, separated by a blank line', () => {
  const late = [said('first'), said('second'), replied('answer to first'), replied('answer to second')];
  expect(buildMessages([...late, said('third')], 'S')).toEqual([
    { role: 'system', content: 'S' },
    { role: 'user', content: 'first' },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: 'answer to first\n\nanswer to second' },
    { role: 'user', content: 'third' },
  ]);
  // Events that are not shown do not keep two replies apart.
  const apart = buildMessages([said('a'), replied('one'), ev({ type: 'generation.started', commit: 'a' }), replied('two'), replied('three'), said('b')], 'S');
  expect(apart.map((m) => m.content)).toEqual(['S', 'a', 'one\n\ntwo\n\nthree', 'b']);
  // An empty reply adds nothing, and no stray blank lines.
  const empty = buildMessages([said('a'), replied(''), replied('two'), replied(''), said('b')], 'S');
  expect(empty.map((m) => m.content)).toEqual(['S', 'a', 'two', 'b']);
});

test('a plain reply after a reply with tool calls stays its own message', () => {
  const messages = buildMessages([said('go'), called('c1'), intent('c1'), result('c1', 'out'), replied('done'), said('next')], 'S');
  expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'user']);
});

// The journal is permanent and replayed into every request. Whatever is in it, the request must be one a provider accepts.
const raw = (body: Record<string, unknown>) => ev(body as unknown as EventBody);
const callsOn = (events: JournalEvent[], budget?: number) => buildMessages(events, 'S', budget).flatMap((m) => m.tool_calls ?? []);

test('a tool name goes on the wire in the characters a provider accepts, 64 at most, and is `unknown` when there is none', () => {
  const names = ['bash', 'functions.read:0', 'we ird/näme', 'n'.repeat(100), '', 7, null, undefined];
  const event = raw({ type: 'assistant', text: '', toolCalls: names.map((name, i) => ({ id: `c${i}`, name, args: {} })) });
  expect(callsOn([said('go'), event]).map((c) => c.function.name)).toEqual([
    'bash', 'functions_read_0', 'we_ird_n_me', 'n'.repeat(64), 'unknown', 'unknown', 'unknown', 'unknown',
  ]);
});

test('arguments on the wire are always a JSON object: anything else is wrapped as _raw', () => {
  const args = [{ path: 'a' }, '{oops', '', null, [1, 2], 5, true, undefined];
  const event = raw({ type: 'assistant', text: '', toolCalls: args.map((a, i) => ({ id: `c${i}`, name: 'bash', args: a })) });
  expect(callsOn([said('go'), event]).map((c) => c.function.arguments)).toEqual([
    '{"path":"a"}', '{"_raw":"{oops"}', '{"_raw":""}', '{"_raw":"null"}', '{"_raw":"[1,2]"}', '{"_raw":"5"}', '{"_raw":"true"}', '{}',
  ]);
});

test('ids on the wire are unique in the whole request, not empty and at most 40 characters; each result carries its call\'s wire id', () => {
  const long = 'x'.repeat(41);
  const first = raw({ type: 'assistant', text: '', toolCalls: [{ id: 'a', name: 'bash', args: {} }, { id: '', name: 'bash', args: {} }, { name: 'bash', args: {} }] });
  const second = raw({ type: 'assistant', text: '', toolCalls: [{ id: 'a', name: 'bash', args: {} }, { id: long, name: 'bash', args: {} }, { id: 'call_2', name: 'bash', args: {} }, { id: 9, name: 'bash', args: {} }] });
  const messages = buildMessages([
    said('go'), first, result('a', 'first a'), result('', 'empty id'),
    second, result('a', 'second a'), result(long, 'long id'), result('call_2', 'named like a position'),
  ], 'S');
  const ids = messages.flatMap((m) => m.tool_calls ?? []).map((c) => c.id);
  expect(ids[0]).toBe('a');
  expect(new Set(ids).size).toBe(7);
  expect(ids.every((id) => typeof id === 'string' && id !== '' && id.length <= 40)).toBe(true);
  const tools = messages.filter((m) => m.role === 'tool');
  expect(tools.map((m) => m.tool_call_id)).toEqual(ids);
  expect(tools.map((m) => m.content!.slice(0, 13))).toEqual(['first a', 'empty id', '[not started]', 'second a', 'long id', 'named like a ', '[not started]']);
});

test('wire ids do not change when the front of the journal is cut away', () => {
  const events = [said('go'), called(''), result('', 'one'), said('more'), called(''), result('', 'two')];
  const whole = buildMessages(events, 'S');
  const cut = buildMessages(events, 'S', 150);
  expect(cut.length).toBeLessThan(whole.length);
  expect(cut.at(-1)).toEqual(whole.at(-1)!);
});

test('events in older shapes are read as empty rather than thrown on', () => {
  const noCalls = raw({ type: 'assistant', text: 'old reply' });
  const noText = raw({ type: 'assistant', toolCalls: [{ id: 'c1', name: 'bash', args: {} }] });
  const junk = raw({ type: 'assistant', text: 5, toolCalls: 'none' });
  const badCalls = raw({ type: 'assistant', text: '', toolCalls: [null, 'x', { id: 'c2' }] });
  const messages = buildMessages([
    said('go'), noCalls, said('more'), noText, raw({ type: 'tool.result', callId: 'c1', ok: true }), junk, badCalls,
    raw({ type: 'stimulus' }), raw({ type: 'molt.rejected' }),
  ], 'S');
  expect(messages[2]).toEqual({ role: 'assistant', content: 'old reply' });
  expect(messages[4]!.tool_calls).toHaveLength(1);
  expect(messages[5]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '' });
  expect(messages.flatMap((m) => m.tool_calls ?? []).map((c) => c.function.name)).toEqual(['bash', 'unknown', 'unknown', 'unknown']);
  expect(needsTurn([said('go'), noCalls])).toBe(false);
  expect(needsTurn([said('go'), noText])).toBe(true);
  expect(needsTurn([said('go'), junk])).toBe(false);
});

test('an empty reply is not sent, but still counts as the turn having been taken', () => {
  for (const text of ['', '  \n']) {
    const events = [said('hi'), replied(text)];
    expect(buildMessages(events, 'S')).toEqual([{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }]);
    expect(needsTurn(events)).toBe(false);
  }
});

test('a plain reply directly before a reply with tool calls is folded into it', () => {
  const withText = ev({ type: 'assistant', text: 'now the tool', toolCalls: [{ id: 'c1', name: 'bash', args: {} }] });
  const folded = buildMessages([said('a'), said('b'), replied('answer to a'), withText, result('c1', 'out')], 'S');
  expect(folded.map((m) => m.role)).toEqual(['system', 'user', 'user', 'assistant', 'tool']);
  expect(folded[3]!.content).toBe('answer to a\n\nnow the tool');
  expect(folded[3]!.tool_calls).toHaveLength(1);
  const silent = buildMessages([said('a'), replied('answer to a'), called('c1'), result('c1', 'out')], 'S');
  expect(silent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
  expect(silent[2]!.content).toBe('answer to a');
});

test('everything sent is well-formed Unicode, whatever an old journal holds', () => {
  const lone = 'a\ud83dz';
  const messages = buildMessages([
    said(lone), ev({ type: 'assistant', text: lone, toolCalls: [{ id: `c${lone}`, name: 'bash', args: { command: lone } }] }),
    result(`c${lone}`, lone), ev({ type: 'molt.rejected', commit: 'b', gate: 'tests', output: lone }),
  ], lone);
  expect(messages).toHaveLength(5);
  for (const m of messages) {
    expect(m.content!.isWellFormed()).toBe(true);
    expect(JSON.stringify(m).includes('\\ud83d')).toBe(false);
  }
  expect(messages[1]!.content).toBe('a\ufffdz');
});

test('the system prompt counts against the budget', () => {
  const events = [said('a'.repeat(100)), replied('b'.repeat(100)), said('c'.repeat(100))];
  expect(buildMessages(events, 'S', 310)).toHaveLength(4);
  expect(buildMessages(events, 'S'.repeat(50), 310).map((m) => m.role)).toEqual(['system', 'user']);
});

test('a newest stimulus too large for what is left is cut to fit, head and tail, not dropped', () => {
  const big = `HEAD${'x'.repeat(5000)}TAIL`;
  const total = (messages: ReturnType<typeof buildMessages>) => messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  const messages = buildMessages([said('a'.repeat(600)), replied('fine'), said(big)], 'S', 1000);
  expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
  const shown = messages[1]!.content!;
  expect(shown.startsWith('HEADxxx')).toBe(true);
  expect(shown.endsWith('xxxTAIL')).toBe(true);
  expect(shown).toContain('characters dropped here');
  expect(total(messages)).toBeLessThanOrEqual(1000);
  expect(shown.length).toBeGreaterThan(800);

  // It is cut to what the budget leaves, so short messages before it may stay.
  const kept = buildMessages([said('old'), replied('fine'), said(big)], 'S', 1000);
  expect(kept.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  expect(total(kept)).toBeLessThanOrEqual(1000);

  // What follows it must still fit: the exchange after it is kept whole, the stimulus gives way.
  const then = buildMessages([said(big), called('c1'), result('c1', 'r'.repeat(300))], 'S', 1000);
  expect(then.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
  expect(then[1]!.content).toContain('characters dropped here');
  expect(then.reduce((sum, m) => sum + (m.content?.length ?? 0) + JSON.stringify(m.tool_calls ?? '').length, 0)).toBeLessThanOrEqual(1000);
});

test('a kernel note carries at most 4000 characters of gate output, both ends kept', () => {
  const note = buildMessages([ev({ type: 'molt.rejected', commit: 'b', gate: 'tests', output: `FIRST${'x'.repeat(10_000)}LAST` })], 'S')[1]!.content!;
  expect(note.length).toBeLessThan(4300);
  expect(note).toContain('FIRSTxx');
  expect(note.endsWith('xxLAST')).toBe(true);
  expect(note).toContain('characters dropped here');
});

test('the default budget is 250,000 characters', () => {
  const messages = buildMessages([said('a'.repeat(200_000)), replied('ok'), said('b'.repeat(100_000))], 'S');
  expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
  expect(messages[1]!.content).toBe('b'.repeat(100_000));
});

test('a stimulus with no text is shown as an empty message, since a provider takes no empty content', () => {
  expect(buildMessages([said(''), said(' \n')], 'S').map((m) => m.content)).toEqual(['S', '[empty message]', '[empty message]']);
});
