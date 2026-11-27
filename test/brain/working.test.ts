import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reflectQuestion } from '../../brain/agenda';
import type { JournalEvent } from '../../brain/journal';
import { known } from '../../brain/known';
import type { Lesson } from '../../brain/lessons';
import { journalPast, projections, storePast, type Past } from '../../brain/past';
import { openStore } from '../../brain/store';
import { WORKING_DAYS, workingText } from '../../brain/working';
import { library, ray } from './rayforce';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-27T12:00:00.000Z');
let n = 0;
const call = (name: string, daysAgo: number): JournalEvent => ({ v: 1, id: `w${++n}`, ts: new Date(NOW - daysAgo * DAY + n).toISOString(), gen: 'g1', type: 'tool.intent', callId: `c${n}`, name, args: {} }) as JournalEvent;

function life(): string {
  const events = [
    // Before the days looked back over: not counted.
    call('lesson', 40), call('bash', 40),
    call('bash', 20), call('read', 20), call('bash', 3), call('recall', 1), call('bash', 0),
    { v: 1, id: 'said', ts: new Date(NOW).toISOString(), gen: 'g1', type: 'stimulus', source: 'terminal', text: 'bash is not a call' } as JournalEvent,
  ].sort((a, b) => a.ts.localeCompare(b.ts));
  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-working-')), 'journal.jsonl');
  writeFileSync(journal, events.map((one) => `${JSON.stringify(one)}\n`).join(''));
  return journal;
}

const served = (journal: string): Past => storePast(journal, ray(), openStore(ray(), journal, undefined, projections()), false);

for (const [how, open] of [['read through', (journal: string) => journalPast(journal)], ['asked of the database', served]] as const) {
  test.skipIf(how === 'asked of the database' && library === null)(`how often each tool was called in the days looked back over is counted, ${how}`, { timeout: 20_000 }, () => {
    const past = open(life());
    const counted = past.called(NOW - WORKING_DAYS * DAY).sort((a, b) => a.name.localeCompare(b.name));
    expect(counted).toEqual([{ name: 'bash', n: 3 }, { name: 'read', n: 1 }, { name: 'recall', n: 1 }]);
    expect(past.called(NOW - 2 * DAY).map((c) => `${c.name} ${c.n}`).sort()).toEqual(['bash 1', 'recall 1']);
    expect(past.called(NOW + 2 * DAY)).toEqual([]);
    past.close();
  });
}

test('the agent is told which of its tools it never calls and what has come of its lessons, and nothing while there is too little to count', () => {
  const tools = ['bash', 'read', 'recall', 'lesson', 'script'];
  const lesson = (accepted: boolean): Lesson => ({ accepted: accepted ? {} : undefined }) as unknown as Lesson;
  // A few calls say nothing of any one tool; the lessons are said all the same.
  expect(workingText({ calls: [{ name: 'bash', n: 12 }], tools, lessons: [] })).toBe('you hold no lesson');
  const busy = [{ name: 'bash', n: 300 }, { name: 'read', n: 40 }, { name: 'recall', n: 9 }, { name: 'gone-tool', n: 4 }];
  expect(workingText({ calls: busy, tools, lessons: [] })).toBe('in the last 30 days you called your tools 353 times and never called `lesson`, `script`; you hold no lesson');
  expect(workingText({ calls: [...busy, { name: 'lesson', n: 2 }, { name: 'script', n: 1 }], tools, lessons: [lesson(true), lesson(false), lesson(false)] })).toBe('of your lessons 1 is kept and 2 wait to be');
  // An agent that has no tool for lessons is told nothing of them.
  expect(workingText({ calls: [{ name: 'bash', n: 300 }], tools: ['bash'], lessons: [] })).toBe('');
  const many = Array.from({ length: 15 }, (_, i) => `tool-${String(i).padStart(2, '0')}`);
  expect(workingText({ calls: [{ name: 'bash', n: 300 }], tools: ['bash', ...many], lessons: [] })).toContain('`tool-11` and 3 more');

  // The look ahead is asked with it, and without it is asked as it was.
  const held = known([]);
  expect(reflectQuestion(held, '', NOW)).not.toContain('How you work');
  const asked = reflectQuestion(held, '', NOW, 'you hold no lesson');
  expect(asked).toContain('How you work, counted: you hold no lesson.');
  expect(asked).toContain('mending it is work of your own');
});
