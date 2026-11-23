import { splitMarkers } from '../body/images';
import { eventChars, shownChars } from './episodes';
import { idleStart, idleStep, type IdleState } from './idle';
import type { JournalEvent } from './journal';
import { OWNER_PREFIX, fromOwner } from './owned';
import { asText } from './stemnote';

// How the events of a journal go out in a request, where that is a property of the events alone:
// what a reply and a stimulus are shown as, which name a call goes out under, which result
// answers which call, and what a stretch counts for. The assembly of a request (brain/memory.ts)
// and the tables kept for it (brain/memory-table.ts, brain/frame-table.ts) both read it here, so
// that the tables need nothing of the assembly.

/** The mark of what the agent's own memory says in a request: nothing that arrives may pass for it. */
export const MEMORY_MARK = '[memory]';

export function reply(e: JournalEvent): { text: string; calls: unknown[] } {
  const r = e as { text?: unknown; toolCalls?: unknown };
  return { text: asText(r.text), calls: Array.isArray(r.toolCalls) ? r.toolCalls : [] };
}

/**
 * Names the calls of a journal as they go out on the wire, in order: the journaled id where it
 * will do, otherwise one made from the call's position. Positions count from the start of the
 * journal, so cutting the front of a request does not rename anything. `position` is how many
 * calls went before, `usedBefore` whether a name went out among them.
 */
export function wireNames(position = 0, usedBefore: (name: string) => boolean = () => false): (id: unknown) => string {
  const used = new Set<string>();
  const taken = (name: string): boolean => used.has(name) || usedBefore(name);
  return (id) => {
    position += 1;
    let wire = typeof id === 'string' && id !== '' && id.length <= 40 && id.isWellFormed() && !taken(id) ? id : `call_${position}`;
    for (let n = 1; taken(wire); n++) wire = `call_${position}_${n}`;
    used.add(wire);
    return wire;
  };
}

/** How many images an event holds a place for, when it is one that may show images: something the owner said, or what `look` returned. */
export function imagePlaces(text: string): number {
  return splitMarkers(text).paths.length;
}

/** Whether what was said by this source may carry images of the owner's. */
export const showsImages = (source: unknown): boolean => source === 'terminal' || source === 'owner:zulip';

/** A stimulus as the agent reads it. Only stem events may say `[stem]`; anything else that does is forging a note. */
export function stimulusText(source: unknown, text: unknown): string {
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
export function answers(events: JournalEvent[], at: number): { results: Map<unknown, { output: string; ok: boolean; id: string; at: number }[]>; started: Map<unknown, number> } {
  const results = new Map<unknown, { output: string; ok: boolean; id: string; at: number }[]>();
  const started = new Map<unknown, number>();
  for (let j = at + 1; j < events.length; j++) {
    const e = events[j]!;
    if (e.type === 'assistant') break;
    if (e.type === 'tool.intent') started.set(e.callId, (started.get(e.callId) ?? 0) + 1);
    if (e.type === 'tool.result') results.set(e.callId, [...(results.get(e.callId) ?? []), { output: asText(e.output), ok: e.ok === true, id: e.id, at: j }]);
  }
  return { results, started };
}

/**
 * What a request counts of each stretch of a journal held whole: what its events count for, new
 * and old, how many calls its replies made, and how many images it holds a place for (in what
 * the owner said, and in what `look` returned to a call of a reply in it). Summed over the
 * stretches before a point, it is what a request that begins there must know of what it does not
 * show. The tables of the database hold the same of every episode (brain/memory-table.ts).
 */
export function counted<T extends { from: number; to: number }>(events: JournalEvent[], cut: T[]): (T & { chars: number; shown: number; calls: number; slots: number; idle: IdleState })[] {
  // How the count of idle ticks stands at the end of each stretch: counted from the first event, the stretches being in order.
  const idle = idleStart();
  let counted = 0;
  return cut.map((stretch) => {
    for (; counted < stretch.to; counted++) idleStep(idle, events[counted]!);
    let chars = 0, shown = 0, calls = 0, slots = 0;
    for (let i = stretch.from; i < stretch.to; i++) {
      const e = events[i]!;
      chars += eventChars(e);
      shown += shownChars(e);
      if (e.type === 'stimulus') {
        if (showsImages(e.source)) slots += imagePlaces(stimulusText(e.source, e.text));
      } else if (e.type === 'assistant') {
        const { results } = answers(events, i);
        for (const call of reply(e).calls) {
          const c = (typeof call === 'object' && call !== null ? call : {}) as { id?: unknown; name?: unknown };
          calls += 1;
          const result = results.get(c.id)?.shift();
          if (c.name === 'look' && result?.ok) slots += imagePlaces(result.output);
        }
      }
    }
    return { ...stretch, chars, shown, calls, slots, idle: { ...idle } };
  });
}
