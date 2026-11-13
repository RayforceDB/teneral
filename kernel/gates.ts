import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { appendEvent, readEvents } from './journal';
import { ORGANS_FILE, ORGAN_CHECK_TIMEOUT_MS, organRoot, parseOrgans, provideOrgans, type Organ } from './organs';
import { protectedChanges } from './protected';
import { judgeApproval, type ApprovalOptions } from './approval';

export interface GateResult {
  ok: boolean;
  gate: string;
  output: string;
  /** A rejection that judged nothing, so that the same commit may be asked for again: the owner has yet to approve it. */
  undecided?: boolean;
}

export interface Check {
  gate: string;
  cmd: string[];
  /** The command is `bun test`: besides exit 0, its summary must show tests ran and none failed. */
  bunSummary?: boolean;
}

export const DEFAULT_CHECKS: readonly Check[] = [
  { gate: 'types', cmd: ['bun', 'x', 'tsc', '--noEmit'] },
  // Two runs, so the kernel's tests and the agent's own, of its body and its brain, each have to show up and pass on their own.
  // A lineage from before there was a brain has no test/brain, and bun then runs what test/body holds.
  { gate: 'tests-kernel', cmd: ['bun', 'test', 'test/kernel'], bunSummary: true },
  { gate: 'tests-body', cmd: ['bun', 'test', 'test/body', 'test/brain'], bunSummary: true },
];

/** The command a generation is started with, by the supervisor and by the smoke gate alike. */
export const BODY_CMD: readonly string[] = ['bun', 'body/main.ts'];

/** Where a body finds its install. The supervisor and the smoke gate both build the body's environment from this. */
export interface BodyPlaces {
  gen: string;
  journal: string;
  workspace: string;
  id: string;
  inbox: string;
  peers: string;
  soul: string;
  owner: string;
  /** The configured provider's id (kernel/providers.ts), when one is set. It decides the wire protocol the body speaks. */
  provider?: string;
  /** Where sign-in credentials are kept. Left out of a smoke run, which must not reach them. */
  auth?: string;
  /** The directory that holds this generation's pinned organs, one entry per name (kernel/organs.ts). Left out when it pins none. */
  organs?: string;
}

/** Everything the kernel itself sets for a body. The supervisor and the smoke gate both start one with exactly this. */
export function bodyEnv(at: BodyPlaces): Record<string, string> {
  return {
    TENERAL_GEN: at.gen, TENERAL_JOURNAL: at.journal, TENERAL_WORKSPACE: at.workspace,
    TENERAL_ID: at.id, TENERAL_INBOX: at.inbox, TENERAL_PEERS: at.peers,
    TENERAL_SOUL: at.soul, TENERAL_OWNER: at.owner,
    ...(at.provider ? { TENERAL_PROVIDER: at.provider } : {}),
    ...(at.auth ? { TENERAL_AUTH: at.auth } : {}),
    ...(at.organs ? { TENERAL_ORGANS: at.organs } : {}),
  };
}

/** The only variables passed on to a check. The supervisor's own environment holds API keys; candidate code under test must not. */
const CHECK_ENV = ['PATH', 'HOME', 'LANG', 'BUN_INSTALL'];

/**
 * What a check sees. Its temp directory is `tmp`, inside the gate checkout, so what the tests leave
 * behind goes with the checkout instead of piling up in the machine's. The ceiling keeps git, run
 * from a temp directory that is not a repository, from finding the checkout around it and acting on that.
 */
