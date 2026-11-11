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
  return async (messages, tools) => {
    const body: Record<string, unknown> = { model: cfg.model, messages };
    if (tools.length > 0) body.tools = tools.map((t) => ({ type: 'function', function: t }));
    const res = await send(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`provider answered ${res.status}: ${text.slice(0, 2000)}`);
    const message = (JSON.parse(text) as { choices?: { message?: { content?: string | null; tool_calls?: WireToolCall[] } }[] })
      .choices?.[0]?.message;
    if (!message) throw new Error(`provider reply has no message: ${text.slice(0, 2000)}`);
    const calls = message.tool_calls ?? [];
    const ids = ownIds(calls);
    return {
      text: message.content ?? '',
      toolCalls: calls.map((c, i) => ({ id: ids[i]!, name: c.function.name, args: parseArgs(c.function.arguments) })),
    };
  };
}
