import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTurn } from '../../brain/loop';
import { ProviderError, type ChatMessage, type Provider, type Reply } from '../../brain/provider';
import type { Tool, ToolContext } from '../../body/tools';
import { needsTurn } from '../../brain/memory';
import { appendEvent, readEvents } from '../../brain/journal';

function setup(replies: Reply[], tools: Tool[] = []) {
  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-loop-')), 'journal.jsonl');
  const ctx: ToolContext = { workspace: '/tmp', journal, gen: 'g1', mutationCommit: null, id: 'me', inbox: '/tmp/unused-inbox', peers: '/tmp/unused-peers.json' };
  const seen: ChatMessage[][] = [];
  const provider: Provider = async (messages) => {
    seen.push(messages);
    const next = replies.shift();
    if (!next) throw new Error('the script ran out of replies');
    return next;
  };
  appendEvent(journal, 'g1', { type: 'stimulus', source: 'terminal', text: 'go' });
  return { journal, ctx, seen, deps: { journal, gen: 'g1', provider, tools, system: () => 'SYS', ctx } };
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

test('a mutation ends the turn without another model call', async () => {
  const mutator: Tool = {
    spec: { name: 'mutate', description: '', parameters: {} },
    async run(_args, ctx) { ctx.mutationCommit = 'abc'; return 'requested'; },
  };
  const s = setup([{ text: 'mutating', toolCalls: [{ id: 'c1', name: 'mutate', args: {} }] }], [mutator]);
  expect(await runTurn(s.deps)).toBe('mutation');
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
  // The late stimulus sits before the first answer in the journal, so the request must not end on that answer.
  expect(seen[1]!.map((m) => m.role)).toEqual(['system', 'user', 'user', 'assistant', 'user']);
  expect(seen[1]!.at(-1)!.content).toContain('Something arrived while you were writing your last reply');
  expect(readEvents(s.journal).map((e) => e.type)).toEqual(['stimulus', 'stimulus', 'assistant', 'assistant']);
});

test('a kernel note that arrives while the last reply is on its way gets another round; other events do not', async () => {
  const during = async (body: Parameters<typeof appendEvent>[2]) => {
    const s = setup([]);
    let calls = 0;
    const provider: Provider = async (messages) => {
      calls += 1;
      // Whatever the round, the request ends with something to answer, never with the agent's own finished reply.
      expect(messages.at(-1)!.role).toBe('user');
      if (calls === 1) appendEvent(s.journal, 'g1', body);
      return { text: 'answer', toolCalls: [] };
    };
    await runTurn({ ...s.deps, provider });
    return calls;
  };
  expect(await during({ type: 'mutation.rejected', commit: 'b', gate: 'tests', output: '1 fail' })).toBe(2);
  expect(await during({ type: 'generation.ready', commit: 'g1' })).toBe(1);
});

test('after a mutation the rest of the reply is not run, and every call still has a result', async () => {
  let written = false;
  const mutator: Tool = {
    spec: { name: 'mutate', description: '', parameters: {} },
    async run(_args, ctx) { ctx.mutationCommit = 'abc'; return 'requested'; },
  };
  const writer: Tool = { spec: { name: 'write', description: '', parameters: {} }, async run() { written = true; return 'wrote'; } };
  const s = setup([{ text: '', toolCalls: [{ id: 'c1', name: 'mutate', args: {} }, { id: 'c2', name: 'write', args: {} }] }], [mutator, writer]);

  expect(await runTurn(s.deps)).toBe('mutation');

  expect(written).toBe(false);
  const events = readEvents(s.journal);
  expect(events.map((e) => e.type)).toEqual(['stimulus', 'assistant', 'tool.intent', 'tool.result', 'tool.result']);
  expect(events[3]).toMatchObject({ callId: 'c1', ok: true, output: 'requested' });
  expect(events[4]).toMatchObject({ callId: 'c2', ok: false });
  expect((events[4] as { output: string }).output).toMatch(/not run.*mutation/);
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

const sizeOf = (messages: ChatMessage[]) => messages.reduce((sum, m) => sum + (m.content?.length ?? 0) + JSON.stringify(m.tool_calls ?? '').length, 0);

test('the system prompt is composed again for every round, so a change made during the turn is seen', async () => {
  let soul = 'before';
  const rewrite: Tool = { spec: { name: 'rewrite', description: '', parameters: {} }, async run() { soul = 'after'; return 'ok'; } };
  const s = setup([{ text: '', toolCalls: [{ id: 'c1', name: 'rewrite', args: {} }] }, { text: 'done', toolCalls: [] }], [rewrite]);
  await runTurn({ ...s.deps, system: () => soul });
  expect(s.seen.map((messages) => messages[0]!.content)).toEqual(['before', 'after']);
});

test('each tool is announced as it starts, known or not, but not one skipped after a mutation', async () => {
  const mutator: Tool = { spec: { name: 'mutate', description: '', parameters: {} }, async run(_a, ctx) { ctx.mutationCommit = 'abc'; return 'ok'; } };
  const calls = [{ id: 'c1', name: 'echo', args: {} }, { id: 'c2', name: 'nope', args: {} }, { id: 'c3', name: 'mutate', args: {} }, { id: 'c4', name: 'echo', args: {} }];
  const s = setup([{ text: '', toolCalls: calls }], [echo, mutator]);
  const announced: string[] = [];
  await runTurn({ ...s.deps, onTool: (name) => announced.push(name) });
  expect(announced).toEqual(['echo', 'nope', 'mutate']);
});

test('what a tool returns or throws is journaled as well-formed text', async () => {
  const cut: Tool = { spec: { name: 'cut', description: '', parameters: {} }, async run() { return 'half \ud83d emoji'; } };
  const boom: Tool = { spec: { name: 'boom', description: '', parameters: {} }, async run() { throw new Error('bad \udc00 byte'); } };
  const s = setup([{ text: '', toolCalls: [{ id: 'c1', name: 'cut', args: {} }, { id: 'c2', name: 'boom', args: {} }] }, { text: 'ok', toolCalls: [] }], [cut, boom]);
  await runTurn(s.deps);
  const outputs = readEvents(s.journal).flatMap((e) => (e.type === 'tool.result' ? [e.output] : []));
  expect(outputs).toEqual(['half \ufffd emoji', 'error: bad \ufffd byte']);
});

test('the tool specs count against the budget', async () => {
  const wordy: Tool = { spec: { name: 'wordy', description: 'd'.repeat(500), parameters: {} }, async run() { return ''; } };
  const run = async (tools: Tool[]) => {
    const s = setup([{ text: 'ok', toolCalls: [] }], tools);
    appendEvent(s.journal, 'g1', { type: 'assistant', text: 'a'.repeat(300), toolCalls: [] });
    appendEvent(s.journal, 'g1', { type: 'stimulus', source: 'terminal', text: 'newest' });
    await runTurn({ ...s.deps, budgetChars: 700 });
    return s.seen[0]!;
  };
  expect(await run([])).toHaveLength(4);
  const withSpecs = await run([wordy]);
  expect(withSpecs.map((m) => m.content)).toEqual(['SYS', 'newest']);
});

test('a request the provider refuses as too long is tried once more at half the budget, which then holds for the turn', async () => {
  const s = setup([]);
  for (let i = 0; i < 6; i++) {
    appendEvent(s.journal, 'g1', { type: 'assistant', text: 'a'.repeat(200), toolCalls: [] });
    appendEvent(s.journal, 'g1', { type: 'stimulus', source: 'terminal', text: `more ${i}` });
  }
  const seen: ChatMessage[][] = [];
  const provider: Provider = async (messages) => {
    seen.push(messages);
    if (seen.length === 1) throw new ProviderError('refused', 400, '{"error":{"message":"This model\'s maximum context length is 8192 tokens"}}');
    return seen.length === 2 ? { text: '', toolCalls: [{ id: 'c1', name: 'echo', args: {} }] } : { text: 'done', toolCalls: [] };
  };
  expect(await runTurn({ ...s.deps, provider, tools: [echo], budgetChars: 2000 })).toBe('done');
  expect(seen).toHaveLength(3);
  expect(sizeOf(seen[0]!)).toBeGreaterThan(1000);
  expect(sizeOf(seen[1]!)).toBeLessThanOrEqual(1000);
  expect(sizeOf(seen[2]!)).toBeLessThanOrEqual(1000);
  expect(seen[1]!.at(-1)!.content).toBe('more 5');
});

test('a second refusal, or a failure that is not about length, is not retried', async () => {
  const failing = (err: Error) => {
    const s = setup([]);
    let calls = 0;
    const provider: Provider = async () => { calls += 1; throw err; };
    return { run: runTurn({ ...s.deps, provider }), calls: () => calls, journal: s.journal };
  };
  const tooLong = failing(new ProviderError('refused 413', 413, 'Request too large: reduce the length'));
  await expect(tooLong.run).rejects.toThrow(/413/);
  expect(tooLong.calls()).toBe(2);
  expect(readEvents(tooLong.journal).map((e) => e.type)).toEqual(['stimulus']);
  const others = [
    new ProviderError('unknown model', 400, 'unknown model'),
    new ProviderError('slow down', 429, 'token rate limit'),
    new ProviderError('timed out', null),
    // The words alone do not make it a refusal: this one is not from the provider.
    new Error('provider answered 400: maximum context length'),
  ];
  for (const err of others) {
    const other = failing(err);
    await expect(other.run).rejects.toBe(err);
    expect(other.calls()).toBe(1);
  }
});

test('at the round limit, something the model was never shown keeps the turn owed: no note is written over it', async () => {
  const noisy: Tool = {
    spec: { name: 'noisy', description: '', parameters: {} },
    async run(_args, ctx) { appendEvent(ctx.journal, 'g1', { type: 'stimulus', source: 'terminal', text: 'are you there?' }); return 'ok'; },
  };
  const call = { text: '', toolCalls: [{ id: 'c', name: 'noisy', args: {} }] };
  const s = setup([call, call], [noisy]);
  expect(await runTurn({ ...s.deps, maxRounds: 1 })).toBe('done');
  const events = readEvents(s.journal);
  expect(events.map((e) => e.type)).toEqual(['stimulus', 'assistant', 'tool.intent', 'stimulus', 'tool.result']);
  expect(needsTurn(events)).toBe(true);
  expect(s.seen).toHaveLength(1);
});

// --- usage, reasoning and images ---

import { imageStore } from '../../body/images';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

test('the usage and the summary of the reasoning are journaled with the reply, and left out when the provider gave none', async () => {
  const s = setup([
    { text: '', toolCalls: [{ id: 'c1', name: 'echo', args: {} }], usage: { input: 1200, output: 40, cached: 1000 }, reasoning: 'First I echo.' },
    { text: 'done', toolCalls: [], usage: { input: 1300, output: 5 } },
  ], [echo]);
  await runTurn(s.deps);
  const replies = readEvents(s.journal).filter((e) => e.type === 'assistant');
  expect(replies[0]).toMatchObject({ text: '', usage: { input: 1200, output: 40, cached: 1000 }, reasoning: 'First I echo.' });
  expect(replies[1]).toMatchObject({ text: 'done', usage: { input: 1300, output: 5 } });
  expect('reasoning' in replies[1]!).toBe(false);
  // The second request shows the first reply without either.
  expect(JSON.stringify(s.seen[1])).not.toContain('First I echo.');
  expect(JSON.stringify(s.seen[1])).not.toContain('1200');

  const bare = setup([{ text: 'hello', toolCalls: [] }]);
  await runTurn(bare.deps);
  const reply = readEvents(bare.journal).at(-1)!;
  expect(Object.keys(reply).sort()).toEqual(['gen', 'id', 'text', 'toolCalls', 'ts', 'type', 'v']);
});

const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

/** A turn's journal at `<root>/memory/journal.jsonl`, with one image in the store and the owner's message naming it. */
function withImage(provider: Provider) {
  const root = mkdtempSync(join(tmpdir(), 'teneral-loop-img-'));
  const journal = join(root, 'memory', 'journal.jsonl');
  const path = `memory/images/${'5'.repeat(64)}.png`;
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), PNG_BYTES);
  appendEvent(journal, 'g1', { type: 'stimulus', source: 'terminal', text: `what is this?\n[image: ${path}]` });
  const ctx: ToolContext = { workspace: '/tmp', journal, gen: 'g1', mutationCommit: null, id: 'me', inbox: '/tmp/unused-inbox', peers: '/tmp/unused-peers.json' };
  return { journal, path, deps: { journal, gen: 'g1', provider, tools: [echo], system: () => 'SYS', ctx, sight: { load: imageStore(root) } } };
}

test('the owner\'s image goes out with the message, read from the store beside the journal', async () => {
  const seen: ChatMessage[][] = [];
  const s = withImage(async (messages) => { seen.push(messages); return { text: 'a dot', toolCalls: [] }; });
  await runTurn(s.deps);
  expect(seen[0]![1]).toEqual({ role: 'user', content: 'what is this?', images: [{ name: `${'5'.repeat(64)}.png`, mime: 'image/png', data: PNG_BYTES.toString('base64') }] });
  // The journal holds the marker, as it was typed, and no image data.
  expect(readEvents(s.journal)[0]).toMatchObject({ text: `what is this?\n[image: ${s.path}]` });
});

test('a request refused because of its image is asked once more with a note in its place, and the turn goes on without images', async () => {
  const seen: ChatMessage[][] = [];
  const s = withImage(async (messages) => {
    seen.push(messages);
    if (messages.some((m) => m.images)) throw new ProviderError('refused', 400, '{"error":{"message":"image_url is only supported by certain models"}}');
    return seen.length === 2 ? { text: '', toolCalls: [{ id: 'c1', name: 'echo', args: {} }] } : { text: 'I cannot see it.', toolCalls: [] };
  });
  expect(await runTurn(s.deps)).toBe('done');
  expect(seen).toHaveLength(3);
  expect(seen[0]![1]!.images).toHaveLength(1);
  expect(seen[1]![1]).toEqual({ role: 'user', content: `what is this?\n[image not shown: the model or the route in use does not take images: ${'5'.repeat(64)}.png]` });
  // The round after the tool call does not try the image again.
  expect(seen[2]![1]).toEqual(seen[1]![1]!);
  // Journaled as any turn is: the refusal left no trace, and nothing is owed.
  expect(readEvents(s.journal).map((e) => e.type)).toEqual(['stimulus', 'assistant', 'tool.intent', 'tool.result', 'assistant']);
  expect(needsTurn(readEvents(s.journal))).toBe(false);
});

test('a refusal that stays after the images are gone is passed on, and one about images without any in the request is not retried', async () => {
  let calls = 0;
  const always = new ProviderError('refused', 400, 'vision is not supported');
  const s = withImage(async () => { calls += 1; throw always; });
  await expect(runTurn(s.deps)).rejects.toBe(always);
  expect(calls).toBe(2);
  expect(readEvents(s.journal).map((e) => e.type)).toEqual(['stimulus']);

  const plain = setup([]);
  let asked = 0;
  await expect(runTurn({ ...plain.deps, provider: async () => { asked += 1; throw always; } })).rejects.toBe(always);
  expect(asked).toBe(1);
});

// --- interrupted by the owner ---

/** A provider that waits until its call is cancelled, as the real ones do, and counts how often it was asked. */
function stalling() {
  const state = { calls: 0, entered: () => {} };
  const provider: Provider = (_messages, _tools, options) => {
    state.calls += 1;
    state.entered();
    return new Promise<Reply>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new ProviderError('provider request cancelled', null)), { once: true });
    });
  };
  return { state, provider };
}

