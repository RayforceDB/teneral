import { WORKING_DAYS, WORKING_KIND, countedOf, workingText, type Counted } from './working';
import { appendEvent, type EventBody, type JournalEvent, type Usage } from './journal';
import { DONE_KIND, INTENTION_KIND, WORK_KIND, agenda, known, type Intention, type IntentionData, type Known, type WorkState } from './known';
import { MEMORY_MARK } from './logbook';
import { requestFrom } from './frame';
import { DEFAULT_BUDGET } from './memory';
import type { ChatMessage } from './provider';
import { EPISODE_KIND } from './remembered';
import { QUIET_REPLY, ROUND_LIMIT_REPLY } from './quiet';
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

/** Journals what a request of the agent's own formed: at once, or through the body when the request goes on beside a turn (`append` in brain/sleep.ts). */
export function put(d: Pick<SleepDeps, 'journal' | 'gen' | 'append'>, body: EventBody): void {
  if (d.append) d.append(body);
  else appendEvent(d.journal, d.gen, body);
}

export const REFLECTION_KIND = 'memory.reflection.v1';
/** The agent looks over what it is doing once this many memories of episodes have been formed since it last did. */
export const REFLECT_EVERY = 6;
/** A commitment that has waited this many days with nothing recorded is named when the agent looks ahead. */
export const STALE_DAYS = 2;
const LISTED_STALE = 8;
/** The most lines of one list that a look may set down: a longer list is not a list of what matters. */
const LIST_MAX = 12;
/** With this many of its own already open, the agent is told so, and asked to close what no longer matters before adding. */
export const OWN_OPEN_MANY = 7;
/** How many lines of the agenda a clock tick offers, and how much of each. */
const OFFERED = 5;
const OFFERED_CHARS = 240;
/**
 * What was asked and not answered is asked again this many days after the first asking, then this many after the
 * second, and so on. After the last it is asked no more: it stays where the owner sees it (`/memory`), and nobody is nagged.
 */
export const REMIND_DAYS = [1, 3, 7];
const DAY_MS = 24 * 3_600_000;

/** What waits for an answer and is to be put now: never asked, or asked long enough ago with no answer. */
export function toAsk(held: Known, now: number): Intention[] {
  return held.intentions.filter((i) => {
    if (!i.waits) return false;
    if (!i.put) return true;
    const days = REMIND_DAYS[i.puts - 1];
    return days !== undefined && now - Date.parse(i.putAt ?? '') >= days * DAY_MS;
  });
}

/** After this many ticks in a row in which nothing was done, a tick offers the next lines of the agenda instead of the same first ones. */
export const PASSED_TICKS = 3;

/** Whether a wake is time of the agent's own: a clock tick, or a reminder of a commitment the agent itself proposed. */
export function ownWake(source: string, text: string, held: Pick<Known, 'intentions' | 'closed'>): boolean {
  if (source === 'clock') return true;
  if (source !== 'work') return false;
  const mark = /^Resume (I[0-9a-zA-Z]{4,12})\b/.exec(text)?.[1];
  const item = mark === undefined ? undefined : [...held.intentions, ...held.closed].find((i) => i.mark === mark);
  return item?.origin === 'own' && (item.unsure !== true || item.allowed !== undefined);
}

export { idleOf, idleStart, idleStep, idleTicks, type IdleState } from './idle';
import { REPORT_MARK, SUBAGENT_KIND, idleTicks, ownStart, ownStep } from './idle';

/**
 * What the agent's initiative has come to, counted from the journal with no model asked. A memory
 * has its exam; this is the agenda's: without it the agent cannot know that it keeps proposing
 * what is never done, or asking for what is always refused.
 */
export interface Initiative {
  /** Ideas of its own that needed no word: carried out, given up, still open. `undone` is the subset of `dropped` whose done record was written by a generation the stem later rolled back. */
  own: { done: number; dropped: number; open: number; undone: number };
  /** Ideas it was not sure of: the owner said yes, said no, has not answered. */
  asked: { yes: number; no: number; waiting: number };
  /** Questions: answered, still waiting. */
  questions: { answered: number; waiting: number };
  /** The latest ticks in a row that ended with nothing done. */
  idle: number;
}

export function initiative(events: JournalEvent[]): Initiative {
  return initiativeOf(known(events), events.filter((e) => e.type === 'generation.rolledback'), idleTicks(events));
}

/** The same from what is known, the records of generations rolled back, and the idle ticks in a row, wherever they are read. */
export function initiativeOf(held: Known, rolled: JournalEvent[], idle: number): Initiative {
  const all = [...held.intentions, ...held.closed];
  const count = (of: (i: Intention) => boolean): number => all.filter(of).length;
  const sure = (i: Intention): boolean => i.origin === 'own' && (i.unsure !== true || i.allowed !== undefined);
  const rolledBack = new Map<string, string>();
  for (const e of rolled) if (e.type === 'generation.rolledback') rolledBack.set(e.commit, e.ts);
  // Only an actual done record can be undone; a dropped idea must not become a fresh cancellation on every later rollback.
  const undone = (i: Intention): boolean => i.ended === 'done' && i.endedGen !== undefined && (rolledBack.get(i.endedGen) ?? '') > (i.endedAt ?? '');
  const wasDone = (i: Intention): boolean => sure(i) && i.ended === 'done' && !undone(i);
  const wasDropped = (i: Intention): boolean => sure(i) && (i.ended === 'dropped' || undone(i));
  return {
    own: {
      done: count(wasDone), dropped: count(wasDropped),
      open: count((i) => sure(i) && i.ended === undefined), undone: count((i) => sure(i) && undone(i)),
    },
    asked: { yes: count((i) => i.unsure === true && i.allowed !== undefined), no: count((i) => i.ended === 'refused'), waiting: count((i) => i.unsure === true && i.waits && i.ended === undefined) },
    questions: { answered: count((i) => i.ended === 'answered'), waiting: count((i) => i.origin === 'ask' && i.ended === undefined) },
    idle,
  };
}

