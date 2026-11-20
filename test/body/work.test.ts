import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, readEvents } from '../../brain/journal';
import { agenda, INTENTION_KIND, known, knownText } from '../../brain/known';
import { dueWork, heldByInterrupt, work, workDueAt } from '../../body/work';

/** The heart asks `dueWork` between turns (heart/coordinator.ts); here a timer stands in for it, held off while `busy`. */
const resumeWork = (journal: string, gen: string, busy: () => boolean, now: () => number, ms: number) => (emit: (s: { source: string; text: string }) => void): (() => void) => {
  const timer = setInterval(() => { if (busy()) return; const s = dueWork(journal, gen, now()); if (s !== null) emit(s); }, ms);
  return () => clearInterval(timer);
};
import type { ToolContext } from '../../body/tools';

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'work-journal-'));
  return { dir, journal: join(dir, 'journal.jsonl'), ctx: { journal: join(dir, 'journal.jsonl'), gen: 'g1' } as ToolContext };
};
const item = (journal: string, task: string) => known(readEvents(journal)).intentions.find((i) => i.text === task);

test('queued, waiting and done are journal notes; other commitments and checkpoints survive', async () => {
  const s = setup();
  try {
    await work.run({ status: 'queued', task: 'A', next: 'Inspect receipt', outcome: 'Verified A', recovery: 'receipt-A' }, s.ctx);
    await work.run({ status: 'queued', task: 'B', next: 'Inspect B' }, s.ctx);
    await work.run({ status: 'waiting', task: 'A', next: 'A real dependency' }, s.ctx);
    expect(item(s.journal, 'A')?.work).toMatchObject({ status: 'waiting', recovery: 'receipt-A', outcome: 'Verified A' });
    expect(agenda(known(readEvents(s.journal)), '2026-11-14').map((i) => i.text)).toEqual(['A', 'B']);
    expect(item(s.journal, 'B')?.work?.next).toBe('Inspect B');
    await work.run({ status: 'done', task: 'A', next: 'Dependency resolved and result verified', evidence: 'receipt-A' }, s.ctx);
    expect(item(s.journal, 'A')).toBeUndefined();
    expect(item(s.journal, 'B')?.work?.status).toBe('queued');
    expect(readEvents(s.journal).filter((e) => e.type === 'note' && e.kind === 'memory.intention.done.v1')).toHaveLength(1);
  } finally { rmSync(s.dir, { recursive: true }); }
});

test('scheduler resumes only ready work, preserves the bounded no-progress budget, then waits', async () => {
  const s = setup();
  let busy = true, now = Date.now() + 20000;
  const notices: string[] = [];
  try {
    await work.run({ status: 'queued', task: 'test', next: 'step' }, s.ctx);
    const stop = resumeWork(s.journal, 'g1', () => busy, () => now, 5)((stimulus) => notices.push(stimulus.text));
    try {
      await Bun.sleep(25);
      expect(notices).toHaveLength(0);
      busy = false;
      await Bun.sleep(25);
      expect(notices).toHaveLength(1);
      expect(item(s.journal, 'test')?.work?.attempts).toBe(1);
      now += 61000;
      await Bun.sleep(25);
      expect(item(s.journal, 'test')?.work?.attempts).toBe(2);
      now += 61000;
      await Bun.sleep(25);
      expect(item(s.journal, 'test')?.work?.attempts).toBe(3);
      now += 61000;
      await Bun.sleep(25);
      expect(item(s.journal, 'test')?.work?.status).toBe('waiting');
      expect(notices).toHaveLength(4);
      expect(notices.at(-1)).toContain('paused after three resumptions');
    } finally { stop(); }
  } finally { rmSync(s.dir, { recursive: true }); }
});

test('work cannot turn an unsure idea into an authorized commitment', async () => {
  const s = setup();
  try {
    appendEvent(s.journal, 'g1', { type: 'note', kind: INTENTION_KIND, data: { text: 'May I?', origin: 'own', unsure: true } });
    await expect(work.run({ status: 'queued', task: 'May I?', next: 'Do it anyway' }, s.ctx)).rejects.toThrow("owner's word");
    expect(item(s.journal, 'May I?')?.waits).toBe(true);
    expect(item(s.journal, 'May I?')?.work).toBeUndefined();
  } finally { rmSync(s.dir, { recursive: true }); }
});

