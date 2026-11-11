import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTurn } from '../../body/loop';
import type { ChatMessage, Provider, Reply } from '../../body/provider';
import type { Tool, ToolContext } from '../../body/tools';
import { appendEvent, readEvents } from '../../kernel/journal';

function setup(replies: Reply[], tools: Tool[] = []) {
  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-loop-')), 'journal.jsonl');
  const ctx: ToolContext = { workspace: '/tmp', journal, gen: 'g1', moltCommit: null };
  const seen: ChatMessage[][] = [];
  const provider: Provider = async (messages) => {
    seen.push(messages);
    const next = replies.shift();
    if (!next) throw new Error('the script ran out of replies');
    return next;
  };
  appendEvent(journal, 'g1', { type: 'stimulus', source: 'terminal', text: 'go' });
  return { journal, ctx, seen, deps: { journal, gen: 'g1', provider, tools, system: 'SYS', ctx } };
}

const echo: Tool = {
  spec: { name: 'echo', description: '', parameters: {} },
  async run(args) { return `echo:${JSON.stringify(args)}`; },
};

test('a plain reply is journaled and ends the turn', async () => {
  const s = setup([{ text: 'hello', toolCalls: [] }]);
  const shown: string[] = [];
  expect(await runTurn({ ...s.deps, onText: (t) => shown.push(t) })).toBe('done');
  expect(readEvents(s.journal).map((e) => e.type)).toEqual(['stimulus', 'assistant']);
  expect(shown).toEqual(['hello']);
});

test('the intent is journaled before the tool runs, the result after', async () => {
  let typesWhenRun: string[] = [];
  const spy: Tool = {
    spec: { name: 'spy', description: '', parameters: {} },
    async run(_args, ctx) { typesWhenRun = readEvents(ctx.journal).map((e) => e.type); return 'ok'; },
  };
  const s = setup([{ text: '', toolCalls: [{ id: 'c1', name: 'spy', args: {} }] }, { text: 'done', toolCalls: [] }], [spy]);

  await runTurn(s.deps);

  expect(typesWhenRun).toEqual(['stimulus', 'assistant', 'tool.intent']);
  expect(readEvents(s.journal).map((e) => e.type)).toEqual(['stimulus', 'assistant', 'tool.intent', 'tool.result', 'assistant']);
  expect(s.seen[1]!.at(-1)).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'ok' });
});

test('a tool that throws becomes a failed result the model can read', async () => {
  const boom: Tool = { spec: { name: 'boom', description: '', parameters: {} }, async run() { throw new Error('kaput'); } };
  const s = setup([{ text: '', toolCalls: [{ id: 'c1', name: 'boom', args: {} }] }, { text: 'ok', toolCalls: [] }], [boom]);
  await runTurn(s.deps);
  const result = readEvents(s.journal).find((e) => e.type === 'tool.result');
  expect(result).toMatchObject({ ok: false, output: 'error: kaput' });
});

test('an unknown tool is a failed result, not a crash', async () => {
  const s = setup([{ text: '', toolCalls: [{ id: 'c1', name: 'nope', args: {} }] }, { text: 'ok', toolCalls: [] }]);
  await runTurn(s.deps);
  expect(readEvents(s.journal).find((e) => e.type === 'tool.result')).toMatchObject({ ok: false, output: 'error: unknown tool: nope' });
});

test('a molt ends the turn without another model call', async () => {
  const molter: Tool = {
    spec: { name: 'molt', description: '', parameters: {} },
    async run(_args, ctx) { ctx.moltCommit = 'abc'; return 'requested'; },
  };
  const s = setup([{ text: 'molting', toolCalls: [{ id: 'c1', name: 'molt', args: {} }] }], [molter]);
  expect(await runTurn(s.deps)).toBe('molt');
  expect(s.seen).toHaveLength(1);
});

test('the round limit ends the turn with a note', async () => {
  const call = { text: '', toolCalls: [{ id: 'c', name: 'echo', args: {} }] };
  const s = setup([call, call, call], [echo]);
  expect(await runTurn({ ...s.deps, maxRounds: 2 })).toBe('done');
  const last = readEvents(s.journal).at(-1)!;
  expect(last).toMatchObject({ type: 'assistant', toolCalls: [] });
  expect(s.seen).toHaveLength(2);
});

