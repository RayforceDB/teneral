import { expect, test } from 'bun:test';
import { openAiProvider } from '../../body/provider';

function fakeFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}) {
  return (async (url: string, init?: RequestInit) => {
    seen.url = url;
    seen.init = init;
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

const cfg = { baseUrl: 'https://llm.test/v1/', apiKey: 'k', model: 'm' };

test('sends the model, messages and tools, and returns the text', async () => {
  const seen: { url?: string; init?: RequestInit } = {};
  const provider = openAiProvider({ ...cfg, fetch: fakeFetch(200, { choices: [{ message: { content: 'hello' } }] }, seen) });

  const reply = await provider(
    [{ role: 'user', content: 'hi' }],
    [{ name: 'read', description: 'd', parameters: { type: 'object' } }],
  );

  expect(reply).toEqual({ text: 'hello', toolCalls: [] });
  expect(seen.url).toBe('https://llm.test/v1/chat/completions');
  expect((seen.init!.headers as Record<string, string>).authorization).toBe('Bearer k');
  const sent = JSON.parse(seen.init!.body as string);
  expect(sent.model).toBe('m');
  expect(sent.messages).toEqual([{ role: 'user', content: 'hi' }]);
  expect(sent.tools).toEqual([{ type: 'function', function: { name: 'read', description: 'd', parameters: { type: 'object' } } }]);
});

test('parses tool calls and their JSON arguments', async () => {
  const provider = openAiProvider({
    ...cfg,
    fetch: fakeFetch(200, {
      choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } }] } }],
    }),
  });
  expect(await provider([], [])).toEqual({ text: '', toolCalls: [{ id: 'c1', name: 'read', args: { path: 'a.ts' } }] });
});

test('arguments that are not JSON are passed on as text for the tool to refuse', async () => {
  const provider = openAiProvider({
    ...cfg,
    fetch: fakeFetch(200, { choices: [{ message: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{oops' } }] } }] }),
  });
  expect((await provider([], [])).toolCalls[0]!.args).toBe('{oops');
});

test('a failed request throws with the status and the body', async () => {
  const provider = openAiProvider({ ...cfg, fetch: fakeFetch(429, { error: 'slow down' }) });
  await expect(provider([], [])).rejects.toThrow(/429.*slow down/);
});

test('a reply with no choices throws', async () => {
  const provider = openAiProvider({ ...cfg, fetch: fakeFetch(200, { choices: [] }) });
  await expect(provider([], [])).rejects.toThrow(/no message/);
});

test('every tool call leaves with an id of its own, whatever the model sent', async () => {
  const call = (id: unknown) => ({ id, type: 'function', function: { name: 'read', arguments: '{}' } });
  const provider = openAiProvider({
    ...cfg,
    fetch: fakeFetch(200, { choices: [{ message: { tool_calls: [call('a'), call('a'), call(''), call(undefined), call('a_1')] } }] }),
  });
  const ids = (await provider([], [])).toolCalls.map((c) => c.id);
  expect(ids[0]).toBe('a');
  expect(ids.every((id) => typeof id === 'string' && id !== '')).toBe(true);
  expect(new Set(ids).size).toBe(5);
});
