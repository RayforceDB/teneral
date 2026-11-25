import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptTool } from '../../body/script';
import { TOOLS, type Tool, type ToolContext } from '../../body/tools';
import { eventChars, ruleStart, ruleStep, slimOf } from '../../brain/episodes';
import { appendEvent, readEvents, type JournalEvent } from '../../brain/journal';
import { runTurn } from '../../brain/loop';
import { buildMessages } from '../../brain/memory';
import type { ChatMessage, Provider, Reply } from '../../brain/provider';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'teneral-script-'));
  const ctx: ToolContext = { workspace: dir, journal: join(dir, 'journal.jsonl'), gen: 'g1', mutationCommit: null, id: 'me', inbox: join(dir, 'inbox'), peers: join(dir, 'peers.json'), soul: dir };
  return { dir, ctx };
}

const spoke: string[] = [];
/** A tool that speaks to someone: no script may call it. */
const speak: Tool = { spec: { name: 'speak', description: '', parameters: {} }, async run(args) { spoke.push(JSON.stringify(args)); return 'said'; } };
const tools = [...TOOLS, speak];
const inner = (journal: string): JournalEvent[] => readEvents(journal).filter((e) => (e as { within?: unknown }).within !== undefined);

test('a script calls the tools as functions and the agent is shown only what it returns', { timeout: 30_000 }, async () => {
  const { dir, ctx } = setup();
  for (const [name, text] of [['a.txt', 'nothing here'], ['b.txt', 'the needle is in this one, among much else '.repeat(40)], ['c.txt', 'nothing here either']] as const) writeFileSync(join(dir, name), text);
  const out = await scriptTool(tools).run({ code: `
    const found = [];
    for (const path of ['a.txt', 'b.txt', 'c.txt']) if ((await tools.read({ path })).includes('needle')) found.push(path);
    return found;
  ` }, ctx, undefined, { id: 'call-7' });
  expect(out).toBe('returned; it made 3 calls\n[\n  "b.txt"\n]');
  // Each call is in the journal under the tool's own name, with what it returned, marked with the call that ran the script.
  const events = inner(ctx.journal) as (JournalEvent & { callId: string; name?: string; within: string; output?: string; ok?: boolean })[];
  expect(events.map((e) => `${e.type} ${e.callId} ${e.name ?? e.ok}`)).toEqual([
    'tool.intent call-7/1 read', 'tool.result call-7/1 true', 'tool.intent call-7/2 read', 'tool.result call-7/2 true', 'tool.intent call-7/3 read', 'tool.result call-7/3 true',
  ]);
  expect(events.every((e) => e.within === 'call-7')).toBe(true);
  expect(events[3]!.output).toContain('needle');
});

test('one expression comes to its value, what is printed is shown, and a script that throws has failed', { timeout: 30_000 }, async () => {
  const { ctx } = setup();
  const script = scriptTool(tools);
  expect(await script.run({ code: '6 * 7' }, ctx)).toBe('returned; it made 0 calls\n42');
  expect(await script.run({ code: 'console.log("on the way"); return "there";' }, ctx)).toBe('returned; it made 0 calls\nthere\n[printed]\non the way\n');
  expect(await script.run({ code: 'const nothing = 1;' }, ctx)).toBe('returned; it made 0 calls');
  await expect(script.run({ code: 'throw new Error("it went wrong")' }, ctx)).rejects.toThrow(/failed; it made 0 calls\nError: it went wrong/);
  await expect(script.run({ code: 'this is not (' }, ctx)).rejects.toThrow(/it is not JavaScript that can be run/);
  await expect(script.run({ code: '  ' }, ctx)).rejects.toThrow('code is required');
  // A tool that fails throws in the script, which may catch it and go on.
  expect(await script.run({ code: 'try { await tools.read({ path: "no-such-file" }); return "read"; } catch (err) { return "caught: " + (err.message.length > 0); }' }, ctx)).toBe('returned; it made 1 call\ncaught: true');
  expect((inner(ctx.journal).at(-1) as { ok?: boolean }).ok).toBe(false);
});

test('a script cannot call what speaks to anyone or cannot be taken back: nothing runs and nothing is journaled', { timeout: 30_000 }, async () => {
  const { ctx } = setup();
  const script = scriptTool(tools);
  expect(script.spec.description).toContain('It can call: read, write, edit, bash, recall, open, timeline, about.');
  for (const name of ['speak', 'mutate', 'send', 'done', 'script']) {
    const out = await script.run({ code: `try { await tools.${name}({ text: 'hello' }); return 'called'; } catch (err) { return err.message; }` }, ctx);
    expect(out).toBe(`returned; it made 0 calls\n${name === 'script' ? 'unknown tool: script' : `${name} cannot be called from a script: call it yourself`}`);
  }
  expect(spoke).toEqual([]);
  expect(ctx.mutationCommit).toBeNull();
  expect(inner(ctx.journal)).toEqual([]);
  // None of the tools that may be scripted speaks or mutates: the list is short, and is this one.
  expect(tools.filter((t) => t.scripted).map((t) => t.spec.name)).toEqual(['read', 'write', 'edit', 'bash', 'recall', 'open', 'timeline', 'about']);
});

