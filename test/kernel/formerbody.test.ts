import { expect, test } from 'bun:test';
import { cpSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { git, sh, type GateResult } from '../../kernel/gates';
import { readEvents, type JournalEvent } from '../../brain/journal';
import { init, paths, supervise } from '../../kernel/supervisor';
import { commitAll, makeRepo } from './helpers';

// A body from before a mutation was called one, as it really was, under this kernel. Such a body has a
// tool named `molt`, journals `molt.requested`, and hears the kernel's no only as `molt.rejected`. A
// living lineage keeps that body until it changes it itself, so this kernel has to serve it as it is.
//
// The body is taken from this repository's own history: by default the species' last commit before
// the change. TENERAL_FORMER_BODY names another commit or ref to take it from, for a lineage to try
// its own. Where the history does not reach that far (a shallow clone) there is nothing to run, and
// the test says so by being skipped; test/kernel/supervisor.test.ts covers the same with stand-ins.

const HERE = join(import.meta.dir, '..', '..');
const FORMER = process.env.TENERAL_FORMER_BODY || 'd192043a5707556ee86ffc1c12ba174ffafa6c65';
const reachable = sh(['git', 'cat-file', '-e', `${FORMER}^{commit}`], HERE).code === 0;

/** An install with this checkout's kernel and the body of `rev`, committed as its first generation. */
function installWith(rev: string): { dir: string; seed: string } {
  const { dir } = makeRepo({});
  // The kernel, and the one file of the brain it is built on: the journal. A former body finds that under its old name, kernel/journal.ts.
  for (const name of ['kernel', join('brain', 'journal.ts'), 'package.json', 'tsconfig.json']) cpSync(join(HERE, name), join(dir, name), { recursive: true });
  const archive = Bun.spawnSync(['git', 'archive', '--format=tar', rev, 'body', 'BIRTH.md'], { cwd: HERE, stdout: 'pipe', stderr: 'pipe' });
  if (archive.exitCode !== 0) throw new Error(`git archive ${rev} failed: ${archive.stderr.toString()}`);
  const unpack = Bun.spawnSync(['tar', '-x', '-C', dir], { stdin: archive.stdout, stdout: 'pipe', stderr: 'pipe' });
  if (unpack.exitCode !== 0) throw new Error(`tar failed: ${unpack.stderr.toString()}`);
  // What a lineage pins is not what this is about, and its archives are not here.
  rmSync(join(dir, 'body', 'organs.json'), { force: true });
  return { dir, seed: commitAll(dir, 'a former body under this kernel') };
}

interface Asked { tools: string[]; last: { role: string; content: string } }

/**
 * A stand-in for the model that plays one story, by what it was last told: born, it writes a file
 * and calls `molt`; told of a rejection, it writes again and calls `molt` again; told it was
 * accepted, it says so in words. Chat-completions, not streamed, as the body asks without a provider set.
 */
function startModel(): { url: string; asked: Asked[]; stop: () => void } {
  const asked: Asked[] = [];
  let n = 0;
  const call = (name: string, args: unknown) => ({ content: null, tool_calls: [{ id: `call_${n += 1}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const body = await req.json() as { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] };
      const final = body.messages.at(-1)!;
      const last = { role: final.role, content: typeof final.content === 'string' ? final.content : JSON.stringify(final.content) };
      asked.push({ tools: (body.tools ?? []).map((t) => t.function.name), last });
      let message: { content: string | null; tool_calls?: unknown[] };
      if (last.role === 'tool' && last.content.startsWith('wrote ')) message = call('molt', { motive: 'a note of my own' });
      else if (last.role === 'user' && last.content.includes('was rejected at gate')) message = call('write', { path: 'body/former-note.md', content: 'second\n' });
      else if (last.role === 'user' && last.content.includes('was accepted')) message = { content: 'I am in the new body.' };
      else if (last.role === 'user') message = call('write', { path: 'body/former-note.md', content: 'first\n' });
      else message = { content: `Nothing in the story answers this: ${last.content.slice(0, 200)}` };
      return Response.json({
        id: 'chatcmpl-former', object: 'chat.completion', created: 0, model: 'former',
        choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, asked, stop: () => { void server.stop(true); } };
}

test.skipIf(!reachable)(`a body from before the change (${FORMER.slice(0, 12)}) asks with its tool molt, hears a rejection, asks again and is promoted, all under the former names`, async () => {
  const { dir, seed } = installWith(FORMER);
  // It is a former body, or this test shows nothing.
  expect(readFileSync(join(dir, 'body', 'tools.ts'), 'utf8')).toContain("name: 'molt'");
  expect(readFileSync(join(dir, 'body', 'context.ts'), 'utf8')).not.toContain('mutation');
  init(dir);
  const p = paths(dir);
  const model = startModel();
  const set = { TENERAL_BASE_URL: model.url, TENERAL_API_KEY: 'former', TENERAL_MODEL: 'former', TENERAL_HEARTBEAT_MINUTES: '0', TENERAL_PROVIDER: undefined };
  const kept = Object.fromEntries(Object.keys(set).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(set)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  const judged: string[] = [];
  const logs: string[] = [];
  const said: string[] = [];
  /** The story is over once a generation other than the first has answered in words. */
  const over = (events: JournalEvent[]) => events.some((e) => e.type === 'assistant' && e.gen !== seed && e.toolCalls.length === 0);
  // supervise has its handler installed while it runs, so the signal ends it and not the test run.
  // A body that did not hear an answer waits for ever; the story is then ended for it, and fails below.
  const deadline = Date.now() + 30_000;
  const watch = setInterval(() => {
    if (!over(readEvents(p.journal)) && Date.now() < deadline) return;
    clearInterval(watch);
    process.kill(process.pid, 'SIGTERM');
  }, 50);
  let outcome: string;
  try {
    outcome = await supervise({
      root: dir, readyTimeoutMs: 20_000, restartDelayMs: 0, killGraceMs: 2000,
      log: (line) => { logs.push(line); }, stderr: (chunk) => { said.push(Buffer.from(chunk).toString('utf8')); },
      gates: (_dir, from, to): GateResult => {
        judged.push(`${from}>${to}`);
        return judged.length === 1 ? { ok: false, gate: 'tests-body', output: 'FORMER-GATE-OUTPUT 1 fail' } : { ok: true, gate: 'all', output: '' };
      },
    });
  } finally {
    clearInterval(watch);
    model.stop();
    for (const [name, value] of Object.entries(kept)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const events = readEvents(p.journal);
  const told = `What the kernel logged:\n${logs.join('\n')}\nWhat the body wrote to stderr:\n${said.join('')}`;
  expect(over(events), told).toBe(true);
  expect(outcome).toBe('stopped');

  // The body offered the model a tool `molt` and none called `mutate`, every time.
  expect(model.asked.length).toBeGreaterThanOrEqual(5);
  for (const request of model.asked) {
    expect(request.tools).toContain('molt');
    expect(request.tools).not.toContain('mutate');
  }

  // Two requests, both under the former name; the first refused under the former name, the second promoted.
  const requests = events.filter((e) => e.type === 'molt.requested');
  const rejections = events.filter((e) => e.type === 'molt.rejected');
  expect(requests).toHaveLength(2);
  expect(rejections).toHaveLength(1);
  const [first, second] = requests.map((e) => e.commit) as [string, string];
  expect(first).not.toBe(second);
  expect(judged).toEqual([`${seed}>${first}`, `${seed}>${second}`]);
  expect(rejections[0]).toMatchObject({ commit: first, gate: 'tests-body', output: 'FORMER-GATE-OUTPUT 1 fail', gen: seed });
  expect(events.map((e) => e.type).filter((type) => type.startsWith('mutation.'))).toEqual([]);
  expect(events.filter((e) => e.type === 'generation.promoted')).toMatchObject([{ commit: second, previous: seed, gen: second }]);
  expect(events.map((e) => e.type)).not.toContain('generation.rolledback');
  expect(JSON.parse(readFileSync(p.state, 'utf8'))).toEqual({ current: second, previous: seed });
  expect(git(p.live, 'rev-parse', 'HEAD')).toBe(second);
  expect(readFileSync(join(p.live, 'body', 'former-note.md'), 'utf8')).toBe('second\n');
  expect(logs).toContain(`mutation to ${first} rejected at gate tests-body; restarting in 0 ms`);
  expect(logs).toContain(`promoted ${second}`);

  // And it heard both answers: its own words for them reached the model.
  const heard = model.asked.map((request) => request.last).filter((last) => last.role === 'user' && last.content.startsWith('[kernel]')).map((last) => last.content);
  expect(heard).toHaveLength(2);
  expect(heard[0]).toStartWith(`[kernel] Your molt to ${first} was rejected at gate "tests-body".`);
  expect(heard[0]).toContain('FORMER-GATE-OUTPUT 1 fail');
  expect(heard[1]).toStartWith(`[kernel] Your molt was accepted. You are now running generation ${second}`);
  const lastWords = events.findLast((e) => e.type === 'assistant');
  expect(lastWords).toMatchObject({ gen: second, toolCalls: [] });
  // A lineage's body may add a line of its own to what the model said.
  expect((lastWords as { text: string }).text).toStartWith('I am in the new body.');
}, 120_000);
