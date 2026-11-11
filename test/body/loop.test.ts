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
