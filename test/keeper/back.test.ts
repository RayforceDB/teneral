import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  OWNER_REASON, chooseTarget, formatList, generations, goBack,
} from '../../keeper/back';
import { git } from '../../immune/gates';
import { appendEvent, readEvents, type EventBody, type JournalEvent } from '../../brain/journal';
import { init, paths, supervise } from '../../stem/supervisor';
import { commitAll, makeRepo, writeFiles } from '../helpers';

// --- synthetic journals ---

/** A commit id made of one repeated two-character pair, so each has a prefix of its own. */
const sha = (pair: string) => pair.repeat(20);
const S = sha('5e');
const A = sha('a1');
const B = sha('b2');
const C = sha('c3');
const D = sha('d4');

let tick = 0;
function ev(gen: string, body: EventBody): JournalEvent {
  tick += 1;
  return { ...body, v: 1, id: `e${tick}`, ts: new Date(Date.UTC(2026, 0, 1, 0, tick)).toISOString(), gen } as JournalEvent;
}
const started = (c: string) => ev(c, { type: 'generation.started', commit: c });
const ready = (c: string) => ev(c, { type: 'generation.ready', commit: c });
const reply = (c: string) => ev(c, { type: 'assistant', text: 'hi', toolCalls: [] });
const promoted = (c: string, previous: string) => ev(c, { type: 'generation.promoted', commit: c, previous });
const rolledback = (c: string, to: string) => ev(to, { type: 'generation.rolledback', commit: c, to, reason: 'crashed' });
/** A generation's ordinary life: started, ready, one reply. */
const lived = (c: string) => [started(c), ready(c), reply(c)];
/** `c` promoted over `previous`, then its ordinary life. */
const mutated = (c: string, previous: string) => [promoted(c, previous), ...lived(c)];

const everything = () => true;
const before = (events: JournalEvent[], current: string, exists: (c: string) => boolean = everything) => chooseTarget(events, current, null, exists);

test('with only the first generation there is nothing to go back to', () => {
  expect(before([], S).ok).toBe(false);
  const only = before(lived(S), S);
  expect(only.ok).toBe(false);
  expect(only.ok ? '' : only.why).toContain('first');
});

test('the one before is the generation the current one was first promoted over', () => {
  expect(before([...lived(S), ...mutated(A, S)], A)).toEqual({ ok: true, target: S });
  expect(before([...lived(S), ...mutated(A, S), ...mutated(B, A), ...mutated(C, B)], C)).toEqual({ ok: true, target: B });
});

test('straight after an automatic rollback, back goes further back, not forward to what was just rolled back', () => {
  // S, then A, then B which failed and was rolled back to A.
  const events = [...lived(S), ...mutated(A, S), ...mutated(B, A), rolledback(B, A), started(A), ready(A)];
  expect(before(events, A)).toEqual({ ok: true, target: S });
  // And when the rollback landed on the first generation, there is nothing before it.
  expect(before([...lived(S), ...mutated(A, S), rolledback(A, S), started(S), ready(S)], S).ok).toBe(false);
});

test('after going back by hand, back again goes one further, and a mutation from there has that generation before it', () => {
  const toA = [...lived(S), ...mutated(A, S), ...mutated(B, A), ...mutated(C, B), rolledback(C, A), started(A), ready(A)];
  expect(before(toA, A)).toEqual({ ok: true, target: S });
  const thenD = [...toA, ...mutated(D, A)];
  expect(before(thenD, D)).toEqual({ ok: true, target: A });
});

test('a generation that never became ready, or that git no longer has, is passed over', () => {
  // A was promoted, never became ready and was rolled back; then B was promoted over S.
  const events = [...lived(S), promoted(A, S), started(A), rolledback(A, S), started(S), ready(S), ...mutated(B, S), ...mutated(C, B)];
  expect(before(events, C)).toEqual({ ok: true, target: B });
  expect(before(events, C, (c) => c !== B)).toEqual({ ok: true, target: S });
  const none = before(events, C, () => false);
  expect(none.ok).toBe(false);
});

