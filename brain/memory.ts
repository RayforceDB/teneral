import { acceptanceNotes } from '../body/acceptance';
import type { JournalEvent } from './journal';
import { backNote, standing, OWNER_PREFIX, fromOwner } from './owned';
import { asText, stemNote } from './stemnote';
import { MEMORY_MARK, logbook, sizeOf, type Sizes } from './logbook';
import { DEFAULT_IMAGES, IMAGES_PER_MESSAGE, imageChars, splitMarkers, type Image } from '../body/images';
import type { ChatMessage, WireToolCall } from './provider';
import { clip } from '../body/text';
import { arrivals, replyIsCurrent } from './shown';

// How the stem's events read is in brain/stemnote.ts; it is given out from here as well, where it always was.
export { stemNote };

// The journal is permanent and replayed into every request. One thing in it that a provider
// refuses would fail every request from then on, and no rollback can fix that: the fault would be
// in the journal, not the code. So nothing here trusts the journal's shape. Whatever an older or
// buggy generation wrote, buildMessages must give a request a provider accepts.

/** Characters for one request at most: system prompt, tool specs and messages together. How much of it is used is in brain/logbook.ts. */
export const DEFAULT_BUDGET = 250_000;

const INTERRUPTED =
  '[interrupted] The process stopped while this tool was running. It may have partly run. Check the current state before repeating it.';
const NOT_STARTED = '[not started] The process stopped before this tool ran. It is safe to call it again.';

/** How a `turn.interrupted` event reads to the agent, where it happened. Nothing is owed for it: see `needsTurn`. */
const STOPPED =
  '[interrupted] Your owner interrupted your turn here. The request to the model was cancelled and any tool that was running was stopped. ' +
  'Do not take that work up again unless your owner asks; when you next reply, say in a line where it stopped.';

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
const size = sizeOf;

/** How images get into a request. Without one, a marker is text like any other and no file is read. */
export interface Sight {
  /** The image a marker's path names, or, as text, why it cannot be shown (body/images.ts). */
  load: (path: string) => Image | string;
  /** Images in one request at most. Default: DEFAULT_IMAGES. */
  max?: number;
  /** Set once the provider refused a request because of its images: every image becomes a note. */
  refused?: boolean;
  /** Content names this model/route has already refused, including notes from earlier turns. */
  refusedImages?: ReadonlySet<string>;
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
      : sight.refused || sight.refusedImages?.has(name) ? `[image not shown: the model or the route in use does not take images: ${name}]`
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

  /** Characters the state of the work in hand may take at the end of a request. */

const TOO_LARGE =
  '[context] The last exchange was too large to show and was dropped. Look at the current state before going on.';
const NOTHING = '[context] There is nothing in your journal to show yet.';
/** Stands between the newest stimulus and the latest steps taken for it, when the first ones did not fit. See `latestSteps`. */
const EARLIER_STEPS = (steps: number): string =>
  `[context] You have taken more steps on this than fit here: the first ${steps} are not shown. What follows are your latest steps, as they happened. The earlier ones are in your journal; do not take them again to find out what they gave.`;

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
    const text = room - (m.images ?? []).reduce((sum, image) => sum + imageChars(image), 0);
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
  if (start < messages.length && total - dropped <= budgetChars) return messages.slice(start);
  return newest === -1 ? [{ role: 'user', content: TOO_LARGE }] : latestSteps(messages[newest]!, messages.slice(newest + 1), budgetChars);
}

/**
 * What is sent when the steps taken since the newest stimulus are by themselves more than the
 * room: the stimulus, a line that says how many of the first steps are not shown, and the latest
 * steps, as many as fit. Never the note alone while a step fits: an agent that is not shown its
 * own last step takes it again, the journal grows by it, and the next request is the same one.
 * A step is a reply with the results of its calls, and is kept or dropped whole. The steps leave
 * from the first in whole steps of the room, as the front of a request does in `fit`.
 */
