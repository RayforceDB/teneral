import { appendEvent, readEvents } from '../kernel/journal';
import { buildMessages } from './context';
import type { Provider } from './provider';
import type { Tool, ToolContext } from './tools';

export interface TurnDeps {
  journal: string;
  gen: string;
  provider: Provider;
  tools: Tool[];
  system: string;
  ctx: ToolContext;
  onText?: (text: string) => void;
  maxRounds?: number;
}

/** Model, tools, model, ... until a reply with no tool calls. 'molt' means: exit with 75 now. */
export async function runTurn(d: TurnDeps): Promise<'done' | 'molt'> {
  const specs = d.tools.map((t) => t.spec);
  for (let round = 0; round < (d.maxRounds ?? 50); round++) {
    // Re-read every round: a sensor may have journaled a stimulus while a tool ran.
    const reply = await d.provider(buildMessages(readEvents(d.journal), d.system), specs);
    appendEvent(d.journal, d.gen, { type: 'assistant', text: reply.text, toolCalls: reply.toolCalls });
    if (reply.text !== '') d.onText?.(reply.text);
    if (reply.toolCalls.length === 0) return 'done';

    for (const call of reply.toolCalls) {
      // The intent goes to disk first, so a crash mid-tool is told apart from one before it.
      appendEvent(d.journal, d.gen, { type: 'tool.intent', callId: call.id, name: call.name, args: call.args });
      let ok = true;
      let output: string;
      try {
        const tool = d.tools.find((t) => t.spec.name === call.name);
        if (!tool) throw new Error(`unknown tool: ${call.name}`);
        output = await tool.run(call.args, d.ctx);
      } catch (err) {
        ok = false;
        output = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
      appendEvent(d.journal, d.gen, { type: 'tool.result', callId: call.id, ok, output });
    }
    if (d.ctx.moltCommit !== null) return 'molt';
  }
  appendEvent(d.journal, d.gen, { type: 'assistant', text: '[round limit reached; waiting for the next stimulus]', toolCalls: [] });
  return 'done';
}