/** The same in a line or two of words, for the owner's page and for the agent when it looks ahead; empty when there is nothing to count yet. */
export function initiativeText(m: Initiative): string {
  const parts: string[] = [];
  if (m.own.done + m.own.dropped + m.own.open > 0) {
    parts.push(`of your own ideas ${m.own.done} were done, ${m.own.dropped} given up${m.own.undone > 0 ? ` (${m.own.undone} because their generation was rolled back)` : ''}, ${m.own.open} are open`);
  }
  if (m.asked.yes + m.asked.no + m.asked.waiting > 0) parts.push(`of the ideas you asked your owner about, ${m.asked.yes} got a yes, ${m.asked.no} a no, ${m.asked.waiting} wait`);
  if (m.questions.answered + m.questions.waiting > 0) parts.push(`of your questions ${m.questions.answered} were answered, ${m.questions.waiting} wait`);
  if (m.idle >= PASSED_TICKS) parts.push(`the last ${m.idle} ticks of time of your own ended with nothing done`);
  return parts.join('; ');
}

/** The notes of a subagent's life in the agent's journal (body/subagents.ts): queued, running, ended, told. */
export { SUBAGENT_KIND };

/**
 * What the turns woken by a clock tick spent in the day ending at `now`, in tokens read and written:
 * the cost of the agent's time of its own, which its owner may cap (TENERAL_OWN_TOKENS_DAY).
 */
export function ownSpend(events: JournalEvent[], now: number): number {
  const state = ownStart();
  let spent = 0;
  for (const e of events) {
    const tokens = ownStep(state, e);
    if (tokens > 0 && Date.parse(e.ts) >= now - DAY_MS) spent += tokens;
  }
  return spent;
}

/** Whether it is time to look ahead: enough memories, or an idle agenda with no own idea to carry it. */
export function reflectionDue(events: JournalEvent[]): boolean {
  return reflectionDueOf(events, known(events), (last) => idleTicks(events.filter((e) => e.ts > last)));
}

/**
 * The same from the notes of the looks ahead and of the memories (`REFLECTION_KIND`, the kind of a
 * memory of an episode; other events among them are passed over), what is known, and the idle
 * ticks in a row since a time, asked for only when it is needed.
 */
export function reflectionDueOf(notes: JournalEvent[], held: Known, idleSince: (last: string) => number): boolean {
  let since = 0;
  let last = '';
  for (let i = notes.length - 1; i >= 0; i--) {
    const e = notes[i]!;
    if (e.type !== 'note') continue;
    if (e.kind === REFLECTION_KIND) {
      last = e.ts;
      break;
    }
    if (e.kind === EPISODE_KIND && (e.data as { outcome?: unknown } | null)?.outcome !== 'quiet') since += 1;
  }
  if (since >= REFLECT_EVERY) return true;
  if (held.intentions.some((i) => i.origin === 'own' && !i.waits)) return false;
  // Only idle ticks since the last look can make another one due. That look itself, or a reflection
  // reached through new memories, is a fresh boundary: three new idle ticks are needed, not a loop.
  return idleSince(last) >= PASSED_TICKS;
}

