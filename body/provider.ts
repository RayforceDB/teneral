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

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * The ids are the model's, and results are paired with calls by id.
 * A missing, empty or repeated id gets a replacement so each call in a reply has its own.
 */
function ownIds(calls: WireToolCall[]): string[] {
  const taken = new Set<string>();
  return calls.map((c, i) => {
    let id = typeof c.id === 'string' && c.id !== '' ? c.id : `call_${i}`;
    while (taken.has(id)) id = `${id}_${i}`;
    taken.add(id);
    return id;
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
    let parsed: { choices?: { message?: { content?: WireContent; tool_calls?: WireToolCall[] } }[] } | null;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`provider reply is not JSON: ${text.slice(0, 2000)}`);
    }
    const message = parsed?.choices?.[0]?.message;
    if (!message) throw new Error(`provider reply has no message: ${text.slice(0, 2000)}`);
    const calls = message.tool_calls ?? [];
    const ids = ownIds(calls);
    return {
      text: contentText(message.content),
      toolCalls: calls.map((c, i) => ({ id: ids[i]!, name: c.function.name, args: parseArgs(c.function.arguments) })),
    };
  };
}
