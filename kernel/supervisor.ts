import {
  closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { identity } from './envelope';
import {
  dropLeftoverGateTrees, git, linkModules, runGates, sh, type GateResult,
} from './gates';
import {
  appendEvent, journalSize, readEvents, readEventsFrom, type JournalEvent,
} from './journal';

/** The agent exits with this code to ask for a molt. */
export const MOLT_EXIT = 75;
/** Crashes in a row, with no reply in between, before a generation is given up on. */
export const CRASH_LIMIT = 3;
/** Rejected molts in a row, with no reply in between, before the supervisor stops and leaves it to the owner. */
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

function readState(p: Paths): State {
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
function saveState(p: Paths, state: State): void {
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
  // Forget worktrees whose directories are gone; git refuses to add those again otherwise.
  git(root, 'worktree', 'prune');
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
function reconcileJournal(p: Paths, state: State): void {
  const events = readEvents(p.journal);
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

/** Locks this process holds, so a lock file naming our own pid can be told from one a dead process with the same pid left. */
const heldLocks = new Set<string>();

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Takes the lock and returns null, or returns the pid of the live supervisor that holds it. */
function takeLock(lock: string): number | null {
  mkdirSync(dirname(lock), { recursive: true });
  // Written aside and linked into place, so the lock never exists without a pid in it.
  const mine = `${lock}.${process.pid}`;
  writeFileSync(mine, `${process.pid}\n`);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(mine, lock);
        heldLocks.add(lock);
        return null;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      let pid = Number.NaN;
      try { pid = Number(readFileSync(lock, 'utf8').trim()); } catch { /* gone again: try once more */ }
      const ours = pid === process.pid && heldLocks.has(lock);
      const alive = Number.isInteger(pid) && pid > 0 && pidAlive(pid) && (pid !== process.pid || ours);
      if (alive) return pid;
      rmSync(lock, { force: true });
    }
    throw new Error('it keeps reappearing');
  } finally {
    rmSync(mine, { force: true });
  }
}

function dropLock(lock: string): void {
  heldLocks.delete(lock);
  rmSync(lock, { force: true });
}

/** What is written to `Paths.child` while a body runs. */
interface ChildRecord {
  pid: number;
  gen: string;
  cmd: string[];
}

/**
 * Whether `pid` is still the process the record describes. Where /proc exists, its
 * command line must be the one that was started; a pid that has since been given to
 * another program does not match. Elsewhere, being alive is all that can be checked.
 */
function isRecordedChild(record: ChildRecord): boolean {
  if (!pidAlive(record.pid)) return false;
  let cmdline: string;
  try {
    cmdline = readFileSync(`/proc/${record.pid}/cmdline`, 'utf8');
  } catch {
    return true;
  }
  return cmdline.split('\0').filter(Boolean).join('\0') === record.cmd.join('\0');
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
  if (record !== null && record.pid !== process.pid && isRecordedChild(record)) {
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
  gates?: (dir: string, from: string, to: string) => GateResult | Promise<GateResult>;
  /** How long a generation has to journal `generation.ready` before it is killed. Default 60 s. */
  readyTimeoutMs?: number;
  /** How long a generation told to stop (SIGTERM) has before it is killed outright (SIGKILL). Default 5 s. */
  killGraceMs?: number;
  /** Wait before a restart: this times the crashes in a row (or the rejected molts in a row) so far, at most RESTART_DELAY_CAP_MS. Default 1 s. */
  restartDelayMs?: number;
  /** Restarts after a crash one generation gets in total, whether or not it replied in between, before it is given up on. Default 10. */
  restartBudget?: number;
  log?: (line: string) => void;
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
  const gates = opts.gates ?? runGates;
  const cmd = opts.agentCmd ?? ['bun', 'body/main.ts'];
  const readyTimeoutMs = opts.readyTimeoutMs ?? 60_000;
  const killGraceMs = opts.killGraceMs ?? 5_000;
  const restartDelayMs = opts.restartDelayMs ?? 1_000;
  const restartBudget = opts.restartBudget ?? 10;
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
  /** Stops the running generation, if there is one. */
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
    try {
      state = init(opts.root);
      reconcileJournal(p, state);
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
    /** Rejected molts in a row with no reply in between. */
    let rejections = 0;
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
      rejections = 0;
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
      const mark = journalSize(p.journal);
      appendEvent(p.journal, gen, { type: 'generation.started', commit: gen });
      const since = () => readEventsFrom(p.journal, mark);
      const isReady = () => since().some((e) => e.type === 'generation.ready' && e.gen === gen);

      const running = Bun.spawn(cmd, {
        cwd: p.live,
        env: {
          ...process.env,
          TENERAL_GEN: gen, TENERAL_JOURNAL: p.journal, TENERAL_WORKSPACE: p.candidate,
          TENERAL_ID: identity(join(p.root, '.teneral')), TENERAL_INBOX: p.inbox, TENERAL_PEERS: p.peers,
          TENERAL_SOUL: p.soul, TENERAL_OWNER: p.owner,
        },
        stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
      });
      const record: ChildRecord = { pid: running.pid, gen, cmd };
      writeFileSync(p.child, JSON.stringify(record));
      const timers: { ready?: ReturnType<typeof setTimeout>; kill?: ReturnType<typeof setTimeout> } = {};
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
      const code = await running.exited;
      clearTimeout(timers.ready);
      clearTimeout(timers.kill);
      terminate = null;
      rmSync(p.child, { force: true });
      if (stopping) return 'stopped';

      const events = since();
      const replied = events.some((e) => e.type === 'assistant');
      if (replied) {
        crashes = 0;
        rejections = 0;
      }
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
        if (spent) reason = `kept crashing after ${restartBudget} restarts`;
        else if (ready) reason = `crashed ${CRASH_LIMIT} times without a reply`;
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
        result = await gates(p.candidate, gen, request.commit);
        // The gates block this thread; let a stop signal that arrived meanwhile be heard before acting on the result.
        await new Promise<void>((resolve) => { setImmediate(resolve); });
        if (stopping) return 'stopped';
      }
      if (!result.ok) {
        appendEvent(p.journal, gen, { type: 'molt.rejected', commit: request.commit, gate: result.gate, output: result.output });
        // Asking is never a reason to roll back, and a generation that speaks between attempts is iterating:
        // it waits one unit each time and is never stopped. Only asking again and again without a reply in
        // between is slowed more each time and, at the limit, left to the owner.
        rejections += 1;
        if (rejections >= REJECTION_LIMIT) {
          log(`molt to ${request.commit} rejected at gate ${result.gate}`);
          log(`generation ${gen} keeps requesting molts the gates reject without a reply in between (${rejections} in a row); stopping`);
          return 'halted';
        }
        const delay = delayAfter(rejections);
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
