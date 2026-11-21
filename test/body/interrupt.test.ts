import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { needsTurn } from '../../brain/memory';
import { QUIET_REPLY } from '../../brain/quiet';
import { clockMayTick, clockText } from '../../body/sensors';
import { known } from '../../brain/known';
import { standing } from '../../brain/owned';
import { appendEvent, readEvents, type JournalEvent } from '../../brain/journal';
import { deliver, ENVELOPE_VERSION } from '../../body/envelope';
import { interrupt, tell } from '../../keeper/owner';

// The body as the stem starts it, `bun body/main.ts`, with a stand-in for the model on a local
// port. What is typed and the interrupt go in through the real owner channel (keeper/owner.ts),
// and what happened is read from the journal: these are the paths the owner's Esc takes.

const ROOT = join(import.meta.dir, '..', '..');
// A fresh journal seeds the built-in skill (register, verify, enable) before ready.
const READY = ['note', 'note', 'note', 'generation.ready'];

interface Asked { messages: { role: string; content: unknown }[]; aborted: boolean }
type Answer = (n: number, asked: Asked) => Response | Promise<Response>;

const reply = (message: Record<string, unknown>): Response => Response.json({ choices: [{ message }] });
const tool = (id: string, name: string, args: Record<string, unknown>) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

const says = (text: string, calls: { id: string; command: string }[] = []): Response => reply({
  content: text, tool_calls: calls.map(c => tool(c.id, 'bash', { command: c.command })),
});
/** An answer that never comes. */
const never = (): Promise<Response> => new Promise(() => {});

const ends: (() => void)[] = [];
afterEach(() => {
  for (const end of ends.splice(0)) end();
});

/** A life that has already said its first words and is at rest, unless `seed` says otherwise. */
function life(answer: Answer, seedOrLook?: ((journal: string, owner: string) => void) | boolean, lookAfterEveryTurn = false) {
  const seed = typeof seedOrLook === 'function' ? seedOrLook : undefined;
  if (typeof seedOrLook === 'boolean') lookAfterEveryTurn = seedOrLook;
  // Do not add an `undefined` argument before the flag: Bun's TS transform can drop the last one.
  const dir = mkdtempSync(join(tmpdir(), 'teneral-interrupt-'));
  const journal = join(dir, 'memory', 'journal.jsonl');
  const owner = join(dir, 'owner');
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(dir, 'soul'), { recursive: true });
  writeFileSync(join(dir, 'soul', 'identity.md'), '# Test agent\n');
  // mutate requires a real commit descending from the running generation, even in this fixture.
  for (const args of [
    ['init', '-q'], ['config', 'user.name', 'test'], ['config', 'user.email', 'test@localhost'],
    ['commit', '--allow-empty', '-q', '-m', 'running generation'],
    ['commit', '--allow-empty', '-q', '-m', 'candidate'],
  ]) {
    const run = Bun.spawnSync(['git', ...args], { cwd: workspace });
    if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  }
  const history = Bun.spawnSync(['git', 'log', '--format=%H', '--reverse'], { cwd: workspace }).stdout.toString().trim().split('\n');
  const commit = history[0]!;
  appendEvent(journal, commit, { type: 'stimulus', source: 'birth', text: 'Hello.' });
  appendEvent(journal, commit, { type: 'assistant', text: 'Hello. I am here.', toolCalls: [] });
  seed?.(journal, owner);
  const asked: Asked[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    async fetch(req) {
      const entry: Asked = { messages: ((await req.json()) as { messages: Asked['messages'] }).messages, aborted: false };
      req.signal.addEventListener('abort', () => { entry.aborted = true; });
      asked.push(entry);
      return answer(asked.length, entry);
    },
  });
  // Run from the scratch directory, by the full path: Bun reads a `.env` from where it is started, and the
  // repository's own may name another provider.
  const body = Bun.spawn([process.execPath, join(ROOT, 'body', 'main.ts')], {
    cwd: dir,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      TENERAL_GEN: commit, TENERAL_JOURNAL: journal, TENERAL_WORKSPACE: workspace, TENERAL_SOUL: join(dir, 'soul'), TENERAL_PEERS: join(dir, 'soul', 'peers.json'),
      TENERAL_INBOX: join(dir, 'inbox'), TENERAL_OWNER: owner, TENERAL_ID: 'test', TENERAL_HEARTBEAT_MINUTES: '0',
      ...(lookAfterEveryTurn ? { TENERAL_REFLECT_AFTER_TURN: '1' } : { TENERAL_REFLECT_AFTER_TURN: '0' }),
      ...(process.env.TEST_TENERAL_BACKGROUND ? { TENERAL_BACKGROUND: process.env.TEST_TENERAL_BACKGROUND } : {}),
      TENERAL_BASE_URL: `http://127.0.0.1:${server.port}/v1`, TENERAL_API_KEY: 'none', TENERAL_MODEL: 'none',
      // This test is about interruption, not trimming. Keep enough room after the real composed
      // prompt and tool specifications to show the interrupted exchange on the next request.
      TENERAL_CONTEXT_CHARS: '100000',
    },
    // Keep the foreground terminal channel available: these tests also type /quit into it.
    stdin: process.env.MICA_TEST_BACKGROUND === '1' ? 'ignore' : 'pipe', stdout: 'ignore', stderr: 'pipe',
  });
  let stderr = '';
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of body.stderr) stderr += decoder.decode(chunk, { stream: true });
  })().catch(() => {});
  // Close the input as well as killing: a foreground stdin reader may own the PTY/pipe.
  ends.push(() => { body.stdin?.end(); body.kill('SIGKILL'); void server.stop(true); });
  const events = (): JournalEvent[] => readEvents(journal);
  const types = (): string[] => events().slice(2).map((e) => e.type);
  /** Wait until `seen` holds, or fail saying what there was instead. */
  const until = async (what: string, seen: () => boolean, ms = 7_000): Promise<void> => {
    for (const began = Date.now(); Date.now() - began < ms;) {
      if (seen()) return;
      await Bun.sleep(15);
    }
    throw new Error(`never happened: ${what}\njournal: ${JSON.stringify(events().slice(-12).map(e => ({ type: e.type, source: (e as { source?: unknown }).source, text: (e as { text?: unknown }).text, kind: (e as { kind?: unknown }).kind, data: (e as { data?: unknown }).data })))}\nasked: ${asked.length}\nexit: ${body.exitCode}\nstderr: ${stderr}`);
  };
  return { dir, journal, owner, workspace, asked, body, events, types, until, lookAfterEveryTurn, stderr: () => stderr };
}

