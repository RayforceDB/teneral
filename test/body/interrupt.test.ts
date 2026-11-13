import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { needsTurn } from '../../brain/memory';
import { appendEvent, readEvents, type JournalEvent } from '../../brain/journal';
import { interrupt, tell } from '../../kernel/owner';

// The body as the kernel starts it, `bun body/main.ts`, with a stand-in for the model on a local
// port. What is typed and the interrupt go in through the real owner channel (kernel/owner.ts),
// and what happened is read from the journal: these are the paths the owner's Esc takes.

const ROOT = join(import.meta.dir, '..', '..');

interface Asked { messages: { role: string; content: unknown }[]; aborted: boolean }
type Answer = (n: number, asked: Asked) => Response | Promise<Response>;

const says = (text: string, calls: { id: string; command: string }[] = []): Response => Response.json({
  choices: [{ message: { content: text, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: c.command }) } })) } }],
});
/** An answer that never comes. */
const never = (): Promise<Response> => new Promise(() => {});

const ends: (() => void)[] = [];
afterEach(() => {
  for (const end of ends.splice(0)) end();
});

/** A life that has already said its first words and is at rest, unless `seed` says otherwise. */
function life(answer: Answer, seed?: (journal: string, owner: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'teneral-interrupt-'));
  const journal = join(dir, 'memory', 'journal.jsonl');
  const owner = join(dir, 'owner');
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  appendEvent(journal, 'g0', { type: 'stimulus', source: 'birth', text: 'Hello.' });
  appendEvent(journal, 'g0', { type: 'assistant', text: 'Hello. I am here.', toolCalls: [] });
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
      TENERAL_GEN: 'g1', TENERAL_JOURNAL: journal, TENERAL_WORKSPACE: workspace, TENERAL_SOUL: join(dir, 'soul'), TENERAL_PEERS: join(dir, 'soul', 'peers.json'),
      TENERAL_INBOX: join(dir, 'inbox'), TENERAL_OWNER: owner, TENERAL_ID: 'test', TENERAL_HEARTBEAT_MINUTES: '0',
      TENERAL_BASE_URL: `http://127.0.0.1:${server.port}/v1`, TENERAL_API_KEY: 'none', TENERAL_MODEL: 'none',
    },
    stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
  });
  let stderr = '';
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of body.stderr) stderr += decoder.decode(chunk, { stream: true });
  })().catch(() => {});
  ends.push(() => { body.kill('SIGKILL'); void server.stop(true); });
  const events = (): JournalEvent[] => readEvents(journal);
  const types = (): string[] => events().slice(2).map((e) => e.type);
  /** Wait until `seen` holds, or fail saying what there was instead. */
  const until = async (what: string, seen: () => boolean, ms = 10_000): Promise<void> => {
    for (const began = Date.now(); Date.now() - began < ms;) {
      if (seen()) return;
      await Bun.sleep(15);
    }
    throw new Error(`never happened: ${what}\njournal: ${types().join(', ')}\nasked: ${asked.length}\nstderr: ${stderr}`);
  };
  return { dir, journal, owner, workspace, asked, body, events, types, until, stderr: () => stderr };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('interrupted while it waits for the model: the request is dropped at the provider, the journal says so, and the body waits without asking again', async () => {
  const l = life((n) => (n === 1 ? never() : says('Stopped before I had begun. What now?')));
  await l.until('ready', () => l.types().includes('generation.ready'));
  tell(l.owner, 'think about this for a long time');
  await l.until('the request', () => l.asked.length === 1);
  interrupt(l.owner);
  await l.until('the interruption', () => l.types().includes('turn.interrupted'));
  expect(l.types()).toEqual(['generation.ready', 'stimulus', 'turn.interrupted']);
  await l.until('the provider seeing the request dropped', () => l.asked[0]!.aborted);
  // No turn of its own after that: nothing is asked and nothing is journaled, and the process is there.
  await Bun.sleep(700);
  expect(l.asked).toHaveLength(1);
  expect(l.types()).toEqual(['generation.ready', 'stimulus', 'turn.interrupted']);
  expect(needsTurn(l.events())).toBe(false);
  expect(l.body.exitCode).toBeNull();
  expect(existsSync(l.owner) ? readdirSync(l.owner) : []).toEqual([]);
  // The next thing said starts a turn, and the model is shown where it was stopped.
  tell(l.owner, 'never mind, say hello');
  await l.until('the reply', () => l.types().at(-1) === 'assistant');
  expect(l.asked).toHaveLength(2);
  const shown = l.asked[1]!.messages.map((m) => String(m.content));
  expect(shown.slice(-3).map((text) => text.slice(0, 50))).toEqual(['think about this for a long time', '[interrupted] Your owner interrupted your turn her', 'never mind, say hello']);
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
  expect(l.types()).toEqual(['generation.ready', 'stimulus', 'assistant', 'tool.intent', 'tool.result', 'tool.result', 'turn.interrupted']);
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
  expect(l.asked[1]!.messages.map((m) => m.role).slice(-5)).toEqual(['assistant', 'tool', 'tool', 'user', 'user']);
}, 30_000);

test('an interrupt while nothing is owed is dropped, also one left from before this process: neither stops the turn that comes after', async () => {
  const l = life(() => says('Hello again.'), (_journal, owner) => {
    // Left behind for a process that is gone, with a line typed after it.
    interrupt(owner);
    tell(owner, 'are you there?');
  });
  await l.until('the reply to the line that waited', () => l.types().at(-1) === 'assistant');
  expect(l.types()).toEqual(['generation.ready', 'stimulus', 'assistant']);
  // At rest now.
  interrupt(l.owner);
  await l.until('the interrupt taken', () => readdirSync(l.owner).length === 0);
  await Bun.sleep(400);
  expect(l.types()).toEqual(['generation.ready', 'stimulus', 'assistant']);
  tell(l.owner, 'and now?');
  await l.until('the second reply', () => l.types().length === 5 && l.types().at(-1) === 'assistant');
  expect(l.types()).not.toContain('turn.interrupted');
  expect(l.asked).toHaveLength(2);
  expect(l.asked.some((a) => a.aborted)).toBe(false);
}, 30_000);

test('interrupted while it waits to try a failed turn again: the turn is given up, and the body neither retries nor exits', async () => {
  const l = life(() => new Response('upstream is down', { status: 503 }));
  await l.until('ready', () => l.types().includes('generation.ready'));
  tell(l.owner, 'hello?');
  await l.until('the failed turn waiting', () => l.stderr().includes('[retry] 1 in a row'));
  expect(needsTurn(l.events())).toBe(true);
  interrupt(l.owner);
  await l.until('the interruption', () => l.types().includes('turn.interrupted'));
  expect(l.types()).toEqual(['generation.ready', 'stimulus', 'note', 'turn.interrupted']);
  expect(needsTurn(l.events())).toBe(false);
  await Bun.sleep(500);
  expect(l.asked).toHaveLength(1);
  expect(l.body.exitCode).toBeNull();
}, 30_000);
