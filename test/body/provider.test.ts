import { expect, test } from 'bun:test';
import { openAiProvider, ProviderError } from '../../body/provider';

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

test('a request that gets no answer in time fails saying it timed out', async () => {
  let signal: AbortSignal | undefined;
  const hung = ((_url: string, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal!.reason)));
  }) as unknown as typeof fetch;
  const started = Date.now();
  await expect(openAiProvider({ ...cfg, fetch: hung, timeoutMs: 30 })([], [])).rejects.toThrow(/timed out after 0\.03s/);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(signal?.aborted).toBe(true);
});

test('a body that stops arriving also counts as timed out', async () => {
  const stalled = (async (_url: string, init?: RequestInit) => ({
    ok: true,
    status: 200,
    text: () => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason))),
  })) as unknown as typeof fetch;
  await expect(openAiProvider({ ...cfg, fetch: stalled, timeoutMs: 30 })([], [])).rejects.toThrow(/timed out/);
});

test('an error that is not a timeout is passed on as it is', async () => {
  const down = (async () => { throw new Error('connection refused'); }) as unknown as typeof fetch;
  await expect(openAiProvider({ ...cfg, fetch: down })([], [])).rejects.toThrow('connection refused');
});

test('a 200 that is not JSON throws with the start of the body', async () => {
  const html = (async () => new Response('<html>Bad gateway</html>', { status: 200 })) as unknown as typeof fetch;
  await expect(openAiProvider({ ...cfg, fetch: html })([], [])).rejects.toThrow(/not JSON.*<html>Bad gateway/);
});

test('content given as parts is joined from its text parts', async () => {
  const provider = openAiProvider({
    ...cfg,
    fetch: fakeFetch(200, {
      choices: [{ message: { content: [{ type: 'text', text: 'hel' }, { type: 'image_url', image_url: { url: 'x' } }, { type: 'text', text: 'lo' }, 'junk', null] } }],
    }),
  });
  expect(await provider([], [])).toEqual({ text: 'hello', toolCalls: [] });
});

const withCalls = (tool_calls: unknown) => openAiProvider({ ...cfg, fetch: fakeFetch(200, { choices: [{ message: { content: 'x', tool_calls } }] }) })([], []);

test('malformed tool calls become calls to `unknown` carrying what was sent, never a thrown TypeError', async () => {
  const good = { id: 'ok', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } };
  const noFunction = { id: 'a', type: 'function' };
  const badName = { id: 'b', type: 'function', function: { name: 7, arguments: '{}' } };
  const reply = await withCalls([null, noFunction, badName, 'text', good]);
  expect(reply.toolCalls.map((c) => c.name)).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'read']);
  expect(reply.toolCalls.map((c) => c.args)).toEqual([null, noFunction, badName, 'text', { path: 'a' }]);
  expect(reply.toolCalls.map((c) => c.id)).toEqual(['call_0', 'a', 'b', 'call_3', 'ok']);
});

test('tool_calls that is not a list is one call to `unknown`; null means none', async () => {
  expect((await withCalls({ name: 'read' })).toolCalls).toEqual([{ id: 'call_0', name: 'unknown', args: { name: 'read' } }]);
  expect((await withCalls('read')).toolCalls).toEqual([{ id: 'call_0', name: 'unknown', args: 'read' }]);
  expect((await withCalls(null)).toolCalls).toEqual([]);
});

test('arguments already given as an object are taken as they are, and missing ones are an empty object', async () => {
  const call = (args: unknown) => ({ id: 'c', type: 'function', function: { name: 'read', arguments: args } });
  expect((await withCalls([call({ path: 'a' })])).toolCalls[0]!.args).toEqual({ path: 'a' });
  expect((await withCalls([call(undefined)])).toolCalls[0]!.args).toEqual({});
  expect((await withCalls([call('')])).toolCalls[0]!.args).toBe('');
});

const caught = async (run: Promise<unknown>): Promise<unknown> => run.then(() => null, (err: unknown) => err);

test('every way a request can fail is a ProviderError that carries the status and the body', async () => {
  const refused = await caught(openAiProvider({ ...cfg, fetch: fakeFetch(422, { error: 'no such tool' }) })([], []));
  expect(refused).toBeInstanceOf(ProviderError);
  expect(refused).toMatchObject({ status: 422, body: '{"error":"no such tool"}' });

  const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  const unreachable = await caught(openAiProvider({ ...cfg, fetch: down })([], []));
  expect(unreachable).toBeInstanceOf(ProviderError);
  expect(unreachable).toMatchObject({ status: null });
  expect((unreachable as Error).message).toContain('fetch failed');

  const hung = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)))) as unknown as typeof fetch;
  const late = await caught(openAiProvider({ ...cfg, fetch: hung, timeoutMs: 20 })([], []));
  expect(late).toBeInstanceOf(ProviderError);
  expect(late).toMatchObject({ status: null });

  const html = (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch;
  expect(await caught(openAiProvider({ ...cfg, fetch: html })([], []))).toBeInstanceOf(ProviderError);
  expect(await caught(openAiProvider({ ...cfg, fetch: fakeFetch(200, { choices: [] }) })([], []))).toBeInstanceOf(ProviderError);
});
