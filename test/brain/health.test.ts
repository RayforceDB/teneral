import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GAP_MS } from '../../brain/episodes';
import { EXAM_EVERY, EXAM_KIND, RESULT_KIND, due, lastResult, sit, type Result } from '../../brain/exam';
import { health, healthBadge, healthNote } from '../../brain/health';
import type { EventBody, JournalEvent } from '../../brain/journal';
import { INTENTION_KIND } from '../../brain/known';
import { buildMessages } from '../../brain/memory';
import { journalPast } from '../../brain/past';
import { EPISODE_KIND, MERGE_KIND, QUARANTINE_KIND } from '../../brain/remembered';

let n = 0;
let clock = 0;
const ev = (body: EventBody, afterMs = 60_000): JournalEvent => {
  clock += afterMs;
  return { v: 1, id: `h${++n}`, ts: new Date(clock).toISOString(), gen: 'g1', ...body } as JournalEvent;
};
const LONG = GAP_MS + 1000;
const HOUR = 3_600_000;
/** `count` episodes that are over, each said by the owner and answered, and one going on. */
function life(count: number) {
  clock = Date.parse('2026-11-01T00:00:00.000Z');
  const stretches = Array.from({ length: count }, (_, i) => [
    ev({ type: 'stimulus', source: 'terminal', text: `the passphrase for vault${i} is tangerine${i} please keep it` }, LONG),
    ev({ type: 'assistant', text: `noted the passphrase for vault${i}`, toolCalls: [] }),
  ]);
  const now = ev({ type: 'stimulus', source: 'terminal', text: 'and now?' }, LONG);
  return { stretches, now, end: clock };
}
const memory = (s: JournalEvent[], text = 'My owner gave me a passphrase and I noted it.') =>
  ev({ type: 'note', kind: EPISODE_KIND, data: { from: s[0]!.id, to: s[1]!.id, start: s[0]!.ts, end: s[1]!.ts, title: 'A passphrase', text, outcome: 'done' } }, 0);
const quarantine = (s: JournalEvent[]) => ev({ type: 'note', kind: QUARANTINE_KIND, data: { from: s[0]!.id, to: s[1]!.id, start: s[0]!.ts, end: s[1]!.ts, reason: 'not in form' } }, 0);
const score = (passed: number, questions = 30) => ({ questions, passed, nearness: 1 });
const result = (r: Partial<Result>) => ev({ type: 'note', kind: RESULT_KIND, data: { recall: score(30), plain: score(27), told: score(25), written: true, ...r } }, 0);

test('a memory that keeps up is well, and says nothing of itself in a request', () => {
  const { stretches, now, end } = life(4);
  const events = [...stretches.flat(), now, ...stretches.map((s) => memory(s))];
  const h = health(events, end);
  expect(h).toMatchObject({ state: 'well', reasons: [], remembered: 4, waiting: 0, oldest: null, quarantined: 0, overdue: 0, exam: null });
  expect(healthNote(h, '[memory]')).toBeNull();
  expect(healthBadge(h)).toBe('memory well');
  expect(buildMessages(events, 'S').map((m) => m.content).join('\n')).not.toContain('Your memory is');
});

test('episodes that pile up unremembered make it behind, and many for long make it failing', () => {
  const few = life(4);
  expect(health([...few.stretches.flat(), few.now], few.end + 7 * HOUR)).toMatchObject({ state: 'behind', waiting: 4, reasons: ['4 episodes wait to be remembered, the oldest for 9 hours'] });
  // The same four, so soon after, are only what has not been got to yet.
  expect(health([...few.stretches.flat(), few.now], few.end).state).toBe('well');
  const many = life(12);
  const h = health([...many.stretches.flat(), many.now], many.end + 60 * HOUR);
  expect(h).toMatchObject({ state: 'failing', reasons: ['12 episodes wait to be remembered, the oldest for 2 days'] });
  expect(healthBadge(h)).toBe('memory failing');
});

test('stretches of which no memory could be formed, and wider memories that are only lists, are a memory failing', () => {
  const { stretches, now, end } = life(6);
  const given = [...stretches.flat(), now, ...stretches.slice(0, 3).map(quarantine), ...stretches.slice(3).map((s) => memory(s))];
  expect(health(given, end)).toMatchObject({ state: 'failing', quarantined: 3, reasons: ['of 3 stretches in 6 no memory could be formed'] });
  const listed = (s: JournalEvent[][], mechanical: boolean) => ev({
    type: 'note', kind: MERGE_KIND,
    data: { from: s[0]![0]!.id, to: s.at(-1)![1]!.id, start: s[0]![0]!.ts, end: s.at(-1)![1]!.ts, title: 'Several', text: '- a\n- b', outcome: 'done', level: 2, ...(mechanical ? { mechanical: true } : {}) },
  }, 0);
  const merged = [...stretches.flat(), now, ...stretches.map((s) => memory(s)), listed(stretches.slice(0, 2), true), listed(stretches.slice(2, 4), true), listed(stretches.slice(4), false)];
  expect(health(merged, end).reasons).toEqual(['2 of 3 wider memories are only lists of titles']);
});