/** A journal in which one stretch is over and has no memory yet: the owner spoke long ago, so the agent is at rest. */
const anOldStretch = (journal: string): void => {
  const lines = readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line) as JournalEvent);
  const gen = lines[0]!.gen;
  const at = (ms: number): string => new Date(Date.now() - ms).toISOString();
  const more = [
    { type: 'stimulus', source: 'terminal', text: 'please set up the mail, use the work address', ts: at(30 * 3_600_000) },
    { type: 'assistant', text: 'It is set up and a test message arrived.', toolCalls: [], ts: at(30 * 3_600_000 - 1000) },
    { type: 'stimulus', source: 'terminal', text: 'thanks', ts: at(3_600_000) },
    { type: 'assistant', text: 'Any time.', toolCalls: [], ts: at(3_600_000 - 1000) },
  ].map((e, i) => ({ ...e, v: 1, id: `old-${i}`, gen }));
  writeFileSync(journal, [...lines.map(l => ({ ...l, ts: at(40 * 3_600_000) })), ...more].map(e => `${JSON.stringify(e)}\n`).join(''));
};
const MEMORY = 'Title: Setting up the mail\nOutcome: done\n\nMy owner asked me to set up the mail and said "use the work address". I did, and a test message arrived.';
const memoryAsked = (entry: Asked): boolean => String(entry.messages.at(-1)?.content ?? '').includes('It is time to form a memory');

