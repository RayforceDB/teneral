import { QUESTION_MAX, QUESTION_MIN, REMINDED_KIND, type Reminder } from './reminded';
import { acceptanceNotes } from "../body/acceptance";
import { REFUSED_KIND, SENT_KIND, type BudgetDecision } from '../body/adaptive-budget';
import { appendEvent, journalSize, readEvents, readEventsFrom, type JournalEvent } from './journal';
import { requestFrom } from './frame';
import type { ChatMessage } from './provider';
import { DEFAULT_BUDGET, stemNote, type Sight, type View } from './memory';
import { IMAGE_REFUSAL_KIND, imageChars, imageRoute, refusedImages, type ImageRoute } from '../body/images';
import type { Provider, Reply } from './provider';
import { NO_OP_REPLY, QUIET_REPLY, ROUND_LIMIT_REPLY, SAME_REQUEST_REPLY, quietReply } from './quiet';
import { saysNoImages, saysTooLong } from './retry';
import { SHOWN_KIND } from './shown';
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
  /** Incremental provider text; final `onText` is suppressed only for that reply. */
  onDelta?: (delta: string) => void;
  /** Called with a tool's name just before it runs. */
  onTool?: (name: string) => void;
  maxRounds?: number;
  /** Who stopped the turn when `signal` aborts, as the results of the calls it cut read. Without it, the owner: only they interrupt the agent's own turns. */
  stoppedBy?: { cut: string; notRun: string };
  /** Characters for one request: system prompt, tool specs and messages together. */
  budgetChars?: number;
  /** Characters of the conversation shown as it happened; what is older is shown as memories. Default: brain/logbook.ts. */
  tailChars?: number;
  /**
   * Asked once, at the start of a turn: what of the agent's older memories the thing just said
   * brings back (brain/reminded.ts). `inFront` is the request as it would be sent without it.
   * Null when nothing does. Omitted in tests of everything else.
   */
  remind?: (question: string, inFront: string, events: JournalEvent[]) => Reminder | null;
  /** Characters the memories of older episodes may take. Default: the one in brain/logbook.ts. */
  logbookChars?: number;
  /** The budget chooser's state: set at turn start from the journal's measurements, journaled when it changes. */
  budget?: BudgetDecision;
  /** How images are loaded and how many go in a request. Without it, no image is ever sent. */
  sight?: Sight;
  /** Provider identity for persistent image refusals. Omit only in isolated tests. */
  imageRoute?: ImageRoute;
  /** Aborts when the owner interrupts this turn (body/main.ts). The turn then ends as 'interrupted'. */
  signal?: AbortSignal;
  /** How long a running tool gets to stop by itself after that, before the turn ends without it. Default: two seconds. */
  abandonMs?: number;
  /** Begin/end external composition for this turn's exact stimulus; absent or undefined means no indicator. */
  onTyping?: (stimulus?: Extract<JournalEvent, { type: 'stimulus' }>) => (active: boolean) => void;
}

const ABANDON_MS = 2000;
/** The two marks brain/memory.ts gives a call that a stopped process left unanswered, as journaled here when it was the owner who stopped the turn. */
const CUT_BY_OWNER =
  '[interrupted] Your owner interrupted this turn while this tool was running. It may have partly run. Check the current state before repeating it.';
const NOT_RUN_FOR_OWNER = '[not started] Your owner interrupted this turn before this tool ran.';
const LEFT = Symbol('left behind');

/**
 * Whether a turn woken by this source may end with the internal quiet reply. A line typed at the
 * owner's terminal always gets words there; a tick, a notification or talk in a chat, where any
 * answer goes out by a tool, often deserves none here.
 */
export function mayStayQuiet(source: string | undefined): boolean {
  return source !== undefined && source !== 'birth' && source !== 'terminal';
}

/** For tests: count only incremental suffix reads, not the one full read at turn start. */
export const journalSuffixReads: { path: string; bytes: number }[] = [];

