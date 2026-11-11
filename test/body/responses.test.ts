import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ProviderError, connect, readResponsesStream, responsesProvider, tidyReasoning, toResponsesInput, toResponsesTools, type ChatMessage,
} from '../../body/provider';
import { failureKind, saysTooLong, verdict } from '../../body/retry';
import { bashEnv } from '../../body/tools';
import { saveCredentials, type Credentials } from '../../kernel/signin';

// --- the message list as Responses input ---

const CONVERSATION: ChatMessage[] = [
  { role: 'system', content: 'SYSTEM' },
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'looking', tool_calls: [
    { id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } },
    { id: 'c2', type: 'function', function: { name: 'bash', arguments: '{}' } },
  ] },
  { role: 'tool', tool_call_id: 'c1', content: 'A' },
  { role: 'tool', tool_call_id: 'c2', content: 'B' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'c3', type: 'function', function: { name: 'read', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'c3', content: '' },
  { role: 'assistant', content: 'done' },
  { role: 'user', content: 'thanks' },
];

test('the system text becomes the instructions, and every other message an input item', () => {
  expect(toResponsesInput(CONVERSATION)).toEqual({
    instructions: 'SYSTEM',
    input: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'looking' },
      { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{"path":"a"}' },
      { type: 'function_call', call_id: 'c2', name: 'bash', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'A' },
      { type: 'function_call_output', call_id: 'c2', output: 'B' },
      { type: 'function_call', call_id: 'c3', name: 'read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c3', output: '' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'thanks' },
    ],
  });
});

test('no item is a system message and none carries an id', () => {
  const { input } = toResponsesInput([...CONVERSATION, { role: 'system', content: 'MORE' }], 'teneral');
  expect(input.some((item) => item.role === 'system' || 'id' in item)).toBe(false);
  // A second system text is not lost: it joins the instructions.
  expect(toResponsesInput([...CONVERSATION, { role: 'system', content: 'MORE' }]).instructions).toBe('SYSTEM\n\nMORE');
});

test('with a namespace, replayed calls name it, as the calls the model made did', () => {
  const calls = toResponsesInput(CONVERSATION, 'teneral').input.filter((item) => item.type === 'function_call');
  expect(calls).toHaveLength(3);
  for (const call of calls) expect(call.namespace).toBe('teneral');
});

test('tool specs are flat, or grouped in one namespace', () => {
  const specs = [{ name: 'read', description: 'd', parameters: { type: 'object' } }];
  const flat = [{ type: 'function', name: 'read', description: 'd', parameters: { type: 'object' } }];
  expect(toResponsesTools(specs)).toEqual(flat);
  expect(toResponsesTools(specs, 'teneral')).toEqual([{ type: 'namespace', name: 'teneral', description: expect.any(String), tools: flat }]);
  expect(toResponsesTools([], 'teneral')).toEqual([]);
});

// --- the stream ---

const sse = (...events: unknown[]): string => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const CREATED = { type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } };
const message = (text: string) => ({ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const call = (n: number, name: string, args: string) => ({ type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name, arguments: args, status: 'completed' });
const REASONING = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' };
const completed = (output: unknown[]) => ({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output } });

test('a stream with text only gives the text', () => {
  const stream = sse(
    CREATED,
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, delta: 'Hel' },
    { type: 'response.output_text.delta', output_index: 0, delta: 'lo' },
    { type: 'response.output_item.done', output_index: 0, item: message('Hello') },
    completed([message('Hello')]),
  );
  expect(readResponsesStream(stream)).toEqual({ text: 'Hello', toolCalls: [] });
  // The same with CRLF line ends and a closing [DONE], which some servers add.
  expect(readResponsesStream(`${stream.replaceAll('\n', '\r\n')}data: [DONE]\r\n\r\n`)).toEqual({ text: 'Hello', toolCalls: [] });
});

test('a stream with one call gives the call under its call_id, with parsed arguments, and reasoning items are left out', () => {
  const output = [REASONING, call(1, 'read', '{"path":"a.ts"}')];
  const reply = readResponsesStream(sse(CREATED, ...output.map((item) => ({ type: 'response.output_item.done', item })), completed(output)));
  expect(reply).toEqual({ text: '', toolCalls: [{ id: 'call_1', name: 'read', args: { path: 'a.ts' } }] });
});

