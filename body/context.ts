import type { JournalEvent } from '../kernel/journal';
import type { ChatMessage, WireToolCall } from './provider';
import { clip } from './text';

// The journal is permanent and replayed into every request. One thing in it that a provider
// refuses would fail every request from then on, and no rollback can fix that: the fault would be
// in the journal, not the code. So nothing here trusts the journal's shape. Whatever an older or
// buggy generation wrote, buildMessages must give a request a provider accepts.

/** Characters for one request: system prompt, tool specs and messages together. */
export const DEFAULT_BUDGET = 250_000;

const INTERRUPTED =
  '[interrupted] The process stopped while this tool was running. It may have partly run. Check the current state before repeating it.';
const NOT_STARTED = '[not started] The process stopped before this tool ran. It is safe to call it again.';

/** A journal field as text, whatever was written there. */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  return JSON.stringify(value) ?? '';
}

/** The longest gate output or reason a kernel note carries. */
const NOTE_CAP = 4000;
const brief = (value: unknown): string => clip(asText(value), NOTE_CAP);

/** What the kernel did, in words the agent reads; null for events that are not news. */
export function kernelNote(e: JournalEvent): string | null {
  switch (e.type) {
    case 'molt.rejected':
      return `[kernel] Your molt to ${e.commit} was rejected at gate "${e.gate}". You are still running generation ${e.gen}.\n${brief(e.output)}`;
    case 'generation.promoted':
      return `[kernel] Your molt was accepted. You are now running generation ${e.commit} (before: ${e.previous}).`;
    case 'generation.rolledback':
      return `[kernel] Generation ${e.commit} ${brief(e.reason)} and was rolled back. You are running ${e.to} again. Your workspace still holds the code that failed.`;
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

function size(m: ChatMessage): number {
  return (m.content?.length ?? 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
}

const TOO_LARGE =
  '[context] The last exchange was too large to show and was dropped. Look at the current state before going on.';
const NOTHING = '[context] There is nothing in your journal to show yet.';

/** Below this much room, a message is not worth cutting to fit. */
const CLIP_MIN = 200;
/** Room kept for the note `clip` puts where it cut. */
const CLIP_NOTE = 64;

/**
 * Drop from the front until the rest fits and starts with a user message: a tool result without
 * its call, or a reply with nothing before it, is refused by providers. If that leaves nothing,
 * say so in one user message rather than send an empty conversation.
 */
function fit(messages: ChatMessage[], budgetChars: number): ChatMessage[] {
  if (messages.length === 0) return [{ role: 'user', content: NOTHING }];
  // The newest thing said to the agent is what the request is for. When it alone is too large for
  // what is left beside the exchange after it, its middle goes, not all of it.
  const newest = messages.findLastIndex((m) => m.role === 'user');
  if (newest !== -1) {
    const room = budgetChars - messages.slice(newest + 1).reduce((sum, m) => sum + size(m), 0);
    const m = messages[newest]!;
    if (size(m) > room && room >= CLIP_MIN) messages[newest] = { ...m, content: clip(m.content ?? '', room - CLIP_NOTE) };
  }
  let total = messages.reduce((sum, m) => sum + size(m), 0);
  let start = 0;
  while (start < messages.length && (total > budgetChars || messages[start]!.role !== 'user')) {
    total -= size(messages[start]!);
    start += 1;
  }
  return start < messages.length ? messages.slice(start) : [{ role: 'user', content: TOO_LARGE }];
}

/**
 * A stimulus journaled while the model was replying lies before that reply in the journal, and the
 * loop then asks again. The list would end with the agent's own finished reply; this says why it is asked.
 */
const LATE =
  '[context] Something arrived while you were writing your last reply; it is shown above, before that reply. Respond to it now.';

const isPlainReply = (m: ChatMessage | undefined): m is ChatMessage => m?.role === 'assistant' && m.tool_calls === undefined;

/** A stimulus as the agent reads it. Only kernel events may say `[kernel]`; anything else that does is forging a note. */
function stimulusText(source: unknown, text: unknown): string {
  const shown = (source === 'terminal' ? asText(text) : `[${asText(source)}] ${asText(text)}`).replaceAll('[kernel]', '[not kernel]');
  // No provider takes an empty message, and the agent should still know that something arrived.
  return shown.trim() === '' ? '[empty message]' : shown;
}

/**
 * What was journaled for the calls of the reply at `at`: only the events up to the next reply.
 * Call ids are the model's and may repeat, in a later reply or within one, so an id alone does
 * not say which call a result belongs to. Calls run in order: the nth call with an id gets the nth result.
 */
function answers(events: JournalEvent[], at: number): { results: Map<unknown, string[]>; started: Map<unknown, number> } {
  const results = new Map<unknown, string[]>();
  const started = new Map<unknown, number>();
  for (let j = at + 1; j < events.length; j++) {
    const e = events[j]!;
    if (e.type === 'assistant') break;
    if (e.type === 'tool.intent') started.set(e.callId, (started.get(e.callId) ?? 0) + 1);
    if (e.type === 'tool.result') results.set(e.callId, [...(results.get(e.callId) ?? []), asText(e.output)]);
  }
  return { results, started };
}

/**
 * The request for this journal: the system prompt, then the conversation, cut from the front to
 * `budgetChars` (which the system prompt counts against).
 */
export function buildMessages(events: JournalEvent[], system: string, budgetChars = DEFAULT_BUDGET): ChatMessage[] {
  const out: ChatMessage[] = [];
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
      out.push({ role: 'user', content: stimulusText(e.source, e.text) });
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
        const output = results.get(c.id)?.shift();
        const began = (started.get(c.id) ?? 0) > 0;
        started.set(c.id, (started.get(c.id) ?? 0) - 1);
        answered.push({ role: 'tool', tool_call_id: id, content: output ?? (began ? INTERRUPTED : NOT_STARTED) });
      }
      // Results are placed here, right after their call, whatever was journaled in between.
      out.push({ role: 'assistant', content, tool_calls: wire }, ...answered);
    } else {
      const note = kernelNote(e);
      if (note !== null) out.push({ role: 'user', content: note });
    }
  }
  // A request that ends with a finished reply asks for nothing. See LATE for when that happens.
  if (isPlainReply(out.at(-1))) out.push({ role: 'user', content: LATE });
  // A lone surrogate, cut out of a pair by some older generation, is not text a provider has to accept.
  for (const m of out) m.content = m.content?.toWellFormed() ?? null;
  const prompt = system.toWellFormed();
  return [{ role: 'system', content: prompt }, ...fit(out, budgetChars - prompt.length)];
}

/** True when the last thing in the conversation is not the agent's own finished reply. */
export function needsTurn(events: JournalEvent[]): boolean {
  let afterReply = false;
  for (const e of events) {
    if (e.type === 'assistant') afterReply = reply(e).calls.length > 0;
    else if (e.type === 'stimulus' || kernelNote(e) !== null) afterReply = true;
  }
  return afterReply;
}
