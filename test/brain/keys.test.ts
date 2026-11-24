import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXAM_KIND, questionsOf, sit } from '../../brain/exam';
import type { JournalEvent } from '../../brain/journal';
import { openPast } from '../../brain/past';
import { HELD_EVERY, documentOf, heldOut } from '../../brain/recall';

let n = 0;
const ev = (body: Record<string, unknown>, id?: string): JournalEvent => ({ v: 1, id: id ?? `k${++n}`, ts: new Date(Date.parse('2026-03-01T00:00:00.000Z') + ++n * 1000).toISOString(), gen: 'g1', ...body }) as JournalEvent;
/** Ids of notes, the first of them indexed and the second held out. */
const ids = Array.from({ length: 400 }, (_, i) => `q${i}`);
const indexed = ids.filter((id) => !heldOut(id));
const held = ids.filter((id) => heldOut(id));

function life(events: JournalEvent[]) {
  const dir = mkdtempSync(join(tmpdir(), 'teneral-keys-'));
  const journal = join(dir, 'journal.jsonl');
  writeFileSync(journal, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  // With the database when the tests are given one, and by reading the journal through when not: both must agree.
  return openPast(journal, process.env.TENERAL_TEST_RAYFORCE ?? null);
}

test('one question in a few is held out, by its id alone and for good', () => {
  expect(held.length).toBeGreaterThan(400 / HELD_EVERY / 2);
  expect(held.length).toBeLessThan((400 / HELD_EVERY) * 2);
  expect(ids.filter((id) => heldOut(id))).toEqual(held);
});

test('a question written of what happened is a key: it leads to the event it names, by words the event does not have, and is never itself found', () => {
  const noise = Array.from({ length: 30 }, (_, i) => ev({ type: 'stimulus', source: 'terminal', text: `the weather report number ${i} says rain and wind over the harbour` }));
  const answer = ev({ type: 'assistant', text: 'Use port 8443 behind the proxy, never 443.', toolCalls: [] });
  const key = ev({ type: 'note', kind: EXAM_KIND, data: { question: 'which listener does the gateway bind to', events: [answer.id], episode: 'k1' } }, indexed[0]);
  const heldKey = ev({ type: 'note', kind: EXAM_KIND, data: { question: 'what number should the firewall rule carry', events: [answer.id], episode: 'k1' } }, held[0]);
  const past = life([...noise, answer, key, heldKey]);
  // By the key's words, none of which the answer has.
  const found = past.find('gateway listener bind');
  expect(found[0]?.event.id).toBe(answer.id);
  expect(found.some((hit) => hit.event.type === 'note')).toBe(false);
  // The held-out question leads nowhere: it was never indexed.
  expect(documentOf(heldKey)).toBeNull();
  expect(past.find('firewall rule carry').map((hit) => hit.event.id)).not.toContain(answer.id);
  // Asked for memories alone, a key adds nothing that is not a memory.
  expect(past.find('gateway listener bind', { kinds: ['memory'] })).toEqual([]);
  past.close();
});

test('the exam scores the held-out questions apart', () => {
  const answers = Array.from({ length: 40 }, (_, i) => ev({ type: 'assistant', text: `Answer ${i}: the value is v${i}x and nothing else.`, toolCalls: [] }));
  const notes = answers.map((a, i) => ev({ type: 'note', kind: EXAM_KIND, data: { question: `what did topic alpha${i} come to`, events: [a.id], episode: 'k1' } }, i % 2 === 0 ? indexed[i] : held[i]));
  const events = [...answers, ...notes];
  expect(questionsOf(events).filter((q) => q.held === true)).toHaveLength(20);
  const past = life(events);
  const result = sit(past, events);
  // Every key leads to its answer; a held-out question, whose words the answer does not have, finds nothing.
  expect(result.recall.passed).toBe(20);
  expect(result.held).toEqual({ questions: 20, passed: 0, nearness: 0 });
  past.close();
});