test('a stream with text and several calls gives them all, in order', () => {
  const output = [REASONING, message('First this.'), call(1, 'read', '{"path":"a"}'), call(2, 'bash', '{"command":"ls"}'), call(3, 'read', '{oops')];
  const reply = readResponsesStream(sse(CREATED, completed(output)));
  expect(reply.text).toBe('First this.');
  expect(reply.toolCalls).toEqual([
    { id: 'call_1', name: 'read', args: { path: 'a' } },
    { id: 'call_2', name: 'bash', args: { command: 'ls' } },
    { id: 'call_3', name: 'read', args: '{oops' },
  ]);
});

test('when the final event carries no output, the items that were completed on the way are used', () => {
  const reply = readResponsesStream(sse(
    CREATED,
    { type: 'response.output_item.done', item: message('From the items.') },
    { type: 'response.output_item.done', item: call(1, 'read', '{}') },
    completed([]),
  ));
  expect(reply).toEqual({ text: 'From the items.', toolCalls: [{ id: 'call_1', name: 'read', args: {} }] });
});

test('a failed response is a provider error carrying its code', () => {
  const failed = { type: 'response.failed', response: { status: 'failed', output: [], error: { code: 'server_error', message: 'boom' } } };
  const err = (() => { try { readResponsesStream(sse(CREATED, failed)); } catch (e) { return e; } return null; })();
  expect(err).toBeInstanceOf(ProviderError);
  expect((err as ProviderError).status).toBe(500);
  expect((err as ProviderError).body).toContain('server_error');
  expect(failureKind(err)).toBe('passing');
});

test('a stream cut off mid-way is a provider error with no status, to be tried again', () => {
  const whole = sse(CREATED, { type: 'response.output_item.done', item: message('Half') });
  for (const cut of [whole, `${whole}event: response.output_text.delta\ndata: {"type":"response.output_te`, '']) {
    const err = (() => { try { readResponsesStream(cut); } catch (e) { return e; } return null; })();
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBeNull();
    expect((err as Error).message).toMatch(/ended before/);
    expect(failureKind(err)).toBe('passing');
  }
});

test('a usage limit, as a failed response in the stream or as a 429, is waited out, and points at the usage page', () => {
  const failed = { type: 'response.failed', response: { status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } };
  const inStream = (() => { try { readResponsesStream(sse(CREATED, failed)); } catch (e) { return e; } return null; })() as ProviderError;
  expect(inStream.status).toBe(429);
  expect(inStream.message).toContain('https://chatgpt.com/settings/usage');
  const body = JSON.stringify({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } });
  for (const err of [inStream, new ProviderError('provider answered 429', 429, body)]) {
    expect(failureKind(err)).toBe('passing');
    for (const inARow of [1, 3, 50]) expect(verdict(failureKind(err), inARow)).toBe('retry');
  }
});

test('a context-length answer is the length case, before the stream or in it', () => {
  const failed = { type: 'response.failed', response: { status: 'failed', error: { code: 'context_length_exceeded', message: 'Your input exceeds the context window of this model.' } } };
  const inStream = (() => { try { readResponsesStream(sse(CREATED, failed)); } catch (e) { return e; } return null; })();
  expect(saysTooLong(inStream)).toBe(true);
  expect(failureKind(inStream)).toBe('long');
  expect(failureKind(new ProviderError('x', 400, JSON.stringify({ error: { code: 'context_length_exceeded', message: 'too long' } })))).toBe('long');
});

test('the codes the plan route documents map onto the statuses it documents', () => {
  const statusOf = (code: string): number | null => {
    try {
      readResponsesStream(sse(CREATED, { type: 'error', code, message: 'm' }));
    } catch (e) {
      return (e as ProviderError).status;
    }
    return -1;
  };
  expect(statusOf('subscription_sharing_usage_unavailable')).toBe(503);
  expect(statusOf('subscription_sharing_user_unavailable')).toBe(503);
  expect(statusOf('subscription_sharing_user_not_eligible')).toBe(403);
  expect(statusOf('subscription_sharing_invalid_user')).toBe(401);
  expect(statusOf('subscription_sharing_unsupported_capability')).toBe(400);
  expect(statusOf('rate_limit_exceeded')).toBe(429);
  expect(statusOf('something_new')).toBe(500);
});