test('a memory being formed goes on beside the turn that answers what arrived, and is journaled when that turn is over', async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let memoryDone = false;
  const l = life(async (_n, entry) => {
    if (memoryAsked(entry)) { await hold; memoryDone = true; return reply({ content: MEMORY }); }
    // The turn calls a tool, so it is still running when the memory comes back.
    if (entry.messages.some(m => m.role === 'tool')) { await Bun.sleep(400); return says('The file is there.'); }
    return reply({ content: '', tool_calls: [tool('b1', 'bash', { command: 'ls' })] });
  }, anOldStretch);
  ends.push(release);
  await l.until('ready', () => l.types().includes('generation.ready'));
  await l.until('the memory is asked for at rest', () => l.asked.some(memoryAsked));
  tell(l.owner, 'is the file there?');
  // The local no-op guard completes a zero-effect tool call without `tool.intent`: either a
  // real tool result or that guard's settled reply proves the answering turn began beside it.
  await l.until('the turn begins beside it', () => l.events().some(e => e.type === 'tool.intent' || e.type === 'tool.result'));
  // The memory request was not thrown away for the owner's line.
  expect(l.asked.find(memoryAsked)!.aborted).toBe(false);
  release();
  await l.until('the memory has come back', () => memoryDone);
  await l.until('the owner is answered', () => l.events().some(e => e.type === 'assistant' && e.text === 'The file is there.'));
  const titled = (e: JournalEvent): boolean => e.type === 'note' && e.kind === 'memory.episode.v1' && (e.data as { title?: unknown }).title === 'Setting up the mail';
  await l.until('the memory is journaled', () => l.events().some(titled));
  // Written after the turn's last word, never into the middle of it.
  expect(l.events().findIndex(titled)).toBeGreaterThan(l.events().findIndex(e => e.type === 'assistant' && e.text === 'The file is there.'));
  expect(l.asked.filter(memoryAsked)).toHaveLength(1);
}, 15_000);

test('with TENERAL_BACKGROUND=serial whatever arrives cancels the memory request, as it used to', async () => {
  process.env.TEST_TENERAL_BACKGROUND = 'serial';
  try {
    const l = life(async (_n, entry) => memoryAsked(entry) ? never() : says('Here.'), anOldStretch);
    await l.until('ready', () => l.types().includes('generation.ready'));
    await l.until('the memory is asked for at rest', () => l.asked.some(memoryAsked));
    tell(l.owner, 'are you there?');
    await l.until('the owner is answered', () => l.events().some(e => e.type === 'assistant' && e.text === 'Here.'));
    expect(l.asked.find(memoryAsked)!.aborted).toBe(true);
  } finally { delete process.env.TEST_TENERAL_BACKGROUND; }
}, 15_000);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a clock tick with nothing to say stores only the internal no-reply marker', async () => {
  const l = life((n) => n === 1 ? says(QUIET_REPLY) : never());
  await l.until('ready', () => l.types().includes('generation.ready'));
  appendEvent(l.journal, l.events()[0]!.gen, { type: 'stimulus', source: 'clock', text: clockText(new Date()) });
  await l.until('the quiet marker', () => l.events().some(e => e.type === 'assistant' && e.text === QUIET_REPLY));
  const idle = l.events().findLast(e => e.type === 'assistant')!;
  expect(idle.toolCalls).toEqual([]);
  expect(needsTurn(l.events())).toBe(false);
  expect(clockMayTick(l.events(), join(l.dir, 'soul'))).toBe(true);
  expect(l.asked).toHaveLength(1);
}, 10_000);

test('a terminal line read during a mutation turn is answered before generation hand-off', async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const l = life(async (n, asked) => {
    if (n === 1) return reply({ content: '', tool_calls: [tool('m1', 'mutate', { motive: 'test hand-off' })] });
    if (n === 2) { await hold; return says('Mutation requested.'); }
    expect(asked.messages.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.endsWith('keep my late line'))).toBe(true);
    return says('Kept.');
  });
  // Never release the provider if an assertion or timeout fails.
  ends.push(release);
  await l.until('ready', () => l.types().includes('generation.ready'));
  l.body.stdin!.write('start\n');
  await l.until('mutation requested', () => l.asked.length === 2);
  l.body.stdin!.write('keep my late line\n');
  await l.until('the line is journaled', () => l.events().some(e => e.type === 'stimulus' && e.source === 'terminal' && e.text === 'keep my late line'));
  release();
  await l.until('the late-line answer', () => l.events().some(e => e.type === 'assistant' && e.text === 'Kept.'));
  const exit = await Promise.race([l.body.exited, Bun.sleep(1000).then(() => 'still running' as const)]);
  expect(exit).toBe(75);
  expect(l.events().filter(e => e.type === 'mutation.requested')).toHaveLength(1);
  expect(needsTurn(l.events())).toBe(false);
}, 10_000);