function latestSteps(asked: ChatMessage, after: ChatMessage[], budgetChars: number): ChatMessage[] {
  const tooLarge: ChatMessage[] = [{ role: 'user', content: TOO_LARGE }];
  // The stimulus may be large too: it gets half the room at most, and the steps the rest.
  const half = Math.floor(budgetChars / 2);
  const images = (asked.images ?? []).reduce((sum, image) => sum + imageChars(image), 0);
  const said = size(asked) > half && half - images >= CLIP_MIN ? { ...asked, content: clip(asked.content ?? '', half - images - CLIP_NOTE) } : asked;
  const room = budgetChars - size(said) - EARLIER_STEPS(0).length - 8;
  const whole = after.reduce((sum, m) => sum + size(m), 0);
  if (room <= 0 || after.length === 0) return tooLarge;
  const step = Math.max(1, Math.floor(budgetChars * STEP));
  const toDrop = Math.ceil(Math.max(1, whole - room) / step) * step;
  let at = 0;
  let gone = 0;
  let steps = 0;
  while (at < after.length && (gone < toDrop || after[at]!.role !== 'assistant')) {
    if (after[at]!.role === 'assistant') steps += 1;
    gone += size(after[at]!);
    at += 1;
  }
  if (at >= after.length || whole - gone > room) return tooLarge;
  return [said, { role: 'user', content: EARLIER_STEPS(steps) }, ...after.slice(at)];
}

/**
 * Stands over a message that reached the agent in the middle of its work: while it was writing a
 * reply, or while a tool ran. It is shown after the steps that were taken without it (`arrivals`
 * in brain/shown.ts), and this says that nothing above was an answer to it. What to do with it is
 * in brain/prompt.md.
 */
export const ARRIVED = '[arrived while you were working]';

/**
 * A stimulus journaled while the model was replying lies before that reply in the journal, and the
 * loop then asks again. Where the request boundaries say so, it is shown after that reply (see
 * ARRIVED). This is for what they do not cover, a journal from before them or a note of the stem's:
 * the list would end with the agent's own finished reply, and this says why it is asked.
 */
const LATE =
  '[context] Something arrived while you were writing your last reply; it is shown above, before that reply. Respond to it now.';
const CONTINUE =
  '[context] Your previous reply was cut off by the provider\'s output limit. Continue exactly where it stopped; do not repeat the fragment or call tools from an unfinished call.';

const isPlainReply = (m: ChatMessage | undefined): m is ChatMessage => m?.role === 'assistant' && m.tool_calls === undefined;