/** What the agent is asked, after everything a turn would show it. */
export function reflectQuestion(held: Known, measured = '', now = Date.now(), working = ''): string {
  const own = held.intentions.filter((i) => i.origin === 'own').length;
  const stale = held.intentions.filter((i) => !i.waits && i.work?.status === 'waiting' && now - Date.parse(i.work.at ?? i.at) >= STALE_DAYS * DAY_MS);
  return [
    `${MEMORY_MARK} Nothing is asked of you at this moment, and you have remembered a good deal since you last looked over what you are doing. `
    + 'Look over it now: your memories, what you know and what you mean to do, all above. Think ahead, not back. Not what happened: what follows from it.',
    'What was left unfinished that nobody is holding? What keeps coming back, the same failure, the same request, the same detour, and could be dealt with once? '
    + 'What would your owner be glad to find done without having asked? What do you need from your owner that you have not asked for? '
    + 'And a way of doing something that you worked out, that held, and that you would have to work out again next time: setting it down as a skill of your own (the tool `skill`, action scaffold) is a thing for your agenda too.',
    'Set down only what you would really do in time of your own, each so that it can be understood on its own, weeks from now. '
    + 'Nothing that is already in your list above. Ground each in something you can point to above, a memory, a failure, a thing your owner said; one such is worth more than five that are not, and none is an honest answer.'
    + (own >= OWN_OPEN_MANY ? ` You already hold ${own} ideas of your own that are open: before adding to them, close under Done those that no longer matter.` : ''),
    ...(stale.length === 0 ? [] : [`These have waited ${STALE_DAYS} days or more with nothing recorded: ${stale.slice(0, LISTED_STALE).map((i) => i.mark).join(', ')}. `
      + 'A list of things that only wait is no agenda. Of each, say under Done whether it is settled or given up; what still stands and needs your owner\'s word, put to them again under Ask, naming its mark.']),
    ...(working === '' ? [] : [`How you work, counted: ${working}. A tool you never call is one you do not need, or one you were not told of well enough to reach for; `
      + 'no lesson in weeks of work means that nothing taught you anything, or that what did was not set down. Which it is, you can tell and nobody else can. '
      + 'Where the fault is in how you are made, the description of a tool, a word of your prompt, mending it is work of your own, and belongs on your agenda like any other.']),
    ...(measured === '' ? [] : [`What has come of it so far: ${measured}. Let that tell you what is worth setting down: `
      + 'ideas that are never done are not worth more of, and what your owner refused once is not to be asked again in other words.']),
    'An idea of your own is no permission. What your owner has plainly allowed you, or what touches only your own work, goes under Agenda. '
    + 'What you are not sure they would allow goes under Unsure: it is not lost, it waits, and you ask them. Do not drop an idea because you may not be allowed it, and do not do it without asking.',
    'Call no tool. Reply with these lists and nothing else, each only when there is something for it:',
    'Agenda:\n- [] <a thing you mean to do, that nobody asked for and that you are sure you may do>\n- [YYYY-MM-DD] <the same, when it has a day>',
    'Unsure:\n- <a thing you would do if your owner allows it, said so that they can answer yes or no>',
    'Ask:\n- [whom it is for, and where you will reach them] <a question, put so that it can be answered in a line>\n- [] <the same, when it is for your owner>\n'
    + 'A question goes to whoever can answer it: your owner, one person, the people of some chat. Whom to ask and where is yours to choose.',
    'Done:\n- I1a2b3c4 [done] <how it ended>\n- I1a2b3c4 [dropped] <why it is given up>\nFor each thing in your list above that is settled, or no longer worth doing: its mark, which of the two, and in a few words why.',
    'If there is nothing for any of them, reply with the one word: Nothing',
  ].join('\n\n');
}

export interface Looked {
  own: { text: string; due?: string }[];
  /** Ideas that wait for the owner's word. */
  unsure: string[];
  asks: { text: string; to?: string }[];
  done: { mark: string; how: string; ended?: 'dropped' }[];
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
      const how = /^\[\s*(done|dropped)\s*\]\s*(.*)$/i.exec(m?.[2]?.trim() ?? '');
      if (m) found.done.push({ mark: m[1]!, how: (how?.[2] ?? m[2]!).trim(), ...(how?.[1]?.toLowerCase() === 'dropped' ? { ended: 'dropped' as const } : {}) });
    }
  }
  return headed ? found : { problem: 'it had none of the lists "Agenda:", "Unsure:", "Ask:", "Done:" and was not the one word "Nothing"' };
}

/**
 * Looks ahead once, when it is time: asks the agent what follows from what it remembers, and
 * journals what it sets down. Whatever comes of it, a record that it looked is journaled, so that
 * a model that will not answer in form is not asked again and again. `now` is used once when the
 * last ready commitment closes; its reflection record is still the cooldown boundary.
 */