function checkEnv(tmp: string): Record<string, string> {
  const env: Record<string, string> = { TMPDIR: tmp, TMP: tmp, TEMP: tmp, GIT_CEILING_DIRECTORIES: tmp };
  for (const name of CHECK_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * Why a `bun test` run that exited 0 still does not count, or null when it does.
 * A test file can end the process with exit 0 before anything ran; only the summary
 * bun prints last shows it got to the end. bun writes it to stderr, as one block:
 *
 *      2 pass
 *      0 fail
 *      3 expect() calls
 *     Ran 2 tests across 1 file. [4.00ms]
 *
 * So only stderr is read, the `Ran` line must be its last line, and the counts must
 * be in the lines directly above it. This keeps out a summary-shaped line a test
 * happened to print; it cannot tell bun's summary from the same text written to
 * stderr by a test that then exits 0, and is not meant to.
 */
export function bunSummaryProblem(stderr: string): string | null {
  const missing = 'bun test exited 0 but its stderr does not end with its summary, so nothing shows the tests ran to the end';
  const lines = stderr.trimEnd().split('\n');
  if (!/^Ran \d+ tests? across \d+ files?\. \[.*\]$/.test(lines.at(-1) ?? '')) return missing;
  let passed: number | null = null;
  let failed: number | null = null;
  for (let i = lines.length - 2; i >= 0 && lines[i] !== ''; i--) {
    const count = /^ (\d+) (pass|fail)$/.exec(lines[i]!);
    if (count?.[2] === 'pass' && passed === null) passed = Number(count[1]);
    if (count?.[2] === 'fail' && failed === null) failed = Number(count[1]);
  }
  if (passed === null || failed === null) return missing;
  if (failed !== 0) return `bun test exited 0 but its summary reports ${failed} failing`;
  if (passed < 1) return 'bun test ran no tests';
  return null;
}

export interface ShResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout followed by stderr, for showing to a reader. */
  output: string;
}

/** `env`, when given, is the whole environment of the command; otherwise it inherits this process's. */
export function sh(cmd: string[], cwd: string, timeoutMs = 600_000, env?: Record<string, string>): ShResult {
  const p = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs, ...(env ? { env } : {}) });
  const stdout = p.stdout.toString();
  const stderr = p.stderr.toString();
  return { code: p.exitCode ?? 1, stdout, stderr, output: stdout + stderr };
}