/** A stimulus as the agent reads it. Only stem events may say `[stem]`; anything else that does is forging a note. */
function stimulusText(source: unknown, text: unknown): string {
  const shown = (source === 'terminal' ? asText(text) : `[${asText(source)}] ${asText(text)}`).replaceAll('[stem]', '[not stem]')
    // Nor may anything that arrives pass for the agent's own memory (brain/logbook.ts).
    .replaceAll(MEMORY_MARK, '[not memory]');
  // Only the label a sensor gave says whose word something is (brain/owned.ts): the same label inside what someone else sent is their text.
  const honest = fromOwner(source) ? shown : shown.replaceAll(`[${OWNER_PREFIX}`, `[not ${OWNER_PREFIX}`);
  // No provider takes an empty message, and the agent should still know that something arrived.
  return honest.trim() === '' ? '[empty message]' : honest;
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

/** How a request is laid out, beyond its budget: how much is shown as it happened (brain/logbook.ts), and a closing question. */
export interface View extends Sizes {
  /**
   * Said to the agent after everything in the journal. It is how the agent is asked something
   * that is no part of its conversation and is not journaled as one, such as to form a memory
   * (brain/sleep.ts).
   */
  ask?: string;
}

/**
 * The request for this journal: the system prompt, then the conversation, cut from the front to
 * `budgetChars` (which the system prompt counts against). With `sight`, the images the owner sent
 * and the ones `look` returned go with their messages; see `takeMarkers` and `fillSlots`.
 */
export function buildMessages(journaled: JournalEvent[], system: string, budgetChars = DEFAULT_BUDGET, sight?: Sight, view: View = {}): ChatMessage[] {
  const { ask } = view;
  // Without what the owner took back (brain/owned.ts): that is in the journal and in no request.
  // Acceptance is derived from that same view. Stem records deliberately survive a take-back:
  // forgetting the conversation does not cancel a candidate or consent that really happened.
  const events = standing(journaled);
  const last = events.at(-1);
  const continuation = last?.type === 'assistant' && reply(last).text.includes('[this reply was cut off by the provider:');
  const accepted = acceptanceNotes(events);
  const out: ChatMessage[] = [];
  // For each message, the position in `events` of the event it was made from: what brain/logbook.ts cuts by.
  const origin: number[] = [];
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

  const { after, during } = arrivals(events);
  const show = (e: JournalEvent & { type: 'stimulus' }, i: number, at: number): void => {
    const text = stimulusText(e.source, e.text);
    const message: ChatMessage = { role: 'user', content: during.has(i) ? `${ARRIVED}\n${text}` : text };
    if (sight && (e.source === 'terminal' || e.source === 'owner:zulip')) takeMarkers(message, slots);
    out.push(message);
    origin.push(at);
  };
  // What a reply was written without, in the order it arrived: shown once that reply and its results are.
  let held: number[] = [];
  for (let i = 0; i <= events.length; i++) {
    if (held.length > 0 && (i === events.length || after.get(held[0]!)! < i)) {
      for (const s of held) show(events[s] as JournalEvent & { type: 'stimulus' }, s, after.get(s)!);
      held = [];
    }
    if (i === events.length) break;
    const e = events[i]!;
    if (e.type === 'stimulus') {
      if (after.has(i)) held.push(i);
      else show(e, i, i);
    } else if (e.type === 'assistant') {
      const { text, calls } = reply(e);
      const said = text.trim() === '' ? null : text;
      // Providers refuse or misread two assistant messages in a row (see LATE for how they arise):
      // a finished reply followed by another reply, of either kind, is shown as one message.
      const merged = isPlainReply(out.at(-1));
      const before = merged ? out.pop()!.content : null;
      // A reply shown as one with the reply before it belongs where that one did.
      const at = merged ? origin.pop()! : i;
      const content = before !== null && said !== null ? `${before}\n\n${said}` : before ?? said;
      if (calls.length === 0) {
        // A reply that says nothing is not sent; no provider takes an empty message.
        if (content !== null) {
          out.push({ role: 'assistant', content });
          origin.push(at);
        }
        continue;
      }
      const { results, started } = answers(events, i);
      const wire: WireToolCall[] = [];
      if (continuation && i === events.length - 1) {
        // A truncated call cannot be executed. Omit it entirely: neither protocol can replay
        // it without a fabricated result. The visible fragment is enough to continue.
        if (content !== null) out.push({ role: 'assistant', content });
        origin.push(i);
        continue;
      }
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
      origin.push(at, ...answered.map(() => i));
    } else if (e.type === 'turn.interrupted') {
      out.push({ role: 'user', content: STOPPED });
      origin.push(i);
    } else {
      const note = stemNote(e) ?? accepted.get(e.id) ?? backNote(e, MEMORY_MARK);
      if (note !== null) {
        out.push({ role: 'user', content: note });
        origin.push(i);
      }
    }
  }
  // A request that ends with a finished reply asks for nothing. See LATE for when that happens.
  if (ask !== undefined) {
    out.push({ role: 'user', content: ask });
    origin.push(events.length);
  } else if (continuation || isPlainReply(out.at(-1))) {
    out.push({ role: 'user', content: continuation ? CONTINUE : LATE });
    origin.push(events.length);
  }
  if (sight) fillSlots(slots, sight);
  // A lone surrogate, cut out of a pair by some older generation, is not text a provider has to accept.
  for (const m of out) m.content = m.content?.toWellFormed() ?? null;
  const prompt = system.toWellFormed();
  const room = budgetChars - prompt.length;
  // What was remembered and no longer fits as it happened is shown as memories; the rest is cut to fit as before.
  const { head, seam, start } = logbook(events, out, origin, room, view);
  const taken = head.reduce((sum, m) => sum + size(m), 0);
  const fitted = fit(seam === null ? out : [seam, ...out.slice(start)], room - taken);
  return [{ role: 'system', content: prompt }, ...head, ...fitted];
}

/** True when the last thing in the conversation is not the agent's own finished reply, nor its owner stopping the turn. */
export function needsTurn(journaled: JournalEvent[]): boolean {
  // What the owner took back asks for nothing any more. Derive acceptance from that same view.
  const events = standing(journaled);
  const accepted = acceptanceNotes(events);
  // Only the last thing that bears on it decides: each such event overrides all before it. So the
  // journal is read from its end to the first one, and whether a reply is current, which goes
  // through the journal itself, is asked once and not of every reply the agent ever gave. Asked of
  // each, this took seconds on a journal a week old, and it is asked every few seconds.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'assistant') return reply(e).calls.length > 0 || !replyIsCurrent(events, e);
    // The owner ended that turn. What was unanswered stays so until something else arrives.
    if (e.type === 'turn.interrupted') return false;
    if (e.type === 'stimulus' || stemNote(e) !== null || accepted.has(e.id)) return true;
  }
  return false;
}