export async function reflect(d: SleepDeps, events: JournalEvent[], now = false): Promise<Slept> {
  // With a past to ask, `events` need be only the journal's last event: everything else is asked.
  const asked = d.asked;
  const due = asked === undefined ? reflectionDue(events) : reflectionDueOf(asked.notes([REFLECTION_KIND, EPISODE_KIND]), asked.known(), (last) => {
    if (last === '') return asked.stands().idle;
    const at = asked.notesAt([REFLECTION_KIND]).at(-1)!.seq;
    return idleTicks(asked.standingFrom(at + 1).filter((e) => e.ts > last));
  });
  if (!now && !due) return 'nothing';
  const held = asked === undefined ? known(events) : asked.known();
  const counted = asked === undefined ? initiative(events) : initiativeOf(held, asked.ofType('generation.rolledback'), asked.stands().idle);
  const budget = (d.budgetChars ?? DEFAULT_BUDGET) - JSON.stringify(d.specs).length;
  const at = Date.parse(events.at(-1)?.ts ?? '') || Date.now();
  // How it works is counted only where there is a past to ask: read through, a journal of months is not read once more for it.
  let working = '';
  let tally: Counted | null = null;
  if (asked !== undefined) {
    try {
      const w = { calls: asked.called(at - WORKING_DAYS * DAY_MS), tools: d.specs.map((spec) => spec.name).filter((name) => process.env.TENERAL_LESSONS !== '0' || name !== 'lesson'), lessons: process.env.TENERAL_LESSONS === '0' ? [] : asked.lessons().held };
      working = workingText(w);
      tally = countedOf(w);
    } catch (err) {
      console.error(`[memory] how the agent works was not counted for the look ahead: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let messages: ChatMessage[] = requestFrom(d.asked, events, d.system(), budget, undefined, { ask: reflectQuestion(held, initiativeText(counted), at, working), ...(d.tailChars === undefined ? {} : { tailChars: d.tailChars }) });
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
      for (const i of own) put(d, { type: 'note', kind: INTENTION_KIND, data: { ...i, origin: 'own' } satisfies IntentionData });
      for (const text of unsure) put(d, { type: 'note', kind: INTENTION_KIND, data: { text, origin: 'own', unsure: true } satisfies IntentionData });
      for (const ask of asks) put(d, { type: 'note', kind: INTENTION_KIND, data: { ...ask, origin: 'ask' } satisfies IntentionData });
      let closed = 0;
      for (const settled of looked.done) {
        const open = held.intentions.find((i) => i.mark === settled.mark);
        if (open === undefined) continue;
        put(d, { type: 'note', kind: DONE_KIND, data: { intention: open.id, how: settled.how, ...(settled.ended === undefined ? {} : { ended: settled.ended }) } });
        closed += 1;
      }
      // What it was shown of how it works, for the owner's status line and for whoever asks later what it was told.
      if (tally !== null) put(d, { type: 'note', kind: WORKING_KIND, data: tally });
      put(d, { type: 'note', kind: REFLECTION_KIND, data: { own: own.length, unsure: unsure.length, asks: asks.length, closed, ...(usage ? { usage } : {}) } });
      return 'reflected';
    }
    messages = [
      ...messages,
      { role: 'assistant', content: reply.text.trim() === '' ? '(no text)' : reply.text },
      { role: 'user', content: `${MEMORY_MARK} That cannot be kept: ${looked.problem}. Reply again in exactly the form asked for, and call no tool.` },
    ];
  }
  put(d, { type: 'note', kind: REFLECTION_KIND, data: { own: 0, unsure: 0, asks: 0, closed: 0, failed: true, ...(usage ? { usage } : {}) } });
  return 'reflected';
}

/** The mark a report to the owner carries, so that it is known to have been made: `R` and the day. */

const LISTED = 8;

/**
 * What a clock tick asks when it is time to tell the owner what the agent has been doing on its
 * own: once in `everyMs`, and only when there is something to tell. What the agent does in time of
 * its own is otherwise seen only by an owner who reads the whole conversation. The agent sends it
 * by the way it chooses, with the mark, and the mark in what it said or sent is what counts.
 * Empty when it is not time, or there is nothing to say.
 */
export function reportAsk(events: JournalEvent[], now: number, everyMs = DAY_MS, held: Known = known(events)): string {
  if (!(everyMs > 0)) return '';
  let last = '';
  let worked = 0;
  let pending = 0;
  let own = false;
  const ownIdea = new Set<string>();
  const ownItems = [...held.intentions, ...held.closed].filter((i) => i.origin === 'own' && (i.unsure !== true || i.allowed !== undefined));
  const rolledBack = new Set<string>();
  for (const e of events) {
    if (e.type === 'stimulus') {
      // A work reminder already names whose commitment it is. A clock tick only creates the
      // possibility of initiative: its tools count when they name or close an idea of the agent's own.
      own = e.source === 'work' && ownWake(e.source, e.text, held);
      pending = 0;
      continue;
    }
    // A done record a later generation undid is reportable work, but not a surviving success.
    if (e.type === 'generation.rolledback' && !rolledBack.has(e.commit)) {
      rolledBack.add(e.commit);
      for (const i of [...held.intentions, ...held.closed]) {
        if (i.origin === 'own' && i.ended === 'done' && i.endedGen === e.commit && (i.endedAt ?? '') < e.ts) ownIdea.add(i.id);
      }
      continue;
    }
    if (e.type === 'note' && e.kind === DONE_KIND && typeof e.data === 'object' && e.data !== null) {
      const id = (e.data as { intention?: unknown }).intention;
      const item = typeof id === 'string' ? held.closed.find((i) => i.id === id) : undefined;
      if (item?.origin === 'own' && (item.unsure !== true || item.allowed !== undefined)) {
        ownIdea.add(item.id);
        // In a clock turn the tools alone cannot say whose work they advanced. A closure names the
        // idea and settles that attribution; until then the steps remain only pending.
        worked += pending;
        pending = 0;
      }
      continue;
    }
    if (e.type !== 'assistant') continue;
    const calls = Array.isArray(e.toolCalls) && e.toolCalls.length > 0;
    const words = `${e.text}\n${calls ? JSON.stringify(e.toolCalls) : ''}`;
    if (REPORT_MARK.test(words)) {
      last = e.ts;
      worked = 0;
      pending = 0;
    } else if (own && calls) worked += 1;
    else if (calls) {
      pending += 1;
      if (ownItems.some((i) => words.includes(i.mark) || words.includes(i.id) || words.includes(i.text))) {
        worked += pending;
        pending = 0;
      }
    }
  }
  if (last !== '' && now - Date.parse(last) < everyMs) return '';
  // Never told before: of the last week, not of a whole life. Only the agent's own initiative, never delegated tasks.
  const since = last !== '' ? last : new Date(now - 7 * DAY_MS).toISOString();
  const brief = (text: string): string => (text.length > 120 ? `${text.slice(0, 119)}…` : text).replace(/\s+/g, ' ');
  const ended = [...held.intentions, ...held.closed].filter((i) => i.ended !== undefined && (i.endedAt ?? '') > since && ownIdea.has(i.id)).slice(-LISTED).map((i) => `- ${i.ended}${rolledBack.has(i.endedGen ?? '') ? ' (that generation was rolled back)' : ''}: ${brief(i.text)}`);
  const added = held.intentions.filter((i) => i.at > since && i.origin === 'own' && !i.waits && !ownIdea.has(i.id)).slice(-LISTED).map((i) => `- ${i.mark} ${brief(i.text)}`);
  const waiting = held.intentions.filter((i) => i.waits && i.to === undefined).slice(-LISTED).map((i) => `- ${i.mark} ${brief(i.text)}`);
  // What was put to the owner and has had no answer for a day is told again with the day's report, all of it in one message,
  // whether or not anything else is to be told: after its few reminders a question would otherwise wait in silence for good.
  const unanswered = held.intentions.filter((i) => i.waits && i.to === undefined && i.put && now - Date.parse(i.putAt ?? '') >= DAY_MS).length;
  if (ended.length + added.length === 0 && worked === 0 && unanswered === 0) return '';
  const day = new Date(now).toISOString().slice(0, 10).replaceAll('-', '');
  return [
    ...(ended.length + added.length === 0 && worked === 0
      ? [`${unanswered === 1 ? 'A question of yours has' : `${unanswered} questions of yours have`} waited for your owner's word for a day or more. `
        + `Put what waits to them again now, all of it together in one short message, by the way you judge they will see it, with the mark R${day} in it: without the mark it does not count as sent. `
        + 'One line for each, with its mark, put so that it can be answered in a word; say which work of yours stands still for want of the answer. What waits:']
      : [`It is time to tell your owner what you have been doing on your own${last === '' ? '' : ` since ${last.slice(0, 16).replace('T', ' ')} UTC`}. `
        + `Send them one short message now, by the way you judge they will see it, with the mark R${day} in it: without the mark it does not count as sent. `
        + 'Say what you did unasked and what came of it, what waits for their word, and what you mean to do next; a few lines, no more. What the journal shows of it:']),
    ...(ended.length > 0 ? ['Closed:', ...ended] : []),
    ...(added.length > 0 ? ['New ideas of your own:', ...added] : []),
    ...(waiting.length > 0 ? ['Waiting for their word:', ...waiting] : []),
    ...(worked > 0 ? [`Steps of work in time of your own: ${worked}.`] : []),
    '',
  ].join('\n');
}