/** Every call a reply made has exactly one result, and nothing else has one. */
function paired(journal: string): boolean {
  const events = readEvents(journal);
  const calls = events.flatMap((e) => (e.type === 'assistant' ? e.toolCalls.map((c) => c.id) : [])).sort();
  const results = events.flatMap((e) => (e.type === 'tool.result' ? [e.callId] : [])).sort();
  return JSON.stringify(calls) === JSON.stringify(results);
}

test('interrupted while the model is asked: the request is cancelled, not tried again, and the turn ends with nothing owed', async () => {
  const s = setup([]);
  const { state, provider } = stalling();
  const controller = new AbortController();
  state.entered = () => setTimeout(() => controller.abort(), 10);
  expect(await runTurn({ ...s.deps, provider, signal: controller.signal })).toBe('interrupted');
  expect(state.calls).toBe(1);
  expect(readEvents(s.journal).map((e) => e.type)).toEqual(['stimulus', 'turn.interrupted']);
  expect(needsTurn(readEvents(s.journal))).toBe(false);
});

test('whatever the provider throws once the owner interrupted, nothing is asked again: not at half the budget, not without the images', async () => {
  for (const error of [new ProviderError('provider answered 400: maximum context length', 400, 'maximum context length'), new ProviderError('provider answered 400: image input is not supported', 400, 'image input is not supported'), new Error('socket closed')]) {
    const s = setup([]);
    appendEvent(s.journal, 'g1', { type: 'stimulus', source: 'terminal', text: `see\n[image: memory/images/${'a'.repeat(64)}.png]` });
    const controller = new AbortController();
    let calls = 0;
    const provider: Provider = async () => {
      calls += 1;
      controller.abort();
      throw error;
    };
    const sight = { load: () => ({ name: 'a.png', mime: 'image/png', data: 'AAAA' }) };
    expect(await runTurn({ ...s.deps, provider, sight, signal: controller.signal })).toBe('interrupted');
    expect(calls).toBe(1);
    expect(readEvents(s.journal).at(-1)!.type).toBe('turn.interrupted');
  }
});