/** git's stdout only: a warning on stderr must never be read as part of the answer. */
function gitRaw(dir: string, ...args: string[]): string {
  const r = sh(['git', ...args], dir);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.output.trim()}`);
  return r.stdout;
}

/** Runs git in `dir`; throws with git's own words when it fails. */
export function git(dir: string, ...args: string[]): string {
  return gitRaw(dir, ...args).trim();
}

/**
 * The NUL-separated paths a `-z` git command prints, exactly as git gave them.
 * Never trimmed: ` body/x` is not `body/x`, and trimming would let it through the allowlist.
 */
export function gitPaths(dir: string, ...args: string[]): string[] {
  return gitRaw(dir, ...args).split('\0').filter(Boolean);
}

export interface BodyEntry {
  path: string;
  /** Git's file mode, e.g. 100644. */
  mode: string;
  /** Blob size in bytes; 0 for entries that are not blobs. */
  size: number;
}

/** What `commit` holds under body/ and brain/, read from the commit itself, never from a worktree. */
export function bodyEntries(dir: string, commit: string): BodyEntry[] {
  // Each record is `<mode> <type> <object> <size>\t<path>`, the size padded with spaces.
  return gitPaths(dir, 'ls-tree', '-r', '-l', '-z', commit, '--', 'body', 'brain').map((record) => {
    const tab = record.indexOf('\t');
    const [mode = '', , , size = ''] = record.slice(0, tab).split(/ +/);
    return { path: record.slice(tab + 1), mode, size: Number(size) || 0 };
  });
}

/** Bytes of the files `commit` holds under body/ and brain/. */
export function bodySize(dir: string, commit = 'HEAD'): number {
  return bodyEntries(dir, commit).reduce((total, entry) => total + entry.size, 0);
}

/** Regular and executable files. Anything else (a symlink, a nested repo) is not plain. */
const PLAIN_MODES = new Set(['100644', '100755']);

/**
 * Makes the repo's dependencies visible in a worktree without copying them. A link that points
 * somewhere else, as after the install was moved, is replaced; a real directory is left alone.
 */
export function linkModules(root: string, dir: string): void {
  const source = join(root, 'node_modules');
  const target = join(dir, 'node_modules');
  if (!existsSync(source)) return;
  let stat: ReturnType<typeof lstatSync> | null = null;
  try { stat = lstatSync(target); } catch { /* nothing there */ }
  if (stat?.isSymbolicLink()) {
    if (readlinkSync(target) === source) return;
    rmSync(target, { force: true });
  } else if (stat) {
    return;
  }
  symlinkSync(source, target);
}

/** What `commit` pins as its organs: the text of its body/organs.json, or null when it has no such file. */
export function organsAt(dir: string, commit: string): string | null {
  if (gitPaths(dir, 'ls-tree', '-z', '--name-only', commit, '--', ORGANS_FILE).length === 0) return null;
  return gitRaw(dir, 'show', `${commit}:${ORGANS_FILE}`);
}

/** The main checkout of the repo that `dir` (possibly one of its worktrees) belongs to. */
export function repoRoot(dir: string): string {
  return dirname(git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
}

/** Removes every gate checkout a killed gate run left under the repo's .teneral/. Never throws. */
export function dropLeftoverGateTrees(root: string): string[] {
  const home = join(root, '.teneral');
  let names: string[] = [];
  try {
    names = readdirSync(home).filter((name) => name.startsWith('gate-'));
  } catch {
    return [];
  }
  for (const name of names) dropGateTree(root, join(home, name));
  return names;
}

/** Never throws: whatever is at `tree` is gone afterwards, or was never there. */
function dropGateTree(root: string, tree: string): void {
  // The checks' temp files first: they can hold whole repositories, which git would not remove.
  for (const inner of [GATE_TMP, GATE_SMOKE]) {
    try { rmSync(join(tree, inner), { recursive: true, force: true }); } catch { /* the removal below says more */ }
  }
  if (existsSync(tree)) sh(['git', 'worktree', 'remove', '--force', tree], root);
  try { rmSync(tree, { recursive: true, force: true }); } catch { /* left for the owner; the next gate run will say why it cannot start */ }
  sh(['git', 'worktree', 'prune'], root);
}

/** Inside a gate checkout: the checks' temp directory, and the throwaway install the smoke run lives in. Both dot-named, so bun's test scan skips them. */
const GATE_TMP = '.tmp';
const GATE_SMOKE = '.smoke';

/**
 * A fresh, kernel-owned checkout of exactly `commit`. Checks run here, so nothing
 * that exists only in the agent's worktree (ignored files, edits git was told to
 * overlook) can make them pass.
 */
function makeGateTree(root: string, commit: string): string {
  const tree = join(root, '.teneral', `gate-${commit.slice(0, 12)}`);
  mkdirSync(dirname(tree), { recursive: true });
  // A gate run that was killed may have left its checkout behind.
  dropGateTree(root, tree);
  git(root, 'worktree', 'add', '--detach', tree, commit);
  linkModules(root, tree);
  mkdirSync(join(tree, GATE_TMP), { recursive: true });
  return tree;
}

/** The last `max` bytes of a stream. */
class Tail {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly max: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.chunks.length > 1 && this.size - this.chunks[0]!.length >= this.max) {
      this.size -= this.chunks.shift()!.length;
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).subarray(-this.max).toString('utf8');
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** Signals the whole process group a command was started in, so what it started goes with it. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}

interface Running {
  pid: number;
  stdout: Tail;
  stderr: Tail;
  /** The exit code; 1 when it was ended by a signal. Resolves once its output has been read. */
  exited: Promise<number>;
  done: () => boolean;
  /** SIGTERM, then SIGKILL after `graceMs`. False only if it is still there after that. */
  stop: (graceMs: number) => Promise<boolean>;
}

/**
 * Starts a command without waiting for it, in a process group of its own and with no terminal:
 * unlike `sh`, this leaves the event loop free, so a stop signal is heard while it runs.
 */
function start(cmd: readonly string[], cwd: string, env: Record<string, string>, keepBytes = 4_000_000): Running {
  const stdout = new Tail(keepBytes);
  const stderr = new Tail(keepBytes);
  const child = spawn(cmd[0]!, cmd.slice(1), { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const pid = child.pid ?? 0;
  child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));
  let finished = false;
  const exited = new Promise<number>((resolve) => {
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      resolve(code);
    };
    child.on('error', (err) => {
      stderr.push(Buffer.from(`could not start ${cmd.join(' ')}: ${err.message}\n`));
      finish(127);
    });
    child.on('exit', (code) => {
      // Whatever it left running in its group goes too; such a leftover may also hold the pipes open,
      // so the output is not waited for beyond a moment.
      if (pid > 0) signalGroup(pid, 'SIGKILL');
      setTimeout(() => finish(code ?? 1), 500);
    });
    child.on('close', (code) => finish(code ?? 1));
  });
  const stop = async (graceMs: number): Promise<boolean> => {
    if (finished || pid === 0) return true;
    signalGroup(pid, 'SIGTERM');
    await Promise.race([exited, sleep(graceMs)]);
    if (finished) return true;
    signalGroup(pid, 'SIGKILL');
    await Promise.race([exited, sleep(5_000)]);
    return finished;
  };
  return { pid, stdout, stderr, exited, done: () => finished, stop };
}

/** Resolves when `signal` aborts; never, without one. `forget` drops the listener. */
function aborted(signal: AbortSignal | undefined): { promise: Promise<void>; forget: () => void } {
  if (!signal) return { promise: new Promise<void>(() => {}), forget: () => {} };
  let listener = () => {};
  const promise = new Promise<void>((resolve) => {
    listener = () => resolve();
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', listener, { once: true });
  });
  return { promise, forget: () => signal.removeEventListener('abort', listener) };
}

interface CheckRun extends ShResult {
  interrupted: boolean;
}

export async function runCheck(
  cmd: readonly string[], cwd: string, env: Record<string, string>, o: { signal?: AbortSignal; graceMs: number; timeoutMs: number },
): Promise<CheckRun> {
  const running = start(cmd, cwd, env);
  const abort = aborted(o.signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), o.timeoutMs); });
  const first = await Promise.race([running.exited, abort.promise.then(() => 'abort' as const), timeout]);
  clearTimeout(timer);
  abort.forget();
  let note = '';
  if (typeof first !== 'number') {
    const stopped = await running.stop(o.graceMs);
    if (first === 'timeout') note = `\n[stopped: it was still running after ${o.timeoutMs} ms${stopped ? '' : ', and could not be killed'}]`;
  }
  const code = typeof first === 'number' ? first : 1;
  const stdout = running.stdout.text();
  const stderr = running.stderr.text();
  return { code, stdout, stderr, output: stdout + stderr + note, interrupted: first === 'abort' };
}

/**
 * What the `organs` gate does, for pins already read: every archive is in the cache under its
 * hash and is unpacked, and every check an organ names exits with 0. A check runs in its organ's
 * root with what any check sees (`tmp` is its temp directory) and TENERAL_ORGANS, and nothing
 * else. Returns the directory to hand on as TENERAL_ORGANS, null when nothing is pinned.
 */
export async function tryOrgans(
  root: string, organs: readonly Organ[], tmp: string, o: { signal?: AbortSignal; graceMs?: number; timeoutMs?: number } = {},
): Promise<{ dir: string | null; problem?: string; interrupted?: boolean }> {
  const provided = await provideOrgans(root, organs, { verify: true });
  if (provided.problem !== undefined) return { dir: null, problem: provided.problem };
  if (provided.dir === null) return { dir: null };
  const env = { ...checkEnv(tmp), TENERAL_ORGANS: provided.dir };
  const timeoutMs = o.timeoutMs ?? ORGAN_CHECK_TIMEOUT_MS;
  for (const organ of organs) {
    if (!organ.check) continue;
    const cwd = organRoot(root, organ);
    const r = await runCheck([join(cwd, organ.check[0]!), ...organ.check.slice(1)], cwd, env, { signal: o.signal, graceMs: o.graceMs ?? 5_000, timeoutMs });
    if (r.interrupted) return { dir: null, interrupted: true };
    if (r.code !== 0) {
      // The reason goes last: a gate's output is kept from its end.
      return { dir: null, problem: `${r.output.trimEnd()}\norgan ${organ.name}: its check (${organ.check.join(' ')}), run in the organ's directory, `
        + `did not exit with 0 within ${timeoutMs / 1000} s` };
    }
  }
  return { dir: provided.dir };
}

