import { appendEvent, readEvents, type JournalEvent } from './journal';
import { DEFAULT_BUDGET, buildMessages, stemNote, type Sight } from './memory';
import type { Provider, Reply } from './provider';
import { saysNoImages, saysTooLong } from './retry';
import type { Tool, ToolContext } from '../body/tools';

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
  /** How images are loaded and how many go in a request. Without it, no image is ever sent. */
  sight?: Sight;
  /** Aborts when the owner interrupts this turn (body/main.ts). The turn then ends as 'interrupted'. */
  signal?: AbortSignal;
  /** How long a running tool gets to stop by itself after that, before the turn ends without it. Default: two seconds. */
  abandonMs?: number;
}

const ABANDON_MS = 2000;
/** The two marks brain/memory.ts gives a call that a stopped process left unanswered, as journaled here when it was the owner who stopped the turn. */
const CUT_BY_OWNER =
  '[interrupted] Your owner interrupted this turn while this tool was running. It may have partly run. Check the current state before repeating it.';
const NOT_RUN_FOR_OWNER = '[not started] Your owner interrupted this turn before this tool ran.';
const LEFT = Symbol('left behind');

/** Resolves `ms` after `signal` aborts, for a tool that does not stop when asked. `stop` ends the waiting. */
function leftBehind(signal: AbortSignal, ms: number): { gone: Promise<typeof LEFT>; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = (): void => {};
  const gone = new Promise<typeof LEFT>((resolve) => {
    onAbort = () => { timer = setTimeout(() => resolve(LEFT), ms); };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  return { gone, stop: () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); } };
}

/** Whether anything that calls for a reply was journaled after the first `shown` events. */
function arrivedSince(journal: string, shown: number): boolean {
  return readEvents(journal).slice(shown).some((e: JournalEvent) => e.type === 'stimulus' || stemNote(e) !== null);
}

/**
 * Model, tools, model, ... until a reply with no tool calls. 'mutation' means: exit with 75 now.
 *
 * 'interrupted' means the owner stopped the turn (`signal`). The request to the model is cancelled
 * and its reply, if any was on the way, is lost; a running tool is told to stop. Every call that was
 * journaled still gets a result, and the journal ends with `turn.interrupted`, after which no turn
 * is owed. Two things an interruption does not undo: a reply with no tool calls that had already
 * arrived ends the turn as 'done', and a mutation already requested stays requested.
 */
export async function runTurn(d: TurnDeps): Promise<'done' | 'mutation' | 'interrupted'> {
  const interrupted = (): 'interrupted' => {
    appendEvent(d.journal, d.gen, { type: 'turn.interrupted' });
    return 'interrupted';
  };
  const specs = d.tools.map((t) => t.spec);
  const specsSize = JSON.stringify(specs).length;
  let budget = d.budgetChars ?? DEFAULT_BUDGET;
  // How much of the journal the model has been shown. The journal only grows, so everything past this is new to it.
  let shown = 0;
  // Set when the provider refused a request because of its images; holds for the rest of the turn.
  let blind = false;
  for (let round = 0; round < (d.maxRounds ?? 50); round++) {
    if (d.signal?.aborted) return interrupted();
    // Re-read every round: a sensor may have journaled a stimulus while a tool ran.
    const events = readEvents(d.journal);
    shown = events.length;
    const system = d.system();
    let halved = false;
    let reply: Reply;
    for (;;) {
      const messages = buildMessages(events, system, budget - specsSize, d.sight && { ...d.sight, refused: blind });
      try {
        reply = await d.provider(messages, specs, d.signal && { signal: d.signal });
        break;
      } catch (err) {
        // Whatever the provider threw once the owner had interrupted, it is not a failure, and is not answered by asking again.
        if (d.signal?.aborted) return interrupted();
        if (!blind && messages.some((m) => m.images !== undefined) && saysNoImages(err)) {
          // One image the model or the route cannot take must not hold up the conversation: asked again with a note in its place.
          blind = true;
        } else if (!halved && saysTooLong(err)) {
          // Characters are only an estimate of tokens. Half is tried once and kept for the rest of the turn.
          budget = Math.floor(budget / 2);
          halved = true;
        } else throw err;
      }
    }
    // The usage and the summary of the reasoning are for the owner and the record. buildMessages never reads them back.
    appendEvent(d.journal, d.gen, {
      type: 'assistant', text: reply.text, toolCalls: reply.toolCalls,
      ...(reply.usage ? { usage: reply.usage } : {}), ...(reply.reasoning ? { reasoning: reply.reasoning } : {}),
    });
    if (reply.text !== '') d.onText?.(reply.text);
    if (reply.toolCalls.length === 0) {
      // Something that arrived while the model was answering was not in what it saw; it gets a round of its own.
      if (arrivedSince(d.journal, shown)) continue;
      return 'done';
    }

    for (const call of reply.toolCalls) {
      if (d.ctx.mutationCommit !== null) {
        // The mutation committed the workspace; anything run after it would change what the gates judge.
        // No intent: the call never started. It still gets a result, so every call has an answer.
        appendEvent(d.journal, d.gen, {
          type: 'tool.result', callId: call.id, ok: false, output: 'error: not run, because a mutation was requested earlier in this reply',
        });
        continue;
      }
      if (d.signal?.aborted) {
        // The owner interrupted before this call began. As above: no intent, and a result all the same.
        appendEvent(d.journal, d.gen, { type: 'tool.result', callId: call.id, ok: false, output: NOT_RUN_FOR_OWNER });
        continue;
      }
      // The intent goes to disk first, so a crash mid-tool is told apart from one before it.
      appendEvent(d.journal, d.gen, { type: 'tool.intent', callId: call.id, name: call.name, args: call.args });
      d.onTool?.(call.name);
      let ok = true;
      let output: string;
      const wait = d.signal && leftBehind(d.signal, d.abandonMs ?? ABANDON_MS);
      try {
        const tool = d.tools.find((t) => t.spec.name === call.name);
        if (!tool) throw new Error(`unknown tool: ${call.name}`);
        // The tools are the agent's to rewrite; whatever one returns, the journal holds text.
        const running = tool.run(call.args, d.ctx, d.signal);
        const result = wait ? await Promise.race([running, wait.gone]) : await running;
        if (result === LEFT) {
          // A tool that ignores the signal must not hold an interrupted turn. What it later returns or throws is nobody's.
          void Promise.resolve(running).catch(() => {});
          output = 'It did not stop when asked and was left behind: it may still be running.';
        } else output = String(result);
      } catch (err) {
        ok = false;
        output = `error: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        wait?.stop();
      }
      // Interrupted while it ran: the result says so first, whatever the tool made of being stopped.
      if (d.signal?.aborted) {
        ok = false;
        output = `${CUT_BY_OWNER}\n${output}`;
      }
      // Well-formed, too: half of a character pair in the journal would go into every later request.
      appendEvent(d.journal, d.gen, { type: 'tool.result', callId: call.id, ok, output: output.toWellFormed() });
    }
    // A mutation that was requested before the interruption is the stem's to judge now; the interruption is dropped.
    if (d.ctx.mutationCommit !== null) return 'mutation';
    if (d.signal?.aborted) return interrupted();
  }
  // The note below reads as a finished reply. Written over something the model never saw, it would
  // mark that as answered; without it the turn stays owed and the caller starts another.
  if (arrivedSince(d.journal, shown)) return 'done';
  appendEvent(d.journal, d.gen, { type: 'assistant', text: '[round limit reached; waiting for the next stimulus]', toolCalls: [] });
  return 'done';
}
