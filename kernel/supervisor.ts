import {
  closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { identity } from './envelope';
import {
  BODY_CMD, DEFAULT_CHECKS, bodyEnv, dropLeftoverGateTrees, git, linkModules, organsAt, runGates, sh, type GateResult,
} from './gates';
import {
  appendEvent, journalSize, readEvents, readEventsFrom, type JournalEvent,
} from './journal';
import { parseOrgans, provideOrgans } from './organs';
import { authDir } from './providers';

/** The agent exits with this code to ask for a molt. */
export const MOLT_EXIT = 75;
/** Crashes in a row, with no reply in between, before a generation is given up on. */
export const CRASH_LIMIT = 3;
/** Rejections in a row of one and the same commit before the supervisor stops and leaves it to the owner. */
export const REJECTION_LIMIT = 3;

export interface Exit {
  code: number;
  /** The generation journaled `generation.ready` during this run. */
  ready: boolean;
}

export type Decision = 'stop' | 'gate' | 'restart' | 'rollback' | 'halt';

/** `crashes` counts earlier crashes of this generation since its last reply. */
export function decide(exit: Exit, s: { hasPrevious: boolean; crashes: number }): Decision {
  if (exit.code === 0) return 'stop';
  // Only a generation that proved it can start may ask for a molt, so `previous` is always one that did.
  if (exit.code === MOLT_EXIT && exit.ready) return 'gate';
  const givenUp = !exit.ready || s.crashes + 1 >= CRASH_LIMIT;
  if (!givenUp) return 'restart';
  return s.hasPrevious ? 'rollback' : 'halt';
}

/** The branch the agent's own commits live on. Never pushed by the kernel. */
export const LINEAGE_BRANCH = 'lineage/local';
/** The longest the supervisor waits before restarting a crashed generation. */
export const RESTART_DELAY_CAP_MS = 30_000;

export interface Paths {
  root: string;
  /** Worktree the running agent's code is checked out in. */
  live: string;
  /** Worktree the agent edits. */
  candidate: string;
  journal: string;
  state: string;
  /** Holds the pid of the supervisor running this install. */
  lock: string;
  /** Names the body process while one runs, so a later supervisor can stop a body this one left behind. */
  child: string;
  /** Where other agents and programs drop messages for this one. */
  inbox: string;
  /** The owner's list of peers: name to inbox directory. */
  peers: string;
  /** The individual's soul files. Never in git. */
  soul: string;
  /** Where the owner's typed lines are left for the body, one file each. See kernel/owner.ts. */
  owner: string;
  /** Where sign-in credentials are kept. See kernel/signin.ts. */
  auth: string;
}

export function paths(root: string): Paths {
  return {
    root,
    live: join(root, '.teneral', 'live'),
    candidate: join(root, '.teneral', 'candidate'),
    journal: join(root, 'memory', 'journal.jsonl'),
    state: join(root, '.teneral', 'state.json'),
    lock: join(root, '.teneral', 'lock'),
    child: join(root, '.teneral', 'child.json'),
    inbox: join(root, 'inbox'),
    peers: join(root, 'soul', 'peers.json'),
    soul: join(root, 'soul'),
    owner: join(root, '.teneral', 'owner'),
    auth: authDir(root),
  };
}

export interface State {
  current: string;
  /** The generation to return to if `current` fails; null when there is none. */
  previous: string | null;
}

const COMMIT = /^[0-9a-f]{40}$/;
const isCommit = (value: unknown): value is string => typeof value === 'string' && COMMIT.test(value);
const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function readState(p: Paths): State {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p.state, 'utf8'));
  } catch (err) {
    throw new Error(`${p.state} cannot be read as JSON: ${reasonOf(err)}`);
  }
  const s = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  if (!isCommit(s.current) || !(s.previous === null || isCommit(s.previous))) {
    throw new Error(`${p.state} does not hold a state: "current" must be a 40-character commit and "previous" a commit or null`);
  }
  return { current: s.current, previous: s.previous };
}

