import type { JournalEvent } from '../kernel/journal';
import type { ChatMessage } from './provider';

const INTERRUPTED =
  '[interrupted] The process stopped while this tool was running. It may have partly run. Check the current state before repeating it.';
const NOT_STARTED = '[not started] The process stopped before this tool ran. It is safe to call it again.';

/** What the kernel did, in words the agent reads; null for events that are not news. */
export function kernelNote(e: JournalEvent): string | null {
  switch (e.type) {
    case 'molt.rejected':
      return `[kernel] Your molt to ${e.commit} was rejected at gate "${e.gate}". You are still running generation ${e.gen}.\n${e.output}`;
    case 'generation.promoted':
      return `[kernel] Your molt was accepted. You are now running generation ${e.commit} (before: ${e.previous}).`;
    case 'generation.rolledback':
      return `[kernel] Generation ${e.commit} ${e.reason} and was rolled back. You are running ${e.to} again. Your workspace still holds the code that failed.`;
    default:
      return null;
  }
}

function size(m: ChatMessage): number {
  return (m.content?.length ?? 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
}

const TOO_LARGE =
  '[context] The last exchange was too large to show and was dropped. Look at the current state before going on.';

/**
 * Drop from the front until the rest fits and starts with a user message: a tool result without
 * its call, or a reply with nothing before it, is refused by providers. If that leaves nothing,
 * say so in one user message rather than send an empty conversation.
 */
function fit(messages: ChatMessage[], budgetChars: number): ChatMessage[] {
  if (messages.length === 0) return [];
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

const isPlainReply = (m: ChatMessage): boolean => m.role === 'assistant' && m.tool_calls === undefined;

/** A stimulus as the agent reads it. Only kernel events may say `[kernel]`; anything else that does is forging a note. */
function stimulusText(source: string, text: string): string {
  return (source === 'terminal' ? text : `[${source}] ${text}`).replaceAll('[kernel]', '[not kernel]');
}

/**
 * What was journaled for the calls of the reply at `at`: only the events up to the next reply.
 * Call ids are the model's and may repeat, in a later reply or within one, so an id alone does
 * not say which call a result belongs to. Calls run in order: the nth call with an id gets the nth result.
 */
function answers(events: JournalEvent[], at: number): { results: Map<string, string[]>; started: Map<string, number> } {
  const results = new Map<string, string[]>();
  const started = new Map<string, number>();
  for (let j = at + 1; j < events.length; j++) {
    const e = events[j]!;
    if (e.type === 'assistant') break;
    if (e.type === 'tool.intent') started.set(e.callId, (started.get(e.callId) ?? 0) + 1);
    if (e.type === 'tool.result') results.set(e.callId, [...(results.get(e.callId) ?? []), e.output]);
  }
  return { results, started };
}

export function buildMessages(events: JournalEvent[], system: string, budgetChars = 400_000): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.type === 'stimulus') {
      out.push({ role: 'user', content: stimulusText(e.source, e.text) });
    } else if (e.type === 'assistant') {
      if (e.toolCalls.length === 0) {
        const before = out.at(-1);
        if (before !== undefined && isPlainReply(before)) {
          // Two finished replies in a row (see LATE) are one message: providers refuse or misread the pair.
          before.content = [before.content, e.text].filter((t) => t !== null && t !== '').join('\n\n');
        } else {
          out.push({ role: 'assistant', content: e.text });
        }
        continue;
      }
      out.push({
        role: 'assistant',
        content: e.text === '' ? null : e.text,
        tool_calls: e.toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })),
      });
      // Results are placed here, right after their call, whatever was journaled in between.
      const { results, started } = answers(events, i);
      for (const c of e.toolCalls) {
        const output = results.get(c.id)?.shift();
        const began = (started.get(c.id) ?? 0) > 0;
        started.set(c.id, (started.get(c.id) ?? 0) - 1);
        out.push({ role: 'tool', tool_call_id: c.id, content: output ?? (began ? INTERRUPTED : NOT_STARTED) });
      }
    } else {
      const note = kernelNote(e);
      if (note !== null) out.push({ role: 'user', content: note });
    }
  }
  // A request that ends with a finished reply asks for nothing. See LATE for when that happens.
  const last = out.at(-1);
  if (last !== undefined && isPlainReply(last)) out.push({ role: 'user', content: LATE });
  return [{ role: 'system', content: system }, ...fit(out, budgetChars)];
}

/** True when the last thing in the conversation is not the agent's own finished reply. */
export function needsTurn(events: JournalEvent[]): boolean {
  let afterReply = false;
  for (const e of events) {
    if (e.type === 'assistant') afterReply = e.toolCalls.length > 0;
    else if (e.type === 'stimulus' || kernelNote(e) !== null) afterReply = true;
  }
  return afterReply;
}