test('a named generation is found by its full id or a prefix of seven or more', () => {
  const events = [...lived(S), ...mutated(A, S), ...mutated(B, A)];
  expect(chooseTarget(events, B, S, everything)).toEqual({ ok: true, target: S });
  expect(chooseTarget(events, B, S.slice(0, 7), everything)).toEqual({ ok: true, target: S });
  expect(chooseTarget(events, B, A.slice(0, 12), everything)).toEqual({ ok: true, target: A });
});

test('a named generation is refused when it cannot be the one meant, each time saying why', () => {
  const twin = `${A.slice(0, 10)}${'0'.repeat(30)}`;
  const events = [...lived(S), ...mutated(A, S), promoted(C, A), started(C), rolledback(C, A), started(A), ready(A), ...mutated(twin, A), ...mutated(B, twin)];
  const why = (wanted: string, exists: (c: string) => boolean = everything) => {
    const choice = chooseTarget(events, B, wanted, exists);
    return choice.ok ? `chose ${choice.target}` : choice.why;
  };
  expect(why(sha('ff'))).toContain('no generation');
  expect(why(A.slice(0, 6))).toContain('at least 7');
  expect(why('not-a-commit')).toContain('at least 7');
  expect(why(A.slice(0, 8))).toContain('more than one');
  expect(why(B)).toContain('already');
  expect(why(B.slice(0, 7))).toContain('already');
  expect(why(C)).toContain('never became ready');
  expect(why(S, (c) => c !== S)).toContain('git');
});

test('the list shows every generation lived in, oldest first, with when it became ready, its replies, and which is current', () => {
  const events = [...lived(S), reply(S), ...mutated(A, S), promoted(C, A), started(C), rolledback(C, A), started(A), reply(A), reply(A)];
  const rows = generations(events, A);
  expect(rows.map((r) => r.commit)).toEqual([S, A, C]);
  expect(rows.map((r) => r.replies)).toEqual([2, 3, 0]);
  expect(rows.map((r) => r.current)).toEqual([false, true, false]);
  expect(rows[0]!.readyAt).toBe(events[1]!.ts);
  expect(rows[2]!.readyAt).toBeNull();

  const lines = formatList(rows).split('\n');
  expect(lines).toHaveLength(3);
  expect(lines[0]).toContain(S.slice(0, 12));
  expect(lines[0]).toContain(events[1]!.ts);
  expect(lines[0]).toContain('2 replies');
  expect(lines[1]).toContain('current');
  expect(lines[0]).not.toContain('current');
  expect(lines[2]).toContain('never became ready');
  // A generation the journal has not heard of yet, such as before the very first start, is still listed.
  expect(generations([], S).map((r) => [r.commit, r.current])).toEqual([[S, true]]);
});

// --- the change itself, on a real install ---

/** An install that has lived in three generations, each ready and with a reply, and is on the last. */
function install() {
  const { dir, seed } = makeRepo({ 'body/main.ts': 'process.exit(0);\n' });
  init(dir);
  const p = paths(dir);
  writeFiles(p.candidate, { 'body/main.ts': 'process.exit(0);\n// second\n' });
  const second = commitAll(p.candidate, 'second');
  writeFiles(p.candidate, { 'body/main.ts': 'process.exit(0);\n// third\n' });
  const third = commitAll(p.candidate, 'third');
  const live = (c: string) => {
    appendEvent(p.journal, c, { type: 'generation.started', commit: c });
    appendEvent(p.journal, c, { type: 'generation.ready', commit: c });
    appendEvent(p.journal, c, { type: 'assistant', text: 'hi', toolCalls: [] });
  };
  live(seed);
  appendEvent(p.journal, second, { type: 'generation.promoted', commit: second, previous: seed });
  live(second);
  appendEvent(p.journal, third, { type: 'generation.promoted', commit: third, previous: second });
  live(third);
  writeFileSync(p.state, JSON.stringify({ current: third, previous: second }));
  return { dir, p, seed, second, third };
}
const stateOf = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as unknown;
const rollbacks = (journal: string) => readEvents(journal).flatMap((e) => (e.type === 'generation.rolledback' ? [e] : []));
const QUIET = { gates: () => ({ ok: true, gate: 'all', output: '' }), restartDelayMs: 0, log: () => {} };