/** What the stub endpoint says, whatever it is asked. Plain text and no tool calls, so a turn ends with it. */
const STUB_REPLY = 'This is the kernel\'s stand-in for the model during a smoke test. Nothing to do.';

/**
 * A model endpoint on a free local port that answers every request with one fixed assistant
 * message: as chat-completions (streamed if the request asks for that), or, at `/responses`, as a
 * Responses event stream. It exists only while a smoke run needs it: the candidate has to show it
 * can take a turn over the protocol its configuration uses, not that the real model is reachable.
 */
export function startStubProvider(): { url: string; stop: () => void } {
  const head = { id: 'chatcmpl-smoke', created: 0, model: 'smoke' };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const sse = (body: string) => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      if (new URL(req.url).pathname.endsWith('/responses')) {
        const response = { id: 'resp_smoke', object: 'response', model: 'smoke', store: false };
        const item = {
          type: 'message', id: 'msg_smoke', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: STUB_REPLY, annotations: [] }],
        };
        const events = [
          { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } },
        ];
        return sse(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      }
      let wantsStream = false;
      try {
        wantsStream = (await req.json() as { stream?: unknown } | null)?.stream === true;
      } catch { /* answered the same way whatever was sent */ }
      if (!wantsStream) {
        return Response.json({
          ...head, object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: STUB_REPLY }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }
      const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({
        ...head, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
      return sse(`${chunk({ role: 'assistant', content: STUB_REPLY }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`);
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, stop: () => { void server.stop(true); } };
}

/** What the smoke run finds waiting for it. It comes as a line typed at the terminal, which every body must answer. */
const SMOKE_STIMULUS = 'This is the kernel checking that a new generation can start and take a turn. Nothing here is real and nothing needs doing: answer with one short line and no tool calls.';

/**
 * Starts the candidate as the supervisor would, on a throwaway install inside the gate checkout,
 * with one message waiting and a stub in place of the model. Passing the tests does not show that
 * a body starts and can take a turn; this does. Returns null when it did, else what was missing.
 */
async function smokeRun(
  tree: string, commit: string, env: Record<string, string>,
  o: { signal?: AbortSignal; graceMs: number; timeoutMs: number; provider?: string; organs?: string },
): Promise<{ problem: string | null; interrupted: boolean }> {
  const home = join(tree, GATE_SMOKE);
  const at: BodyPlaces = {
    gen: commit,
    journal: join(home, 'memory', 'journal.jsonl'),
    // A checkout of the commit, as the real workspace is; this one is thrown away.
    workspace: tree,
    id: randomUUID(),
    inbox: join(home, 'inbox'),
    peers: join(home, 'soul', 'peers.json'),
    soul: join(home, 'soul'),
    owner: join(home, 'owner'),
    // The provider the owner configured, so the candidate is tried over the protocol it will really speak.
    // No `auth`: with the dummy key below a body has no reason to look for a sign-in, and is not told where one is.
    provider: o.provider,
    // The candidate's own organs, which the gate before this one made ready.
    organs: o.organs,
  };
  for (const dir of [at.inbox, at.soul, at.owner]) mkdirSync(dir, { recursive: true });
  appendEvent(at.journal, commit, { type: 'stimulus', source: 'terminal', text: SMOKE_STIMULUS });

  const stub = startStubProvider();
  const abort = aborted(o.signal);
  let wasAborted = false;
  void abort.promise.then(() => { wasAborted = true; });
  try {
    const running = start(BODY_CMD, tree, {
      ...env, ...bodyEnv(at),
      TENERAL_BASE_URL: stub.url, TENERAL_API_KEY: 'smoke', TENERAL_MODEL: 'smoke', TENERAL_HEARTBEAT_MINUTES: '0',
    }, 4096);
    const deadline = Date.now() + o.timeoutMs;
    let ready = false;
    let replied = false;
    const look = () => {
      const events = readEvents(at.journal);
      const readyAt = events.findIndex((e) => e.type === 'generation.ready' && e.gen === commit);
      ready = readyAt !== -1;
      replied = ready && events.some((e, i) => i > readyAt && e.type === 'assistant');
    };
    for (;;) {
      const over = running.done();
      look();
      if (replied || over || wasAborted || Date.now() >= deadline) break;
      await Promise.race([running.exited, abort.promise, sleep(50)]);
    }
    const died = running.done();
    const code = died ? await running.exited : null;
    const stopped = await running.stop(o.graceMs);
    if (wasAborted) return { problem: null, interrupted: true };
    if (replied && stopped) return { problem: null, interrupted: false };

    const missing = ready ? 'became ready but did not reply: its journal holds no assistant event' : 'did not journal generation.ready';
    let problem = replied
      ? 'became ready and replied, but could not be stopped afterwards, even with SIGKILL'
      : `${missing} ${code === null ? `within ${o.timeoutMs / 1000} s` : `before it exited with ${code}`}`;
    if (!stopped && !replied) problem += ', and it could not be stopped afterwards';
    const said = running.stderr.text().trim();
    return {
      problem: `The candidate was started the way the kernel starts a generation (${BODY_CMD.join(' ')}), on an empty install with one message `
        + `waiting and a stand-in for the model. It ${problem}.\n`
        + (said === '' ? 'It wrote nothing to stderr.' : `Its stderr ended with:\n${said.slice(-3000)}`),
      interrupted: false,
    };
  } finally {
    abort.forget();
    stub.stop();
  }
}

export interface GateOptions {
  /** Aborting it stops the running check and ends the gate run with gate `interrupted`. */
  signal?: AbortSignal;
  /** How long a check told to stop has before it is killed outright. Default 5 s. */
  killGraceMs?: number;
  /** Whether to end with the smoke run. Default: yes for the default checks, no for a list of one's own. */
  smoke?: boolean;
  /** How long the smoke run has to become ready and reply. Default 30 s. */
  smokeTimeoutMs?: number;
  /** How long one check may run. Default 10 minutes. */
  checkTimeoutMs?: number;
  /** The configured provider's id. The smoke run is made as that provider, against the stub, with a dummy key. */
  provider?: string;
  /** How long the check of one organ may run. Default ORGAN_CHECK_TIMEOUT_MS. */
  organTimeoutMs?: number;
  /** What the owner allows outside the free paths, and the launcher this supervisor runs under (kernel/approval.ts). */
  approval?: ApprovalOptions;
}

/** The paths outside the free ones in which commits `a` and `b` differ: empty when they have the same kernel, project files and all. */
export function protectedDiff(dir: string, a: string, b: string): string[] {
  // --no-renames lists both ends of a move, so moving a protected file out is caught.
  // -z: without it git prints unusual names quoted and escaped, which would not match the allowlist.
  return protectedChanges(gitPaths(dir, 'diff', '--name-only', '--no-renames', '-z', a, b));
}

/**
 * Decide whether commit `to`, checked out in `dir`, may replace generation `from`.
 * Checks run in a temporary checkout of `to`, so they test that commit and nothing else.
 */
export async function runGates(
  dir: string, from: string, to: string, checks: readonly Check[] = DEFAULT_CHECKS, opts: GateOptions = {},
): Promise<GateResult> {
  const fail = (gate: string, output: string): GateResult => ({ ok: false, gate, output: output.slice(-4000) });
  const interrupted = (): GateResult => fail('interrupted', 'the gate run was stopped before it finished; nothing was decided');
  const smoke = opts.smoke ?? checks === DEFAULT_CHECKS;
  const graceMs = opts.killGraceMs ?? 5_000;
  let root: string;
  let pins: string | null;
  try {
    // These two say early, in the agent's own terms, why its worktree is not what it asked for.
    if (git(dir, 'rev-parse', 'HEAD') !== to) return fail('head', `the candidate is not at ${to}`);
    if (git(dir, 'status', '--porcelain') !== '') return fail('head', 'the candidate has uncommitted changes');
    root = repoRoot(dir);
    const outside = protectedDiff(dir, from, to);
    if (outside.length > 0) {
      // Outside the free paths a commit runs only on the owner's word. A mutation that stays inside them never gets here.
      const verdict = judgeApproval(root, from, to, outside, opts.approval);
      if (!verdict.ok) return { ...fail(verdict.gate, verdict.output), ...(verdict.undecided ? { undecided: true } : {}) };
    }
    const entries = bodyEntries(dir, to);
    const odd = entries.filter((entry) => !PLAIN_MODES.has(entry.mode));
    if (odd.length > 0) {
      return fail('body', `body/ and brain/ may hold only plain files; these are not: ${odd.map((entry) => entry.path).join(', ')}`);
    }
    pins = organsAt(dir, to);
  } catch (err) {
    return fail('git', err instanceof Error ? err.message : String(err));
  }
  let organs: Organ[];
  try {
    organs = parseOrgans(pins);
  } catch (err) {
    return fail('organs', err instanceof Error ? err.message : String(err));
  }
  if (checks.length === 0 && !smoke && organs.length === 0) return { ok: true, gate: 'all', output: '' };
  if (opts.signal?.aborted) return interrupted();

  let tree: string;
  try {
    tree = makeGateTree(root, to);
  } catch (err) {
    return fail('git', err instanceof Error ? err.message : String(err));
  }
  try {
    let env = checkEnv(join(tree, GATE_TMP));
    // Before anything of the candidate's runs, so its tests and its smoke run find the organs it pins.
    // No network: an archive the agent did not put in the cache is a rejection, not a download.
    const tried = await tryOrgans(root, organs, join(tree, GATE_TMP), { signal: opts.signal, graceMs, timeoutMs: opts.organTimeoutMs });
    if (tried.interrupted) return interrupted();
    if (tried.problem !== undefined) return fail('organs', tried.problem);
    if (tried.dir !== null) env = { ...env, TENERAL_ORGANS: tried.dir };
    for (const check of checks) {
      const r = await runCheck(check.cmd, tree, env, { signal: opts.signal, graceMs, timeoutMs: opts.checkTimeoutMs ?? 600_000 });
      if (r.interrupted) return interrupted();
      if (r.code !== 0) return fail(check.gate, r.output);
      const problem = check.bunSummary ? bunSummaryProblem(r.stderr) : null;
      // The reason goes last: fail() keeps the end of the output.
      if (problem) return fail(check.gate, `${r.output}\n${problem}`);
    }
    if (smoke) {
      // Last, so a body is only ever started once its types and tests are in order.
      const r = await smokeRun(tree, to, env, { signal: opts.signal, graceMs, timeoutMs: opts.smokeTimeoutMs ?? 30_000, provider: opts.provider, organs: tried.dir ?? undefined });
      if (r.interrupted) return interrupted();
      if (r.problem !== null) return fail('smoke', r.problem);
    }
    return { ok: true, gate: 'all', output: '' };
  } catch (err) {
    return fail('kernel', `the gate run itself failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    dropGateTree(root, tree);
  }
}
