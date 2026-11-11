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
  expect(buildMessages([said('hi'), replied('hello')], 'SYS')).toEqual([
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
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
  const messages = buildMessages(events, 'S', 40);
  expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
  expect(messages[1]!.content).toBe('new');
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