test('interrupted while a tool runs: the tool is told, its result says so, the calls after it are answered unrun, and no new request is made', async () => {
  let told = false;
  const slow: Tool = {
    spec: { name: 'slow', description: '', parameters: {} },
    run: (_args, _ctx, signal) => new Promise<string>((resolve) => {
      signal!.addEventListener('abort', () => { told = true; resolve('stopped half-way'); }, { once: true });
    }),
  };
  const s = setup([
    { text: 'working', toolCalls: [{ id: 'c1', name: 'echo', args: {} }, { id: 'c2', name: 'slow', args: {} }, { id: 'c3', name: 'echo', args: {} }, { id: 'c4', name: 'slow', args: {} }] },
    { text: 'never asked for', toolCalls: [] },
  ], [echo, slow]);
  const controller = new AbortController();
  const started: string[] = [];
  const done = runTurn({ ...s.deps, signal: controller.signal, onTool: (name) => { started.push(name); if (name === 'slow') setTimeout(() => controller.abort(), 10); } });
  expect(await done).toBe('interrupted');
  expect(told).toBe(true);
  expect(started).toEqual(['echo', 'slow']);
  expect(s.seen).toHaveLength(1);
  const events = readEvents(s.journal);
  expect(events.map((e) => e.type)).toEqual(['stimulus', 'assistant', 'tool.intent', 'tool.result', 'tool.intent', 'tool.result', 'tool.result', 'tool.result', 'turn.interrupted']);
  const results = events.flatMap((e) => (e.type === 'tool.result' ? [e] : []));
  expect(results[0]).toMatchObject({ callId: 'c1', ok: true, output: 'echo:{}' });
  expect(results[1]).toMatchObject({ callId: 'c2', ok: false });
  expect(results[1]!.output).toMatch(/^\[interrupted\] Your owner interrupted this turn while this tool was running\..*\nstopped half-way$/s);
  for (const [i, id] of [[2, 'c3'], [3, 'c4']] as const) expect(results[i]).toMatchObject({ callId: id, ok: false, output: '[not started] Your owner interrupted this turn before this tool ran.' });
  expect(paired(s.journal)).toBe(true);
  expect(needsTurn(events)).toBe(false);
});

