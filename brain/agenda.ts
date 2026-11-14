import { appendEvent, type JournalEvent, type Usage } from './journal';
import { DONE_KIND, INTENTION_KIND, agenda, known, type Intention, type IntentionData, type Known } from './known';
import { MEMORY_MARK } from './logbook';
import { DEFAULT_BUDGET, buildMessages } from './memory';
import type { ChatMessage } from './provider';
import { EPISODE_KIND } from './remembered';
import type { SleepDeps, Slept } from './sleep';

// A memory that only looks back gives its agent nothing to do. Forming a memory answers "what
// happened"; nothing in that asks what follows from it. So, now and then, when there is nothing
// to remember, the agent is shown what a turn would show it (its memories, what it knows, what it
// means to do, the latest of the conversation) and asked to think ahead: what is left unfinished
// that nobody holds, what keeps coming back, what its owner would be glad to find done, what it
// needs to ask. What it sets down are intentions of its own (brain/known.ts), and with what it
// took on for others they are its agenda. A clock tick offers the agenda in order, one thing at a
// time (body/sensors.ts): that is where initiative comes from, and the owner sees and can strike
// every line of it (`/memory`).
//
// No idea is lost. Whatever the agent sets down in form is kept; when many of its own are open it
// is told so and asked to close what no longer matters, and what it closes stays in the journal
// with the reason. An idea it is not sure its owner allows is kept as one that waits for the
// owner's word, and a question is kept for whoever the agent says can answer it. To whom each
// goes, and by what way, is the agent's choice: nothing here names a channel (brain/known.ts).
// What got no answer is put again after a while, to the same people.
//
// It is asked rarely, after several new memories, and with the request a turn would send, so that
// most of it is still in the provider's cache. An answer that is not in form sets down nothing.

export const REFLECTION_KIND = 'memory.reflection.v1';
/** The agent looks over what it is doing once this many memories of episodes have been formed since it last did. */
export const REFLECT_EVERY = 6;
/** The most lines of one list that a look may set down: a longer list is not a list of what matters. */
const LIST_MAX = 12;
/** With this many of its own already open, the agent is told so, and asked to close what no longer matters before adding. */
export const OWN_OPEN_MANY = 7;
/** How many lines of the agenda a clock tick offers, and how much of each. */
const OFFERED = 5;
const OFFERED_CHARS = 240;
/** What was asked and not answered is asked again after this long, and again each time as long passes. */
export const REMIND_MS = 24 * 3_600_000;

/** What waits for an answer and is to be put now: never asked, or asked long enough ago with no answer. */
export function toAsk(held: Known, now: number): Intention[] {
  return held.intentions.filter((i) => i.waits && (!i.put || now - Date.parse(i.putAt ?? '') >= REMIND_MS));
}

/** Whether it is time to look ahead: enough has been remembered since the last time. */
export function reflectionDue(events: JournalEvent[]): boolean {
  let since = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== 'note') continue;
    if (e.kind === REFLECTION_KIND) break;
    if (e.kind === EPISODE_KIND && (e.data as { outcome?: unknown } | null)?.outcome !== 'quiet') since += 1;
  }
  return since >= REFLECT_EVERY;
}

/** What the agent is asked, after everything a turn would show it. */
export function reflectQuestion(held: Known): string {
  const own = held.intentions.filter((i) => i.origin === 'own').length;
  return [
    `${MEMORY_MARK} Nothing is asked of you at this moment, and you have remembered a good deal since you last looked over what you are doing. `
    + 'Look over it now: your memories, what you know and what you mean to do, all above. Think ahead, not back. Not what happened: what follows from it.',
    'What was left unfinished that nobody is holding? What keeps coming back, the same failure, the same request, the same detour, and could be dealt with once? '
    + 'What would your owner be glad to find done without having asked? What do you need from your owner that you have not asked for?',
    'Set down only what you would really do in time of your own, each so that it can be understood on its own, weeks from now. '
    + 'Nothing that is already in your list above. Fewer is better, and none is an honest answer.'
    + (own >= OWN_OPEN_MANY ? ` You already hold ${own} ideas of your own that are open: before adding to them, close under Done those that no longer matter.` : ''),
    'An idea of your own is no permission. What your owner has plainly allowed you, or what touches only your own work, goes under Agenda. '
    + 'What you are not sure they would allow goes under Unsure: it is not lost, it waits, and you ask them. Do not drop an idea because you may not be allowed it, and do not do it without asking.',
    'Call no tool. Reply with these lists and nothing else, each only when there is something for it:',
    'Agenda:\n- [] <a thing you mean to do, that nobody asked for and that you are sure you may do>\n- [YYYY-MM-DD] <the same, when it has a day>',
    'Unsure:\n- <a thing you would do if your owner allows it, said so that they can answer yes or no>',
    'Ask:\n- [whom it is for, and where you will reach them] <a question, put so that it can be answered in a line>\n- [] <the same, when it is for your owner>\n'
    + 'A question goes to whoever can answer it: your owner, one person, the people of some chat. Whom to ask and where is yours to choose.',
    'Done:\n- I1a2b3c4 <how it ended>\nFor each thing in your list above that is settled, or no longer worth doing: its mark, and in a few words why.',
    'If there is nothing for any of them, reply with the one word: Nothing',
  ].join('\n\n');
}

