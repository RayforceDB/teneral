import { pastOf } from './asked';
import { appendEvent, type JournalEvent } from '../brain/journal';
import type { Past } from '../brain/past';
import { readsState } from '../brain/states-table';
import type { Stimulus } from './sensors';
import type { Tool } from './tools';

// Things the agent set itself to do again and again: every hour, every day, every weekday, every week.
//
// What it means to do once it sets down with `intend`, and what waits for something it looks at
// again after a while (body/work.ts). Neither says "each morning at nine". This does: a note says
// what is to be done and when it comes round, and when the time has come the agent is woken with
// it, as with any work of its own that has come due. All times are UTC.
//
// Each time is given at most once: a note is written first that it was given, so a body that dies
// in the middle does not give it twice. After the agent was down for a day it is given the latest
// time that has passed, once, and not every one it missed. It is the agent's own word to itself and
// gives no authority: what it may do when woken is what it may do at any time.

/** Something to do again and again: `{ text, every, at, on? }`. */
export const SCHEDULE_KIND = 'schedule.v1';
/** It was given to the agent for the time `slot`: `{ schedule, slot }`. */
export const SCHEDULE_RAN_KIND = 'schedule.ran.v1';
/** It is over: `{ schedule, why }`. */
export const SCHEDULE_END_KIND = 'schedule.ended.v1';

export const EVERY = ['hour', 'day', 'weekday', 'week'] as const;
export type Every = (typeof EVERY)[number];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
/** The most of them an agent keeps going at once: each is a turn it will pay for again and again. */
export const SCHEDULES_MAX = 12;

export interface Schedule {
  id: string; mark: string; set: string; text: string; every: Every;
  /** Minutes into the day (for `hour`: into the hour) at which it comes round, UTC. */
  minute: number;
  /** For `week`: the day, 0 for Sunday. */
  on: number;
}

const markOf = (id: string): string => `S${id.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}`;

readsState(SCHEDULE_KIND, 'schedule', (e) => ({ key: e.id, state: 'on' }));
readsState(SCHEDULE_END_KIND, 'schedule', (e) => { const id = (e.data as { schedule?: unknown } | null)?.schedule; return typeof id === 'string' ? { key: id, state: 'ended' } : null; });
readsState(SCHEDULE_RAN_KIND, 'scheduleran', (e) => { const d = e.data as { schedule?: unknown; slot?: unknown } | null; return typeof d?.schedule === 'string' && typeof d.slot === 'string' ? { key: d.schedule, state: d.slot } : null; });

/** A schedule as its note says it, or null when the note is not in form. */
export function scheduleOf(e: JournalEvent): Schedule | null {
  if (e.type !== 'note' || e.kind !== SCHEDULE_KIND || typeof e.data !== 'object' || e.data === null) return null;
  const d = e.data as { text?: unknown; every?: unknown; minute?: unknown; on?: unknown };
  if (typeof d.text !== 'string' || d.text.trim() === '' || !EVERY.includes(d.every as Every) || !Number.isInteger(d.minute)) return null;
  const every = d.every as Every;
  const minute = Math.min(Math.max(d.minute as number, 0), every === 'hour' ? 59 : 1439);
  return { id: e.id, mark: markOf(e.id), set: e.ts, text: d.text, every, minute, on: Number.isInteger(d.on) ? Math.min(Math.max(d.on as number, 0), 6) : new Date(e.ts).getUTCDay() };
}

/** The schedules that are going, the oldest first: asked of the database, which keeps how each stands. */
export function schedulesOf(past: Pick<Past, 'states'>): Schedule[] {
  return past.states('schedule', { state: 'on' }).flatMap((row) => { const s = scheduleOf(row.event); return s === null ? [] : [s]; });
}

const HOUR = 3_600_000, DAY = 24 * HOUR;

/** The latest time at or before `now` at which `s` comes round; before it was set it never did. */
export function slotBefore(s: Schedule, now: number): number | null {
  let at: number;
  if (s.every === 'hour') {
    at = Math.floor(now / HOUR) * HOUR + s.minute * 60_000;
    if (at > now) at -= HOUR;
  } else {
    at = Math.floor(now / DAY) * DAY + s.minute * 60_000;
    if (at > now) at -= DAY;
    const fits = (t: number): boolean => { const day = new Date(t).getUTCDay(); return s.every === 'day' || (s.every === 'weekday' ? day >= 1 && day <= 5 : day === s.on); };
    for (let back = 0; back < 8 && !fits(at); back++) at -= DAY;
  }
  return at > Date.parse(s.set) ? at : null;
}

/** The next time after `now` at which it comes round. */
export function slotAfter(s: Schedule, now: number): number {
  const step = s.every === 'hour' ? HOUR : DAY;
  for (let t = now + step, tries = 0; tries < 9; t += step, tries++) {
    const at = slotBefore(s, t);
    if (at !== null && at > now) return at;
  }
  return now + 7 * DAY;
}

const when = (s: Schedule): string => {
  const hhmm = `${String(Math.floor(s.minute / 60)).padStart(2, '0')}:${String(s.minute % 60).padStart(2, '0')}`;
  return s.every === 'hour' ? `every hour at ${String(s.minute).padStart(2, '0')} past` : s.every === 'week' ? `every ${DAYS[s.on]} at ${hhmm} UTC` : `every ${s.every} at ${hhmm} UTC`;
};