test('an account that may not use the plan is refused, not asked again for ever; a bad token is waited out', () => {
  const body = (code: string) => JSON.stringify({ error: { code, message: 'm' } });
  expect(failureKind(new ProviderError('x', 403, body('subscription_sharing_user_not_eligible')))).toBe('refused');
  expect(failureKind(new ProviderError('x', 403, body('subscription_sharing_route_not_supported')))).toBe('refused');
  expect(failureKind(new ProviderError('x', 400, body('subscription_sharing_unsupported_capability')))).toBe('refused');
  expect(failureKind(new ProviderError('x', 403, '{"detail":"region"}'))).toBe('passing');
  expect(failureKind(new ProviderError('x', 401, body('subscription_sharing_invalid_user')))).toBe('passing');
  expect(failureKind(new ProviderError('x', 503, '{"detail":"Direct routing is unavailable"}'))).toBe('passing');
});

test('a response the provider cut short gives what was complete, marked as cut off', () => {
  const incomplete = { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [message('Half a rep')] } };
  const reply = readResponsesStream(sse(CREATED, incomplete));
  expect(reply.text).toStartWith('Half a rep');
  expect(reply.text).toMatch(/cut off.*max_output_tokens/);
});

// --- the request ---

interface Sent { url: string; headers: Record<string, string>; body: Record<string, unknown> }

function recorder(answers: (() => Response)[], sent: Sent[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    sent.push({ url, headers: init!.headers as Record<string, string>, body: JSON.parse(init!.body as string) });
    return answers.shift()!();
  }) as unknown as typeof fetch;
}