test('a turn that stops half-way is settled at once, and the step it names wakes the agent with no tick and no reflection', async () => {
  const l = life((n) => {
    if (n === 1) return says('The first half is done; I will finish the rest.');
    // Settling: the turn's own request with one question after it.
    if (n === 2) return reply({ content: 'Next:\n- Finish the second half of the job => Run the second step and check its output' });
    if (n === 3) return reply({ content: '', tool_calls: [tool('w1', 'work', { task: 'Finish the second half of the job', status: 'done', next: 'Both halves ran and the output was checked.' })] });
    if (n === 4) return says('All of it is done now.');
    return never();
  }, undefined, true);
  await l.until('ready', () => l.types().includes('generation.ready'));
  tell(l.owner, 'do the whole job');
  await l.until('the turn is settled', () => l.events().some(e => e.type === 'note' && e.kind === 'memory.settle.v1'));
  expect(l.asked[1]!.messages.at(-1)!.content).toContain('Your turn has just ended');
  // Read from what was journaled, not from how things stand now: the heart takes the queued step up at once, and may have by the time this looks.
  const journaled = (): string[] => l.events().flatMap(e => (e.type === 'note' ? [JSON.stringify(e.data)] : []));
  await l.until('the step is queued', () => journaled().some(data => data.includes('"status":"queued"') && data.includes('Run the second step and check its output')));
  expect(journaled().some(data => data.includes('Finish the second half of the job'))).toBe(true);
  // The heart wakes it for the queued step; nothing else does.
  await l.until('the queued step is taken', () => l.events().some(e => e.type === 'assistant' && e.text === 'All of it is done now.'), 12_000);
  expect(l.events().filter(e => e.type === 'stimulus' && e.source === 'work')).toHaveLength(1);
  expect(l.events().filter(e => e.type === 'stimulus' && e.source === 'clock')).toHaveLength(0);
  expect(l.events().filter(e => e.type === 'note' && e.kind === 'memory.reflection.v1')).toHaveLength(0);
  expect(known(standing(readEvents(l.journal))).intentions).toEqual([]);
  await Bun.sleep(300);
  // A turn woken for its own work is not settled again: four requests, and then it rests.
  expect(l.asked).toHaveLength(4);
  expect(l.events().filter(e => e.type === 'note' && e.kind === 'memory.settle.v1')).toHaveLength(1);
}, 20_000);

test('a turn in which the agent recorded what it waits for is not asked again, and nothing goes to look at what waits', async () => {
  const l = life((n) => {
    if (n === 1) return reply({ content: '', tool_calls: [tool('w1', 'work', {
      task: 'Finish the repository change', status: 'waiting', next: 'The existing check, which reports by itself.',
      outcome: 'The change is merged.', evidence: 'The check is running.',
    })] });
    if (n === 2) return says('Waiting for the check.');
    return never();
  }, undefined, true);
  await l.until('ready', () => l.types().includes('generation.ready'));
  tell(l.owner, 'finish the repository change');
  await l.until('the dependency answer', () => l.events().some(e => e.type === 'assistant' && e.text === 'Waiting for the check.'));
  await Bun.sleep(1500);
  expect(l.asked).toHaveLength(2);
  expect(l.events().filter(e => e.type === 'stimulus' && (e.source === 'clock' || e.source === 'work'))).toHaveLength(0);
  expect(l.events().filter(e => e.type === 'note' && (e.kind === 'memory.settle.v1' || e.kind === 'memory.reflection.v1'))).toHaveLength(0);
  expect(known(standing(readEvents(l.journal))).intentions[0]!.work).toMatchObject({ status: 'waiting' });
}, 10_000);

