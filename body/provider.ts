import type { ToolCall } from '../kernel/journal';
import { CHATGPT_USAGE_URL, providerFor, userAgent } from '../kernel/providers';
import { accessToken, apiBase } from '../kernel/signin';

export interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Reply {
  text: string;
  toolCalls: ToolCall[];
}

export type Provider = (messages: ChatMessage[], tools: ToolSpec[]) => Promise<Reply>;

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  /** How long one request may take, headers and body together. Default: ten minutes. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * A request that failed on the provider's side or on the way there. Anything else thrown during a
 * turn is this code's own fault, and the two are handled differently (see body/retry.ts).
 */
export class ProviderError extends Error {
  /** The HTTP status, or null when no answer came: not reachable, or timed out. */
  readonly status: number | null;
  /** What the provider said, as far as it was read. */
  readonly body: string;

  constructor(message: string, status: number | null, body = '') {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.body = body;
  }
}

/** Some endpoints answer with a list of parts instead of a string; the text parts are the reply. */
type WireContent = string | null | unknown[];

function contentText(content: WireContent | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'object' && part !== null ? (part as { text?: unknown }).text : undefined))
    .filter((text): text is string => typeof text === 'string')
    .join('');
}

function parseArgs(raw: unknown): unknown {
  // Some endpoints send the arguments already parsed, and some leave them out for a tool that takes none.
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * The model's tool calls, whatever shape they came in. Nothing here throws: a call that cannot be
 * read is kept as a call to `unknown` carrying what was sent, so the loop answers it with an error
 * and the model sees its mistake.
 */
function readCalls(raw: unknown): ToolCall[] {
  if (raw === undefined || raw === null) return [];
  const taken = new Set<string>();
  return (Array.isArray(raw) ? raw : [raw]).map((entry: unknown, i) => {
    const c = (typeof entry === 'object' && entry !== null ? entry : {}) as { id?: unknown; function?: { name?: unknown; arguments?: unknown } | null };
    // Results are paired with calls by id, so each call in a reply needs one of its own.
    let id = typeof c.id === 'string' && c.id !== '' ? c.id : `call_${i}`;
    while (taken.has(id)) id = `${id}_${i}`;
    taken.add(id);
    const fn = c.function;
    if (typeof fn !== 'object' || fn === null || typeof fn.name !== 'string') return { id, name: 'unknown', args: entry };
    return { id, name: fn.name, args: parseArgs(fn.arguments) };
  });
}

export function openAiProvider(cfg: ProviderConfig): Provider {
  const send = cfg.fetch ?? fetch;
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (messages, tools) => {
    const body: Record<string, unknown> = { model: cfg.model, messages };
    if (tools.length > 0) body.tools = tools.map((t) => ({ type: 'function', function: t }));
    const signal = AbortSignal.timeout(timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await send(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(body),
        signal,
      });
      text = await res.text();
    } catch (err) {
      // Without a limit, an endpoint that stops answering would hold the agent forever.
      if (signal.aborted) throw new ProviderError(`provider timed out after ${timeoutMs / 1000}s`, null);
      throw new ProviderError(`provider could not be reached: ${err instanceof Error ? err.message : String(err)}`, null);
    }
    if (!res.ok) throw new ProviderError(`provider answered ${res.status}: ${text.slice(0, 2000)}`, res.status, text);
    let parsed: { choices?: { message?: { content?: WireContent; tool_calls?: unknown } }[] } | null;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ProviderError(`provider reply is not JSON: ${text.slice(0, 2000)}`, res.status, text);
    }
    const message = parsed?.choices?.[0]?.message;
    if (!message) throw new ProviderError(`provider reply has no message: ${text.slice(0, 2000)}`, res.status, text);
    return { text: contentText(message.content), toolCalls: readCalls(message.tool_calls) };
  };
}

// --- The Responses API, streamed and stateless ---
//
// The second wire protocol. The loop still hands over the chat-shaped list buildMessages makes;
// here it becomes Responses input, and the reply is put together from the event stream. Nothing
// is stored on the provider's side (`store: false`), so every request carries the whole history.
// Reasoning items the model returns are not kept or sent back: the journal has no field for them.

