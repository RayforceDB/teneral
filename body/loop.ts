import { appendEvent, readEvents } from '../kernel/journal';
import { buildMessages, kernelNote } from './context';
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
    const shown = readEvents(d.journal);
    const reply = await d.provider(buildMessages(shown, d.system), specs);
    const own = appendEvent(d.journal, d.gen, { type: 'assistant', text: reply.text, toolCalls: reply.toolCalls });
    if (reply.text !== '') d.onText?.(reply.text);
    if (reply.toolCalls.length === 0) {
      // Something that arrived while the model was answering was not in what it saw.
      // The journal only grows, so everything past what was shown is new; it gets a round of its own.
      const missed = readEvents(d.journal).slice(shown.length)
        .some((e) => e.id !== own.id && (e.type === 'stimulus' || kernelNote(e) !== null));
      if (missed) continue;
      return 'done';
    }

    for (const call of reply.toolCalls) {
      if (d.ctx.moltCommit !== null) {
        // The molt committed the workspace; anything run after it would change what the gates judge.
        // No intent: the call never started. It still gets a result, so every call has an answer.
        appendEvent(d.journal, d.gen, {
          type: 'tool.result', callId: call.id, ok: false, output: 'error: not run, because a molt was requested earlier in this reply',
        });
        continue;
      }
      // The intent goes to disk first, so a crash mid-tool is told apart from one before it.
      appendEvent(d.journal, d.gen, { type: 'tool.intent', callId: call.id, name: call.name, args: call.args });
      let ok = true;
      let output: string;
      try {
        const tool = d.tools.find((t) => t.spec.name === call.name);
        if (!tool) throw new Error(`unknown tool: ${call.name}`);
        // The tools are the agent's to rewrite; whatever one returns, the journal holds text.
        output = String(await tool.run(call.args, d.ctx));
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