test('a record nobody has to answer does not end a request of the agent\'s own; something that calls for a turn does', async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const l = life(async (n) => {
    if (n === 1) return says('I will look into it.');
    if (n === 2) { await hold; return reply({ content: 'Waiting:\n- [arrives] Look into the report => The numbers my owner promised to send' }); }
    if (n === 3) return says('I will look into that as well.');
    // The second settling is given up for the owner's next line.
    if (n === 4) return never();
    if (n === 5) return says('Here.');
    return never();
  }, undefined, true);
  ends.push(release);
  await l.until('ready', () => l.types().includes('generation.ready'));
  tell(l.owner, 'look into the report');
  await l.until('settling is under way', () => l.asked.length === 2);
  // A sensor's checkpoint grows the journal while the request is out. The watcher sees it within a second.
  appendEvent(l.journal, l.events()[0]!.gen, { type: 'note', kind: 'github.cursor.v1', data: { repository: 'a/b' } });
  await Bun.sleep(1400);
  expect(l.asked[1]!.aborted).toBe(false);
  release();
  await l.until('the turn is settled all the same', () => l.events().some(e => e.type === 'note' && e.kind === 'memory.settle.v1'));
  expect(known(standing(readEvents(l.journal))).intentions[0]).toMatchObject({ text: 'Look into the report', work: { status: 'waiting' } });

  tell(l.owner, 'and the other report');
  await l.until('the second settling is under way', () => l.asked.length === 4);
  tell(l.owner, 'are you there?');
  await l.until('the owner is answered first', () => l.events().some(e => e.type === 'assistant' && e.text === 'Here.'));
  expect(l.asked[3]!.aborted).toBe(true);
  expect(l.events().filter(e => e.type === 'note' && e.kind === 'memory.settle.v1')).toHaveLength(1);
}, 15_000);

test('a /heart line during a turn waits for its reply and then takes the agenda turn', async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const l = life(async n => {
    if (n === 1) { await hold; return says('Finished first.'); }
    if (n === 2) return says('Pulse answered.');
    return never();
  });
  ends.push(release);
  await l.until('ready', () => l.types().includes('generation.ready'));
  tell(l.owner, 'start');
  await l.until('the running request', () => l.asked.length === 1);
  tell(l.owner, '/heart');
  await Bun.sleep(80);
  expect(l.asked).toHaveLength(1);
  expect(l.asked[0]!.aborted).toBe(false);
  expect(l.events().some(e => e.type === 'stimulus' && e.text === '/heart')).toBe(false);
  release();
  await l.until('the pulse reply', () => l.events().some(e => e.type === 'assistant' && e.text === 'Pulse answered.'));
  expect(l.events().filter(e => e.type === 'stimulus' && e.source === 'clock')).toHaveLength(1);
  expect(l.asked).toHaveLength(2);
}, 10_000);

test('foreground /quit aborts the running turn and exits with its interruption journaled', async () => {
  const l = life(() => never());
  await l.until('ready', () => l.types().includes('generation.ready'));
  l.body.stdin!.write('think for a long time\n');
  await l.until('the request', () => l.asked.length === 1);
  const pressed = Date.now();
  l.body.stdin!.write('/quit\n');
  const exited = await l.body.exited;
  expect(exited).toBe(0);
  expect(Date.now() - pressed).toBeLessThan(2000);
  expect(l.types()).toContain('turn.interrupted');
  expect(l.asked[0]!.aborted).toBe(true);
  expect(needsTurn(l.events())).toBe(false);
}, 10_000);

test('foreground /quit while bash runs reports every tool call, kills its tree and exits', async () => {
  const command = 'echo begun; sleep 303 & echo $! > quit-child.pid; wait';
  const l = life(() => says('I will wait.', [{ id: 'q1', command }, { id: 'q2', command: 'touch quit-second-ran' }]));
  await l.until('ready', () => l.types().includes('generation.ready'));
  l.body.stdin!.write('sleep\n');
  await l.until('the command under way', () => existsSync(join(l.workspace, 'quit-child.pid')));
  const child = Number(readFileSync(join(l.workspace, 'quit-child.pid'), 'utf8'));
  const pressed = Date.now();
  l.body.stdin!.write('/quit\n');
  expect(await l.body.exited).toBe(0);
  expect(Date.now() - pressed).toBeLessThan(2000);
  expect(alive(child)).toBe(false);
  const results = l.events().flatMap(e => e.type === 'tool.result' ? [e] : []);
  expect(results).toHaveLength(2);
  expect(results[0]).toMatchObject({ callId: 'q1', ok: false });
  expect(results[0]!.output).toContain('[interrupted]');
  expect(results[1]).toMatchObject({ callId: 'q2', ok: false, output: '[not started] Your owner interrupted this turn before this tool ran.' });
  expect(l.types().at(-1)).toBe('turn.interrupted');
  expect(existsSync(join(l.workspace, 'quit-second-ran'))).toBe(false);
}, 10_000);