export interface ResponsesConfig {
  /** Where requests go; asked before each one. */
  baseUrl: () => string;
  /** The bearer token. Asked for before each request, and once more, naming the token refused, after a 401. */
  token: (rejected?: string) => Promise<string>;
  model: string;
  /** Set where the provider wants function tools grouped in a namespace (kernel/providers.ts). */
  namespace?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

type Item = Record<string, unknown>;

/**
 * The system text goes in `instructions`: the ChatGPT plan route rejects system messages among the
 * input. A call is a `function_call` item and its result a `function_call_output`, paired by
 * `call_id`. No item has an `id`: ids name items stored at the provider, and nothing is stored.
 */
export function toResponsesInput(messages: ChatMessage[], namespace?: string): { instructions: string; input: Item[] } {
  const system: string[] = [];
  const input: Item[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) system.push(m.content);
    } else if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.tool_call_id ?? '', output: m.content ?? '' });
    } else {
      if (m.content) input.push({ role: m.role, content: m.content });
      for (const c of m.tool_calls ?? []) {
        input.push({ type: 'function_call', call_id: c.id, name: c.function.name, arguments: c.function.arguments, ...(namespace ? { namespace } : {}) });
      }
    }
  }
  return { instructions: system.join('\n\n'), input };
}

export function toResponsesTools(tools: ToolSpec[], namespace?: string): Item[] {
  const flat = tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
  if (!namespace || flat.length === 0) return flat;
  return [{ type: 'namespace', name: namespace, description: 'The tools of the teneral agent.', tools: flat }];
}

/** The HTTP status that goes with an error code that arrived inside a stream. From the provider's documentation; anything else counts as its fault (500). */
const CODE_STATUS: Record<string, number> = {
  subscription_sharing_usage_limit_exceeded: 429,
  rate_limit_exceeded: 429,
  subscription_sharing_usage_unavailable: 503,
  subscription_sharing_user_unavailable: 503,
  subscription_sharing_user_not_eligible: 403,
  subscription_sharing_route_not_supported: 403,
  subscription_sharing_invalid_user: 401,
  subscription_sharing_unsupported_capability: 400,
  context_length_exceeded: 400,
};

/** Where the owner looks when their ChatGPT plan's limit, or this app's share of it, is used up. */
function hint(body: string): string {
  return body.includes('subscription_sharing_usage_limit_exceeded') ? ` The ChatGPT plan's usage limit is reached; manage usage at ${CHATGPT_USAGE_URL}` : '';
}

/**
 * The reply in a finished event stream. Only `response.completed` is success: a failed response,
 * an error event, or a stream that just ends is a ProviderError, with the status the error's code
 * stands for, so the retry rules treat it as they would the same answer without a stream.
 */
export function readResponsesStream(stream: string): Reply {
  const done: Item[] = [];
  type End = { type: string; response?: Item; code?: unknown; message?: unknown };
  let last: End | null = null;
  for (const block of stream.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (data === '' || data === '[DONE]') continue;
    let event: { type?: unknown; item?: unknown; response?: Item };
    try {
      event = JSON.parse(data);
    } catch {
      continue; // half an event, where the stream broke off
    }
    if (event.type === 'response.output_item.done' && typeof event.item === 'object' && event.item !== null) done.push(event.item as Item);
    if (event.type === 'response.completed' || event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') {
      last = event as End;
    }
  }
  if (last === null) throw new ProviderError('the provider\'s stream ended before the response was complete', null, stream.slice(-2000));
  if (last.type === 'response.failed' || last.type === 'error') {
    const error = (last.type === 'error' ? last : last.response?.error ?? {}) as { code?: unknown; message?: unknown };
    const code = typeof error.code === 'string' ? error.code : 'unknown_error';
    const body = JSON.stringify({ error: { code, message: error.message ?? null } });
    throw new ProviderError(`the provider's response failed: ${code}: ${String(error.message ?? '')}.${hint(body)}`, CODE_STATUS[code] ?? 500, body);
  }
  const sent = last.response?.output;
  const output = (Array.isArray(sent) && sent.length > 0 ? sent as Item[] : done).filter((item) => item.status !== 'in_progress' && item.status !== 'incomplete');
  let text = output.filter((item) => item.type === 'message').map((item) => contentText(item.content as WireContent)).join('');
  if (last.type === 'response.incomplete') {
    const reason = (last.response?.incomplete_details as { reason?: unknown } | undefined)?.reason;
    text += `${text === '' ? '' : '\n'}[this reply was cut off by the provider: ${String(reason ?? 'no reason given')}]`;
  }
  const calls = output.filter((item) => item.type === 'function_call');
  return { text, toolCalls: readCalls(calls.map((c) => ({ id: c.call_id, function: { name: c.name, arguments: c.arguments } }))) };
}