const okStream = () => new Response(sse(CREATED, completed([message('hi')])), { headers: { 'content-type': 'text/event-stream' } });
const version = (JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf8')) as { version: string }).version;

test('the request is stateless and streamed, carries only supported fields, and says truthfully who sends it', async () => {
  const sent: Sent[] = [];
  const provider = responsesProvider({
    baseUrl: () => 'https://api.test/v1/', token: async () => 'tok', model: 'm', namespace: 'teneral', fetch: recorder([okStream], sent),
  });
  const reply = await provider(CONVERSATION, [{ name: 'read', description: 'd', parameters: { type: 'object' } }]);
  expect(reply).toEqual({ text: 'hi', toolCalls: [] });
  expect(sent).toHaveLength(1);
  expect(sent[0]!.url).toBe('https://api.test/v1/responses');
  expect(sent[0]!.url).not.toContain('backend-api');
  expect(sent[0]!.headers.authorization).toBe('Bearer tok');
  expect(sent[0]!.headers['user-agent']).toBe(`teneral/${version}`);
  expect(Object.keys(sent[0]!.body).sort()).toEqual(['input', 'instructions', 'model', 'reasoning', 'store', 'stream', 'tools']);
  // The one field added for the owner's sake: a summary of the reasoning. It is not among the fields the plan route says to omit.
  expect(sent[0]!.body.reasoning).toEqual({ summary: 'auto' });
  expect(sent[0]!.body).toMatchObject({ model: 'm', store: false, stream: true, instructions: 'SYSTEM' });
  expect((sent[0]!.body.tools as { type: string }[])[0]!.type).toBe('namespace');
});

test('without tools none are sent', async () => {
  const sent: Sent[] = [];
  await responsesProvider({ baseUrl: () => 'https://api.test/v1', token: async () => 't', model: 'm', fetch: recorder([okStream], sent) })([{ role: 'user', content: 'x' }], []);
  expect(Object.keys(sent[0]!.body).sort()).toEqual(['input', 'model', 'reasoning', 'store', 'stream']);
});

test('after a 401 a token is asked for once more, naming the one refused, and the request is sent again', async () => {
  const sent: Sent[] = [];
  const asked: (string | undefined)[] = [];
  const token = async (rejected?: string) => { asked.push(rejected); return rejected === undefined ? 'old' : 'new'; };
  const no = () => new Response('{"error":{"code":"invalid_api_key"}}', { status: 401 });
  const provider = responsesProvider({ baseUrl: () => 'https://api.test/v1', token, model: 'm', fetch: recorder([no, okStream], sent) });
  expect((await provider([{ role: 'user', content: 'x' }], [])).text).toBe('hi');
  expect(asked).toEqual([undefined, 'old']);
  expect(sent.map((s) => s.headers.authorization)).toEqual(['Bearer old', 'Bearer new']);

  // A second 401 is the answer; and a token that did not change is not sent twice.
  const twice = responsesProvider({ baseUrl: () => 'https://api.test/v1', token, model: 'm', fetch: recorder([no, no, okStream], []) });
  await expect(twice([{ role: 'user', content: 'x' }], [])).rejects.toMatchObject({ status: 401 });
  const same: Sent[] = [];
  const fixed = responsesProvider({ baseUrl: () => 'https://api.test/v1', token: async () => 'key', model: 'm', fetch: recorder([no, okStream], same) });
  await expect(fixed([{ role: 'user', content: 'x' }], [])).rejects.toMatchObject({ status: 401 });
  expect(same).toHaveLength(1);
});

test('an error answer keeps its status and body; an unreachable provider and a missing sign-in are errors of the provider, not of this code', async () => {
  const body = '{"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"limit"}}';
  const limited = responsesProvider({ baseUrl: () => 'https://api.test/v1', token: async () => 't', model: 'm', fetch: recorder([() => new Response(body, { status: 429 })], []) });
  const err = await limited([{ role: 'user', content: 'x' }], []).catch((e: unknown) => e) as ProviderError;
  expect(err).toBeInstanceOf(ProviderError);
  expect(err).toMatchObject({ status: 429, body });
  expect(err.message).toContain('https://chatgpt.com/settings/usage');

  const down = responsesProvider({ baseUrl: () => 'https://api.test/v1', token: async () => 't', model: 'm', fetch: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch });
  await expect(down([{ role: 'user', content: 'x' }], [])).rejects.toMatchObject({ name: 'ProviderError', status: null });

  const signedOut = responsesProvider({ baseUrl: () => 'https://api.test/v1', token: async () => { throw new Error('sign in again with ./box setup'); }, model: 'm', fetch: recorder([], []) });
  const gone = await signedOut([{ role: 'user', content: 'x' }], []).catch((e: unknown) => e) as ProviderError;
  expect(gone).toBeInstanceOf(ProviderError);
  expect(gone.message).toContain('./box setup');
  expect(failureKind(gone)).toBe('passing');
});

// --- choosing the provider from the environment ---

function credentials(dir: string, apiBase: string): Credentials {
  const cred: Credentials = {
    email: '', issuer: 'http://127.0.0.1:9', subject: 's', client_id: 'oaiapp_x', ext_agent_host_id: 'urn:uuid:x', id_token: '',
    access_token: 'at-real', refresh_token: 'rt-real', token_type: 'Bearer', expires_in: 3600, scopes: [], saved_at: '',
    expires_at: Date.now() + 3600_000, api_base: apiBase,
  };
  saveCredentials(dir, 'chatgpt', cred);
  return cred;
}

test('an unset or unknown provider is chat-completions, as before', async () => {
  for (const id of [undefined, 'never-heard-of-it']) {
    const sent: Sent[] = [];
    const answer = () => Response.json({ choices: [{ message: { content: 'chat' } }] });
    const provider = connect({ TENERAL_PROVIDER: id, TENERAL_BASE_URL: 'https://llm.test/v1', TENERAL_API_KEY: 'k', TENERAL_MODEL: 'm' }, recorder([answer], sent));
    expect((await provider([{ role: 'user', content: 'x' }], [])).text).toBe('chat');
    expect(sent[0]!.url).toBe('https://llm.test/v1/chat/completions');
  }
});

test('the API-key provider speaks Responses with the key and flat tools', async () => {
  const sent: Sent[] = [];
  const provider = connect({ TENERAL_PROVIDER: 'openai', TENERAL_BASE_URL: 'https://api.test/v1', TENERAL_API_KEY: 'sk', TENERAL_MODEL: 'm' }, recorder([okStream], sent));
  await provider([{ role: 'user', content: 'x' }], [{ name: 'read', description: 'd', parameters: {} }]);
  expect(sent[0]!.url).toBe('https://api.test/v1/responses');
  expect(sent[0]!.headers.authorization).toBe('Bearer sk');
  expect((sent[0]!.body.tools as { type: string }[])[0]!.type).toBe('function');
});

test('the sign-in provider takes its token and its address from the stored sign-in, never from the environment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'teneral-auth-'));
  credentials(dir, 'https://api.signed-in.test/v1');
  const sent: Sent[] = [];
  const provider = connect({
    TENERAL_PROVIDER: 'chatgpt', TENERAL_AUTH: dir, TENERAL_MODEL: 'm',
    // Someone pointing the agent elsewhere must not get the owner's token sent there.
    TENERAL_BASE_URL: 'https://evil.test/v1',
  }, recorder([okStream], sent));
  await provider([{ role: 'user', content: 'x' }], [{ name: 'read', description: 'd', parameters: {} }]);
  expect(sent[0]!.url).toBe('https://api.signed-in.test/v1/responses');
  expect(sent[0]!.headers.authorization).toBe('Bearer at-real');
  expect((sent[0]!.body.tools as { type: string }[])[0]!.type).toBe('namespace');
});

