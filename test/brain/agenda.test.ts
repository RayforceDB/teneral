import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REFLECTION_KIND, REFLECT_EVERY, offered, parseLook, reflectionDue } from '../../brain/agenda';
import { GAP_MS } from '../../brain/episodes';
import { readEvents, type EventBody, type JournalEvent } from '../../brain/journal';
import { INTENTION_KIND, agenda, known, knownText } from '../../brain/known';
import type { ChatMessage, Provider, Reply } from '../../brain/provider';
import { EPISODE_KIND } from '../../brain/remembered';
import { sleep } from '../../brain/sleep';

let clock = Date.parse('2026-11-01T00:00:00.000Z');
let n = 0;
function ev(body: EventBody, afterMs = 1000): JournalEvent {
  clock += afterMs;
  n += 1;
  return { ...body, v: 1, id: `e${String(n).padStart(4, '0')}x`, ts: new Date(clock).toISOString(), gen: 'g1' } as JournalEvent;
}
const LONG = GAP_MS + 1000;
/** `count` episodes that are over, each with its memory, and one going on. */
function life(count: number): JournalEvent[] {
  const stretches = Array.from({ length: count }, (_, i) => [
    ev({ type: 'stimulus', source: 'terminal', text: `please look into the flaky deploy number ${i}, it failed again` }, LONG),
    ev({ type: 'assistant', text: `I restarted deploy ${i} by hand and it went through.`, toolCalls: [] }),
  ]);
  const now = [ev({ type: 'stimulus', source: 'terminal', text: 'thanks' }, LONG), ev({ type: 'assistant', text: 'Any time.', toolCalls: [] })];
  const memories = stretches.map((s) => ev({ type: 'note', kind: EPISODE_KIND, data: { from: s[0]!.id, to: s[1]!.id, start: s[0]!.ts, end: s[1]!.ts, title: 'A flaky deploy', text: 'The deploy failed again and I restarted it by hand.', outcome: 'done' } }, 0));
  return [...stretches.flat(), ...now, ...memories];
}
function setup(events: JournalEvent[], replies: Reply[]) {
  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-agenda-')), 'journal.jsonl');
  writeFileSync(journal, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  const seen: ChatMessage[][] = [];
  const provider: Provider = async (messages) => {
    seen.push(messages);
    const next = replies.shift();
    if (next === undefined) throw new Error('the script ran out of replies');
    return next;
  };
  return { journal, seen, deps: { journal, gen: 'g2', provider, specs: [], system: () => 'SYS' } };
}
const answer = (text: string): Reply => ({ text, toolCalls: [] });
const intention = (text: string, more: Record<string, unknown> = {}) => ev({ type: 'note', kind: INTENTION_KIND, data: { text, ...more } });

test('the agent looks ahead only once enough has been remembered since it last did', () => {
  expect(reflectionDue(life(REFLECT_EVERY - 1))).toBe(false);
  const events = life(REFLECT_EVERY);
  expect(reflectionDue(events)).toBe(true);
  expect(reflectionDue([...events, ev({ type: 'note', kind: REFLECTION_KIND, data: {} })])).toBe(false);
});

test('what it sets down when it looks ahead becomes intentions of its own, questions for its owner, and closes what is settled', async () => {
  const taken = intention('Send the owner the weekly deploy report');
  const events = [...life(REFLECT_EVERY), taken];
  const mark = known(events).intentions[0]!.mark;
  const s = setup(events, [answer(`Agenda:\n- [] Find why the deploy fails every time and fix the cause instead of restarting it\n- [2026-12-01] Check the certificate before it runs out\nAsk:\n- May I change the deploy script myself?\nDone:\n- ${mark} the report was sent on Friday`)]);
  expect(await sleep(s.deps)).toBe('reflected');
  expect(s.seen[0]!.at(-1)!.content).toContain('Think ahead, not back');
  const after = readEvents(s.journal);
  const held = known(after);
  expect(held.intentions.map((i) => [i.origin, i.due, i.text.slice(0, 20)])).toEqual([
    ['own', undefined, 'Find why the deploy '],
    ['own', '2026-12-01', 'Check the certificat'],
    ['ask', undefined, 'May I change the dep'],
  ]);
  expect(after.at(-1)).toMatchObject({ kind: REFLECTION_KIND, data: { own: 2, asks: 1, closed: 1 } });
  // It looked: it is not asked again until more is remembered.
  expect(await sleep(s.deps)).toBe('nothing');
  expect(s.seen).toHaveLength(1);
});

test('"Nothing" is an answer, and one that is not in form is asked for once more and then let be', async () => {
  const nothing = setup(life(REFLECT_EVERY), [answer('Nothing')]);
  expect(await sleep(nothing.deps)).toBe('reflected');
  expect(known(readEvents(nothing.journal)).intentions).toEqual([]);

  const rambling = setup(life(REFLECT_EVERY), [answer('I think things are going well overall.'), answer('Still fine, really.')]);
  expect(await sleep(rambling.deps)).toBe('reflected');
  expect(rambling.seen).toHaveLength(2);
  expect(readEvents(rambling.journal).at(-1)).toMatchObject({ kind: REFLECTION_KIND, data: { failed: true } });
  expect(await sleep(rambling.deps)).toBe('nothing');
});

test('a look sets down few things, and no more of its own while many are open', async () => {
  expect(parseLook('Agenda:\n- [] one thing to be done\n- [] another thing to do\n- [] a third thing to do\n- [] a fourth thing to do')).toMatchObject({ own: { length: 3 } });
  expect(parseLook('no lists here')).toHaveProperty('problem');
  const many = Array.from({ length: 7 }, (_, i) => intention(`An idea of my own, number ${i}`, { origin: 'own' }));
  const s = setup([...life(REFLECT_EVERY), ...many], [answer('Agenda:\n- [] Yet another idea of my own to do')]);
  expect(await sleep(s.deps)).toBe('reflected');
  expect(s.seen[0]!.at(-1)!.content).toContain('set down no more');
  expect(known(readEvents(s.journal)).intentions).toHaveLength(7);
});

test('the agenda is taken in order: what is due, what was taken on, the agent\'s own; questions wait for the owner', () => {
  const events = [
    intention('My own idea to tidy the logs', { origin: 'own' }),
    intention('Send the report to the owner'),
    intention('Ask whether the old server may go', { origin: 'ask' }),
    intention('Renew the certificate', { due: '2026-11-03', origin: 'own' }),
    intention('Call the bank back', { due: '2027-01-01' }),
  ];
  const held = known(events);
  expect(agenda(held, '2026-11-10').map((i) => i.text)).toEqual(['Renew the certificate', 'Send the report to the owner', 'Call the bank back', 'My own idea to tidy the logs']);
  const tick = offered(held, '2026-11-10');
  expect(tick).toContain('[due 2026-11-03, which has come] Renew the certificate');
  expect(tick).toContain('[your own idea] My own idea to tidy the logs');
  expect(tick).not.toContain('old server');
  expect(tick).toContain('one thing in a tick');
  expect(offered(known([]), '2026-11-10')).toContain('Nothing is on your agenda');
  const shown = knownText(held, '2026-11-10', '[memory]')!;
  expect(shown).toContain('[your own idea] My own idea to tidy the logs');
  expect(shown).toContain('What you mean to ask your owner when they next write');
});
