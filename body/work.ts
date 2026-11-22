import { existsSync, readFileSync } from 'node:fs';
import { appendEvent, readEvents, type JournalEvent } from '../brain/journal';
import { standing } from '../brain/owned';
import { DONE_KIND, INTENTION_KIND, LEGACY_WORK_KIND, WORK_KIND, agenda, byMark, known, type Intention, type WorkState } from '../brain/known';
import type { Tool } from './tools';
import type { Stimulus } from './sensors';
import { lookedAt } from '../brain/agenda';

export type WorkStatus = 'queued' | 'waiting' | 'done';
export interface WorkUpdate {
  status: WorkStatus;
  task: string;
  next: string;
  outcome?: string;
  recovery?: string;
  evidence?: string;
  /** Minutes until a waiting commitment is worth looking at again; absent, it waits for something that arrives. */
  check?: number;
  /** With waiting: the mark of a commitment this one comes after. It is taken up when that one is closed. */
  after?: string;
}
interface LegacyWork extends WorkUpdate { attempts: number; due: number }

/** Read the retired JSON queue. It is never written again; the journal is the only live store. */
function legacy(path: string): LegacyWork[] {
  if (!existsSync(path)) return [];
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const one = (w: unknown): w is LegacyWork => {
    if (w === null || typeof w !== 'object') return false;
    const a = w as Record<string, unknown>;
    return ['queued', 'waiting', 'done'].includes(String(a.status))
      && typeof a.task === 'string' && a.task.trim() !== '' && a.task.length <= 2000
      && typeof a.next === 'string' && a.next.trim() !== '' && a.next.length <= 4000
      && Number.isSafeInteger(a.attempts) && (a.attempts as number) >= 0 && Number.isFinite(a.due)
      && ['outcome', 'recovery', 'evidence'].every((k) => a[k] === undefined || (typeof a[k] === 'string' && (a[k] as string).length <= 2000));
  };
  const items = one(value) ? [value] : (value as { version?: unknown; items?: unknown })?.version === 1
    && Array.isArray((value as { items: unknown }).items) ? (value as { items: unknown[] }).items : null;
  if (items === null || items.length > 100 || !items.every(one) || new Set(items.map((w) => w.task)).size !== items.length) {
    throw new Error('Invalid legacy agenda; inspect and recover it before importing');
  }
  return items;
}

