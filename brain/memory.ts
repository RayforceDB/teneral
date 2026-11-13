import { isMutationRejection, type JournalEvent } from './journal';
import { DEFAULT_IMAGES, IMAGES_PER_MESSAGE, IMAGE_CHARS, splitMarkers, type Image } from '../body/images';
import type { ChatMessage, WireToolCall } from './provider';
import { clip } from '../body/text';

// The journal is permanent and replayed into every request. One thing in it that a provider
// refuses would fail every request from then on, and no rollback can fix that: the fault would be
// in the journal, not the code. So nothing here trusts the journal's shape. Whatever an older or
// buggy generation wrote, buildMessages must give a request a provider accepts.

/** Characters for one request: system prompt, tool specs and messages together. */
export const DEFAULT_BUDGET = 250_000;

const INTERRUPTED =
  '[interrupted] The process stopped while this tool was running. It may have partly run. Check the current state before repeating it.';
const NOT_STARTED = '[not started] The process stopped before this tool ran. It is safe to call it again.';

/** How a `turn.interrupted` event reads to the agent, where it happened. Nothing is owed for it: see `needsTurn`. */
const STOPPED =
  '[interrupted] Your owner interrupted your turn here. The request to the model was cancelled and any tool that was running was stopped. ' +
  'Do not take that work up again unless your owner asks; when you next reply, say in a line where it stopped.';

/** A journal field as text, whatever was written there. */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  return JSON.stringify(value) ?? '';
}

/** The longest gate output or reason a stem note carries. */
const NOTE_CAP = 4000;
const brief = (value: unknown): string => clip(asText(value), NOTE_CAP);

/** What the stem did, in words the agent reads; null for events that are not news. */
export function stemNote(e: JournalEvent): string | null {
  // Under either of its names: the journal keeps the rejections of the time when a mutation was called a molt.
  if (isMutationRejection(e)) {
    return `[stem] Your mutation to ${e.commit} was rejected at gate "${e.gate}". You are still running generation ${e.gen}.\n${brief(e.output)}`;
  }
  switch (e.type) {
    case 'generation.promoted':
      return `[stem] Your mutation was accepted. You are now running generation ${e.commit} (before: ${e.previous}).`;
    case 'generation.rolledback':
      return `[stem] Generation ${e.commit} ${brief(e.reason)} and was rolled back. You are running ${e.to} again. Your workspace still holds the code that failed.`;
    default:
      return null;
  }
}

/** An assistant event's text and calls. Older generations may have written it without one or the other. */
function reply(e: JournalEvent): { text: string; calls: unknown[] } {
  const r = e as { text?: unknown; toolCalls?: unknown };
  return { text: asText(r.text), calls: Array.isArray(r.toolCalls) ? r.toolCalls : [] };
}

/** A tool name in the characters every provider accepts. */
function wireName(name: unknown): string {
  const clean = typeof name === 'string' ? name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) : '';
  return clean === '' ? 'unknown' : clean;
}

/** The same value with every string in it, keys included, made well-formed. JSON would otherwise carry a lone surrogate through as an escape. */
function sound(value: unknown): unknown {
  if (typeof value === 'string') return value.toWellFormed();
  if (Array.isArray(value)) return value.map(sound);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key.toWellFormed(), sound(inner)]));
}

/** Arguments are always the JSON of an object; anything else the model gave is kept inside one, as text. */
function wireArgs(args: unknown): string {
  if (args === undefined) return '{}';
  if (typeof args === 'object' && args !== null && !Array.isArray(args)) return JSON.stringify(sound(args));
  return JSON.stringify({ _raw: asText(args).toWellFormed() });
}

/** What a message counts for against the budget. An image counts a fixed amount, whatever its bytes: see IMAGE_CHARS. */
function size(m: ChatMessage): number {
  return (m.content?.length ?? 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0) + (m.images?.length ?? 0) * IMAGE_CHARS;
}

