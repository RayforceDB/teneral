import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, type EventBody } from '../../brain/journal';
import { QUIET_REPLY } from '../../brain/quiet';
import { PROTOCOL, acp, promptText } from '../../keeper/acp';
import { INTERRUPT_SUFFIX } from '../../keeper/owner';

/** A client's end of the wire, and a body that does what `acts` says with each line it is told. */
function setup(acts: (line: string, journal: string) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'teneral-acp-'));
  const journal = join(root, 'journal.jsonl');
  const owner = join(root, 'owner');
  appendEvent(journal, 'g1', { type: 'stimulus', source: 'terminal', text: 'an earlier word' });
  appendEvent(journal, 'g1', { type: 'assistant', text: 'an earlier answer', toolCalls: [] });
  const sent: any[] = [];
  const server = acp({ journal, owner, send: (line) => { expect(line).not.toContain('\n'); sent.push(JSON.parse(line)); }, pollMs: 5, name: 'Mica', version: '1.2.3', command: (line) => (line === '/update take' ? ['The agent was told to take the update.'] : null) });
  // The body: takes what the owner left, journals it, and acts.
  const body = setInterval(() => {
    let names: string[] = [];
    try { names = readdirSync(owner).filter((n) => !n.startsWith('.')).sort(); } catch { /* nothing yet */ }
    for (const name of names) {
      const path = join(owner, name);
      if (name.endsWith(INTERRUPT_SUFFIX)) { rmSync(path); appendEvent(journal, 'g1', { type: 'turn.interrupted' } as EventBody); continue; }
      const line = readFileSync(path, 'utf8');
      rmSync(path);
      appendEvent(journal, 'g1', { type: 'stimulus', source: 'terminal', text: line });
      acts(line, journal);
    }
  }, 5);
  const ask = (message: Record<string, unknown>) => server.receive(JSON.stringify({ jsonrpc: '2.0', ...message }));
  const until = async (is: () => boolean) => { for (let i = 0; i < 400 && !is(); i++) await Bun.sleep(5); expect(is()).toBe(true); };
  const answer = (id: number) => sent.find((m) => m.id === id);
  const open = async (): Promise<string> => {
    ask({ id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true }, clientInfo: { name: 'orca', version: '1' } } });
    ask({ id: 2, method: 'session/new', params: { cwd: '/somewhere/else', mcpServers: [] } });
    return answer(2).result.sessionId as string;
  };
  return { journal, owner, sent, ask, until, answer, open, stop: () => { clearInterval(body); server.close(); } };
}

test('a client is told what this is: the protocol, words only, and nothing done through the client', async () => {
  const s = setup();
  s.ask({ id: 7, method: 'session/new', params: {} });
  expect(s.answer(7).error.code).toBe(-32600);
  const session = await s.open();
  expect(s.answer(1).result).toEqual({
    protocolVersion: PROTOCOL, agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: true } },
    agentInfo: { name: 'teneral', title: 'Mica', version: '1.2.3' }, authMethods: [],
  });
  expect(session).toMatch(/^sess_/);
  // What it does not offer is refused by name, and what is not a message is said to be none.
  s.ask({ id: 8, method: 'session/load', params: { sessionId: session } });
  expect(s.answer(8).error.code).toBe(-32601);
  s.ask({ id: 9, method: 'session/prompt', params: { sessionId: 'sess_other', prompt: [{ type: 'text', text: 'hello' }] } });
  expect(s.answer(9).error).toMatchObject({ code: -32002, data: { sessionId: 'sess_other' } });
  s.ask({ id: 10, method: 'session/prompt', params: { sessionId: session, prompt: [{ type: 'image', data: 'x', mimeType: 'image/png' }] } });
  expect(s.answer(10).error.code).toBe(-32602);
  s.stop();
});