test('something meant to be done that is past its day makes the memory behind', () => {
  const { stretches, now, end } = life(1);
  const events = [...stretches.flat(), now, memory(stretches[0]!), ev({ type: 'note', kind: INTENTION_KIND, data: { text: 'Send the weekly report', due: '2026-10-30' } }, 0), ev({ type: 'note', kind: INTENTION_KIND, data: { text: 'Renew the token', due: '2027-01-01' } }, 0)];
  expect(health(events, end)).toMatchObject({ state: 'behind', overdue: 1, reasons: ['1 thing meant to be done is past the day'] });
});

test('the last exam counts: a recall that finds less than the words as they stand is failing, memories that tell little are behind', () => {
  const { stretches, now, end } = life(1);
  const base = [...stretches.flat(), now, memory(stretches[0]!)];
  const good = health([...base, result({})], end);
  expect(good.state).toBe('well');
  expect(healthBadge(good)).toBe('memory well · event 100% · episode 83%');
  expect(healthBadge(health([...base, result({ recall: score(22), told: score(20), written: false })], end))).toMatch(/· event 73%$/);
  expect(health([...base, result({ recall: score(20), plain: score(27) })], end)).toMatchObject({ state: 'failing', reasons: ['recall finds less than looking for the words as they stand'] });
  expect(health([...base, result({ told: score(9) })], end)).toMatchObject({ state: 'behind', reasons: ['the memories tell 30% of what the exam asks'] });
  // Questions made from the journal for want of the agent's own say nothing of the memories.
  expect(health([...base, result({ told: score(0, 0), written: false })], end).state).toBe('well');
});

test('while anything is wrong, the agent is told so in every request, after what it knows', () => {
  const { stretches, now, end } = life(4);
  const late = { ...now, ts: new Date(end + 7 * HOUR).toISOString() };
  const shown = buildMessages([...stretches.flat(), late], 'S').map((m) => m.content);
  expect(shown[1]).toBe('[memory] Your memory is behind: 4 episodes wait to be remembered, the oldest for 9 hours.');
});

test('the exam is due once something is remembered, and again after enough more', () => {
  const { stretches, now } = life(EXAM_EVERY + 2);
  const memories = stretches.map((s) => memory(s));
  expect(due([...stretches.flat(), now])).toBe(false);
  expect(due([...stretches.flat(), now, memories[0]!])).toBe(true);
  const sat = [...stretches.flat(), now, memories[0]!, result({})];
  expect(due(sat)).toBe(false);
  expect(due([...sat, ...memories.slice(1, EXAM_EVERY)])).toBe(false);
  expect(due([...sat, ...memories.slice(1, EXAM_EVERY + 1)])).toBe(true);
});

test('sitting the exam scores recall, the plain search and the memories themselves, on the agent\'s own questions once there are enough', () => {
  const { stretches, now } = life(24);
  // Half the memories kept what mattered, the passphrase; the other half are too vague to tell it.
  const memories = stretches.map((s, i) => memory(s, i % 2 === 0 ? `My owner told me the passphrase for vault${i}: tangerine${i}.` : 'We talked for a while about several things.'));
  const questions = stretches.map((s, i) => ev({ type: 'note', kind: EXAM_KIND, data: { question: `Which passphrases opens vault${i}?`, events: [s[0]!.id] } }, 0));
  const events = [...stretches.flat(), now, ...memories, ...questions];
  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-health-')), 'journal.jsonl');
  writeFileSync(journal, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  const r = sit(journalPast(journal), events);
  expect(r.written).toBe(true);
  expect(r.recall).toMatchObject({ questions: 24, passed: 24 });
  expect(r.told).toMatchObject({ questions: 24, passed: 12 });
  // The plain search is asked the same questions; "vault1" is in the text of vault1 and of vault10 to vault19 alike, and it has no way to tell them apart.
  expect(r.plain.questions).toBe(24);
  expect(r.plain.passed).toBeLessThan(24);
  expect(lastResult([...events, ev({ type: 'note', kind: RESULT_KIND, data: r }, 0)])).toMatchObject({ recall: { passed: 24 }, told: { passed: 12 }, written: true });
  expect(lastResult(events)).toBeNull();
  // With too few questions of its own, the journal is asked about what its owner said, and nothing is claimed of the memories.
  const few = sit(journalPast(journal), events.filter((e) => !questions.slice(3).includes(e)));
  expect(few.written).toBe(false);
  expect(few.recall.questions).toBeGreaterThan(20);
  expect(few.told.questions).toBe(3);
});