test('going back writes the state, then the note, and leaves the workspace alone', () => {
  const { dir, p, second, third } = install();
  const result = goBack(dir, null);
  expect(result.ok).toBe(true);
  expect(result.message).toContain(third.slice(0, 12));
  expect(result.message).toContain(second.slice(0, 12));
  expect(result.message).toContain('still holds the later code');

  expect(stateOf(p.state)).toEqual({ current: second, previous: null });
  const last = readEvents(p.journal).at(-1)!;
  // Attributed as the supervisor attributes its own rollbacks: to the generation gone back to.
  expect(last).toMatchObject({ type: 'generation.rolledback', commit: third, to: second, reason: OWNER_REASON, gen: second });
  expect(OWNER_REASON).not.toContain('\n');
  expect(git(p.candidate, 'rev-parse', 'HEAD')).toBe(third);
  expect(git(p.candidate, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('lineage/local');
  expect(git(dir, 'rev-parse', 'lineage/local')).toBe(third);
  expect(existsSync(p.lock)).toBe(false);
});

test('the supervisor starts the generation gone back to and adds no second note', async () => {
  const { dir, p, seed, third } = install();
  expect(goBack(dir, seed.slice(0, 8)).ok).toBe(true);
  expect(stateOf(p.state)).toEqual({ current: seed, previous: null });

  expect(await supervise({ root: dir, ...QUIET })).toBe('stopped');
  expect(await supervise({ root: dir, ...QUIET })).toBe('stopped');
  const events = readEvents(p.journal);
  expect(rollbacks(p.journal)).toHaveLength(1);
  expect(rollbacks(p.journal)[0]).toMatchObject({ commit: third, to: seed, reason: OWNER_REASON });
  expect(events.filter((e) => e.type === 'generation.promoted')).toHaveLength(2);
  expect(events.filter((e) => e.type === 'generation.started').at(-1)).toMatchObject({ commit: seed, gen: seed });
  expect(git(p.live, 'rev-parse', 'HEAD')).toBe(seed);
  expect(stateOf(p.state)).toEqual({ current: seed, previous: null });
});

test('if only the state was written before a kill, the supervisor writes the one missing note, and it agrees with the state', async () => {
  const { dir, p, second, third } = install();
  // goBack's first step, and nothing after it.
  writeFileSync(p.state, JSON.stringify({ current: second, previous: null }));

  expect(await supervise({ root: dir, ...QUIET })).toBe('stopped');
  expect(await supervise({ root: dir, ...QUIET })).toBe('stopped');
  expect(rollbacks(p.journal)).toHaveLength(1);
  expect(rollbacks(p.journal)[0]).toMatchObject({ commit: third, to: second, gen: second });
  expect(readEvents(p.journal).filter((e) => e.type === 'generation.promoted')).toHaveLength(2);
  expect(git(p.live, 'rev-parse', 'HEAD')).toBe(second);
});

test('a refusal says why and changes nothing', () => {
  const { dir, p, seed, second, third } = install();
  const untouched = { state: readFileSync(p.state, 'utf8'), journal: readFileSync(p.journal, 'utf8') };
  const refused = (wanted: string | null) => {
    const result = goBack(dir, wanted);
    expect(result.ok).toBe(false);
    expect(readFileSync(p.state, 'utf8')).toBe(untouched.state);
    expect(readFileSync(p.journal, 'utf8')).toBe(untouched.journal);
    expect(existsSync(p.lock)).toBe(false);
    return result.message;
  };
  expect(refused('f'.repeat(40))).toContain('no generation');
  expect(refused(third)).toContain('already');
  expect(refused(seed.slice(0, 5))).toContain('at least 7');
  // A commit git has, which the journal saw promoted and rolled back without ever becoming ready.
  writeFiles(p.candidate, { 'body/main.ts': 'process.exit(1);\n' });
  const failed = commitAll(p.candidate, 'fourth');
  appendEvent(p.journal, failed, { type: 'generation.promoted', commit: failed, previous: third });
  appendEvent(p.journal, third, { type: 'generation.rolledback', commit: failed, to: third, reason: 'exited with 1 before it was ready' });
  untouched.journal = readFileSync(p.journal, 'utf8');
  expect(refused(failed)).toContain('never became ready');
  // After that rollback the plain form still has somewhere to go: the one before the third.
  expect(goBack(dir, null, { dryRun: true })).toMatchObject({ ok: true, from: third, to: second });
  expect(seed).not.toBe(second);
});

test('a generation the journal knows as ready but git no longer has is refused', () => {
  const { dir, p, third } = install();
  const lost = 'ab'.repeat(20);
  appendEvent(p.journal, lost, { type: 'generation.ready', commit: lost });
  const result = goBack(dir, lost);
  expect(result.ok).toBe(false);
  expect(result.message).toContain('git');
  expect(stateOf(p.state)).toMatchObject({ current: third });
});

test('a dry run says what would happen and changes nothing', () => {
  const { dir, p, second, third } = install();
  const journal = readFileSync(p.journal, 'utf8');
  const result = goBack(dir, null, { dryRun: true });
  expect(result).toMatchObject({ ok: true, from: third, to: second });
  expect(stateOf(p.state)).toMatchObject({ current: third });
  expect(readFileSync(p.journal, 'utf8')).toBe(journal);
});

test('an install that was never started has nowhere to go back from', () => {
  const { dir } = makeRepo({ 'body/main.ts': 'process.exit(0);\n' });
  const result = goBack(dir, null);
  expect(result.ok).toBe(false);
  expect(result.message).toContain('never been started');
});

test('while a supervisor holds the lock, going back is refused and nothing changes', async () => {
  const { dir, p, third } = install();
  // The third generation's body, made to stay up until a stimulus arrives.
  const journalModule = JSON.stringify(`${import.meta.dir}/../../brain/journal.ts`);
  writeFiles(p.candidate, { 'body/main.ts': `import { appendEvent, readEvents } from ${journalModule};
const journal = process.env.TENERAL_JOURNAL;
appendEvent(journal, process.env.TENERAL_GEN, { type: 'generation.ready', commit: process.env.TENERAL_GEN });
setInterval(() => { if (readEvents(journal).some((e) => e.type === 'stimulus')) process.exit(0); }, 20);
` });
  const fourth = commitAll(p.candidate, 'fourth');
  appendEvent(p.journal, fourth, { type: 'generation.promoted', commit: fourth, previous: third });
  appendEvent(p.journal, fourth, { type: 'assistant', text: 'hi', toolCalls: [] });
  writeFileSync(p.state, JSON.stringify({ current: fourth, previous: third }));

  const running = supervise({ root: dir, ...QUIET });
  for (let i = 0; i < 400 && !readEvents(p.journal).some((e) => e.type === 'generation.ready' && e.gen === fourth); i++) await Bun.sleep(10);
  const state = readFileSync(p.state, 'utf8');
  const result = goBack(dir, null);
  expect(result.ok).toBe(false);
  expect(result.message).toContain('running');
  expect(readFileSync(p.state, 'utf8')).toBe(state);
  expect(rollbacks(p.journal)).toEqual([]);
  // The refusal did not take the supervisor's lock away.
  expect(existsSync(p.lock)).toBe(true);

  appendEvent(p.journal, 'test', { type: 'stimulus', source: 'test', text: 'stop' });
  expect(await running).toBe('stopped');
  // With the supervisor gone, the same request goes through.
  expect(goBack(dir, null)).toMatchObject({ ok: true, from: fourth, to: third });
});