/**
 * Something whose time has come and that was not given for that time yet: journaled as given, and
 * returned as what wakes the agent. The oldest first; one at a look, the next at the next.
 */
export function dueSchedule(journal: string, gen: string, now: number, past: Pick<Past, 'states'>): Stimulus | null {
  const ran = new Map(past.states('scheduleran').map((row) => [row.key, row.state]));
  for (const s of schedulesOf(past)) {
    const slot = slotBefore(s, now);
    if (slot === null || (ran.get(s.id) ?? '') >= new Date(slot).toISOString()) continue;
    // Journal first: given at most once, whatever happens to this body next.
    appendEvent(journal, gen, { type: 'note', kind: SCHEDULE_RAN_KIND, data: { schedule: s.id, slot: new Date(slot).toISOString() } });
    return {
      source: 'work',
      text: `It is time for something you set yourself to do ${when(s)} (${s.mark}): ${s.text}\n`
        + 'This is your own word to yourself, come round; it is not new authorization, and what you may do now is what you may do at any time. Do it, and give what comes of it to whoever it is for, where it says. '
        + `If there is nothing to say this time, say nothing. To end it: \`schedule\` with end ${s.mark}.`,
    };
  }
  return null;
}

/** When the next of them comes round, or undefined when none is going: what a body that waits looks at the clock for. */
export function scheduleDueAt(now: number, past: Pick<Past, 'states'>): number | undefined {
  const all = schedulesOf(past);
  if (all.length === 0) return undefined;
  const ran = new Map(past.states('scheduleran').map((row) => [row.key, row.state]));
  return Math.min(...all.map((s) => { const slot = slotBefore(s, now); return slot !== null && (ran.get(s.id) ?? '') < new Date(slot).toISOString() ? now : slotAfter(s, now); }));
}

const str = (args: unknown, key: string): string | undefined => { const v = (args as Record<string, unknown> | null)?.[key]; return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined; };

export const schedule: Tool = {
  spec: {
    name: 'schedule',
    description:
      'Set yourself something to do again and again, at a time in UTC; you are woken with your own words when it comes round, so say in them what to do and whom to give it to. '
      + 'With no arguments: what you have going. With `end` and a mark: it stops. Each is a turn paid for every time: keep few. It gives no authority you do not have.',
    parameters: {
      type: 'object',
      properties: {
        what: { type: 'string', description: 'What to do each time and whom to give it to' },
        every: { type: 'string', enum: [...EVERY] },
        at: { type: 'string', description: 'HH:MM, UTC; for every hour, :MM' },
        on: { type: 'string', enum: [...DAYS], description: 'For every week: the day' },
        end: { type: 'string', description: 'The mark of one to stop' },
      },
      required: [],
    },
  },
  async run(args, ctx) {
    const past = pastOf(ctx);
    const going = schedulesOf(past);
    const ended = str(args, 'end');
    if (ended !== undefined) {
      const one = going.find((s) => s.mark === ended || s.id === ended);
      if (one === undefined) throw new Error(`nothing you have going has the mark ${ended}`);
      appendEvent(ctx.journal, ctx.gen, { type: 'note', kind: SCHEDULE_END_KIND, data: { schedule: one.id, why: str(args, 'what') ?? 'ended by the agent' } });
      return `Ended ${one.mark}: it will not come round again.`;
    }
    const what = str(args, 'what');
    if (what === undefined) {
      if (going.length === 0) return 'You have nothing set to come round.';
      const now = Date.now();
      return going.map((s) => `${s.mark}  ${when(s)}, next ${new Date(slotAfter(s, now)).toISOString().slice(0, 16).replace('T', ' ')} UTC: ${s.text}`).join('\n');
    }
    if (what.length < 12) throw new Error('say what to do each time so that it can be understood on its own, weeks from now');
    const every = str(args, 'every') as Every | undefined;
    if (every === undefined || !EVERY.includes(every)) throw new Error(`every must be one of ${EVERY.join(', ')}`);
    const at = str(args, 'at') ?? (every === 'hour' ? ':00' : undefined);
    const m = every === 'hour' ? /^(?:\d{1,2})?:([0-5]\d)$/.exec(at ?? '') : /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(at ?? '');
    if (m === null) throw new Error(every === 'hour' ? 'at is the minutes past the hour, as :15' : 'at is a time in UTC, as 09:00');
    const minute = every === 'hour' ? Number(m[1]) : Number(m[1]) * 60 + Number(m[2]);
    const day = str(args, 'on');
    if (day !== undefined && (every !== 'week' || !DAYS.includes(day as (typeof DAYS)[number]))) throw new Error(`on is a day for every week: ${DAYS.join(', ')}`);
    if (going.length >= SCHEDULES_MAX) throw new Error(`you have ${going.length} going, which is the most: end one first`);
    if (going.some((s) => s.text === what && s.every === every && s.minute === minute)) return 'You have that going already.';
    const note = appendEvent(ctx.journal, ctx.gen, { type: 'note', kind: SCHEDULE_KIND, data: { text: what.slice(0, 1500), every, minute, ...(day === undefined ? {} : { on: DAYS.indexOf(day as (typeof DAYS)[number]) }) } });
    const s = scheduleOf(note)!;
    return `Set as ${s.mark}: ${when(s)}, first at ${new Date(slotAfter(s, Date.parse(note.ts))).toISOString().slice(0, 16).replace('T', ' ')} UTC. To end it: schedule with end ${s.mark}.`;
  },
};
