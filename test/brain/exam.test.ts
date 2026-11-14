import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXAM_KIND, TOP, byMemory, bySubstring, cloze, examine, questionsOf, report } from '../../brain/exam';
import type { EventBody, JournalEvent } from '../../brain/journal';
import { journalPast } from '../../brain/past';

let n = 0;
const ev = (body: EventBody): JournalEvent => ({ v: 1, id: `x${++n}`, ts: new Date(Date.UTC(2026, 10, 11, 8, n)).toISOString(), gen: 'g', ...body }) as JournalEvent;
const said = (text: string) => ev({ type: 'stimulus', source: 'terminal', text });
const replied = (text: string) => ev({ type: 'assistant', text, toolCalls: [] });
function journalOf(events: JournalEvent[]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'teneral-exam-')), 'journal.jsonl');
  writeFileSync(path, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  return path;
}

test('a question is passed when an answering event is among the first finds, and nearness says how high it stood', () => {
  const find = (question: string): string[] => (question === 'first' ? ['a', 'b'] : question === 'second' ? ['b', 'a'] : ['c']);
  const score = examine(find, [
    { question: 'first', events: ['a'] }, { question: 'second', events: ['a'] }, { question: 'none', events: ['a'] }, { question: 'either', events: ['z', 'c'] },
  ]);
  expect(score).toEqual({ questions: 4, passed: 3, nearness: (1 + 1 / 2 + 0 + 1) / 4 });
  expect(examine(find, [])).toEqual({ questions: 0, passed: 0, nearness: 0 });
});

test('a finder is asked for no more than the exam looks at', () => {
  const limits: number[] = [];
  examine((_, limit) => { limits.push(limit); return []; }, [{ question: 'q', events: ['a'] }]);
  expect(limits).toEqual([TOP]);
});

test('the plain finder counts the question\'s words as they stand, and knows no other form of a word', () => {
  const mail = said('Настрой почту для отчётов');
  const other = said('deploy the billing service');
  const find = bySubstring([mail, replied('ok'), other]);
  expect(find('billing deploy', 5)).toEqual([other.id]);
  expect(find('почту', 5)).toEqual([mail.id]);
  // "почта" is not in the text as it stands; recall finds it by the word's beginning, this does not.
  expect(find('почта', 5)).toEqual([]);
  expect(byMemory(journalPast(journalOf([mail, other])))('почта', 5)).toEqual([mail.id]);
});

test('questions are read from notes in the journal and from a file of lines, and what is not a question is passed over', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'teneral-exam-')), 'q.jsonl');
  writeFileSync(file, '{"question":"from the file","events":["e9"]}\nnot json\n{"question":"","events":["e1"]}\n{"question":"no events","events":[]}\n');
  const events = [
    ev({ type: 'note', kind: EXAM_KIND, data: { question: 'from a note', events: ['e1', 'e2'] } }),
    ev({ type: 'note', kind: EXAM_KIND, data: { question: 7, events: ['e1'] } }),
    ev({ type: 'note', kind: 'other.v1', data: { question: 'not an exam', events: ['e1'] } }),
  ];
  expect(questionsOf(events, file)).toEqual([{ question: 'from a note', events: ['e1', 'e2'] }, { question: 'from the file', events: ['e9'] }]);
  expect(questionsOf(events, '/no/such/file')).toHaveLength(1);
});

test('a journal nobody wrote questions for is asked about what its owner said, by the rarest words of each', () => {
  const common = Array.from({ length: 5 }, () => replied('the service is fine and the report is ready'));
  const asked = said('the billing service needs a quota increase before friday');
  const short = said('ok thanks');
  const questions = cloze([...common, asked, short]);
  expect(questions).toHaveLength(1);
  expect(questions[0]!.events).toEqual([asked.id]);
  // Words that are in every reply are not what the question is made of.
  expect(questions[0]!.question.split(' ')).toHaveLength(3);
  expect(questions[0]!.question).not.toContain('service');
  expect(cloze([said('one two three four five six seven'), said('eight nine ten eleven twelve thirteen')], 1)).toHaveLength(1);
});

test('on a life told in more than one form of its words, recall passes what the plain finder fails', () => {
  const events = [
    said('Адрес почты для еженедельных отчётов: reports@example.org'), replied('Записала адрес.'),
    said('Сервер биллинга переехал в новый кластер, старый выключим в пятницу'), replied('Поняла, переезд сервера учту.'),
  ];
  const questions = [{ question: 'почтой отчётам', events: [events[0]!.id] }, { question: 'кластере серверу биллингом', events: [events[2]!.id] }];
  const memory = examine(byMemory(journalPast(journalOf(events))), questions);
  const plain = examine(bySubstring(events), questions);
  expect(memory.passed).toBe(2);
  expect(plain.passed).toBe(0);
  const lines = report(memory, plain, 'journal', false);
  expect(lines[0]).toBe('2 questions. Passed: an answering event among the first 5 finds.');
  expect(lines[2]).toMatch(/^recall \(asked of the journal\) +2 of 2 +100% +1\.000$/);
  expect(lines[3]).toMatch(/^the words as they stand +0 of 2 +0% +0\.000$/);
});
