import type { ToolCall, Usage } from '../kernel/journal';
import { CHATGPT_USAGE_URL, providerFor, userAgent } from '../kernel/providers';
import { accessToken, apiBase } from '../kernel/signin';
import type { Image } from '../body/images';
import { clip } from '../body/text';

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
  /**
   * Images that go with this message: on a user message what the owner sent, on a tool message
   * what `look` returned (brain/memory.ts puts them nowhere else). Not a wire field: each protocol
   * turns it into its own image parts, below.
   */
  images?: Image[];
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Reply {
  text: string;
  toolCalls: ToolCall[];
  /** What the provider says the request cost, when it says. */
  usage?: Usage;
  /** A summary of the model's reasoning, when the provider gives one. For the owner's terminal: it is journaled and never sent back. */
  reasoning?: string;
}

/** The longest reasoning summary that is journaled. */
const REASONING_CAP = 4000;

/** A reasoning summary as it may be journaled and shown on a terminal: well-formed, no control characters but newline and tab, clipped. */
export function tidyReasoning(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const clean = raw.toWellFormed().replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').trim();
  return clean === '' ? undefined : clip(clean, REASONING_CAP);
}

/** Token counts from a provider's `usage`, under whichever names it uses; undefined unless both are numbers. */
function readUsage(raw: unknown): Usage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const u = raw as Record<string, unknown>;
  const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  const input = count(u.prompt_tokens ?? u.input_tokens);
  const output = count(u.completion_tokens ?? u.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  const cached = count(((u.prompt_tokens_details ?? u.input_tokens_details) as { cached_tokens?: unknown } | null | undefined)?.cached_tokens);
  return cached === undefined ? { input, output } : { input, output, cached };
}

/** A reply without the keys it has nothing for. */
function withExtras(reply: Reply, usage: Usage | undefined, reasoning: string | undefined): Reply {
  if (usage !== undefined) reply.usage = usage;
  if (reasoning !== undefined) reply.reasoning = reasoning;
  return reply;
}

const dataUrl = (image: Image): string => `data:${image.mime};base64,${image.data}`;
const names = (images: Image[]): string => images.map((image) => image.name).join(', ');

/**
 * The list as chat-completions takes it. A user message with images becomes text and `image_url`
 * parts. A tool message may hold only text there, so what `look` returned follows as a user
 * message of its own, after the last result of that reply: results must not be parted from their calls.
 */
export function toChatMessages(messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  let held: Image[] = [];
  const part = (image: Image) => ({ type: 'image_url', image_url: { url: dataUrl(image) } });
  const flush = (): void => {
    if (held.length > 0) out.push({ role: 'user', content: [{ type: 'text', text: `[the result of look, as an image: ${names(held)}]` }, ...held.map(part)] });
    held = [];
  };
  for (const m of messages) {
    if (m.role !== 'tool') flush();
    const { images, ...rest } = m;
    if (!images || images.length === 0) out.push(rest);
    else if (m.role === 'tool') {
      out.push(rest);
      held.push(...images);
    } else out.push({ ...rest, content: [...(m.content ? [{ type: 'text', text: m.content }] : []), ...images.map(part)] });
  }
  flush();
  return out;
}

export interface ProviderCallOptions { signal?: AbortSignal }
export type Provider = (messages: ChatMessage[], tools: ToolSpec[], options?: ProviderCallOptions) => Promise<Reply>;

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
 * turn is this code's own fault, and the two are handled differently (see brain/retry.ts).
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

/** What a call is rejected with when its caller cancelled it (`options.signal`). Not a failure of the provider: nothing is to be tried again. */
const cancelled = (): ProviderError => new ProviderError('provider request cancelled', null);

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
  return async (messages, tools, options) => {
    // Cancelled before it began: nothing is sent.
    if (options?.signal?.aborted) throw cancelled();
    const body: Record<string, unknown> = { model: cfg.model, messages: toChatMessages(messages) };
    if (tools.length > 0) body.tools = tools.map((t) => ({ type: 'function', function: t }));
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options?.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
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
      if (options?.signal?.aborted) throw cancelled();
      // Without a limit, an endpoint that stops answering would hold the agent forever.
      if (signal.aborted) throw new ProviderError(`provider timed out after ${timeoutMs / 1000}s`, null);
      throw new ProviderError(`provider could not be reached: ${err instanceof Error ? err.message : String(err)}`, null);
    }
    if (!res.ok) throw new ProviderError(`provider answered ${res.status}: ${text.slice(0, 2000)}`, res.status, text);
    let parsed: { choices?: { message?: { content?: WireContent; tool_calls?: unknown; reasoning_content?: unknown; reasoning?: unknown } }[]; usage?: unknown } | null;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ProviderError(`provider reply is not JSON: ${text.slice(0, 2000)}`, res.status, text);
    }
    const message = parsed?.choices?.[0]?.message;
    if (!message) throw new ProviderError(`provider reply has no message: ${text.slice(0, 2000)}`, res.status, text);
    // Endpoints that show a model's reasoning do it under one of two names; neither is in the protocol itself.
    const reasoning = tidyReasoning(message.reasoning_content) ?? tidyReasoning(message.reasoning);
    return withExtras({ text: contentText(message.content), toolCalls: readCalls(message.tool_calls) }, readUsage(parsed?.usage), reasoning);
  };
}