test('checkpoints appear once in the coherent request agenda and never append a separate footer', async () => {
  const s = setup();
  try {
    await work.run({ status: 'queued', task: 'Test outcome', next: 'Inspect existing receipt', outcome: 'A verified result', recovery: '/tmp/receipt', evidence: 'Started' }, s.ctx);
    const text = knownText(known(readEvents(s.journal)), '2026-11-14', '[memory]')!;
    expect(text).toContain('queued; next: Inspect existing receipt');
    expect(text).toContain('outcome: A verified result');
    expect(text).toContain('recovery: /tmp/receipt');
    expect(text).toContain('evidence: Started');
    expect(text.match(/Test outcome/g)).toHaveLength(1);
    await work.run({ status: 'done', task: 'Test outcome', next: 'Verified' }, s.ctx);
    expect(knownText(known(readEvents(s.journal)), '2026-11-14', '[memory]')).toBeNull();
  } finally { rmSync(s.dir, { recursive: true }); }
});

test('malformed checkpoints are rejected without changing the journal', async () => {
  const s = setup();
  try {
    await work.run({ status: 'queued', task: 'Valid', next: 'Inspect', outcome: 'Established outcome' }, s.ctx);
    const before = readEvents(s.journal);
    for (const key of ['outcome', 'recovery', 'evidence']) {
      for (const value of [42, {}, 'x'.repeat(2001)]) {
        await expect(work.run({ status: 'queued', task: 'Valid', next: 'Inspect', [key]: value }, s.ctx)).rejects.toThrow();
        expect(readEvents(s.journal)).toEqual(before);
      }
    }
    await expect(work.run({ status: 'done', task: 'Valid', next: 'Finished', outcome: 'A different outcome' }, s.ctx)).rejects.toThrow('cannot be replaced');
    expect(readEvents(s.journal)).toEqual(before);
  } finally { rmSync(s.dir, { recursive: true }); }
});

test('an owner interrupt holds queued work until something arrives', () => {
  const t = (type: string) => ({ type });
  expect(heldByInterrupt([])).toBe(false);
  expect(heldByInterrupt([t('stimulus'), t('assistant')])).toBe(false);
  expect(heldByInterrupt([t('stimulus'), t('turn.interrupted')])).toBe(true);
  expect(heldByInterrupt([t('stimulus'), t('turn.interrupted'), t('note')])).toBe(true);
  expect(heldByInterrupt([t('turn.interrupted'), t('stimulus')])).toBe(false);
});

test('a commitment is named by its mark or its words; a mark that names nothing never becomes a commitment of its own', async () => {
  const s = setup();
  try {
    await work.run({ status: 'queued', task: 'Publish the signed offer', next: 'Run the check', outcome: 'A pull request is open' }, s.ctx);
    const mark = item(s.journal, 'Publish the signed offer')!.mark;
    expect(await work.run({ status: 'waiting', task: mark, next: "The owner's approval of the commit" }, s.ctx)).toContain('Nothing looks at it on a schedule');
    const held = known(readEvents(s.journal)).intentions;
    expect(held).toHaveLength(1);
    expect(held[0]!.work).toMatchObject({ status: 'waiting', next: "The owner's approval of the commit", outcome: 'A pull request is open' });
    expect(held[0]!.work!.checkAt).toBeUndefined();
    await expect(work.run({ status: 'waiting', task: 'I0000zzzz', next: 'Something' }, s.ctx)).rejects.toThrow(`no open commitment has the mark I0000zzzz. Open: ${mark}`);
    expect(known(readEvents(s.journal)).intentions).toHaveLength(1);

    // Only what nobody will announce gets a time to look again.
    const before = Date.now();
    expect(await work.run({ status: 'waiting', task: mark, next: 'The nightly build', check: 45 }, s.ctx)).toContain('offered it again in 45 minutes');
    const checkAt = item(s.journal, 'Publish the signed offer')!.work!.checkAt!;
    expect(checkAt).toBeGreaterThanOrEqual(before + 45 * 60_000);
    expect(checkAt).toBeLessThanOrEqual(Date.now() + 45 * 60_000);
    await expect(work.run({ status: 'waiting', task: mark, next: 'x', check: 0 }, s.ctx)).rejects.toThrow('check is minutes from now');
    // Ready again: the time to look is no part of a queued state.
    await work.run({ status: 'queued', task: mark, next: 'Publish it' }, s.ctx);
    expect(item(s.journal, 'Publish the signed offer')!.work!.checkAt).toBeUndefined();
    expect(known(readEvents(s.journal)).intentions[0]!.work!.at).toBeDefined();
  } finally { rmSync(s.dir, { recursive: true }); }
});