/** One turn's journal view. Only the small suffix added during the turn is reparsed. */
function turnJournal(journal: string): { read: () => JournalEvent[]; refresh: () => void } {
  let events = readEvents(journal);
  let offset = journalSize(journal);
  return {
    read: () => events,
    refresh: () => {
      const size = journalSize(journal);
      // A journal only grows. Replacing or truncating it falls back to the full reader.
      if (size < offset) events = readEvents(journal);
      else {
        journalSuffixReads.push({ path: journal, bytes: size - offset });
        events = events.concat(readEventsFrom(journal, offset));
      }
      offset = size;
    },
  };
}

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
function arrivedSince(events: JournalEvent[], shown: number): boolean {
  const accepted = acceptanceNotes(events);
  return events.slice(shown).some((e: JournalEvent) => e.type === 'stimulus' || stemNote(e) !== null || accepted.has(e.id));
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
/**
 * A tool call that cannot do anything: a shell asked to run nothing, `true`, `:` or `exit 0`. A model
 * that has decided to stop but keeps emitting such calls never ends its turn (it did, for hours, on a
 * clock tick, each call costing a full request). Such a call is not run; its result says how a turn ends.
 */
export function noOpCall(call: { name: string; args: unknown }): boolean {
  if (call.name !== 'bash' || typeof call.args !== 'object' || call.args === null) return false;
  const command = (call.args as Record<string, unknown>).command;
  return (command === undefined || typeof command === 'string') && /^\s*(true|:|exit(\s+0)?)?\s*;?\s*$/.test(command ?? '');
}

export const NO_OP_RESULT = 'Not run: this call does nothing. A turn ends with a reply that has no tool call in it; on a clock turn with nothing to do, that reply is exactly ' + QUIET_REPLY + '. A second round of calls like this ends the turn for you.';

export async function runTurn(d: TurnDeps): Promise<'done' | 'mutation' | 'interrupted'> {
  // The thing just said, asked of the past where the turn has one: the journal is not read through for it.
  const said = d.signal?.aborted ? undefined : d.ctx.past !== undefined ? d.ctx.past.latest('stimulus') ?? undefined : readEvents(d.journal).findLast((e) => e.type === 'stimulus');
  const stimulus = said?.type === 'stimulus' ? said : undefined;
  const typing = d.onTyping?.(stimulus);
  typing?.(true);
  try {
    return await runTurnInner(d);
  } finally {
    // The external status is best effort and bounded. It is never allowed to hold the reply or crash the body.
    typing?.(false);
  }
}

async function runTurnInner(d: TurnDeps): Promise<'done' | 'mutation' | 'interrupted'> {
  const interrupted = (): 'interrupted' => {
    appendEvent(d.journal, d.gen, { type: 'turn.interrupted' });
    return 'interrupted';
  };
  const specs = d.tools.map((t) => t.spec);
  const specsSize = JSON.stringify(specs).length;
  let budget = d.budget?.budgetChars ?? d.budgetChars ?? DEFAULT_BUDGET;
  // How much of the journal the model has been shown. The journal only grows, so everything past this is new to it.
  let shown = 0;
  // Set when the provider refused a request because of its images; holds for the rest of the turn.
  let blind = false;
  // A length-limited answer gets one continuation per turn. A second cut-off stays visibly marked.
  let continued = false;
  const route = d.imageRoute;
  const journal = turnJournal(d.journal);
  const request = (events: JournalEvent[], system: string, budgetChars: number, sight: Sight | undefined, view: View): ChatMessage[] => requestFrom(d.ctx.past, events, system, budgetChars, sight, view);
  // A clock turn that decides to do nothing still needs a terminal assistant event. Store the
  // internal marker in that case, not its streamed words; keeper hides it in both clients.
  const quietTick = mayStayQuiet(journal.read().findLast(e => e.type === 'stimulus')?.source);
  const learned = route ? refusedImages(journal.read(), route) : new Set<string>();
  // Rounds in a row made of nothing but calls that do nothing (noOpCall). The second ends the turn.
  let idleRounds = 0;
  // The request of the round before, and how many rounds in a row began with that same request.
  // Every round adds to the journal, so the same request again means the agent is not being shown
  // what it just did; it would do it again for as long as it is asked. The third ends the turn.
  let lastRequest = '';
  let sameRequests = 0;
  for (let round = 0; round < (d.maxRounds ?? 50); round++) {
    if (d.signal?.aborted) return interrupted();
    // A sensor may have journaled a stimulus while a tool ran; read only that new suffix.
    journal.refresh();
    let events = journal.read();
    if (round === 0 && d.remind !== undefined) {
      // Before the first request of the turn, and only for something said that is a question to look by.
      const asked = events.findLast((e) => e.type === 'stimulus');
      const question = asked?.type === 'stimulus' && !mayStayQuiet(asked.source) ? asked.text.slice(0, QUESTION_MAX) : '';
      const answered = asked === undefined || events.slice(events.indexOf(asked) + 1).some((e) => e.type === 'assistant' || (e.type === 'note' && e.kind === REMINDED_KIND));
      if (question.length >= QUESTION_MIN && !answered) {
        let reminder: Reminder | null = null;
        try {
          const inFront = request(events, d.system(), budget - specsSize, undefined, { tailChars: d.tailChars, ...(d.logbookChars === undefined ? {} : { logbookChars: d.logbookChars }) });
          reminder = d.remind(question, inFront.map((m) => m.content ?? '').join('\n'), events);
        } catch (err) {
          // Remembering is a help, not a condition: the turn goes on without it.
          console.error(`[memory] nothing was brought back for this turn: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (reminder !== null) {
          appendEvent(d.journal, d.gen, { type: 'note', kind: REMINDED_KIND, data: reminder });
          journal.refresh();
          events = journal.read();
        }
      }
    }
    shown = events.length;
    // Durable request boundary: a late stimulus before a finished reply must remain owed
    // even if this process dies before the extra round. Older readers ignore this note.
    appendEvent(d.journal, d.gen, { type: 'note', kind: SHOWN_KIND, data: { through: events.at(-1)?.id ?? null, ...(continued ? { continued: true } : {}) } });
    const system = d.system();
    let halved = false;
    let reply: Reply;
    let streamed = false;
    for (let attempt = 0; ; attempt++) {
      const messages = request(events, system, budget - specsSize, d.sight && { ...d.sight, refused: blind, refusedImages: learned }, { tailChars: d.tailChars, ...(d.logbookChars === undefined ? {} : { logbookChars: d.logbookChars }) });
      if (attempt === 0) {
        const request = JSON.stringify(messages);
        sameRequests = round > 0 && request === lastRequest ? sameRequests + 1 : 0;
        lastRequest = request;
        if (sameRequests >= 2) {
          // As at the round limit: over something the model never saw, no finished reply is written, so that stays owed.
          journal.refresh();
          if (arrivedSince(journal.read(), shown)) return 'done';
          appendEvent(d.journal, d.gen, { type: 'assistant', text: SAME_REQUEST_REPLY, toolCalls: [] });
          d.onText?.(SAME_REQUEST_REPLY);
          return 'done';
        }
      }
      try {
        let timing: { durationMs: number; firstByteMs: number | null } | undefined;
        reply = await d.provider(messages, specs, { signal: d.signal, onCacheProbe: data => { appendEvent(d.journal, d.gen, { type: "note", kind: "cache.probe.v1", data: { ...data } }); }, onTiming: data => { timing = data; }, onTextDelta: delta => { if (delta !== '') { d.onDelta?.(delta); streamed = true; } } });
        // What the provider charged, for the request-size chooser (body/adaptive-budget.ts).
        // Only when a chooser is in play: tests that don't pass `budget` keep the historical event sequence.
        if (d.budget !== undefined) {
          const chars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
          const images = messages.flatMap(m => m.images ?? []);
          const estimatedImageTokens = images.reduce((sum, image) => sum + imageChars(image) / 4, 0);
          appendEvent(d.journal, d.gen, { type: 'note', kind: SENT_KIND, data: { chars, input: reply.usage?.input ?? 0, cached: reply.usage?.cached ?? 0, ...(images.length > 0 ? { estimatedImageTokens } : {}), ...(reply.usage?.images === undefined ? {} : { imageTokens: reply.usage.images }), budget: d.budget.budgetChars, windowTokens: d.budget.windowTokens, ...(timing === undefined ? {} : { durationMs: timing.durationMs, ...(timing.firstByteMs === null ? {} : { firstByteMs: timing.firstByteMs }) }) } });
        }
        break;
      } catch (err) {
        // Whatever the provider threw once the owner had interrupted, it is not a failure, and is not answered by asking again.
        if (d.signal?.aborted) return interrupted();
        if (!blind && messages.some((m) => m.images !== undefined) && saysNoImages(err)) {
          // One image the model or the route cannot take must not hold up the conversation: asked again with a note in its place.
          // The route and content names, never bytes or credentials, make this retry unnecessary in later turns and processes.
          if (route) {
            const images = [...new Set(messages.flatMap(m => m.images?.map(image => image.name) ?? []))];
            if (!images.every(name => learned.has(name))) {
              appendEvent(d.journal, d.gen, { type: 'note', kind: IMAGE_REFUSAL_KIND, data: { route, images } });
              images.forEach(name => learned.add(name));
            }
          }
          blind = true;
        } else if (!halved && saysTooLong(err)) {
          // Characters are only an estimate of tokens. Half is tried once and kept for the rest of the turn.
          budget = Math.floor(budget / 2);
          halved = true;
          // Same gate as the decision/sent notes: only a chooser in play records measurements.
          if (d.budget !== undefined) appendEvent(d.journal, d.gen, { type: 'note', kind: REFUSED_KIND, data: { chars: budget + specsSize } });
        } else throw err;
      }
    }
    // The usage and the summary of the reasoning are for the owner and the record. buildMessages never reads them back.
    const journaledCalls = reply.cutOff === true && reply.partialCalls !== undefined ? reply.partialCalls : reply.toolCalls;
    const quiet = quietTick && reply.toolCalls.length === 0 && quietReply(reply.text);
    appendEvent(d.journal, d.gen, {
      type: 'assistant', text: quiet ? QUIET_REPLY : reply.text, toolCalls: journaledCalls,
      ...(reply.usage ? { usage: reply.usage } : {}), ...(reply.reasoning ? { reasoning: reply.reasoning } : {}),
    });
    if (reply.text !== '' && !streamed && !quiet) d.onText?.(reply.text);
    if (reply.cutOff === true && !continued && round + 1 < (d.maxRounds ?? 50)) {
      // The fragment is in the next request. No tool call from a cut-off reply was run.
      // The request boundary makes the continuation owed across a crash between these calls.
      continued = true;
      continue;
    }
    if (reply.toolCalls.length === 0) {
      // Something that arrived while the model was answering was not in what it saw; it gets a round of its own.
      journal.refresh();
      if (arrivedSince(journal.read(), shown)) continue;
      // Queued work resumes through its sensor, never by replaying a final reply.
      return 'done';
    }

    idleRounds = reply.toolCalls.every(noOpCall) ? idleRounds + 1 : 0;
    if (idleRounds >= 2) {
      for (const call of reply.toolCalls) appendEvent(d.journal, d.gen, { type: 'tool.result', callId: call.id, ok: false, output: NO_OP_RESULT });
      // As at the round limit: over something the model never saw, no finished reply is written, so that stays owed.
      journal.refresh();
      if (arrivedSince(journal.read(), shown)) return 'done';
      appendEvent(d.journal, d.gen, { type: 'assistant', text: quietTick ? QUIET_REPLY : NO_OP_REPLY, toolCalls: [] });
      return 'done';
    }

    for (const call of reply.toolCalls) {
      if (noOpCall(call)) {
        // No intent: nothing starts. It still gets a result, so every call has an answer.
        appendEvent(d.journal, d.gen, { type: 'tool.result', callId: call.id, ok: false, output: NO_OP_RESULT });
        continue;
      }
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
        appendEvent(d.journal, d.gen, { type: 'tool.result', callId: call.id, ok: false, output: d.stoppedBy?.notRun ?? NOT_RUN_FOR_OWNER });
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
        if (d.signal?.aborted && result !== LEFT && tool.idempotent) {
          // Only a tool that explicitly promises this may be repeated. The owner still stops the turn;
          // the retry just completes a read whose first attempt was cut short, with no signal attached.
          output = String(await tool.run(call.args, d.ctx));
        }
      } catch (err) {
        ok = false;
        output = `error: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        wait?.stop();
      }
      // Interrupted while it ran: the result says so first, whatever the tool made of being stopped.
      if (d.signal?.aborted) {
        ok = false;
        output = `${d.stoppedBy?.cut ?? CUT_BY_OWNER}\n${output}`;
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
  journal.refresh();
  if (arrivedSince(journal.read(), shown)) return 'done';
  appendEvent(d.journal, d.gen, { type: 'assistant', text: ROUND_LIMIT_REPLY, toolCalls: [] });
  return 'done';
}