test('a model that reuses a call id still sees each result with its own call', async () => {
  let runs = 0;
  const counter: Tool = { spec: { name: 'count', description: '', parameters: {} }, async run() { runs += 1; return `run ${runs}`; } };
  const call = { text: '', toolCalls: [{ id: 'c', name: 'count', args: {} }] };
  const s = setup([call, call, { text: 'done', toolCalls: [] }], [counter]);
  await runTurn(s.deps);
  expect(s.seen[2]!.filter((m) => m.role === 'tool').map((m) => m.content)).toEqual(['run 1', 'run 2']);
});

test('a stimulus that arrives while the last reply is on its way gets another round', async () => {
  const s = setup([]);
  const seen: ChatMessage[][] = [];
  const provider: Provider = async (messages) => {
    seen.push(messages);
    if (seen.length === 1) {
      appendEvent(s.journal, 'g1', { type: 'stimulus', source: 'terminal', text: 'one more thing' });
      return { text: 'first answer', toolCalls: [] };
    }
    return { text: 'second answer', toolCalls: [] };
  };

  expect(await runTurn({ ...s.deps, provider })).toBe('done');

  expect(seen).toHaveLength(2);
  expect(seen[0]!.some((m) => m.content === 'one more thing')).toBe(false);
  expect(seen[1]!.some((m) => m.role === 'user' && m.content === 'one more thing')).toBe(true);
  expect(readEvents(s.journal).map((e) => e.type)).toEqual(['stimulus', 'stimulus', 'assistant', 'assistant']);
});

test('a kernel note that arrives while the last reply is on its way gets another round; other events do not', async () => {
  const during = async (body: Parameters<typeof appendEvent>[2]) => {
    const s = setup([]);
    let calls = 0;
    const provider: Provider = async () => {
      calls += 1;
      if (calls === 1) appendEvent(s.journal, 'g1', body);
      return { text: 'answer', toolCalls: [] };
    };
    await runTurn({ ...s.deps, provider });
    return calls;
  };
  expect(await during({ type: 'molt.rejected', commit: 'b', gate: 'tests', output: '1 fail' })).toBe(2);
  expect(await during({ type: 'generation.ready', commit: 'g1' })).toBe(1);
});

test('after a molt the rest of the reply is not run, and every call still has a result', async () => {
  let written = false;
  const molter: Tool = {
    spec: { name: 'molt', description: '', parameters: {} },
    async run(_args, ctx) { ctx.moltCommit = 'abc'; return 'requested'; },
  };
  const writer: Tool = { spec: { name: 'write', description: '', parameters: {} }, async run() { written = true; return 'wrote'; } };
  const s = setup([{ text: '', toolCalls: [{ id: 'c1', name: 'molt', args: {} }, { id: 'c2', name: 'write', args: {} }] }], [molter, writer]);

  expect(await runTurn(s.deps)).toBe('molt');

  expect(written).toBe(false);
  const events = readEvents(s.journal);
  expect(events.map((e) => e.type)).toEqual(['stimulus', 'assistant', 'tool.intent', 'tool.result', 'tool.result']);
  expect(events[3]).toMatchObject({ callId: 'c1', ok: true, output: 'requested' });
  expect(events[4]).toMatchObject({ callId: 'c2', ok: false });
  expect((events[4] as { output: string }).output).toMatch(/not run.*molt/);
});

test('a tool that returns something other than text does not lose its result', async () => {
  const odd = (value: unknown): Tool => ({ spec: { name: 'odd', description: '', parameters: {} }, async run() { return value as string; } });
  for (const [value, text] of [[42, '42'], [undefined, 'undefined'], [{ a: 1 }, '[object Object]']] as const) {
    const s = setup([{ text: '', toolCalls: [{ id: 'c1', name: 'odd', args: {} }] }, { text: 'ok', toolCalls: [] }], [odd(value)]);
    await runTurn(s.deps);
    expect(readEvents(s.journal).find((e) => e.type === 'tool.result')).toMatchObject({ ok: true, output: text });
    expect(s.seen[1]!.at(-1)).toEqual({ role: 'tool', tool_call_id: 'c1', content: text });
  }
});