test('the time the agent set to look again wakes it when it comes, once, and then after a wait that doubles', async () => {
  const s = setup();
  let now = Date.now();
  const woken: string[] = [];
  try {
    await work.run({ status: 'waiting', task: 'Publish after the test run', next: 'The detached test run to finish.', check: 3 }, s.ctx);
    const mark = item(s.journal, 'Publish after the test run')!.mark;
    const stop = resumeWork(s.journal, 'g1', () => false, () => now, 5)((stimulus) => woken.push(stimulus.text));
    try {
      await Bun.sleep(25);
      // Not before its time.
      expect(woken).toEqual([]);
      now += 3 * 60_000 + 1000;
      await Bun.sleep(25);
      expect(woken).toHaveLength(1);
      expect(woken[0]).toStartWith(`The time you set to look again at ${mark} has come. It waits for: The detached test run to finish.`);
      expect(woken[0]).toEndWith('Task: Publish after the test run');
      // Looked at once: the next look is half an hour on, not at the next poll.
      const after = item(s.journal, 'Publish after the test run')!.work!;
      expect(after).toMatchObject({ status: 'waiting', attempts: 1 });
      expect(after.checkAt).toBe(now + 30 * 60_000);
      await Bun.sleep(25);
      expect(woken).toHaveLength(1);
      now += 30 * 60_000;
      await Bun.sleep(25);
      expect(woken).toHaveLength(2);
      expect(item(s.journal, 'Publish after the test run')!.work!.checkAt).toBe(now + 60 * 60_000);
    } finally { stop(); }
    // What waits for an arrival, with no time set, is never woken for by the clockwork.
    const quiet = setup();
    try {
      await work.run({ status: 'waiting', task: 'Publish once approved', next: "The owner's approval." }, quiet.ctx);
      const none: string[] = [];
      const halt = resumeWork(quiet.journal, 'g1', () => false, () => Date.now() + 10 * 24 * 3_600_000, 5)((stimulus) => none.push(stimulus.text));
      await Bun.sleep(25);
      halt();
      expect(none).toEqual([]);
    } finally { rmSync(quiet.dir, { recursive: true }); }
  } finally { rmSync(s.dir, { recursive: true }); }
});

test('the time of the next thing due is the earliest that the scheduler would take, and none when nothing waits for a time', async () => {
  const s = setup();
  try {
    expect(workDueAt(readEvents(s.journal))).toBeUndefined();
    await work.run({ status: 'waiting', task: 'no time', next: 'the owner answers' }, s.ctx);
    expect(workDueAt(readEvents(s.journal))).toBeUndefined();
    const before = Date.now();
    await work.run({ status: 'waiting', task: 'the suite', next: 'the tests end', check: 3 }, s.ctx);
    const at = workDueAt(readEvents(s.journal))!;
    expect(at).toBeGreaterThanOrEqual(before + 3 * 60_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 3 * 60_000);
    // Before its time nothing is told; at it, once.
    expect(dueWork(s.journal, 'g1', at - 1)).toBeNull();
    expect(dueWork(s.journal, 'g1', at)?.text).toContain('The time you set to look again');
    expect(dueWork(s.journal, 'g1', at)).toBeNull();
    await work.run({ status: 'queued', task: 'a step', next: 'take it' }, s.ctx);
    expect(workDueAt(readEvents(s.journal))!).toBeLessThan(at);
  } finally { rmSync(s.dir, { recursive: true }); }
});