export interface Looked {
  own: { text: string; due?: string }[];
  /** Ideas that wait for the owner's word. */
  unsure: string[];
  asks: { text: string; to?: string }[];
  done: { mark: string; how: string }[];
}

const plain = (line: string): string => line.replace(/^[\s#*_>-]+/, '').replace(/[*_]+/g, '').trim();
const HEADINGS: Record<string, keyof Looked> = { 'agenda:': 'own', 'unsure:': 'unsure', 'ask:': 'asks', 'done:': 'done' };
const OWN_LINE = /^-\s*\[\s*(\d{4}-\d{2}-\d{2})?\s*\]\s*(.+)$/;
const ASK_LINE = /^-\s*(.+)$/;
const TO_LINE = /^-\s*\[([^\]]*)\]\s*(.+)$/;
const DONE_LINE = /^-\s*(I[0-9a-zA-Z]{4,12})\b[\s:,-]*(.*)$/;

/** What a reply sets down, or the reason it is not in form. A line that is not in form is left out. */
export function parseLook(reply: string): Looked | { problem: string } {
  const lines = reply.replaceAll('\r', '').split('\n');
  const found: Looked = { own: [], unsure: [], asks: [], done: [] };
  if (/^nothing\.?$/i.test(plain(reply.trim()))) return found;
  let list: keyof Looked | null = null;
  let headed = false;
  for (const line of lines) {
    const heading = HEADINGS[plain(line).toLowerCase()];
    if (heading !== undefined) {
      list = heading;
      headed = true;
      continue;
    }
    const item = line.trim();
    if (list === 'own' && found.own.length < LIST_MAX) {
      const m = OWN_LINE.exec(item);
      if (m && m[2]!.trim().length >= 8) found.own.push({ text: m[2]!.trim(), ...(m[1] ? { due: m[1] } : {}) });
    } else if (list === 'unsure' && found.unsure.length < LIST_MAX) {
      // A model may bracket these as it does the others; the brackets are no part of the idea.
      const m = ASK_LINE.exec(item.replace(/^-\s*\[[^\]]*\]\s*/, '- '));
      if (m && m[1]!.trim().length >= 8) found.unsure.push(m[1]!.trim());
    } else if (list === 'asks' && found.asks.length < LIST_MAX) {
      const m = TO_LINE.exec(item) ?? ASK_LINE.exec(item);
      const [to, text] = m === null ? ['', ''] : m.length === 3 ? [m[1]!.trim(), m[2]!.trim()] : ['', m[1]!.trim()];
      if (text.length >= 8) found.asks.push({ text, ...(to !== '' && !/^(your |my |the )?owner$/i.test(to) ? { to } : {}) });
    } else if (list === 'done' && found.done.length < 24) {
      const m = DONE_LINE.exec(item);
      if (m) found.done.push({ mark: m[1]!, how: m[2]!.trim() });
    }
  }
  return headed ? found : { problem: 'it had none of the lists "Agenda:", "Unsure:", "Ask:", "Done:" and was not the one word "Nothing"' };
}

/**
 * Looks ahead once, when it is time: asks the agent what follows from what it remembers, and
 * journals what it sets down. Whatever comes of it, a record that it looked is journaled, so that
 * a model that will not answer in form is not asked again and again.
 */