test('interrupted while it waits for the model: the request is dropped at the provider, the journal says so, and the body waits without asking again', async () => {
  const l = life((n) => (n === 1 ? never() : says('Stopped before I had begun. What now?')));
  await l.until('ready', () => l.types().includes('generation.ready'));
  tell(l.owner, 'think about this for a long time');
  await l.until('the request', () => l.asked.length === 1);
  interrupt(l.owner);
  await l.until('the interruption', () => l.types().includes('turn.interrupted'));
  expect(l.types()).toEqual([...READY, 'stimulus', 'note', 'turn.interrupted']);
  await l.until('the provider seeing the request dropped', () => l.asked[0]!.aborted);
  // No turn of its own after that: nothing is asked and nothing is journaled, and the process is there.
  await Bun.sleep(700);
  expect(l.asked).toHaveLength(1);
  expect(l.types()).toEqual([...READY, 'stimulus', 'note', 'turn.interrupted']);
  expect(needsTurn(l.events())).toBe(false);
  expect(l.body.exitCode).toBeNull();
  expect(existsSync(l.owner) ? readdirSync(l.owner) : []).toEqual([]);
  // The next thing said starts a turn, and the model is shown where it was stopped.
  tell(l.owner, 'never mind, say hello');
  await l.until('the reply', () => l.types().at(-1) === 'assistant');
  expect(l.asked).toHaveLength(2);
  const shown = l.asked[1]!.messages.map((m) => String(m.content));
  expect(shown.at(-1)?.startsWith('think about this for a long time\n\n[next stimulus]\n\n[interrupted] Your owner interrupted your turn here.')).toBe(true);
  expect(shown.at(-1)?.endsWith('\n\n[next stimulus]\n\nnever mind, say hello')).toBe(true);
  expect(l.stderr()).toContain('[interrupted]');
  expect(l.stderr()).not.toContain('[turn failed]');
  expect(l.stderr()).not.toContain('[retry]');
}, 30_000);

test('interrupted while bash runs: the command, its child and its grandchild are dead, every call has its result, and the body waits', async () => {
  const command = 'echo begun; (sleep 303 & echo $! > grandchild.pid; wait) & echo $! > child.pid; echo $$ > bash.pid; wait';
  const l = life((n) => (n === 1 ? says('I will wait a while.', [{ id: 'c1', command }, { id: 'c2', command: 'touch second-ran' }]) : says('It was stopped while sleeping.')));
  await l.until('ready', () => l.types().includes('generation.ready'));
  tell(l.owner, 'sleep for five minutes');
  const pid = (name: string): number => {
    try {
      return Number(readFileSync(join(l.workspace, name), 'utf8')) || 0;
    } catch {
      return 0;
    }
  };
  await l.until('the command under way', () => pid('bash.pid') > 0 && pid('child.pid') > 0 && pid('grandchild.pid') > 0);
  const pids = [pid('bash.pid'), pid('child.pid'), pid('grandchild.pid')];
  expect(pids.map(alive)).toEqual([true, true, true]);
  const pressed = Date.now();
  interrupt(l.owner);
  await l.until('the interruption', () => l.types().includes('turn.interrupted'));
  expect(Date.now() - pressed).toBeLessThan(3000);
  await l.until('the processes gone', () => pids.every((p) => !alive(p)), 3000);
  expect(l.types()).toEqual([...READY, 'stimulus', 'note', 'note', 'assistant', 'tool.intent', 'tool.result', 'tool.result', 'turn.interrupted']);
  const results = l.events().flatMap((e) => (e.type === 'tool.result' ? [e] : []));
  expect(results[0]).toMatchObject({ callId: 'c1', ok: false });
  expect(results[0]!.output).toMatch(/^\[interrupted\] Your owner interrupted this turn while this tool was running\..*\ninterrupted by your owner and killed, with everything it started\nbegun\n$/s);
  expect(results[1]).toMatchObject({ callId: 'c2', ok: false, output: '[not started] Your owner interrupted this turn before this tool ran.' });
  expect(existsSync(join(l.workspace, 'second-ran'))).toBe(false);
  await Bun.sleep(700);
  expect(l.asked).toHaveLength(1);
  expect(l.types().at(-1)).toBe('turn.interrupted');
  expect(l.body.exitCode).toBeNull();
  // And it goes on from there when spoken to: both calls are shown answered, then the interruption.
  tell(l.owner, 'what happened?');
  await l.until('the reply', () => l.types().at(-1) === 'assistant');
  expect(l.asked[1]!.messages.map((m) => m.role).slice(-4)).toEqual(['assistant', 'tool', 'tool', 'user']);
}, 30_000);