// --- The Responses API, streamed and stateless ---
//
// The second wire protocol. The loop still hands over the chat-shaped list buildMessages makes;
// here it becomes Responses input, and the reply is put together from the event stream. Nothing
// is stored on the provider's side (`store: false`), so every request carries the whole history.
// Reasoning items the model returns are not kept or sent back: the journal has no field for them.
// Only the summary of the reasoning is asked for and read, for the owner to see.

export interface ResponsesConfig {
  /** Where requests go; asked before each one. */
  baseUrl: () => string;
  /** The bearer token. Asked for before each request, and once more, naming the token refused, after a 401. */
  token: (rejected?: string) => Promise<string>;
  model: string;
  /** Set where the provider wants function tools grouped in a namespace (kernel/providers.ts). */
  namespace?: string;
  /** False where a summary of the reasoning must not be asked for. Default: asked for, and no longer once the provider refuses the field. */
  summaries?: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

type Item = Record<string, unknown>;

/**
 * The system text goes in `instructions`: the ChatGPT plan route rejects system messages among the
 * input. A call is a `function_call` item and its result a `function_call_output`, paired by
 * `call_id`. No item has an `id`: ids name items stored at the provider, and nothing is stored.
 * Images are `input_image` parts: beside the text in a user message, and in the output of a call,
 * which on this protocol may be a list of parts instead of a string.
 */
export function toResponsesInput(messages: ChatMessage[], namespace?: string): { instructions: string; input: Item[] } {
  const system: string[] = [];
  const input: Item[] = [];
  const part = (image: Image): Item => ({ type: 'input_image', image_url: dataUrl(image) });
  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) system.push(m.content);
    } else if (m.role === 'tool') {
      const text = m.content ?? '';
      input.push({ type: 'function_call_output', call_id: m.tool_call_id ?? '', output: m.images?.length ? [...(text ? [{ type: 'input_text', text }] : []), ...m.images.map(part)] : text });
    } else {
      if (m.images?.length) input.push({ role: m.role, content: [...(m.content ? [{ type: 'input_text', text: m.content }] : []), ...m.images.map(part)] });
      else if (m.content) input.push({ role: m.role, content: m.content });
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
  // A reasoning item carries its summary as a list of `summary_text` parts; one item per stretch of reasoning.
  const summaries = output.filter((item) => item.type === 'reasoning').map((item) => contentText(
    Array.isArray(item.summary) ? item.summary.flatMap((s: unknown) => [s, { text: '\n\n' }]) : null,
  ));
  return withExtras(
    { text, toolCalls: readCalls(calls.map((c) => ({ id: c.call_id, function: { name: c.name, arguments: c.arguments } }))) },
    readUsage(last.response?.usage), tidyReasoning(summaries.join('')),
  );
}

/** The provider's way of saying it will not give a reasoning summary here: this model, this account, or this route. */
function saysNoSummary(err: unknown): boolean {
  return err instanceof ProviderError && err.status === 400 && /summar|"param":\s*"reasoning/i.test(err.body);
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
  let summaries = cfg.summaries !== false;
  const once = async (messages: ChatMessage[], tools: ToolSpec[], options?: ProviderCallOptions): Promise<Reply> => {
    // Cancelled before it began, or between the two tries below: no token is asked for and nothing is sent.
    if (options?.signal?.aborted) throw cancelled();
    const { instructions, input } = toResponsesInput(messages, cfg.namespace);
    const body: Record<string, unknown> = { model: cfg.model, input, store: false, stream: true };
    if (instructions !== '') body.instructions = instructions;
    if (tools.length > 0) body.tools = toResponsesTools(tools, cfg.namespace);
    // Without this the reasoning comes back with no summary at all. `auto` is the most detailed one the model has.
    if (summaries) body.reasoning = { summary: 'auto' };
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options?.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    const post = async (bearer: string): Promise<{ res: Response; text: string }> => {
      try {
        // Cancelled while the token was fetched or renewed: the request is not made.
        if (options?.signal?.aborted) throw cancelled();
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
        if (options?.signal?.aborted) throw cancelled();
        if (signal.aborted) throw new ProviderError(`provider timed out after ${timeoutMs / 1000}s`, null);
        throw new ProviderError(`provider could not be reached: ${err instanceof Error ? err.message : String(err)}`, null);
      }
    };
    let bearer = await token();
    let { res, text } = await post(bearer);
    if (options?.signal?.aborted) throw cancelled();
    if (res.status === 401) {
      // The token may have run out or been replaced by another process. One more, then the answer stands.
      const next = await token(bearer);
      if (next !== bearer) ({ res, text } = await post(bearer = next));
    }
    if (!res.ok) throw new ProviderError(`provider answered ${res.status}: ${text.slice(0, 2000)}.${hint(text)}`, res.status, text);
    return readResponsesStream(text);
  };
  return async (messages, tools, options) => {
    try {
      return await once(messages, tools, options);
    } catch (err) {
      // A model that does not reason, or an account that may not have summaries, refuses the field.
      // The owner's view of the reasoning is not worth a turn: asked again without, and not asked for after that.
      if (!summaries || !saysNoSummary(err)) throw err;
      summaries = false;
      return once(messages, tools, options);
    }
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