/** How long after it was recorded a commitment that waits for something to arrive is looked at all the same: it may have been missed. */
/** Work that waits for something to arrive, with no time set to look again, is looked over once it has stood so this long: nothing waits for ever in silence. */
const MISSED_MS = DAY_MS;
/** The first look at something that waits comes this long after it was offered, and each later one twice as long after, up to a day. */
const LOOK_FIRST_MS = 30 * 60_000;

/**
 * What waits and is worth looking at now. A commitment that names a time to look again is offered
 * when that time has come, and at no other moment: something that waits is not a reason to go and
 * look at it on every wake. One that waits for something to arrive, with no time set, is offered
 * to be looked over once it has stood untouched for a day; having been offered it has a time
 * (`lookedAt`), and comes round again after a wait that doubles.
 */
export function followUps(held: Known, now: number): Intention[] {
  return held.intentions.filter((i) => {
    if (i.waits || i.work?.status !== 'waiting') return false;
    if (i.work.checkAt !== undefined) return i.work.checkAt <= now;
    return now - Date.parse(i.work.at ?? i.at) >= MISSED_MS;
  });
}

/** The state of a waiting commitment once it has been offered: looked at one more time, and not again before a wait that doubles. */
export function lookedAt(work: WorkState, now: number): WorkState {
  const { at: _, ...kept } = work;
  return { ...kept, attempts: work.attempts + 1, checkAt: now + Math.min(DAY_MS, LOOK_FIRST_MS * 2 ** Math.min(work.attempts, 6)) };
}

function look(all: Intention[], line: (text: string) => string): string {
  const rows = (of: Intention[]): string => of.slice(0, OFFERED).map((i) => `${i.mark} ${line(i.text)}\nIt waits for: ${i.work?.next ?? ''}`).join('\n');
  // What has no time set was never promised a look: it is looked over, not checked.
  const untimed = all.filter((i) => i.work?.checkAt === undefined);
  const waiting = all.filter((i) => i.work?.checkAt !== undefined);
  const over = untimed.length === 0 ? '' : `These wait for something to arrive and have no time set to look again, and have stood so for a day or more:\n${rows(untimed)}\n`
    + 'Look each over once. Does what it waits for still exist, and can it still come? If it waits on a question you put to your owner, it is the question that waits: say so as its next step, and the question is put to them again by itself. '
    + 'If it is settled or no longer worth doing, close it with `done`. Otherwise record with `work` when to look again; left as it is, it comes round later by itself.\n';
  if (waiting.length === 0) return `${over}If nothing has changed and nothing is to be recorded, answer exactly ${QUIET_REPLY}.`;
  return `${over}The time you set to look again at what waits has come:\n${rows(waiting)}\n`
    + 'Look once, at the thing itself. If it has come, go on with the work. If not, record with `work` when to look again, or leave it and it is offered later by itself; '
    + `do not look twice in one turn, and do not repeat an external action without checking its receipt. If nothing has changed, answer exactly ${QUIET_REPLY}.`;
}