test('a tool that does not stop when asked is left behind after a moment, and what it does later disturbs nothing', async () => {
  let finish: (text: string) => void = () => {};
  let fail: (err: Error) => void = () => {};
  const deaf: Tool = { spec: { name: 'deaf', description: '', parameters: {} }, run: () => new Promise<string>((resolve) => { finish = resolve; }) };
  const doomed: Tool = { spec: { name: 'doomed', description: '', parameters: {} }, run: () => new Promise<string>((_resolve, reject) => { fail = reject; }) };
  for (const name of ['deaf', 'doomed']) {
    const s = setup([{ text: '', toolCalls: [{ id: 'c1', name, args: {} }] }], [deaf, doomed]);
    const controller = new AbortController();
    const began = Date.now();
    const done = runTurn({ ...s.deps, signal: controller.signal, abandonMs: 30, onTool: () => setTimeout(() => controller.abort(), 10) });
    expect(await done).toBe('interrupted');
    expect(Date.now() - began).toBeLessThan(2000);
    const result = readEvents(s.journal).find((e) => e.type === 'tool.result')!;
    expect(result).toMatchObject({ callId: 'c1', ok: false });
    expect((result as { output: string }).output).toMatch(/^\[interrupted\].*\nIt did not stop when asked and was left behind: it may still be running\.$/s);
    const before = readEvents(s.journal).length;
    // Late, and to nobody: no second result, and no rejection left unhandled to end the process.
    finish('late');
    fail(new Error('late'));
    await Bun.sleep(20);
    expect(readEvents(s.journal)).toHaveLength(before);
    expect(paired(s.journal)).toBe(true);
  }
});

