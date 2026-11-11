import type { ToolCall } from '../kernel/journal';

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
      if (signal.aborted) throw new Error(`provider timed out after ${timeoutMs / 1000}s`);
      throw err;
    }
    if (!res.ok) throw new Error(`provider answered ${res.status}: ${text.slice(0, 2000)}`);
    let parsed: { choices?: { message?: { content?: WireContent; tool_calls?: unknown } }[] } | null;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`provider reply is not JSON: ${text.slice(0, 2000)}`);
    }
    const message = parsed?.choices?.[0]?.message;
    if (!message) throw new Error(`provider reply has no message: ${text.slice(0, 2000)}`);
    return { text: contentText(message.content), toolCalls: readCalls(message.tool_calls) };
  };
}