/**
 * Whether a tick has anything to offer: something ready to do, something to ask or to report, or
 * a thing that waits whose time to be looked at has come. With none of these there is no tick,
 * and no model is asked what it would like to do with nothing.
 */
export function worthATick(held: Known, now: number, report = ''): boolean {
  if (report !== '' || toAsk(held, now).length > 0 || followUps(held, now).length > 0) return true;
  return held.intentions.some((i) => !i.waits && i.work?.status !== 'waiting');
}

/**
 * Whether the next tick is due. Ticks that end with nothing done are a sign that what is offered
 * cannot be acted on, so each PASSED_TICKS of them in a row doubles the wait, up to sixteen
 * intervals. Anything done, or anything arriving, brings the usual interval back.
 */
export function tickDue(events: JournalEvent[], now: number, intervalMs: number): boolean {
  return tickDueOf(idleTicks(events), events.findLast((e) => e.type === 'stimulus' && e.source === 'clock')?.ts ?? '', now, intervalMs);
}

/** The same from the idle ticks in a row and the time of the clock's last tick ('' when it never ticked). */
export function tickDueOf(idle: number, clock: string, now: number, intervalMs: number): boolean {
  if (idle < PASSED_TICKS) return true;
  return clock === '' || now - Date.parse(clock) >= intervalMs * 2 ** Math.min(Math.floor(idle / PASSED_TICKS), 4) - 1000;
}

/**
 * What a clock tick says of the agenda: its first lines in the order to take them, and what to do
 * with them. One thing in a tick: time of its own is not a licence to work through a list while
 * nobody watches.
 */
export function offered(held: Known, now: number, idle = 0, report = ''): string {
  const today = new Date(now).toISOString().slice(0, 10);
  const listed = agenda(held, today);
  // Ready work comes before waits. Otherwise a full page of dependencies can hide the one commitment
  // that can actually advance, leaving the agent silent while the scheduler waits behind it.
  const whole = listed.filter((i) => i.work?.status !== 'waiting');
  // What was offered and passed over several ticks running gives way to what stands after it, so that nothing behind
  // a line that cannot be acted on waits for ever. What is due keeps its place; the rest comes round again in turn.
  const come = whole.filter((i) => i.due !== undefined && i.due <= today);
  const rest = whole.filter((i) => !come.includes(i));
  const waiting = followUps(held, now);
  const turn = rest.length <= OFFERED ? 0 : (Math.floor(idle / PASSED_TICKS) * OFFERED) % rest.length;
  const todo = [...come, ...rest.slice(turn), ...rest.slice(0, turn)];
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
  if (todo.length === 0) {
    if (waiting.length === 0) return `${report}${ask}Nothing ${report + ask === '' ? '' : 'else '}is on your agenda${listed.length > 0 ? ' that is ready now; what it holds waits for what it names, and you are woken when that arrives' : ''}. ${report + ask === '' ? `Answer exactly ${QUIET_REPLY}` : `When that is done, answer exactly ${QUIET_REPLY}`}: do not go looking for something to do.`;
    return `${report}${ask}${look(waiting, line)}`;
  }
  const rows = todo.slice(0, OFFERED).map((i) => {
    const why = i.due !== undefined && i.due <= today ? `[due ${i.due}, which has come] ` : i.origin === 'own' ? '[your own idea] ' : '';
    return `${i.mark} ${why}${line(i.text)}`;
  });
  return report + ask + (waiting.length === 0 ? '' : `${look(waiting, line)}\n`) + [
    `Otherwise this is time of your own. Your agenda, in the order to take it${todo.length > OFFERED ? ` (${OFFERED} of ${todo.length}${turn > 0 ? '; the lines before these you passed over several times, and they stay on it' : ''})` : ''}:`,
    ...rows,
    'Take the first one you can act on now, within what your owner has allowed you, and do it: one thing in a tick. '
    + 'When it is finished, or turns out not to be worth doing, close it with `done` and say how it ended. If none can be acted on now, say why in one line; '
    + 'a line you can never act on is better closed as dropped, or asked about, than passed over again. '
    + `If you decide that no listed commitment can be acted on and have no useful question or finding, answer exactly ${QUIET_REPLY}: it is internal and produces no visible reply.`,
  ].join('\n');
}

// Settling a turn. An intention is worth most at the moment it is formed: when the agent has just
// said "I will" or stopped half-way, knows exactly what remains, and its provider still holds the
// conversation in its cache. A memory formed hours later can only guess at it, and what it guessed
// was mostly work already done (brain/sleep.ts no longer sets intentions down). So when a turn
// that did something ends, the agent is asked once, with the request the turn itself would send:
// what does this turn leave behind? A step it can take now is queued and it is woken at once to
// take it (body/work.ts), so a turn that ended early is not the end of the work. What waits is
// recorded with what it waits for, and with when to look again only when nothing will announce it.