/** The state reaches the disk before anything is done about it, so a kill at any point can be repaired from it. */
export function saveState(p: Paths, state: State): void {
  mkdirSync(dirname(p.state), { recursive: true });
  const tmp = `${p.state}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const fd = openSync(tmp, 'w');
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, p.state);
}

const isWorktree = (dir: string): boolean => existsSync(join(dir, '.git'));

/**
 * Create whatever is missing of: the live worktree, the candidate worktree on the
 * lineage branch, the state file. Safe to run again after an init that died partway,
 * and on every start. The state is written last, so its presence means init finished.
 */
export function init(root: string): State {
  const p = paths(root);
  const known = existsSync(p.state) ? readState(p) : null;
  const head = known?.current ?? git(root, 'rev-parse', 'HEAD');
  mkdirSync(join(root, '.teneral'), { recursive: true });
  // `git gc` forgets worktrees whose directories it cannot find, after three months by default.
  // An individual raised in a container has its worktrees at paths that exist only in there
  // (/teneral/...), so a gc run on the host, by hand or by git itself, would count them as gone.
  git(root, 'config', '--local', 'gc.worktreePruneExpire', 'never');
  // An install that was moved has worktrees that point at where it used to be, and the repository at where
  // they used to be. Mend both directions before pruning, which would otherwise forget them as gone.
  const present = [p.live, p.candidate].filter(isWorktree);
  if (present.length > 0) sh(['git', 'worktree', 'repair', ...present], root);
  // Forget worktrees whose directories are gone; git refuses to add those again otherwise.
  git(root, 'worktree', 'prune');
  const works = (dir: string): boolean => sh(['git', 'rev-parse', '--git-dir'], dir).code === 0;
  // live holds nothing that is not in a commit, so one that cannot be mended is made again.
  if (isWorktree(p.live) && !works(p.live)) rmSync(p.live, { recursive: true, force: true });
  if (isWorktree(p.candidate) && !works(p.candidate)) {
    throw new Error(`${p.candidate} is no longer a checkout git can use, and it may hold work that is not committed; `
      + 'mend it by hand (git worktree repair) or move it away');
  }
  if (!isWorktree(p.live)) git(root, 'worktree', 'add', '--detach', p.live, head);
  if (!isWorktree(p.candidate)) {
    const hasBranch = sh(['git', 'show-ref', '--verify', '--quiet', `refs/heads/${LINEAGE_BRANCH}`], root).code === 0;
    if (hasBranch) git(root, 'worktree', 'add', p.candidate, LINEAGE_BRANCH);
    else git(root, 'worktree', 'add', '-b', LINEAGE_BRANCH, p.candidate, head);
  }
  linkModules(root, p.live);
  linkModules(root, p.candidate);
  if (known) return known;
  const state: State = { current: head, previous: null };
  saveState(p, state);
  return state;
}

/** Make the live worktree exactly `commit`: no other checkout, no local edits, no stray files. */
function syncLive(p: Paths, commit: string): void {
  git(p.live, 'checkout', '-q', '-f', '--detach', commit);
  git(p.live, 'clean', '-q', '-fdx', '-e', 'node_modules');
}

/**
 * The state is saved before the journal hears of a promotion or rollback. If the
 * supervisor died in between, write the missing event now, so the agent still
 * finds the kernel's note about what happened to it.
 */
function reconcileJournal(p: Paths, state: State, events: JournalEvent[]): void {
  let journaled: string | null = null;
  for (let i = events.length - 1; i >= 0 && journaled === null; i--) {
    const e = events[i]!;
    if (e.type === 'generation.promoted') journaled = e.commit;
    else if (e.type === 'generation.rolledback') journaled = e.to;
  }
  if (journaled === state.current) return;
  if (state.previous !== null) {
    appendEvent(p.journal, state.current, { type: 'generation.promoted', commit: state.current, previous: state.previous });
  } else if (journaled !== null) {
    appendEvent(p.journal, state.current, {
      type: 'generation.rolledback', commit: journaled, to: state.current,
      reason: 'the kernel was stopped while rolling back, before it recorded why',
    });
  }
}

/** What the agent is told when a molt it asked for was never judged. */
const INTERRUPTED = 'The kernel was stopped, or the body died, before the gates finished with this commit. Nothing was decided about it. Call molt again.';

/**
 * A molt request must not be left hanging: the agent waits for one of three answers. If the
 * latest request in `events` has none after it, say that it was interrupted. Returns whether it did.
 */
function answerPendingMolt(p: Paths, gen: string, events: JournalEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'molt.rejected' || e.type === 'generation.promoted' || e.type === 'generation.rolledback') return false;
    if (e.type === 'molt.requested') {
      appendEvent(p.journal, gen, { type: 'molt.rejected', commit: e.commit, gate: 'interrupted', output: INTERRUPTED });
      return true;
    }
  }
  return false;
}

/**
 * Whether the current generation still has to show it can reply. One that was promoted over
 * another is on probation until its first assistant event; one with nothing to go back to never is.
 */
function onProbation(state: State, events: JournalEvent[]): boolean {
  if (state.previous === null) return false;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'assistant' && e.gen === state.current) return false;
    if (e.type === 'generation.promoted' && e.commit === state.current) return true;
  }
  return true;
}

/** Locks this process holds, so a lock file naming our own pid can be told from one a dead process with the same pid left. */
const heldLocks = new Set<string>();

/** The command line of a running process as /proc gives it, or null where there is no /proc or no such process. */
function cmdlineOf(pid: number | 'self'): string[] | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Whether `pid` is alive and still the program `cmd` says it was. A pid is given to another
 * program sooner or later, at the latest after a reboot; where /proc exists, the command line
 * tells the two apart. Without /proc, or with nothing recorded, being alive is all there is.
 */
function isProgram(pid: number, cmd: string[] | null): boolean {
  if (!pidAlive(pid)) return false;
  const now = cmdlineOf(pid);
  if (cmd === null || now === null) return true;
  return now.join('\0') === cmd.join('\0');
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** What a lock file says: a pid, and what that process was when it took the lock. NaN for a file that is gone or is not a lock. */
function lockRecord(lock: string): { pid: number; cmd: string[] | null } {
  let pid = Number.NaN;
  let cmd: string[] | null = null;
  try {
    const [first = '', second = ''] = readFileSync(lock, 'utf8').split('\n');
    pid = Number(first.trim());
    const parsed: unknown = second.trim() === '' ? null : JSON.parse(second);
    if (Array.isArray(parsed)) cmd = parsed.map(String);
  } catch { /* gone again, or not a lock */ }
  return { pid, cmd };
}

/**
 * The pid of the live supervisor that holds the lock, or null when nobody does. Only looks: for
 * the owner's screen, which says whether the agent is running. It has to be asked from where
 * the supervisor's pid means something, which `./box talk` is: it runs in the same container.
 */
export function holder(lock: string): number | null {
  const { pid, cmd } = lockRecord(lock);
  return Number.isInteger(pid) && pid > 0 && isProgram(pid, cmd) ? pid : null;
}

/** Takes the lock and returns null, or returns the pid of the live supervisor that holds it. */
export function takeLock(lock: string): number | null {
  mkdirSync(dirname(lock), { recursive: true });
  // Written aside and linked into place, so the lock never exists without a pid in it.
  const mine = `${lock}.${process.pid}`;
  // The pid, and on a second line what this process is, so the pid alone is not taken for a supervisor later.
  const self = cmdlineOf('self');
  writeFileSync(mine, `${process.pid}\n${self === null ? '' : `${JSON.stringify(self)}\n`}`);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(mine, lock);
        heldLocks.add(lock);
        return null;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const { pid, cmd } = lockRecord(lock);
      const ours = pid === process.pid && heldLocks.has(lock);
      const alive = Number.isInteger(pid) && pid > 0 && isProgram(pid, cmd) && (pid !== process.pid || ours);
      if (alive) return pid;
      rmSync(lock, { force: true });
    }
    throw new Error('it keeps reappearing');
  } finally {
    rmSync(mine, { force: true });
  }
}

export function dropLock(lock: string): void {
  heldLocks.delete(lock);
  rmSync(lock, { force: true });
}

/** What is written to `Paths.child` while a body runs. */
interface ChildRecord {
  pid: number;
  gen: string;
  cmd: string[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (pidAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(20);
  }
  return true;
}

/**
 * A supervisor that was killed outright leaves its body running, still writing to the
 * journal and reading the terminal. Stop it before starting another. Returns false
 * only if it could not be stopped.
 */
async function stopOrphan(p: Paths, graceMs: number, log: (line: string) => void): Promise<boolean> {
  if (!existsSync(p.child)) return true;
  let record: ChildRecord | null = null;
  try {
    const parsed = JSON.parse(readFileSync(p.child, 'utf8')) as Partial<ChildRecord> | null;
    if (parsed && Number.isInteger(parsed.pid) && parsed.pid! > 1 && Array.isArray(parsed.cmd)) {
      record = { pid: parsed.pid!, gen: String(parsed.gen), cmd: parsed.cmd.map(String) };
    }
  } catch { /* an unreadable record names nobody */ }
  if (record !== null && record.pid !== process.pid && isProgram(record.pid, record.cmd)) {
    const { pid, gen } = record;
    log(`a body from an earlier supervisor is still running (pid ${pid}, generation ${gen}); stopping it`);
    try {
      process.kill(pid, 'SIGTERM');
      if (!await goneWithin(pid, graceMs)) {
        log(`pid ${pid} did not stop within ${graceMs} ms; killing it`);
        process.kill(pid, 'SIGKILL');
        if (!await goneWithin(pid, 5_000)) {
          log(`pid ${pid} could not be killed; not starting another body beside it`);
          return false;
        }
      }
    } catch (err) {
      // ESRCH: it went away by itself in the meantime.
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
        log(`pid ${pid} could not be signalled (${reasonOf(err)}); not starting another body beside it`);
        return false;
      }
    }
  }
  rmSync(p.child, { force: true });
  return true;
}

export interface Options {
  root: string;
  agentCmd?: string[];
  /** Judges a candidate. `stop` is aborted when the supervisor is told to stop; the run should then end at once. */
  gates?: (dir: string, from: string, to: string, stop?: AbortSignal) => GateResult | Promise<GateResult>;
  /** How long a generation has to journal `generation.ready` before it is killed. Default 60 s. */
  readyTimeoutMs?: number;
  /** How long a generation told to stop (SIGTERM) has before it is killed outright (SIGKILL). Default 5 s. */
  killGraceMs?: number;
  /** Wait before a restart: this times the crashes in a row (or the rejections in a row of the same commit) so far, at most RESTART_DELAY_CAP_MS. Default 1 s. */
  restartDelayMs?: number;
  /** Restarts after a crash one generation gets, whether or not it replied in between, before it is given up on. A long run gives them back; see `stableRunMs`. Default 10. */
  restartBudget?: number;
  /**
   * How long a generation promoted over another has, in each run until its first reply, to journal an assistant
   * event. The promotion note always owes a turn, so a healthy one replies; one that is alive but silent is
   * killed and rolled back. Default 10 minutes.
   */
  probationMs?: number;
  /** A run that lasted at least this long before ending abnormally gives the generation its restart budget back. Default 1 hour. */
  stableRunMs?: number;
  /** Where the body's stderr is shown as it comes. Default: this process's stderr. */
  stderr?: (chunk: Uint8Array) => void;
  log?: (line: string) => void;
}

/** How much of a body's stderr is kept to explain a rollback. */
const STDERR_TAIL_BYTES = 4096;

/**
 * Passes a body's stderr on as it arrives and keeps the end of it. `tail` waits a moment for
 * what is still in the pipe after the body has exited, and no longer: something the body
 * started may hold the pipe open for good.
 */
function forwardStderr(stream: ReadableStream<Uint8Array>, show: (chunk: Uint8Array) => void): { tail: () => Promise<string> } {
  let kept = Buffer.alloc(0);
  const reader = stream.getReader();
  const drained = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      try { show(value); } catch { /* showing it is a courtesy; keeping it is not */ }
      kept = Buffer.concat([kept, value]).subarray(-STDERR_TAIL_BYTES);
    }
  })().catch(() => {});
  return {
    tail: async () => {
      await Promise.race([drained, sleep(500)]);
      void reader.cancel().catch(() => {});
      return kept.toString('utf8').trim();
    },
  };
}

function lastOf<T extends JournalEvent['type']>(events: JournalEvent[], type: T): Extract<JournalEvent, { type: T }> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === type) return e as Extract<JournalEvent, { type: T }>;
  }
  return undefined;
}

/**
 * Run generations until the agent exits cleanly or the owner stops it ('stopped'),
 * or nothing can run ('halted').
 */
export async function supervise(opts: Options): Promise<'stopped' | 'halted'> {
  const p = paths(opts.root);
  const cmd = opts.agentCmd ?? [...BODY_CMD];
  const readyTimeoutMs = opts.readyTimeoutMs ?? 60_000;
  const killGraceMs = opts.killGraceMs ?? 5_000;
  const restartDelayMs = opts.restartDelayMs ?? 1_000;
  const restartBudget = opts.restartBudget ?? 10;
  const probationMs = opts.probationMs ?? 600_000;
  const stableRunMs = opts.stableRunMs ?? 3_600_000;
  const showStderr = opts.stderr ?? ((chunk: Uint8Array) => { process.stderr.write(chunk); });
  const gates = opts.gates
    ?? ((dir: string, from: string, to: string, stop?: AbortSignal) => runGates(dir, from, to, DEFAULT_CHECKS, { signal: stop, killGraceMs, provider: process.env.TENERAL_PROVIDER }));
  const log = opts.log ?? ((line: string) => console.error(`[teneral] ${line}`));

  try {
    const holder = takeLock(p.lock);
    if (holder !== null) {
      log(`another supervisor is running this install (pid ${holder}, named in ${p.lock}); not starting`);
      return 'halted';
    }
  } catch (err) {
    log(`cannot take the lock ${p.lock}: ${reasonOf(err)}`);
    return 'halted';
  }

  let stopping = false;
  /** Stops the running generation, or the running gates, if there is one. */
  let terminate: (() => void) | null = null;
  /** Ends the wait before a restart, if one is in progress. */
  let wake: (() => void) | null = null;
  const onSignal = () => { stopping = true; terminate?.(); wake?.(); };
  // SIGHUP is what a closing terminal sends. Unhandled, it would cut the supervisor down and leave the body running.
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const signal of signals) process.on(signal, onSignal);

  const pause = (ms: number) => new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); wake = null; resolve(); };
    const timer = setTimeout(done, ms);
    wake = done;
  });

  try {
    if (!await stopOrphan(p, killGraceMs, log)) return 'halted';
    let state: State;
    /** The current generation was promoted over another and has not replied yet. */
    let probation: boolean;
    try {
      state = init(opts.root);
      reconcileJournal(p, state, readEvents(p.journal));
      // Read again: the line above may have added the note of a promotion or rollback.
      const events = readEvents(p.journal);
      if (answerPendingMolt(p, state.current, events)) log('a molt was asked for and never answered; told the agent to ask again');
      probation = onProbation(state, events);
    } catch (err) {
      log(`cannot start: ${reasonOf(err)}`);
      return 'halted';
    }
    const leftover = dropLeftoverGateTrees(p.root);
    if (leftover.length > 0) log(`removed gate checkouts left by an earlier run: ${leftover.join(', ')}`);
    /** Crashes in a row with no reply in between. */
    let crashes = 0;
    /** Restarts of this generation after a crash, in total. */
    let restarts = 0;
    /** The commit last rejected, and how many times in a row it has been. */
    let rejected: { commit: string; times: number } | null = null;
    const delayAfter = (count: number) => Math.min(restartDelayMs * count, RESTART_DELAY_CAP_MS);

    /** Write-ahead: the state first, then the checkout, and only then (by the caller) the journal. */
    const moveTo = (next: State): boolean => {
      try {
        saveState(p, next);
        syncLive(p, next.current);
      } catch (err) {
        log(`cannot switch to generation ${next.current}: ${reasonOf(err)}`);
        return false;
      }
      state = next;
      crashes = 0;
      restarts = 0;
      rejected = null;
      probation = next.previous !== null;
      return true;
    };

    for (;;) {
      if (stopping) return 'stopped';
      try {
        // Whatever a kill, a stray process or the body itself left in live, this is what runs.
        syncLive(p, state.current);
      } catch (err) {
        log(`cannot check out generation ${state.current}: ${reasonOf(err)}`);
        return 'halted';
      }
      const gen = state.current;
      // The organs this generation pins, from its own commit: after a rollback that is the older pin,
      // whose tree is still in the cache. A tree that is gone is unpacked again from its archive. When
      // that is gone too, nothing is started: a body without the organ it was gated with would only
      // crash, and going back a generation would give up a sound one for a file the owner can put back.
      let organs: string | null;
      try {
        const provided = await provideOrgans(p.root, parseOrgans(organsAt(p.root, gen)), { verify: false });
        if (provided.problem !== undefined) throw new Error(provided.problem);
        organs = provided.dir;
      } catch (err) {
        log(`cannot start generation ${gen}: ${reasonOf(err)}`);
        log('nothing was changed, and no generation was given up: it starts once that is mended');
        return 'halted';
      }
      if (stopping) return 'stopped';
      const mark = journalSize(p.journal);
      appendEvent(p.journal, gen, { type: 'generation.started', commit: gen });
      const since = () => readEventsFrom(p.journal, mark);
      const isReady = () => since().some((e) => e.type === 'generation.ready' && e.gen === gen);

      // The organs are this generation's or nobody's: never a directory the supervisor's own environment happened to name.
      const { TENERAL_ORGANS: _inherited, ...inherited } = process.env;
      const running = Bun.spawn(cmd, {
        cwd: p.live,
        env: {
          ...inherited,
          ...bodyEnv({
            gen, journal: p.journal, workspace: p.candidate, id: identity(join(p.root, '.teneral')),
            inbox: p.inbox, peers: p.peers, soul: p.soul, owner: p.owner,
            provider: process.env.TENERAL_PROVIDER, auth: p.auth, organs: organs ?? undefined,
          }),
        },
        // stderr is passed on as it comes and its end kept, to say why if this generation has to be given up on.
        stdin: 'inherit', stdout: 'inherit', stderr: 'pipe',
      });
      const startedAt = Date.now();
      const said = forwardStderr(running.stderr, showStderr);
      const record: ChildRecord = { pid: running.pid, gen, cmd };
      writeFileSync(p.child, JSON.stringify(record));
      const timers: { ready?: ReturnType<typeof setTimeout>; kill?: ReturnType<typeof setTimeout>; probation?: ReturnType<typeof setTimeout> } = {};
      // Ask first; a generation that does not go within the grace period is killed outright.
      const stop = () => {
        if (timers.kill !== undefined) return;
        running.kill('SIGTERM');
        timers.kill = setTimeout(() => running.kill('SIGKILL'), killGraceMs);
      };
      terminate = stop;
      timers.ready = setTimeout(() => {
        // Nothing may throw out of a timer: a journal that cannot be read counts as not ready.
        let ready = false;
        try { ready = isReady(); } catch { /* not ready */ }
        if (!ready) stop();
      }, readyTimeoutMs);
      /** This run was ended because a newly promoted generation stayed silent. */
      let silent = false;
      if (probation) {
        timers.probation = setTimeout(() => {
          let replied = false;
          try { replied = since().some((e) => e.type === 'assistant' && e.gen === gen); } catch { /* not replied */ }
          if (replied) return;
          silent = true;
          stop();
        }, probationMs);
      }
      const code = await running.exited;
      const ranMs = Date.now() - startedAt;
      clearTimeout(timers.ready);
      clearTimeout(timers.kill);
      clearTimeout(timers.probation);
      terminate = null;
      rmSync(p.child, { force: true });
      const lastWords = await said.tail();
      if (stopping) return 'stopped';

      const events = since();
      const replied = events.some((e) => e.type === 'assistant');
      if (replied) crashes = 0;
      if (events.some((e) => e.type === 'assistant' && e.gen === gen)) probation = false;
      // A generation that ran for a long time and then fell over is not one that keeps failing.
      if (ranMs >= stableRunMs) restarts = 0;
      const ready = events.some((e) => e.type === 'generation.ready' && e.gen === gen);
      const standing = { hasPrevious: state.previous !== null, crashes };
      let decision = decide({ code, ready }, standing);
      const request = lastOf(events, 'molt.requested');
      if (decision === 'gate' && !request) {
        // A molt with no commit named is a crash like any other, so it is counted and cannot spin.
        log(`generation ${gen} exited with ${code} but named no commit; treating it as a crash`);
        decision = decide({ code: 1, ready }, standing);
      }
      // The budget is not reset by a reply: a generation that answers and then dies, over and over, is still broken.
      const spent = decision === 'restart' && restarts >= restartBudget;
      if (spent) decision = state.previous !== null ? 'rollback' : 'halt';
      // Alive, ready and silent: the kernel ended this run itself, so the exit code says nothing.
      if (silent && state.previous !== null) decision = 'rollback';
      // Anything but the gates or a rollback leaves a request made in this run without an answer.
      if (decision !== 'gate' && decision !== 'rollback' && answerPendingMolt(p, gen, events)) {
        log(`generation ${gen} asked for a molt and did not exit to have it judged; told it to ask again`);
      }

      if (decision === 'stop') return 'stopped';
      if (decision === 'halt') {
        const why = spent ? `kept crashing after ${restartBudget} restarts` : `exited with ${code}`;
        log(`generation ${gen} ${why} and there is nothing to roll back to`);
        return 'halted';
      }
      if (decision === 'restart') {
        crashes += 1;
        restarts += 1;
        const delay = delayAfter(crashes);
        log(`generation ${gen} exited with ${code}; restarting in ${delay} ms (${crashes}/${CRASH_LIMIT})`);
        await pause(delay);
        continue;
      }
      if (decision === 'rollback') {
        const to = state.previous!;
        let reason = `exited with ${code} before it was ready`;
        if (silent) reason = `started but did not reply within ${probationMs / 1000} s of being promoted, so it was stopped`;
        else if (spent) reason = `kept crashing after ${restartBudget} restarts`;
        else if (ready) reason = `crashed ${CRASH_LIMIT} times without a reply`;
        // What it last wrote to stderr is usually the actual cause.
        if (lastWords !== '') reason += `. Its stderr ended with:\n${lastWords}`;
        if (!moveTo({ current: to, previous: null })) return 'halted';
        appendEvent(p.journal, to, { type: 'generation.rolledback', commit: gen, to, reason });
        log(`rolled back ${gen} to ${to}: ${reason}`);
        continue;
      }
      // decision === 'gate', and the request exists or the decision would have been replaced above.
      if (!request) throw new Error('unreachable: gate without a molt request');
      let result: GateResult;
      if (request.commit === gen) {
        // Nothing to test and nothing to switch to; promoting it would only erase `previous`.
        result = { ok: false, gate: 'same', output: `${gen} is the generation already running; commit a change in the workspace before asking to molt` };
      } else {
        // The gates take minutes. A stop signal aborts them; the request then stays unanswered in the
        // journal, and the next start answers it as interrupted.
        const abort = new AbortController();
        terminate = () => abort.abort();
        try {
          result = await gates(p.candidate, gen, request.commit, abort.signal);
        } finally {
          terminate = null;
        }
        if (stopping) return 'stopped';
      }
      if (!result.ok) {
        appendEvent(p.journal, gen, { type: 'molt.rejected', commit: request.commit, gate: result.gate, output: result.output });
        // Asking is never a reason to roll back, and asking for something new each time is iterating: it
        // waits one unit and is never stopped. Asking for the same rejected commit again is slowed more
        // each time and, at the limit, left to the owner. A run that was only interrupted judged nothing.
        const last = rejected as { commit: string; times: number } | null;
        const times: number = result.gate === 'interrupted' ? 0 : (last?.commit === request.commit ? last.times : 0) + 1;
        if (times > 0) rejected = { commit: request.commit, times };
        if (times >= REJECTION_LIMIT) {
          log(`molt to ${request.commit} rejected at gate ${result.gate}`);
          log(`the same commit keeps being requested and rejected (${request.commit}, ${times} times in a row); stopping`);
          return 'halted';
        }
        const delay = delayAfter(Math.max(times, 1));
        log(`molt to ${request.commit} rejected at gate ${result.gate}; restarting in ${delay} ms`);
        await pause(delay);
        continue;
      }
      if (!moveTo({ current: request.commit, previous: gen })) return 'halted';
      appendEvent(p.journal, request.commit, { type: 'generation.promoted', commit: request.commit, previous: gen });
      log(`promoted ${request.commit}`);
    }
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
    dropLock(p.lock);
  }
}