test('a tool that throws because it was stopped is recorded as interrupted, with what it threw', async () => {
  const thrower: Tool = {
    spec: { name: 'thrower', description: '', parameters: {} },
    run: (_args, _ctx, signal) => new Promise<string>((_resolve, reject) => { signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }),
  };
  const s = setup([{ text: '', toolCalls: [{ id: 'c1', name: 'thrower', args: {} }] }], [thrower]);
  const controller = new AbortController();
  expect(await runTurn({ ...s.deps, signal: controller.signal, onTool: () => setTimeout(() => controller.abort(), 10) })).toBe('interrupted');
  const result = readEvents(s.journal).find((e) => e.type === 'tool.result') as { ok: boolean; output: string };
  expect(result.ok).toBe(false);
  expect(result.output).toMatch(/^\[interrupted\].*\nerror: aborted$/s);
});

test('a reply with tool calls that arrived as the owner interrupted is journaled, none of its calls is run, and each has its answer', async () => {
  const controller = new AbortController();
  const s = setup([], [echo]);
  let ran = 0;
  const counted: Tool = { ...echo, async run() { ran += 1; return 'ran'; } };
  const provider: Provider = async () => {
    // A provider that does not hear the signal: the reply comes all the same.
    controller.abort();
    return { text: 'on it', toolCalls: [{ id: 'c1', name: 'echo', args: {} }, { id: 'c2', name: 'echo', args: {} }] };
  };
  expect(await runTurn({ ...s.deps, provider, tools: [counted], signal: controller.signal })).toBe('interrupted');
  expect(ran).toBe(0);
  expect(readEvents(s.journal).map((e) => e.type)).toEqual(['stimulus', 'assistant', 'tool.result', 'tool.result', 'turn.interrupted']);
  expect(paired(s.journal)).toBe(true);
});