test('what a client sends is said to the agent as its owner, and what the agent says and does comes back until the turn is over', async () => {
  const s = setup((line, journal) => {
    if (!line.includes('how are the tests')) return;
    appendEvent(journal, 'g1', { type: 'assistant', text: 'Let me look.', toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'bun test' } }] });
    appendEvent(journal, 'g1', { type: 'tool.intent', callId: 'c1', name: 'bash', args: { command: 'bun test' } });
    appendEvent(journal, 'g1', { type: 'tool.result', callId: 'c1', ok: true, output: '12 pass\n0 fail' });
    appendEvent(journal, 'g1', { type: 'assistant', text: QUIET_REPLY, toolCalls: [{ id: 'c2', name: 'read', args: { path: 'notes.md' } }] });
    appendEvent(journal, 'g1', { type: 'tool.intent', callId: 'c2', name: 'read', args: { path: 'notes.md' } });
    appendEvent(journal, 'g1', { type: 'tool.result', callId: 'c2', ok: false, output: 'no such file' });
    appendEvent(journal, 'g1', { type: 'assistant', text: 'All twelve pass.', toolCalls: [] });
  });
  const session = await s.open();
  s.ask({ id: 3, method: 'session/prompt', params: { sessionId: session, prompt: [{ type: 'text', text: 'how are the tests?' }, { type: 'resource_link', uri: 'file:///work/notes.md', name: 'notes.md' }] } });
  await s.until(() => s.answer(3) !== undefined);
  expect(s.answer(3).result).toEqual({ stopReason: 'end_turn' });
  const updates = s.sent.filter((m) => m.method === 'session/update').map((m) => { expect(m.params.sessionId).toBe(session); return m.params.update; });
  expect(updates.map((u) => u.sessionUpdate)).toEqual(['agent_message_chunk', 'tool_call', 'tool_call_update', 'tool_call', 'tool_call_update', 'agent_message_chunk']);
  expect(updates[0]).toEqual({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Let me look.' } });
  expect(updates[1]).toMatchObject({ title: 'bash: command: bun test', kind: 'execute', status: 'in_progress', rawInput: { command: 'bun test' } });
  expect(updates[2]).toMatchObject({ toolCallId: updates[1].toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '12 pass\n0 fail' } }] });
  expect(updates[3]).toMatchObject({ kind: 'read', title: 'read: path: notes.md' });
  expect(updates[4]).toMatchObject({ toolCallId: updates[3].toolCallId, status: 'failed' });
  expect(updates[5].content.text).toBe('All twelve pass.');
  // Nothing of what was said before the prompt is passed on, and the answers come after the updates.
  expect(JSON.stringify(s.sent)).not.toContain('an earlier answer');
  expect(s.sent.indexOf(s.answer(3))).toBe(s.sent.length - 1);
  s.stop();
});

test('a cancel stops the turn as the owner stops it, and the prompt is answered as cancelled', async () => {
  const s = setup((_, journal) => { appendEvent(journal, 'g1', { type: 'assistant', text: 'This will take a while.', toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'sleep 600' } }] }); });
  const session = await s.open();
  s.ask({ id: 3, method: 'session/prompt', params: { sessionId: session, prompt: [{ type: 'text', text: 'run the long job' }] } });
  await s.until(() => s.sent.some((m) => m.method === 'session/update'));
  s.ask({ method: 'session/cancel', params: { sessionId: session } });
  await s.until(() => s.answer(3) !== undefined);
  expect(s.answer(3).result).toEqual({ stopReason: 'cancelled' });
  s.stop();
});

test('an owner\'s command typed as a prompt is answered here and is not said to the agent', async () => {
  const told: string[] = [];
  const s = setup((line) => { told.push(line); });
  const session = await s.open();
  s.ask({ id: 3, method: 'session/prompt', params: { sessionId: session, prompt: [{ type: 'text', text: '/update take' }] } });
  expect(s.answer(3).result).toEqual({ stopReason: 'end_turn' });
  expect(s.sent.find((m) => m.method === 'session/update').params.update.content.text).toBe('The agent was told to take the update.');
  await Bun.sleep(30);
  expect(told).toEqual([]);
  s.stop();
});

test('the words of a prompt: its text, where an attachment is, and the text of what is embedded', () => {
  expect(promptText([{ type: 'text', text: 'look at this' }, { type: 'resource_link', uri: 'file:///a.md', name: 'a.md' }, { type: 'resource', resource: { uri: 'file:///b.md', text: 'in b' } }, { type: 'image', data: 'x' }]))
    .toBe('look at this\n[a.md: file:///a.md]\n[file:///b.md]\nin b');
  expect(promptText('no')).toBe('');
});