test('an interrupt while nothing is owed is dropped, also one left from before this process: neither stops the turn that comes after', async () => {
  const l = life(() => says('Hello again.'), (_journal, owner) => {
    // Left behind for a process that is gone, with a line typed after it.
    interrupt(owner);
    tell(owner, 'are you there?');
  });
  await l.until('the reply to the line that waited', () => l.types().at(-1) === 'assistant');
  expect(l.types()).toEqual([...READY, 'stimulus', 'note', 'note', 'assistant']);
  // At rest now.
  interrupt(l.owner);
  await l.until('the interrupt taken', () => readdirSync(l.owner).length === 0);
  await Bun.sleep(400);
  expect(l.types()).toEqual([...READY, 'stimulus', 'note', 'note', 'assistant']);
  tell(l.owner, 'and now?');
  await l.until('the second reply', () => l.types().length === READY.length + 8 && l.types().at(-1) === 'assistant');
  expect(l.types()).not.toContain('turn.interrupted');
  expect(l.asked).toHaveLength(2);
  expect(l.asked.some((a) => a.aborted)).toBe(false);
}, 30_000);

test('an outsider arriving during a failed turn does not hurry the retry; the next owner line does', async () => {
  let fail: (() => void) | undefined;
  const first = new Promise<Response>((resolve) => {
    fail = () => resolve(new Response('upstream is down', { status: 503 }));
  });
  const l = life((n) => n === 1 ? first : says(' answered after the owner wrote'));
  await l.until('ready', () => l.types().includes('generation.ready'));
  tell(l.owner, 'hello?');
  await l.until('the first request', () => l.asked.length === 1);
  deliver(join(l.dir, 'inbox'), {
    v: ENVELOPE_VERSION, id: 'background-1', from: 'other', to: 'test', replyTo: null,
    ts: new Date().toISOString(), hops: 0, text: 'background traffic',
  });
  await l.until('the outsider is journaled', () => l.events().some(e => e.type === 'stimulus' && e.source === 'agent:other'));
  fail!();
  await l.until('the failed turn is waiting', () => l.stderr().includes('[retry] 1 in a row'));
  const failure = l.events().findLast(e => e.type === 'note' && e.kind === 'turn.failed');
  expect(failure?.type).toBe('note');
  if (failure?.type === 'note') expect(typeof (failure.data as {retryAt?: unknown}).retryAt).toBe('string');
  deliver(join(l.dir, 'inbox'), {
    v: ENVELOPE_VERSION, id: 'background-2', from: 'other', to: 'test', replyTo: null,
    ts: new Date().toISOString(), hops: 0, text: 'traffic during the retry wait',
  });
  await l.until('the wait is interrupted by an outsider', () => l.events().some(e => e.type === 'stimulus' && e.source === 'agent:other' && e.text.includes('background-2')));
  await Bun.sleep(500);
  expect(l.asked).toHaveLength(1);
  expect(l.stderr()).not.toContain('something arrived meanwhile');
  tell(l.owner, 'try now');
  await l.until('the owner shortens the wait', () => l.asked.length === 2);
  await l.until('the reply', () => l.types().at(-1) === 'assistant');
  expect(l.body.exitCode).toBeNull();
}, 30_000);

test('interrupted while it waits to try a failed turn again: the turn is given up, and the body neither retries nor exits', async () => {
  const l = life(() => new Response('upstream is down', { status: 503 }));
  await l.until('ready', () => l.types().includes('generation.ready'));
  tell(l.owner, 'hello?');
  await l.until('the failed turn waiting', () => l.stderr().includes('[retry] 1 in a row'));
  expect(needsTurn(l.events())).toBe(true);
  interrupt(l.owner);
  await l.until('the interruption', () => l.types().includes('turn.interrupted'));
  expect(l.types()).toEqual([...READY, 'stimulus', 'note', 'note', 'turn.interrupted']);
  expect(needsTurn(l.events())).toBe(false);
  await Bun.sleep(500);
  expect(l.asked).toHaveLength(1);
  expect(l.body.exitCode).toBeNull();
}, 30_000);