/** How images get into a request. Without one, a marker is text like any other and no file is read. */
export interface Sight {
  /** The image a marker's path names, or, as text, why it cannot be shown (body/images.ts). */
  load: (path: string) => Image | string;
  /** Images in one request at most. Default: DEFAULT_IMAGES. */
  max?: number;
  /** Set once the provider refused a request because of its images: every image becomes a note. */
  refused?: boolean;
}

/** A place in the conversation where an image belongs: the message, and the path its marker named (null: one marker too many). */
interface Slot { message: ChatMessage; path: string | null }

/**
 * Takes the marker lines off the end of `message` and records a slot for each. Called only for
 * what may show images: a stimulus whose source is `terminal`, which is the owner, and the result
 * of a `look` call that ran. A marker anywhere else is never looked for, so nobody else's text can
 * make a file be read and sent to the provider.
 */
function takeMarkers(message: ChatMessage, slots: Slot[]): void {
  const { text, paths } = splitMarkers(message.content ?? '');
  if (paths.length === 0) return;
  message.content = text;
  paths.forEach((path, i) => slots.push({ message, path: i < IMAGES_PER_MESSAGE ? path : null }));
}

/**
 * Puts an image, or a line saying why there is none, in every slot.
 *
 * At most `max` images go in a request, the newest ones. Which ones those are must not change with
 * every request, or the start of the request would, and with it what a provider can reuse (see
 * `fit`). So slots are counted from the start of the whole journal, not of what is sent, and the
 * number of older ones turned into a line moves in steps of half of `max`: it is the smallest
 * multiple of the step that leaves at most `max`. With the default of 4, images 1 and 2 become
 * lines when the 5th arrives, 3 and 4 when the 7th does: between those moments nothing already
 * sent changes. A file that cannot be shown still fills its slot, so its going missing moves nothing.
 */
function fillSlots(slots: Slot[], sight: Sight): void {
  const max = Math.max(0, Math.floor(sight.max ?? DEFAULT_IMAGES));
  const step = Math.max(1, Math.floor(max / 2));
  const earlier = slots.length > max ? Math.ceil((slots.length - max) / step) * step : 0;
  slots.forEach(({ message, path }, i) => {
    const name = path?.split('/').at(-1) ?? '';
    const image = path === null ? `[image not available: more than ${IMAGES_PER_MESSAGE} images in one message]`
      : sight.refused ? `[image not shown: the model or the route in use does not take images: ${name}]`
      : i < earlier ? `[an image shown earlier: ${name}]`
      : sight.load(path);
    if (typeof image !== 'string') (message.images ??= []).push(image);
    else {
      const line = image.startsWith('[') ? image : `[image not available: ${image}]`;
      message.content = message.content ? `${message.content}\n${line}` : line;
    }
  });
  // No provider takes an empty text part; a message that is only images has no text at all. A tool's result is always text, if empty.
  for (const { message } of slots) if (message.content === '' && message.role === 'user') message.content = null;
}

const TOO_LARGE =
  '[context] The last exchange was too large to show and was dropped. Look at the current state before going on.';
const NOTHING = '[context] There is nothing in your journal to show yet.';

/** Below this much room, a message is not worth cutting to fit. */
const CLIP_MIN = 200;
/** Room kept for the note `clip` puts where it cut. */
const CLIP_NOTE = 64;

/** The front is cut in steps of this share of the room. See `fit`. */
const STEP = 0.2;

/**
 * Drop from the front until the rest fits and starts with a user message: a tool result without
 * its call, or a reply with nothing before it, is refused by providers. If that leaves nothing,
 * say so in one user message rather than send an empty conversation.
 *
 * The cut moves in steps. Dropping only as much as each request needs would start every request
 * at a different message, and a provider can reuse its work on an earlier request (a prompt cache)
 * only while the start is the same. So the amount dropped, measured from the start of the whole
 * conversation, is always a multiple of one step: the cut stays where it is while the journal
 * grows by up to a step, then jumps.
 */