export const SETTLE_KIND = 'memory.settle.v1';
/** The most lines of either list one turn may leave: a turn that leaves more was not one turn's work. */
const SETTLE_MAX = 3;
const MARK_AT = /^-\s*(I[0-9a-zA-Z]{4,12})\b[\s:,-]*(.*)$/;
const TAG_AT = /^\[\s*([^\]]*)\]\s*(.*)$/;

export interface Left {
  /** Ready now: a new commitment, or by its mark one already held, with its first step. */
  next: { mark?: string; text: string; step: string }[];
  /** Waiting: for what, and in how many minutes to look again when nothing will announce it. */
  waiting: { mark?: string; text: string; step: string; minutes?: number; after?: string }[];
  done: Looked['done'];
}

/** What the agent is asked when a turn has just ended. `cut` says the turn was ended by the limit of rounds, not by the agent. */
export function settleQuestion(cut = false): string {
  return [
    `${MEMORY_MARK} Your turn has just ended${cut ? ', stopped by the limit of rounds in one turn and not by you' : ''}. Before you rest, settle what it leaves behind, so that nothing you began or promised is held only by this conversation. `
    + 'Look at what was asked in it, at what you did and said, and at what you mean to do, listed above.',
    'Is what was asked finished, as the one who asked would judge it? If a step remains that you can take now, without anyone\'s word, name it under Next: you are woken at once to take it. '
    + 'When what was asked held more than one thing, or something to go on to afterwards ("finish this, then go back to that"), each is a commitment of its own: the later one is set down as well, under Next when it can begin now, and otherwise under Waiting with [after <mark>], the mark of what comes before it. You are then woken to take it when that one is closed, and it is not forgotten with it. '
    + 'If it waits for something, name that under Waiting. If something in your list above was settled in this turn, close it under Done.'
    + (cut ? ' If you were still getting somewhere when you were stopped, the step you were on goes under Next; if you were going round in circles, say under Waiting what stops you, for your owner.' : ''),
    'Only what this turn began, promised or settled. To change something already in your list above, begin the line with its mark and do not set it down again in other words. '
    + 'Not a new idea, and not a thing to do merely because it could be done. Most turns leave nothing behind: then reply with the one word Nothing.',
    'Call no tool. Reply with these lists and nothing else, each only when there is something for it:',
    'Next:\n- <the commitment, in a sentence that can be understood on its own> => <the concrete step you take first>\n- I1a2b3c4 => <the next step of something already in your list>',
    'Waiting:\n- [owner] <the commitment> => <what you need from your owner before you can go on>\n- [arrives] <the commitment> => <the message, review or notification it waits for>\n'
    + '- [45m] <the commitment> => <what you will go and look at then; m, h or d>\n- I1a2b3c4 [2h] => <the same, for something already in your list>\n'
    + '- [after I1a2b3c4] <the commitment that follows that one> => <its first step, taken when that one is closed>\n'
    + 'In the brackets: owner or arrives when you will be told, and nothing is to be looked at meanwhile; a time only when nothing will tell you and you must go and look; after and a mark when it follows something of your own.',
    'Done:\n- I1a2b3c4 [done] <how it ended>\n- I1a2b3c4 [dropped] <why it is given up>',
  ].join('\n\n');
}

/** What a reply leaves behind, or the reason it is not in form. A line that is not in form is left out. */
export function parseSettle(reply: string): Left | { problem: string } {
  const found: Left = { next: [], waiting: [], done: [] };
  if (/^nothing\.?$/i.test(plain(reply.trim()))) return found;
  let list: 'next' | 'waiting' | 'done' | null = null;
  let headed = false;
  for (const raw of reply.replaceAll('\r', '').split('\n')) {
    const heading = ({ 'next:': 'next', 'waiting:': 'waiting', 'done:': 'done' } as const)[plain(raw).toLowerCase()];
    if (heading !== undefined) {
      list = heading;
      headed = true;
      continue;
    }
    const item = raw.trim();
    if (list === null || !item.startsWith('-')) continue;
    if (list === 'done') {
      const m = DONE_LINE.exec(item);
      const how = /^\[\s*(done|dropped)\s*\]\s*(.*)$/i.exec(m?.[2]?.trim() ?? '');
      if (m && found.done.length < 24) found.done.push({ mark: m[1]!, how: (how?.[2] ?? m[2]!).trim(), ...(how?.[1]?.toLowerCase() === 'dropped' ? { ended: 'dropped' as const } : {}) });
      continue;
    }
    const marked = MARK_AT.exec(item);
    let rest = (marked?.[2] ?? item.replace(/^-\s*/, '')).trim();
    const tagged = TAG_AT.exec(rest);
    const tag = tagged?.[1]?.trim().toLowerCase() ?? '';
    if (tagged) rest = tagged[2]!.trim();
    const [before, ...after] = rest.replace(/^=>\s*/, '=> ').split('=>');
    const text = before!.trim();
    const step = after.join('=>').trim() || text;
    // A new commitment must say what it is; one named by its mark needs only its step.
    if (step.length < 8 || (marked === null && text.length < 8)) continue;
    const mark = marked === null ? {} : { mark: marked[1]! };
    if (list === 'next' && found.next.length < SETTLE_MAX) found.next.push({ ...mark, text, step });
    else if (list === 'waiting' && found.waiting.length < SETTLE_MAX) {
      const time = /^(\d{1,4})\s*(m|min|h|d)\w*$/.exec(tag);
      const minutes = time === null ? undefined : Math.min(60 * 24 * 30, Math.max(1, Number(time[1]) * (time[2] === 'h' ? 60 : time[2] === 'd' ? 1440 : 1)));
      // [after I1a2b3c4]: it comes after another commitment, and is taken up when that one is closed.
      const after = /^after\s+(I[0-9a-zA-Z]{4,8})$/i.exec(tagged?.[1]?.trim() ?? '')?.[1];
      found.waiting.push({ ...mark, text, step, ...(minutes === undefined ? {} : { minutes }), ...(after === undefined ? {} : { after }) });
    }
  }
  return headed ? found : { problem: 'it had none of the lists "Next:", "Waiting:", "Done:" and was not the one word "Nothing"' };
}

