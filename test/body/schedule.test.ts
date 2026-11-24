import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEDULE_RAN_KIND, SCHEDULES_MAX, dueSchedule, schedule, scheduleDueAt, schedulesOf, slotAfter, slotBefore, type Schedule } from '../../body/schedule';
import type { ToolContext } from '../../body/tools';
import { readEvents } from '../../brain/journal';
import { journalPast } from '../../brain/past';

const at = (iso: string): number => Date.parse(iso);
const one = (every: Schedule['every'], minute: number, set: string, on = 1): Schedule => ({ id: 's', mark: 'Ss', set, text: 'x', every, minute, on });

test('when something comes round: the latest time at or before now, never before it was set, and the next after', () => {
  // Every day at 09:00, set on a Monday afternoon (2026-11-23 is a Monday).
  const daily = one('day', 9 * 60, '2026-11-23T14:00:00.000Z');
  expect(slotBefore(daily, at('2026-11-23T20:00:00.000Z'))).toBeNull();
  expect(slotBefore(daily, at('2026-11-24T08:59:00.000Z'))).toBeNull();
  expect(slotBefore(daily, at('2026-11-24T09:00:00.000Z'))).toBe(at('2026-11-24T09:00:00.000Z'));
  expect(slotBefore(daily, at('2026-11-26T03:00:00.000Z'))).toBe(at('2026-11-25T09:00:00.000Z'));
  expect(slotAfter(daily, at('2026-11-24T09:00:00.000Z'))).toBe(at('2026-11-25T09:00:00.000Z'));
  // Weekdays skip the weekend: Friday's is the latest on Sunday, Monday's the next.
  const weekdays = one('weekday', 9 * 60, '2026-11-23T14:00:00.000Z');
  expect(slotBefore(weekdays, at('2026-11-29T12:00:00.000Z'))).toBe(at('2026-11-27T09:00:00.000Z'));
  expect(slotAfter(weekdays, at('2026-11-27T09:00:00.000Z'))).toBe(at('2026-11-30T09:00:00.000Z'));
  // Every week on its day.
  const weekly = one('week', 10 * 60 + 30, '2026-11-23T14:00:00.000Z', 3);
  expect(slotBefore(weekly, at('2026-11-30T00:00:00.000Z'))).toBe(at('2026-11-25T10:30:00.000Z'));
  expect(slotAfter(weekly, at('2026-11-25T10:30:00.000Z'))).toBe(at('2026-12-02T10:30:00.000Z'));
  // Every hour at a quarter past.
  const hourly = one('hour', 15, '2026-11-23T14:00:00.000Z');
  expect(slotBefore(hourly, at('2026-11-23T14:10:00.000Z'))).toBeNull();
  expect(slotBefore(hourly, at('2026-11-23T16:05:00.000Z'))).toBe(at('2026-11-23T15:15:00.000Z'));
  expect(slotAfter(hourly, at('2026-11-23T16:05:00.000Z'))).toBe(at('2026-11-23T16:15:00.000Z'));
});

function agent() {
  const dir = mkdtempSync(join(tmpdir(), 'teneral-schedule-'));
  const journal = join(dir, 'journal.jsonl');
  writeFileSync(journal, '');
  const ctx = { journal, gen: 'g1', workspace: dir, get past() { return journalPast(journal); } } as unknown as ToolContext;
  return { journal, ctx, past: () => journalPast(journal) };
}

test('the agent sets something to come round, is woken with its own words once for each time, and ends it', async () => {
  const a = agent();
  expect(await schedule.run({}, a.ctx)).toBe('You have nothing set to come round.');
  await expect(schedule.run({ what: 'short', every: 'day', at: '09:00' }, a.ctx)).rejects.toThrow('understood on its own');
  await expect(schedule.run({ what: 'Look over the open pull requests and tell my owner in Zulip which wait for them.', every: 'fortnight', at: '09:00' }, a.ctx)).rejects.toThrow('every must be one of');
  await expect(schedule.run({ what: 'Look over the open pull requests and tell my owner in Zulip which wait for them.', every: 'day', at: '9am' }, a.ctx)).rejects.toThrow('a time in UTC');
  const said = await schedule.run({ what: 'Look over the open pull requests and tell my owner in Zulip which wait for them.', every: 'hour', at: ':00' }, a.ctx);
  expect(said).toMatch(/^Set as S\w+: every hour at 00 past, first at /);
  expect(await schedule.run({ what: 'Look over the open pull requests and tell my owner in Zulip which wait for them.', every: 'hour', at: ':00' }, a.ctx)).toBe('You have that going already.');
  const [s] = schedulesOf(a.past());
  expect(s).toMatchObject({ every: 'hour', minute: 0 });
  const set = Date.parse(s!.set);
  // Before its first time: nothing, and the body knows when to look.
  expect(dueSchedule(a.journal, 'g1', set + 1000, a.past())).toBeNull();
  expect(scheduleDueAt(set + 1000, a.past())).toBe(slotAfter(s!, set + 1000));
  // Its time has come: given once, with the agent's own words and no more authority than it has.
  const first = slotAfter(s!, set);
  const woken = dueSchedule(a.journal, 'g1', first + 5000, a.past());
  expect(woken?.source).toBe('work');
  expect(woken?.text).toContain(`(${s!.mark}): Look over the open pull requests`);
  expect(woken?.text).toContain('it is not new authorization');
  expect(dueSchedule(a.journal, 'g1', first + 6000, a.past())).toBeNull();
  // Down for a day: the latest time that passed is given, once, not every one that was missed.
  expect(dueSchedule(a.journal, 'g1', first + 26 * 3_600_000, a.past())).not.toBeNull();
  expect(dueSchedule(a.journal, 'g1', first + 26 * 3_600_000 + 1000, a.past())).toBeNull();
  expect(readEvents(a.journal).filter((e) => e.type === 'note' && e.kind === SCHEDULE_RAN_KIND)).toHaveLength(2);
  expect(await schedule.run({}, a.ctx)).toContain(`${s!.mark}  every hour at 00 past, next `);
  // Ended: it does not come round again, and the body has nothing to look at the clock for.
  await expect(schedule.run({ end: 'Snothing' }, a.ctx)).rejects.toThrow('nothing you have going');
  expect(await schedule.run({ end: s!.mark }, a.ctx)).toContain('will not come round again');
  expect(schedulesOf(a.past())).toEqual([]);
  expect(dueSchedule(a.journal, 'g1', first + 60 * 3_600_000, a.past())).toBeNull();
  expect(scheduleDueAt(first, a.past())).toBeUndefined();
});

test('no more than a few are kept going at once', async () => {
  const a = agent();
  for (let i = 0; i < SCHEDULES_MAX; i++) await schedule.run({ what: `Check thing number ${i} and tell my owner what changed.`, every: 'day', at: '09:00' }, a.ctx);
  await expect(schedule.run({ what: 'One more thing to check every day and report on.', every: 'day', at: '10:00' }, a.ctx)).rejects.toThrow('which is the most');
});