function fit(messages: ChatMessage[], budgetChars: number): ChatMessage[] {
  if (messages.length === 0) return [{ role: 'user', content: NOTHING }];
  // The newest thing said to the agent is what the request is for. When it alone is too large for
  // what is left beside the exchange after it, its middle goes, not all of it.
  const newest = messages.findLastIndex((m) => m.role === 'user');
  if (newest !== -1) {
    const room = budgetChars - messages.slice(newest + 1).reduce((sum, m) => sum + size(m), 0);
    const m = messages[newest]!;
    // Only its text can be cut; its images count in full.
    const text = room - (m.images?.length ?? 0) * IMAGE_CHARS;
    if (size(m) > room && text >= CLIP_MIN) messages[newest] = { ...m, content: clip(m.content ?? '', text - CLIP_NOTE) };
  }
  // What stands before the first user message can never be sent, so it is not counted as something to make room for.
  let start = Math.max(0, messages.findIndex((m) => m.role === 'user'));
  const total = messages.slice(start).reduce((sum, m) => sum + size(m), 0);
  const step = Math.max(1, Math.floor(budgetChars * STEP));
  const toDrop = total > budgetChars ? Math.ceil((total - budgetChars) / step) * step : 0;
  let dropped = 0;
  const drop = (): void => {
    dropped += size(messages[start]!);
    start += 1;
  };
  // A whole step may reach past the newest stimulus when that one is most of the request; the cut stops at it.
  while (start < messages.length && dropped < toDrop && start !== newest) drop();
  while (start < messages.length && messages[start]!.role !== 'user') drop();
  return start < messages.length && total - dropped <= budgetChars ? messages.slice(start) : [{ role: 'user', content: TOO_LARGE }];
}

/**
 * A stimulus journaled while the model was replying lies before that reply in the journal, and the
 * loop then asks again. The list would end with the agent's own finished reply; this says why it is asked.
 */
const LATE =
  '[context] Something arrived while you were writing your last reply; it is shown above, before that reply. Respond to it now.';

const isPlainReply = (m: ChatMessage | undefined): m is ChatMessage => m?.role === 'assistant' && m.tool_calls === undefined;

/** A stimulus as the agent reads it. Only stem events may say `[stem]`; anything else that does is forging a note. */
function stimulusText(source: unknown, text: unknown): string {
  const shown = (source === 'terminal' ? asText(text) : `[${asText(source)}] ${asText(text)}`).replaceAll('[stem]', '[not stem]');
  // No provider takes an empty message, and the agent should still know that something arrived.
  return shown.trim() === '' ? '[empty message]' : shown;
}

/**
 * What was journaled for the calls of the reply at `at`: only the events up to the next reply.
 * Call ids are the model's and may repeat, in a later reply or within one, so an id alone does
 * not say which call a result belongs to. Calls run in order: the nth call with an id gets the nth result.
 */
function answers(events: JournalEvent[], at: number): { results: Map<unknown, { output: string; ok: boolean }[]>; started: Map<unknown, number> } {
  const results = new Map<unknown, { output: string; ok: boolean }[]>();
  const started = new Map<unknown, number>();
  for (let j = at + 1; j < events.length; j++) {
    const e = events[j]!;
    if (e.type === 'assistant') break;
    if (e.type === 'tool.intent') started.set(e.callId, (started.get(e.callId) ?? 0) + 1);
    if (e.type === 'tool.result') results.set(e.callId, [...(results.get(e.callId) ?? []), { output: asText(e.output), ok: e.ok === true }]);
  }
  return { results, started };
}

/**
 * The request for this journal: the system prompt, then the conversation, cut from the front to
 * `budgetChars` (which the system prompt counts against). With `sight`, the images the owner sent
 * and the ones `look` returned go with their messages; see `takeMarkers` and `fillSlots`.
 */