test('a script is stopped by the clock, by its owner and at its limit of calls, with what it started', { timeout: 60_000 }, async () => {
  const { dir, ctx } = setup();
  // By the clock, while a tool it called runs: the tool is stopped too, and its result is journaled before the script's.
  const began = Date.now();
  const slow = await scriptTool(tools, { limitMs: 1_500 }).run({ code: 'await tools.bash({ command: "echo $$ > pid; sleep 60" }); return "never";' }, ctx, undefined, { id: 'slow' });
  expect(Date.now() - began).toBeLessThan(15_000);
  expect(slow).toStartWith('timed out after 1.5s and was killed; it made 1 call');
  const last = inner(ctx.journal).at(-1) as { type: string; callId: string; output: string };
  expect(`${last.type} ${last.callId}`).toBe('tool.result slow/1');
  expect(last.output).toContain('killed');
  const pid = Number(await Bun.file(join(dir, 'pid')).text());
  await Bun.sleep(200);
  expect(() => process.kill(pid, 0)).toThrow();
  // By the owner.
  const owner = new AbortController();
  setTimeout(() => owner.abort(), 500);
  expect(await scriptTool(tools).run({ code: 'await new Promise(() => {});' }, ctx, owner.signal)).toStartWith('interrupted by your owner and killed');
  // A script that ends its own process has returned nothing.
  expect(await scriptTool(tools).run({ code: 'process.exit(3)' }, ctx)).toBe('ended without returning (exit 3); it made 0 calls');
  // At the limit of calls the next is refused, and the script may still return.
  writeFileSync(join(dir, 'a.txt'), 'a');
  const many = await scriptTool(tools, { calls: 2 }).run({ code: 'let n = 0; try { for (;;) { await tools.read({ path: "a.txt" }); n += 1; } } catch (err) { return n + ": " + err.message; }' }, ctx, undefined, { id: 'many' });
  expect(many).toBe('returned; it made 2 calls\n2: not run: a script may make 2 calls');
  expect(inner(ctx.journal).filter((e) => (e as { within?: string }).within === 'many').length).toBe(4);
});

test('in a turn, a script is one call of the reply: what its calls returned is in the journal and in no request', { timeout: 30_000 }, async () => {
  const { dir, ctx } = setup();
  writeFileSync(join(dir, 'long.txt'), 'SECRET-OF-THE-FILE '.repeat(200));
  const replies: Reply[] = [
    { text: '', toolCalls: [{ id: 'c1', name: 'script', args: { code: 'return (await tools.read({ path: "long.txt" })).length > 1000 ? "long" : "short";' } }] },
    { text: 'It is long.', toolCalls: [] },
  ];
  const seen: ChatMessage[][] = [];
  const provider: Provider = async (messages) => { seen.push(messages); return replies.shift()!; };
  appendEvent(ctx.journal, 'g1', { type: 'stimulus', source: 'terminal', text: 'how long is it' });
  expect(await runTurn({ journal: ctx.journal, gen: 'g1', provider, tools: [...tools, scriptTool(tools)], system: () => 'SYS', ctx })).toBe('done');
  // The notes a turn keeps of its requests are beside the point here.
  const events = readEvents(ctx.journal).filter((e) => e.type !== 'note');
  expect(events.map((e) => `${e.type}${(e as { within?: string }).within ? ' in ' + (e as { within?: string }).within : ''}`)).toEqual([
    'stimulus', 'assistant', 'tool.intent', 'tool.intent in c1', 'tool.result in c1', 'tool.result', 'assistant',
  ]);
  // The second request carries the script's answer and nothing of what the script read.
  const second = JSON.stringify(seen[1]);
  expect(second).toContain('returned; it made 1 call\\nlong');
  expect(second).not.toContain('SECRET-OF-THE-FILE');
  expect(JSON.stringify(buildMessages(events, 'SYS'))).not.toContain('SECRET-OF-THE-FILE');
  // What nobody is shown counts for nothing, and is no answer to a call of the reply: one call was owed, and one result answers it.
  const read = events[4]!;
  expect(eventChars(read)).toBe(0);
  expect(slimOf(read).type).toBe('tool.result.inner');
  const state = ruleStart();
  const pending: number[] = [];
  for (const e of events.slice(0, 6)) { ruleStep(state, slimOf(e)); pending.push(state.pending); }
  expect(pending).toEqual([0, 1, 1, 1, 1, 0]);
});