test('a finished reply that had already arrived ends the turn as done: the interruption came too late and is dropped', async () => {
  const controller = new AbortController();
  const s = setup([]);
  const provider: Provider = async () => {
    controller.abort();
    return { text: 'all done', toolCalls: [] };
  };
  expect(await runTurn({ ...s.deps, provider, signal: controller.signal })).toBe('done');
  expect(readEvents(s.journal).map((e) => e.type)).toEqual(['stimulus', 'assistant']);
});

test('a signal already aborted when the turn begins asks the model nothing', async () => {
  const s = setup([{ text: 'never', toolCalls: [] }]);
  const controller = new AbortController();
  controller.abort();
  expect(await runTurn({ ...s.deps, signal: controller.signal })).toBe('interrupted');
  expect(s.seen).toHaveLength(0);
  expect(readEvents(s.journal).map((e) => e.type)).toEqual(['stimulus', 'turn.interrupted']);
});

test('a mutation requested before the interruption stays requested: the turn ends as a mutation, and the calls after it are not run', async () => {
  const controller = new AbortController();
  const mutating: Tool = {
    spec: { name: 'mutate', description: '', parameters: {} },
    async run(_args, ctx) {
      appendEvent(ctx.journal, ctx.gen, { type: 'mutation.requested', commit: 'c'.repeat(40), motive: 'm' });
      ctx.mutationCommit = 'c'.repeat(40);
      controller.abort();
      return 'requested';
    },
  };
  const s = setup([{ text: '', toolCalls: [{ id: 'c1', name: 'mutate', args: {} }, { id: 'c2', name: 'echo', args: {} }] }], [mutating, echo]);
  expect(await runTurn({ ...s.deps, signal: controller.signal })).toBe('mutation');
  const events = readEvents(s.journal);
  expect(events.map((e) => e.type)).not.toContain('turn.interrupted');
  expect(events.at(-1)).toMatchObject({ type: 'tool.result', callId: 'c2', ok: false, output: 'error: not run, because a mutation was requested earlier in this reply' });
  expect(paired(s.journal)).toBe(true);
});

