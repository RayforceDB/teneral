import { appendEvent, readEvents, type JournalEvent } from '../kernel/journal';
import { DEFAULT_BUDGET, buildMessages, kernelNote } from './context';
import type { Provider } from './provider';
import type { Tool, ToolContext } from './tools';

export interface TurnDeps {
  journal: string;
  gen: string;
  provider: Provider;
  tools: Tool[];
  /** Called every round: the agent may rewrite its soul in the middle of a turn. */
  system: () => string;
  ctx: ToolContext;
  onText?: (text: string) => void;
  /** Called with a tool's name just before it runs. */
  onTool?: (name: string) => void;
  maxRounds?: number;
  /** Characters for one request: system prompt, tool specs and messages together. */
  budgetChars?: number;
}

/** The provider's way of saying the request was too long; `provider answered <status>: <body>` is how body/provider.ts words a refusal. */
function saysTooLong(err: unknown): boolean {
  const refusal = /^provider answered (400|413): (.*)$/s.exec(err instanceof Error ? err.message : '');
  return refusal !== null && /context|token|length/i.test(refusal[2]!);
}

/** Whether anything that calls for a reply was journaled after the first `shown` events. */
function arrivedSince(journal: string, shown: number): boolean {
  return readEvents(journal).slice(shown).some((e: JournalEvent) => e.type === 'stimulus' || kernelNote(e) !== null);
}

/** Model, tools, model, ... until a reply with no tool calls. 'molt' means: exit with 75 now. */
export async function runTurn(d: TurnDeps): Promise<'done' | 'molt'> {
  const specs = d.tools.map((t) => t.spec);
  const specsSize = JSON.stringify(specs).length;
  let budget = d.budgetChars ?? DEFAULT_BUDGET;
  // How much of the journal the model has been shown. The journal only grows, so everything past this is new to it.
  let shown = 0;
  for (let round = 0; round < (d.maxRounds ?? 50); round++) {
    // Re-read every round: a sensor may have journaled a stimulus while a tool ran.
    const events = readEvents(d.journal);
    shown = events.length;
    const system = d.system();
    const ask = () => d.provider(buildMessages(events, system, budget - specsSize), specs);
    const reply = await ask().catch((err: unknown) => {
      if (!saysTooLong(err)) throw err;
      // Characters are only an estimate of tokens. Half is tried once and kept for the rest of the turn.
      budget = Math.floor(budget / 2);
      return ask();
    });
    appendEvent(d.journal, d.gen, { type: 'assistant', text: reply.text, toolCalls: reply.toolCalls });
    if (reply.text !== '') d.onText?.(reply.text);
    if (reply.toolCalls.length === 0) {
      // Something that arrived while the model was answering was not in what it saw; it gets a round of its own.
      if (arrivedSince(d.journal, shown)) continue;
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
      d.onTool?.(call.name);
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
      // Well-formed, too: half of a character pair in the journal would go into every later request.
      appendEvent(d.journal, d.gen, { type: 'tool.result', callId: call.id, ok, output: output.toWellFormed() });
    }
    if (d.ctx.moltCommit !== null) return 'molt';
  }
  // The note below reads as a finished reply. Written over something the model never saw, it would
  // mark that as answered; without it the turn stays owed and the caller starts another.
  if (arrivedSince(d.journal, shown)) return 'done';
  appendEvent(d.journal, d.gen, { type: 'assistant', text: '[round limit reached; waiting for the next stimulus]', toolCalls: [] });
  return 'done';
}