export async function reflect(d: SleepDeps, events: JournalEvent[]): Promise<Slept> {
  if (!reflectionDue(events)) return 'nothing';
  const held = known(events);
  const budget = (d.budgetChars ?? DEFAULT_BUDGET) - JSON.stringify(d.specs).length;
  let messages: ChatMessage[] = buildMessages(events, d.system(), budget, undefined, { ask: reflectQuestion(held), ...(d.tailChars === undefined ? {} : { tailChars: d.tailChars }) });
  let usage: Usage | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let reply;
    try {
      reply = await d.provider(messages, d.specs, d.signal && { signal: d.signal });
    } catch (err) {
      if (d.signal?.aborted) return 'woken';
      throw err;
    }
    if (d.signal?.aborted) return 'woken';
    usage = reply.usage;
    const looked = reply.toolCalls.length > 0 ? { problem: 'a tool was called' } : parseLook(reply.text);
    if (!('problem' in looked)) {
      // Everything set down is kept; only what it already holds, word for word, is not set down twice.
      const said = new Set(held.intentions.map((i) => i.text));
      const fresh = (text: string): boolean => !said.has(text) && said.add(text) !== undefined;
      const own = looked.own.filter((i) => fresh(i.text));
      const unsure = looked.unsure.filter(fresh);
      const asks = looked.asks.filter((ask) => fresh(ask.text));
      for (const i of own) appendEvent(d.journal, d.gen, { type: 'note', kind: INTENTION_KIND, data: { ...i, origin: 'own' } satisfies IntentionData });
      for (const text of unsure) appendEvent(d.journal, d.gen, { type: 'note', kind: INTENTION_KIND, data: { text, origin: 'own', unsure: true } satisfies IntentionData });
      for (const ask of asks) appendEvent(d.journal, d.gen, { type: 'note', kind: INTENTION_KIND, data: { ...ask, origin: 'ask' } satisfies IntentionData });
      let closed = 0;
      for (const settled of looked.done) {
        const open = held.intentions.find((i) => i.mark === settled.mark);
        if (open === undefined) continue;
        appendEvent(d.journal, d.gen, { type: 'note', kind: DONE_KIND, data: { intention: open.id, how: settled.how } });
        closed += 1;
      }
      appendEvent(d.journal, d.gen, { type: 'note', kind: REFLECTION_KIND, data: { own: own.length, unsure: unsure.length, asks: asks.length, closed, ...(usage ? { usage } : {}) } });
      return 'reflected';
    }
    messages = [
      ...messages,
      { role: 'assistant', content: reply.text.trim() === '' ? '(no text)' : reply.text },
      { role: 'user', content: `${MEMORY_MARK} That cannot be kept: ${looked.problem}. Reply again in exactly the form asked for, and call no tool.` },
    ];
  }
  appendEvent(d.journal, d.gen, { type: 'note', kind: REFLECTION_KIND, data: { own: 0, unsure: 0, asks: 0, closed: 0, failed: true, ...(usage ? { usage } : {}) } });
  return 'reflected';
}

/**
 * What a clock tick says of the agenda: its first lines in the order to take them, and what to do
 * with them. One thing in a tick: time of its own is not a licence to work through a list while
 * nobody watches.
 */
export function offered(held: Known, now: number): string {
  const today = new Date(now).toISOString().slice(0, 10);
  const todo = agenda(held, today);
  const line = (text: string): string => (text.length > OFFERED_CHARS ? `${text.slice(0, OFFERED_CHARS - 1)}…` : text).replace(/\s+/g, ' ');
  // What waits for an answer comes first, when it was never asked or was asked long ago: an idea nobody answers is as good as lost.
  const unasked = toAsk(held, now);
  const ask = unasked.length === 0 ? '' : [
    'First, what waits for an answer and is to be put now:',
    ...unasked.slice(0, OFFERED).map((i) => {
      const whom = i.unsure === true ? '[an idea, may I? for your owner] ' : `[for ${i.to ?? 'your owner'}] `;
      return `${i.mark} ${whom}${i.put ? `[asked ${(i.putAt ?? '').slice(0, 10)}, no answer yet: remind them] ` : '[not yet asked] '}${line(i.text)}`;
    }),
    'Put each to whom it is for, with its mark and short enough to answer in a line, by the way you judge they will see it soonest; which way that is, is yours to choose. '
    + 'What you say in your reply here your owner reads when they next come to you, and no one else does. A reminder is one line, not the case made again. '
    + 'Asking is all that is needed from you: do not wait for the answer before going on.\n',
  ].join('\n');
  if (todo.length === 0) return `${ask}Nothing ${ask === '' ? '' : 'else '}is on your agenda. If something is worth doing now all the same, do it; if not, say so in one line.`;
  const rows = todo.slice(0, OFFERED).map((i) => {
    const why = i.due !== undefined && i.due <= today ? `[due ${i.due}, which has come] ` : i.origin === 'own' ? '[your own idea] ' : '';
    return `${i.mark} ${why}${line(i.text)}`;
  });
  return ask + [
    `Otherwise this is time of your own. Your agenda, in the order to take it${todo.length > OFFERED ? ` (the first ${OFFERED} of ${todo.length})` : ''}:`,
    ...rows,
    'Take the first one you can act on now, within what your owner has allowed you, and do it: one thing in a tick. '
    + 'When it is finished, or turns out not to be worth doing, close it with `done` and say how it ended. If none can be acted on now, say why in one line.',
  ].join('\n');
}