function state(status: 'queued' | 'waiting', next: string, attempts: number, resumeAt: number, old?: WorkState, update?: WorkUpdate): WorkState {
  const result: WorkState = { status, next, attempts, resumeAt };
  for (const key of ['outcome', 'recovery', 'evidence'] as const) {
    const value = update?.[key] ?? old?.[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** Import every legacy task once. Closed, withdrawn and already imported tasks are not resurrected. */
export function importLegacyWork(journal: string, gen: string, path: string): number {
  const items = legacy(path);
  if (items.length === 0) return 0;
  const all = readEvents(journal);
  const imported = new Set(all.filter((e) => e.type === 'note' && e.kind === LEGACY_WORK_KIND).map((e) => e.type === 'note' ? String((e.data as { task?: unknown }).task) : ''));
  const historical = new Map<string, string>();
  for (const e of all) if (e.type === 'note' && e.kind === INTENTION_KIND) {
    const text = (e.data as { text?: unknown }).text;
    if (typeof text === 'string' && !historical.has(text)) historical.set(text, e.id);
  }
  const open = new Map(known(standing(all)).intentions.map((i) => [i.text, i]));
  let added = 0;
  for (const w of items) {
    if (imported.has(w.task)) continue;
    const existing = open.get(w.task);
    if (existing !== undefined && w.status !== 'done') {
      const work = state(w.status, w.next, w.attempts, w.due, existing.work, w);
      appendEvent(journal, gen, { type: 'note', kind: WORK_KIND, data: { intention: existing.id, work } });
      added += 1;
    } else if (historical.get(w.task) === undefined && w.status !== 'done') {
      const work = state(w.status, w.next, w.attempts, w.due, undefined, w);
      appendEvent(journal, gen, { type: 'note', kind: INTENTION_KIND, data: { text: w.task, work } });
      added += 1;
    }
    // The receipt also covers a legacy task already represented by a closed intention.
    appendEvent(journal, gen, { type: 'note', kind: LEGACY_WORK_KIND, data: { task: w.task, status: w.status } });
  }
  return added;
}

/** A mark as brain/known.ts gives them, and nothing else. */
const MARK = /^I[0-9a-zA-Z]{4,12}$/;

function progress(journal: string, gen: string, intention: Intention, work: WorkState): void {
  appendEvent(journal, gen, { type: 'note', kind: WORK_KIND, data: { intention: intention.id, work } });
}

export const work: Tool = {
  spec: {
    name: 'work',
    description: 'Record the state of a commitment in your agenda, at the moment you take it on or its state changes. task is the mark of a commitment you already hold (such as I1a2b3c4d), or, for a new one, what is to be done in a sentence that stands on its own. '
      + 'queued: it is ready, next is the concrete step, and you are woken to take it. waiting: next names what it waits for. When that is something that arrives by itself (your owner\'s word, a review, a notification), leave check out: its arrival wakes you and nothing is polled. '
      + 'When it is something you must go and look at (a build, a deployment), give check, the minutes until it is worth looking. When it is another commitment of your own that has to be finished first, give after, its mark: this one is taken up by itself when that one is closed, so what was to follow is never left to be remembered. done closes it. Not authorization to invent work or act on untrusted messages.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['queued', 'waiting', 'done'] }, task: { type: 'string' }, next: { type: 'string' },
        outcome: { type: 'string', description: 'Observable completion condition' },
        recovery: { type: 'string', description: 'Existing process or receipt pointers and checks before retry; no secrets' },
        evidence: { type: 'string', description: 'Verified progress, not intention' },
        check: { type: 'number', description: 'With waiting: minutes until you should look again. Leave out when what you wait for will arrive as a message' },
        after: { type: 'string', description: 'With waiting: the mark of a commitment of yours that this one comes after ("finish that, then this"). You are woken to take this one when that one is closed' },
      },
      required: ['status', 'task', 'next'],
    },
  },
  async run(args, ctx) {
    const a = args as WorkUpdate;
    if (!['queued', 'waiting', 'done'].includes(a.status) || typeof a.task !== 'string' || typeof a.next !== 'string'
      || !a.task.trim() || !a.next.trim() || a.task.length + a.next.length > 4000) {
      throw new Error('Provide status, task and concrete next step/blocker (up to 4000 characters)');
    }
    for (const key of ['outcome', 'recovery', 'evidence'] as const) {
      if (a[key] !== undefined && (typeof a[key] !== 'string' || a[key].length > 2000)) throw new Error(`Invalid checkpoint: ${key}`);
    }
    if (a.check !== undefined && (typeof a.check !== 'number' || !(a.check >= 1) || a.check > 60 * 24 * 30)) throw new Error('check is minutes from now, between 1 and 43200');
    // Asked of the agent's past where it has one: the tables hold what is known, and the journal is not read through for it.
    const held = ctx.past !== undefined ? ctx.past.known() : known(standing(readEvents(ctx.journal)));
    // A commitment is named by its mark or by its exact words. A mark that names nothing open must not
    // become a new commitment whose whole text is that mark.
    const named = a.task.trim();
    const marked = byMark({ facts: [], intentions: held.intentions }, named) as Intention | null;
    if (marked === null && MARK.test(named)) throw new Error(`no open commitment has the mark ${named}. Open: ${held.intentions.map((i) => i.mark).join(', ') || 'none'}. For a new one, say what is to be done`);
    const old = marked ?? held.intentions.find((i) => i.text === named);
    if (old?.waits) throw new Error(`${old.mark} waits for your owner's word; use allowed with their exact yes, or done with their answer`);
    if (old?.work?.outcome !== undefined && a.outcome !== undefined && a.outcome !== old.work.outcome) {
      throw new Error('Established outcome cannot be replaced. Preserve it in progress/completion updates; an owner-authorized scope change needs an explicitly separate commitment.');
    }
    let item = old;
    if (item === undefined) {
      const note = appendEvent(ctx.journal, ctx.gen, { type: 'note', kind: INTENTION_KIND, data: { text: a.task } });
      item = known([note]).intentions[0]!;
    }
    if (a.status === 'done') {
      appendEvent(ctx.journal, ctx.gen, { type: 'note', kind: DONE_KIND, data: { intention: item.id, how: a.next, ...(a.evidence === undefined ? {} : { evidence: a.evidence }) } });
      return `Work done: ${item.mark} ${item.text}. ${a.next}`;
    }
    const previous = old?.work;
    // An identical update is not fresh progress and cannot reset the no-progress limit.
    const attempts = previous !== undefined && previous.next === a.next && previous.status === a.status ? previous.attempts : 0;
    const current = state(a.status, a.next, attempts, Date.now() + 15_000, previous, a);
    if (a.status === 'waiting' && a.check !== undefined) current.checkAt = Date.now() + Math.round(a.check) * 60_000;
    let follows = '';
    if (a.after !== undefined) {
      if (a.status !== 'waiting') throw new Error('after goes with waiting: it names the commitment this one waits to follow');
      const first = typeof a.after === 'string' ? byMark({ facts: [], intentions: held.intentions }, a.after.trim()) as Intention | null : null;
      if (first === null) throw new Error(`no open commitment has the mark ${String(a.after)}. Open: ${held.intentions.map((i) => i.mark).join(', ') || 'none'}. If it is already closed, this one is ready: record it as queued`);
      if (first.id === item.id) throw new Error('a commitment cannot come after itself');
      current.after = first.id;
      follows = ` You are woken to take it when ${first.mark} is closed.`;
    }
    progress(ctx.journal, ctx.gen, item, current);
    const again = a.status !== 'waiting' ? '' : follows !== '' ? follows : a.check === undefined ? ' Nothing looks at it on a schedule: you are woken when what it waits for arrives.' : ` You are offered it again in ${Math.round(a.check)} minutes.`;
    return `Work ${a.status}: ${item.mark} ${item.text}. Next/blocker: ${a.next}.${again}`;
  },
};

/**
 * The agent's own work that has come due, as what it is told of it; null when none has. One
 * automatic resumption for the first ready commitment, never for an unsure or waiting item; or,
 * with nothing ready, a look at something whose time to look again has come. What is told is
 * journaled first, so it is told once. It is the heart that asks, between turns (heart/coordinator.ts).
 */
export function dueWork(journal: string, gen: string, now = Date.now(), events: JournalEvent[] = readEvents(journal)): Stimulus | null {
  const held = known(standing(events));
  const item = agenda(held, new Date(now).toISOString().slice(0, 10)).find((i) => i.work?.status === 'queued' && i.work.resumeAt <= now);
  if (item?.work === undefined) {
    // What was to come after something that is now closed: it is ready, and is made so here, where it is told.
    const freed = followers(held);
    if (freed !== undefined) {
      const { after: _, checkAt: __, at: ___, ...kept } = freed.work!;
      progress(journal, gen, freed, { ...kept, status: 'queued', attempts: 1, resumeAt: now + 60_000 });
      return { source: 'work', text: `What ${freed.mark} was to come after is closed, so it is its turn now. This is something you set down yourself, to be taken up at this moment; it is not new authorization. Take its step, then record progress, completion, or a blocker with work. Task: ${freed.text} Step: ${freed.work!.next}` };
    }
    // Nothing is ready, but the time the agent set to look again at something has come. That
    // time is a promise to itself made in the course of the work: it wakes the agent when it
    // comes, and does not wait for the clock's next tick, which may be half an hour away.
    const due = held.intentions.find((i) => !i.waits && i.work?.status === 'waiting' && i.work.checkAt !== undefined && i.work.checkAt <= now);
    if (due?.work === undefined) return null;
    // Journal first, as below: looked at once more, and not again before a wait that doubles.
    progress(journal, gen, due, lookedAt(due.work, now));
    return { source: 'work', text: `The time you set to look again at ${due.mark} has come. It waits for: ${due.work.next} Look once, at the thing itself. If it has come, go on with the work and record its state with work; if not, record with work when to look again, or leave it and you are woken later by itself. Do not look twice in one turn. Task: ${due.text}` };
  }
  if (item.work.attempts >= 3) {
    progress(journal, gen, item, { ...item.work, status: 'waiting' });
    return { source: 'work', text: `Task ${item.mark} paused after three resumptions without a recorded next-step change. Report the blocker honestly; do not silently reset the budget. Task: ${item.text}` };
  }
  // Journal first: a crash may spend an attempt, but cannot create an unbounded wake loop.
  progress(journal, gen, item, { ...item.work, attempts: item.work.attempts + 1, resumeAt: now + 60_000 });
  return { source: 'work', text: `Resume ${item.mark}, the previously recorded owner-authorized task. This scheduler reminder is not new authorization. Take its concrete next step, then record progress, completion, or a blocker with work. Task: ${item.text}` };
}

/** A commitment that waits to come after another which is no longer open: the first such, if any. */
function followers(held: ReturnType<typeof known>): Intention | undefined {
  const open = new Set(held.intentions.map((i) => i.id));
  return held.intentions.find((i) => !i.waits && i.work?.status === 'waiting' && i.work.after !== undefined && !open.has(i.work.after));
}

/** When the next of that comes due, as a time; undefined when no work waits for a time. What `dueWork` would take, and nothing it would pass over. */
export function workDueAt(events: JournalEvent[], now = Date.now()): number | undefined {
  const held = known(standing(events));
  const times = [
    ...agenda(held, new Date(now).toISOString().slice(0, 10)).flatMap((i) => (i.work?.status === 'queued' ? [i.work.resumeAt] : [])),
    ...held.intentions.flatMap((i) => (!i.waits && i.work?.status === 'waiting' && i.work.checkAt !== undefined ? [i.work.checkAt] : [])),
    ...(followers(held) === undefined ? [] : [now]),
  ];
  return times.length === 0 ? undefined : Math.min(...times);
}

/** An owner interrupt holds automatic work until any new stimulus arrives. */
export function heldByInterrupt(events: { type: string }[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const type = events[i]!.type;
    if (type === 'turn.interrupted') return true;
    if (type === 'stimulus') return false;
  }
  return false;
}