/** Whether a turn's events end at the limit of rounds. */
const cutShort = (events: JournalEvent[]): boolean => {
  const last = events.findLast((e) => e.type === 'assistant');
  return last?.type === 'assistant' && last.text === ROUND_LIMIT_REPLY;
};

/**
 * Settles the turn that has just ended: asks once what it leaves behind and journals it. A record
 * that it was settled is journaled whatever comes of it. `now` is when a ready step may be taken.
 */
export async function settle(d: SleepDeps, events: JournalEvent[], now = Date.now()): Promise<Slept> {
  // With a past to ask, `events` need be only the end of the journal, from the latest thing said on: what is known is asked, and the request is made by the database.
  const held = d.asked !== undefined ? d.asked.known() : known(events);
  const budget = (d.budgetChars ?? DEFAULT_BUDGET) - JSON.stringify(d.specs).length;
  let messages: ChatMessage[] = requestFrom(d.asked, events, d.system(), budget, undefined, { ask: settleQuestion(cutShort(events)), ...(d.tailChars === undefined ? {} : { tailChars: d.tailChars }) });
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
    const left = reply.toolCalls.length > 0 ? { problem: 'a tool was called' } : parseSettle(reply.text);
    if (!('problem' in left)) {
      const open = (mark: string | undefined): Intention | undefined => (mark === undefined ? undefined : held.intentions.find((i) => i.mark === mark && !i.waits));
      const said = new Set(held.intentions.map((i) => i.text));
      const record = (item: Left['next'][number], status: WorkState['status'], minutes?: number, after?: string): boolean => {
        const old = open(item.mark);
        // A mark that names nothing open, or words already held, sets nothing down.
        if (old === undefined && (item.mark !== undefined || said.has(item.text))) return false;
        const attempts = old?.work !== undefined && old.work.next === item.step && old.work.status === status ? old.work.attempts : 0;
        const { at: _, checkAt: __, after: ___, ...kept } = old?.work ?? ({} as Partial<WorkState>);
        // What it comes after must be open and another: one that is already closed leaves this ready, which is said by Next, not here.
        const first = after === undefined ? undefined : held.intentions.find((i) => i.mark === after && i.id !== old?.id && !ended.has(i.id));
        const work: WorkState = { ...kept, status, next: item.step, attempts, resumeAt: now, ...(status === 'waiting' && minutes !== undefined ? { checkAt: now + minutes * 60_000 } : {}), ...(status === 'waiting' && first !== undefined ? { after: first.id } : {}) };
        if (old === undefined) {
          said.add(item.text);
          put(d, { type: 'note', kind: INTENTION_KIND, data: { text: item.text, work } });
        } else put(d, { type: 'note', kind: WORK_KIND, data: { intention: old.id, work } });
        return true;
      };
      let closed = 0;
      // Closed first: what was settled in this turn is not also to be gone on with.
      const ended = new Set<string>();
      for (const settled of left.done) {
        const item = held.intentions.find((i) => i.mark === settled.mark);
        if (item === undefined || ended.has(item.id)) continue;
        ended.add(item.id);
        put(d, { type: 'note', kind: DONE_KIND, data: { intention: item.id, how: settled.how, ...(settled.ended === undefined ? {} : { ended: settled.ended }) } });
        closed += 1;
      }
      const live = <T extends { mark?: string }>(items: T[]): T[] => items.filter((item) => !ended.has(open(item.mark)?.id ?? ''));
      const next = live(left.next).filter((item) => record(item, 'queued')).length;
      const waiting = live(left.waiting).filter((item) => record(item, 'waiting', item.minutes, item.after)).length;
      put(d, { type: 'note', kind: SETTLE_KIND, data: { next, waiting, closed, ...(usage ? { usage } : {}) } });
      return 'reflected';
    }
    messages = [
      ...messages,
      { role: 'assistant', content: reply.text.trim() === '' ? '(no text)' : reply.text },
      { role: 'user', content: `${MEMORY_MARK} That cannot be kept: ${left.problem}. Reply again in exactly the form asked for, and call no tool.` },
    ];
  }
  put(d, { type: 'note', kind: SETTLE_KIND, data: { next: 0, waiting: 0, closed: 0, failed: true, ...(usage ? { usage } : {}) } });
  return 'reflected';
}