test('handed a fixed token, the sign-in provider uses it at the given address and never opens the stored sign-in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'teneral-auth-'));
  credentials(dir, 'https://api.signed-in.test/v1');
  const before = readFileSync(join(dir, 'chatgpt.json'), 'utf8');
  for (const auth of [dir, undefined, join(dir, 'missing')]) {
    const sent: Sent[] = [];
    const provider = connect({
      TENERAL_PROVIDER: 'chatgpt', TENERAL_AUTH: auth, TENERAL_MODEL: 'smoke', TENERAL_API_KEY: 'smoke', TENERAL_BASE_URL: 'http://127.0.0.1:1/v1',
    }, recorder([() => new Response('{}', { status: 401 })], sent));
    await expect(provider([{ role: 'user', content: 'x' }], [])).rejects.toMatchObject({ status: 401 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('http://127.0.0.1:1/v1/responses');
    expect(sent[0]!.headers.authorization).toBe('Bearer smoke');
    expect(JSON.stringify(sent)).not.toContain('at-real');
  }
  expect(readFileSync(join(dir, 'chatgpt.json'), 'utf8')).toBe(before);
});

test('what is missing from the environment is said by name', () => {
  expect(() => connect({})).toThrow(/TENERAL_MODEL is not set/);
  expect(() => connect({ TENERAL_MODEL: 'm' })).toThrow(/TENERAL_BASE_URL is not set/);
  expect(() => connect({ TENERAL_MODEL: 'm', TENERAL_PROVIDER: 'chatgpt' })).toThrow(/TENERAL_AUTH is not set/);
  expect(() => connect({ TENERAL_MODEL: 'm', TENERAL_PROVIDER: 'openai', TENERAL_BASE_URL: 'u' })).toThrow(/TENERAL_API_KEY is not set/);
});

test('a shell command sees neither the key nor a token: the sign-in provider puts nothing in the environment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'teneral-auth-'));
  credentials(dir, 'https://api.signed-in.test/v1');
  const env = { TENERAL_PROVIDER: 'chatgpt', TENERAL_AUTH: dir, TENERAL_MODEL: 'm', TENERAL_API_KEY: 'secret' };
  const snapshot = JSON.stringify(process.env);
  await connect({ ...env, TENERAL_API_KEY: undefined }, recorder([okStream], []))([{ role: 'user', content: 'x' }], []);
  expect(JSON.stringify(process.env)).toBe(snapshot);
  expect(JSON.stringify(bashEnv(env))).not.toContain('secret');
  expect(JSON.stringify(bashEnv(env))).not.toContain('at-real');
});

// --- images, usage and the summary of the reasoning ---

const PICTURE = { name: `${'a'.repeat(64)}.png`, mime: 'image/png', data: 'AAAA' };

test('an image beside a user message is an input_image part after the text; alone, it is the only part', () => {
  const { input } = toResponsesInput([
    { role: 'user', content: 'what is this?', images: [PICTURE, { ...PICTURE, mime: 'image/jpeg', data: 'BBBB' }] },
    { role: 'user', content: null, images: [PICTURE] },
  ]);
  expect(input).toEqual([
    { role: 'user', content: [
      { type: 'input_text', text: 'what is this?' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
      { type: 'input_image', image_url: 'data:image/jpeg;base64,BBBB' },
    ] },
    { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
  ]);
  expect(JSON.stringify(input)).not.toContain('"images"');
});

test('an image a tool returned goes in the output of its call, as a list of parts', () => {
  const { input } = toResponsesInput([
    { role: 'user', content: 'look at it' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'look', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'a.png: image/png, 3 bytes', images: [PICTURE] },
  ], 'teneral');
  expect(input[2]).toEqual({ type: 'function_call_output', call_id: 'c1', output: [
    { type: 'input_text', text: 'a.png: image/png, 3 bytes' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
  ] });
});

const summary = (...texts: string[]) => ({ type: 'reasoning', id: 'rs_1', summary: texts.map((text) => ({ type: 'summary_text', text })) });
const USAGE = { input_tokens: 1200, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 80, output_tokens_details: { reasoning_tokens: 64 }, total_tokens: 1280 };

test('the usage the stream ends with is returned, with the cached part of the input', () => {
  const done = { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [message('hi')], usage: USAGE } };
  expect(readResponsesStream(sse(CREATED, done))).toEqual({ text: 'hi', toolCalls: [], usage: { input: 1200, output: 80, cached: 1000 } });
  const bare = { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [message('hi')], usage: { input_tokens: 5, output_tokens: 1 } } };
  expect(readResponsesStream(sse(CREATED, bare)).usage).toEqual({ input: 5, output: 1 });
  // Not numbers, or not there: no usage, rather than a made-up one.
  for (const usage of [null, 'much', { input_tokens: '5', output_tokens: 1 }, { input_tokens: -1, output_tokens: 1 }]) {
    const odd = { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [message('hi')], usage } };
    expect('usage' in readResponsesStream(sse(CREATED, odd))).toBe(false);
  }
});

