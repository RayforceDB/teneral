import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JournalEvent } from '../../brain/journal';
import { journalPast, projections, storePast, type Past } from '../../brain/past';
import { openStore } from '../../brain/store';
import { library, ray } from './rayforce';
import { USE_FULL, USE_WEIGHT, openedBy, useLift } from '../../brain/uses-table';

let n = 0;
const ev = (body: Record<string, unknown>): JournalEvent => ({ v: 1, id: `u${++n}`, ts: new Date(Date.parse('2026-05-01T00:00:00.000Z') + n * 60_000).toISOString(), gen: 'g1', ...body }) as JournalEvent;
/** Asked of the database: over the one runtime the tests share (test/brain/rayforce.ts). */
const served = (journal: string): Past => storePast(journal, ray(), openStore(ray(), journal, undefined, projections()), false);

test('the weight is small and has a ceiling', () => {
  expect(useLift(0)).toBe(1);
  expect(useLift(1)).toBeCloseTo(1 + USE_WEIGHT / USE_FULL);
  expect(useLift(50)).toBe(1 + USE_WEIGHT);
  expect(openedBy(ev({ type: 'tool.intent', callId: 'c', name: 'open', args: { event: ' u7 ' } }))).toBe('u7');
  expect(openedBy(ev({ type: 'tool.intent', callId: 'c', name: 'recall', args: { event: 'u7' } }))).toBeNull();
  expect(openedBy(ev({ type: 'tool.intent', callId: 'c', name: 'open', args: {} }))).toBeNull();
});

for (const [how, open] of [['read through', (journal: string) => journalPast(journal)], ['asked of the database', served]] as const) {
  test.skipIf(how === 'asked of the database' && library === null)(`of two events that say the same, the one the agent went back to is found first, ${how}; and it is still only a little`, () => {
    const first = ev({ type: 'stimulus', source: 'terminal', text: 'the deploy key lives in the vault under harbour' });
    const second = ev({ type: 'stimulus', source: 'terminal', text: 'the deploy key lives in the vault under harbour' });
    const other = ev({ type: 'stimulus', source: 'terminal', text: 'the deploy key lives in the vault under harbour, rotation every quarter' });
    const opens = [1, 2].map((k) => ev({ type: 'tool.intent', callId: `c${k}`, name: 'open', args: { event: first.id } }));
    const journal = join(mkdtempSync(join(tmpdir(), 'teneral-uses-')), 'journal.jsonl');
    const lines = (events: JournalEvent[]): string => events.map((e) => `${JSON.stringify(e)}\n`).join('');
    // With nothing opened, of two alike the later is first.
    writeFileSync(journal, lines([first, second]));
    const past = open(journal);
    expect(past.by).toBe(how === 'read through' ? 'journal' : 'store');
    expect(past.find('deploy key vault harbour').map((hit) => hit.event.id)).toEqual([second.id, first.id]);
    // Opened twice, the earlier one is.
    appendFileSync(journal, lines(opens));
    past.sync?.();
    const found = past.find('deploy key vault harbour');
    expect(found.map((hit) => hit.event.id)).toEqual([first.id, second.id]);
    // Alike in everything else, they differ by the weight and nothing more.
    expect(found[0]!.score / found[1]!.score).toBeCloseTo(useLift(2));
    // It does not carry an event past one that answers plainly better, however often it was opened.
    appendFileSync(journal, lines([other, ...opens.map((o) => ({ ...o, id: `${o.id}x` })), ...opens.map((o) => ({ ...o, id: `${o.id}y` }))]));
    past.sync?.();
    expect(past.find('deploy key vault harbour rotation')[0]!.event.id).toBe(other.id);
    past.close();
  });
}