export function buildMessages(events: JournalEvent[], system: string, budgetChars = DEFAULT_BUDGET, sight?: Sight): ChatMessage[] {
  const out: ChatMessage[] = [];
  const slots: Slot[] = [];
  // Ids on the wire: the journaled one where it will do, otherwise one made from the call's position.
  // Positions count from the start of the journal, so cutting the front does not rename anything.
  const used = new Set<string>();
  let position = 0;
  const wireId = (id: unknown): string => {
    position += 1;
    let wire = typeof id === 'string' && id !== '' && id.length <= 40 && id.isWellFormed() && !used.has(id) ? id : `call_${position}`;
    for (let n = 1; used.has(wire); n++) wire = `call_${position}_${n}`;
    used.add(wire);
    return wire;
  };

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.type === 'stimulus') {
      const message: ChatMessage = { role: 'user', content: stimulusText(e.source, e.text) };
      if (sight && e.source === 'terminal') takeMarkers(message, slots);
      out.push(message);
    } else if (e.type === 'assistant') {
      const { text, calls } = reply(e);
      const said = text.trim() === '' ? null : text;
      // Providers refuse or misread two assistant messages in a row (see LATE for how they arise):
      // a finished reply followed by another reply, of either kind, is shown as one message.
      const before = isPlainReply(out.at(-1)) ? out.pop()!.content : null;
      const content = before !== null && said !== null ? `${before}\n\n${said}` : before ?? said;
      if (calls.length === 0) {
        // A reply that says nothing is not sent; no provider takes an empty message.
        if (content !== null) out.push({ role: 'assistant', content });
        continue;
      }
      const { results, started } = answers(events, i);
      const wire: WireToolCall[] = [];
      const answered: ChatMessage[] = [];
      for (const call of calls) {
        const c = (typeof call === 'object' && call !== null ? call : {}) as { id?: unknown; name?: unknown; args?: unknown };
        const id = wireId(c.id);
        wire.push({ id, type: 'function', function: { name: wireName(c.name), arguments: wireArgs(c.args) } });
        const result = results.get(c.id)?.shift();
        const began = (started.get(c.id) ?? 0) > 0;
        started.set(c.id, (started.get(c.id) ?? 0) - 1);
        const answer: ChatMessage = { role: 'tool', tool_call_id: id, content: result?.output ?? (began ? INTERRUPTED : NOT_STARTED) };
        // What `look` kept for the agent to see (body/tools.ts). The same line in any other tool's output is only text.
        if (sight && c.name === 'look' && result?.ok) takeMarkers(answer, slots);
        answered.push(answer);
      }
      // Results are placed here, right after their call, whatever was journaled in between.
      out.push({ role: 'assistant', content, tool_calls: wire }, ...answered);
    } else if (e.type === 'turn.interrupted') {
      out.push({ role: 'user', content: STOPPED });
    } else {
      const note = stemNote(e);
      if (note !== null) out.push({ role: 'user', content: note });
    }
  }
  // A request that ends with a finished reply asks for nothing. See LATE for when that happens.
  if (isPlainReply(out.at(-1))) out.push({ role: 'user', content: LATE });
  if (sight) fillSlots(slots, sight);
  // A lone surrogate, cut out of a pair by some older generation, is not text a provider has to accept.
  for (const m of out) m.content = m.content?.toWellFormed() ?? null;
  const prompt = system.toWellFormed();
  return [{ role: 'system', content: prompt }, ...fit(out, budgetChars - prompt.length)];
}

/** True when the last thing in the conversation is not the agent's own finished reply, nor its owner stopping the turn. */
export function needsTurn(events: JournalEvent[]): boolean {
  let afterReply = false;
  for (const e of events) {
    if (e.type === 'assistant') afterReply = reply(e).calls.length > 0;
    // The owner ended that turn. What was unanswered stays so until something else arrives.
    else if (e.type === 'turn.interrupted') afterReply = false;
    else if (e.type === 'stimulus' || stemNote(e) !== null) afterReply = true;
  }
  return afterReply;
}