test('the summaries of the reasoning items are returned as one text; an item without a summary gives none', () => {
  const reply = readResponsesStream(sse(CREATED, completed([summary('**Reading the file**\n\nFirst part.', 'Second part.'), call(1, 'read', '{}'), summary('Later.')])));
  expect(reply.reasoning).toBe('**Reading the file**\n\nFirst part.\n\nSecond part.\n\nLater.');
  expect('reasoning' in readResponsesStream(sse(CREATED, completed([REASONING, message('hi')])))).toBe(false);
});

test('a summary is made safe for a terminal and the journal: no control characters, no lone surrogate, a few thousand characters at most', () => {
  expect(tidyReasoning('a\u001b[31mred\u0007\r\nnext\tcol \ud800 end')).toBe('a[31mred\nnext\tcol � end');
  const long = tidyReasoning('x'.repeat(50_000))!;
  expect(long.length).toBeLessThan(4100);
  expect(long).toContain('characters dropped here');
  for (const nothing of ['', '  \n ', undefined, null, 7, ['a']]) expect(tidyReasoning(nothing)).toBeUndefined();
});

test('where the provider refuses the summary field, the request is sent again without it, and it is not asked for again', async () => {
  const sent: Sent[] = [];
  const refusals = [
    '{"error":{"message":"Unsupported parameter: \'reasoning.summary\' is not supported with this model.","param":"reasoning.summary","code":"unsupported_parameter"}}',
    '{"error":{"message":"Your organization must be verified to generate reasoning summaries.","code":"unsupported_value"}}',
    '{"error":{"code":"subscription_sharing_unsupported_capability","param": "reasoning"}}',
  ];
  for (const refusal of refusals) {
    sent.length = 0;
    const provider = responsesProvider({
      baseUrl: () => 'https://api.test/v1', token: async () => 't', model: 'm',
      fetch: recorder([() => new Response(refusal, { status: 400 }), okStream, okStream], sent),
    });
    expect((await provider([{ role: 'user', content: 'x' }], [])).text).toBe('hi');
    await provider([{ role: 'user', content: 'y' }], []);
    expect(sent.map((s) => 'reasoning' in s.body)).toEqual([true, false, false]);
  }
});

test('a refusal that is not about the summary, or a second one, is passed on; and the field can be left out from the start', async () => {
  const sent: Sent[] = [];
  const bad = () => new Response('{"error":{"message":"unknown model"}}', { status: 400 });
  await expect(responsesProvider({ baseUrl: () => 'https://api.test/v1', token: async () => 't', model: 'm', fetch: recorder([bad], sent) })([{ role: 'user', content: 'x' }], []))
    .rejects.toThrow(/unknown model/);
  expect(sent).toHaveLength(1);
  const noSummary = () => new Response('{"error":{"message":"reasoning summaries are not available"}}', { status: 400 });
  await expect(responsesProvider({ baseUrl: () => 'https://api.test/v1', token: async () => 't', model: 'm', fetch: recorder([noSummary, noSummary], sent) })([{ role: 'user', content: 'x' }], []))
    .rejects.toThrow(/not available/);
  expect(sent).toHaveLength(3);
  sent.length = 0;
  await responsesProvider({ baseUrl: () => 'https://api.test/v1', token: async () => 't', model: 'm', summaries: false, fetch: recorder([okStream], sent) })([{ role: 'user', content: 'x' }], []);
  expect('reasoning' in sent[0]!.body).toBe(false);
});