test('a turn that is not interrupted is as it was: the signal changes nothing, and the tools are handed it', async () => {
  const handed: unknown[] = [];
  const spy: Tool = { spec: { name: 'spy', description: '', parameters: {} }, async run(_args, _ctx, signal) { handed.push(signal); return 'ok'; } };
  const controller = new AbortController();
  const s = setup([{ text: '', toolCalls: [{ id: 'c1', name: 'spy', args: {} }] }, { text: 'done', toolCalls: [] }], [spy]);
  expect(await runTurn({ ...s.deps, signal: controller.signal })).toBe('done');
  expect(handed).toEqual([controller.signal]);
  expect(readEvents(s.journal).map((e) => e.type)).toEqual(['stimulus', 'assistant', 'tool.intent', 'tool.result', 'assistant']);
  expect(readEvents(s.journal).find((e) => e.type === 'tool.result')).toMatchObject({ ok: true, output: 'ok' });
});

test('after an interruption the next thing said starts a turn that sees it', async () => {
  const s = setup([{ text: 'I had not begun; what now?', toolCalls: [] }]);
  appendEvent(s.journal, 'g1', { type: 'turn.interrupted' });
  expect(needsTurn(readEvents(s.journal))).toBe(false);
  appendEvent(s.journal, 'g1', { type: 'stimulus', source: 'terminal', text: 'something else' });
  expect(await runTurn(s.deps)).toBe('done');
  expect(s.seen[0]!.map((m) => m.content?.slice(0, 13))).toEqual(['SYS', 'go', '[interrupted]', 'something els']);
});

// --- images and length together ---

test('an image refused and then a request too long: each is answered once, in turn', async () => {
  const seen: ChatMessage[][] = [];
  const s = withImage(async (messages) => {
    seen.push(messages);
    if (messages.some((m) => m.images)) throw new ProviderError('refused', 400, 'unsupported image');
    if (seen.length === 2) throw new ProviderError('refused', 400, 'maximum context length is 10 tokens');
    return { text: 'ok', toolCalls: [] };
  });
  expect(await runTurn(s.deps)).toBe('done');
  expect(seen).toHaveLength(3);
});