export function responsesProvider(cfg: ResponsesConfig): Provider {
  const send = cfg.fetch ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const token = async (rejected?: string): Promise<string> => {
    try {
      return await cfg.token(rejected);
    } catch (err) {
      // No sign-in, or it could not be renewed: for the owner to mend, like a bad key.
      throw new ProviderError(`no token for the provider: ${err instanceof Error ? err.message : String(err)}`, 401);
    }
  };
  return async (messages, tools) => {
    const { instructions, input } = toResponsesInput(messages, cfg.namespace);
    const body: Record<string, unknown> = { model: cfg.model, input, store: false, stream: true };
    if (instructions !== '') body.instructions = instructions;
    if (tools.length > 0) body.tools = toResponsesTools(tools, cfg.namespace);
    const signal = AbortSignal.timeout(timeoutMs);
    const post = async (bearer: string): Promise<{ res: Response; text: string }> => {
      try {
        const res = await send(`${cfg.baseUrl().replace(/\/+$/, '')}/responses`, {
          method: 'POST',
          // The user agent is teneral's own name and version (kernel/providers.ts): the truth about who is asking.
          headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${bearer}`, 'user-agent': userAgent() },
          body: JSON.stringify(body),
          signal,
        });
        // The stream is read to its end; the reply is put together afterwards.
        return { res, text: await res.text() };
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        if (signal.aborted) throw new ProviderError(`provider timed out after ${timeoutMs / 1000}s`, null);
        throw new ProviderError(`provider could not be reached: ${err instanceof Error ? err.message : String(err)}`, null);
      }
    };
    let bearer = await token();
    let { res, text } = await post(bearer);
    if (res.status === 401) {
      // The token may have run out or been replaced by another process. One more, then the answer stands.
      const next = await token(bearer);
      if (next !== bearer) ({ res, text } = await post(bearer = next));
    }
    if (!res.ok) throw new ProviderError(`provider answered ${res.status}: ${text.slice(0, 2000)}.${hint(text)}`, res.status, text);
    return readResponsesStream(text);
  };
}

/**
 * The provider this environment describes. `TENERAL_PROVIDER` names an entry of the kernel's table
 * (kernel/providers.ts); unset or unknown, it is chat-completions with a key, as it always was.
 *
 * A key in `TENERAL_API_KEY` is always used as it is, at `TENERAL_BASE_URL`: that is how the smoke
 * gate hands a body a dummy token. Only with no key does a sign-in provider open the owner's
 * stored sign-in, and then the address comes from that file as well, never from the environment,
 * so the owner's token cannot be pointed anywhere else by a variable. The token is held in memory
 * only: never in the environment, the journal or the workspace.
 *
 * The kernel's setup (kernel/setup.ts) calls this too, for its test request. Keep its shape.
 */
export function connect(env: Record<string, string | undefined>, send?: typeof fetch): Provider {
  const need = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const entry = providerFor(env.TENERAL_PROVIDER);
  const model = need('TENERAL_MODEL');
  if (entry.wire === 'chat') return openAiProvider({ baseUrl: need('TENERAL_BASE_URL'), apiKey: need('TENERAL_API_KEY'), model, fetch: send });
  const namespace = entry.tools === 'namespace' ? 'teneral' : undefined;
  if (entry.auth === 'key' || env.TENERAL_API_KEY) {
    const baseUrl = need('TENERAL_BASE_URL');
    const key = need('TENERAL_API_KEY');
    return responsesProvider({ baseUrl: () => baseUrl, token: async () => key, model, namespace, fetch: send });
  }
  const dir = need('TENERAL_AUTH');
  return responsesProvider({
    baseUrl: () => apiBase(dir, entry.id), token: (rejected) => accessToken(dir, { id: entry.id, rejected }), model, namespace, fetch: send,
  });
}
