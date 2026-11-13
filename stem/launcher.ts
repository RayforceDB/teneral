import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// The launcher: the one program the container starts, and the one part of the stem that is the
// install's and never a generation's. A mutation the owner approved can replace every other file of
// the stem, and the stem of a generation is the stem that runs it: the supervisor, the gates
// and the owner's commands are started from `.teneral/live`, the checkout of the current
// generation. This file stays in the owner's checkout and decides only which stem that is, and
// what to do when a stem that was just brought in does not work. It imports nothing of the
// project, on purpose: every line here is a line no mutation can mend.
//
// The contract between this launcher and a stem, version 2 (version 1 knew the directory `stem/` only as `kernel/`;
// a generation that still has it under that name is started from there):
// - A stem says in `stem/launch.json`, as `{ "launcher": N }`, the lowest launcher version it
//   can be started by. A generation without that file is from before the launcher: its stem
//   cannot run from `.teneral/live`, and the install's own stem supervises it, as it always did.
// - The launcher checks the generation out in `.teneral/live` and starts `bun stem/main.ts`
//   there, in the install's directory, with TENERAL_ROOT (the install) and TENERAL_LAUNCHER (this
//   version) set. `bun stem/main.ts --prepare`, from the install's own stem, makes whatever of
//   the state file and the worktrees is missing, and exits with 0.
// - The supervisor exits with 0 when it was stopped, with RELAUNCH_EXIT after it changed the
//   generation to one whose stem differs from its own, and with anything else when it gave up.
// - Before a stem promotes a generation whose stem differs, it writes `.teneral/trial.json`,
//   `{ "generation", "previous" }`. Until the journal holds a `generation.ready` of that generation
//   written under the new stem, the launcher holds that stem on trial: if it cannot be started,
//   ends by itself, or does not get that far in time, the launcher goes back to `previous`, with
//   the state file and a `generation.rolledback` event written by its own hand.
// - `.teneral/state.json` is `{ "current", "previous" }`, and a journal event is one line of JSON.

/** This launcher's version of the contract above. */
export const LAUNCHER = 2;
/** The directory of a generation that holds its supervisor and says which launcher it needs; and the name it had before. */
const OWN = 'stem';
const FORMER = 'kernel';
/** A supervisor exits with this to say: the generation changed and its stem is not mine; start that one. */
export const RELAUNCH_EXIT = 85;
/** The launcher exits with this when the generation's stem needs a newer launcher than this one. */
export const OUTDATED_EXIT = 78;

export interface LaunchOptions {
  /** The install: the owner's checkout. */
  root: string;
  /** How long a stem on trial has to bring its generation to ready. Default 5 minutes: the supervisor's own 60 s for the body, and time to spare for unpacking organs. */
  trialMs?: number;
  /** How long a stem told to stop has before it is killed outright. Default 20 s. */
  graceMs?: number;
  log?: (line: string) => void;
  /** Where a stem's stderr is shown as it comes. Default: this process's stderr. */
  stderr?: (chunk: Buffer) => void;
}

const COMMIT = /^[0-9a-f]{40}$/;
const UPDATE = 'the owner must update the install (git pull, then ./nest down and ./nest up)';

/** Null for what is not JSON: a file that is not there, a line that was torn. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function json(path: string): unknown {
  try {
    return parsed(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Which stem the checkout at `live` is run by: its own (`home` is `live`), or, for a generation
 * from before the launcher, the install's (`home` is `root`). `problem` is set when it has a
 * stem of its own that this launcher cannot start.
 */
export function stemOf(root: string, live: string): { home: string; dir: string; problem: string | null } {
  let text: string | null = null;
  // `stem/` is where a generation keeps what supervises it; one from before that name keeps it in `kernel/`.
  let dir = OWN;
  for (const named of [OWN, FORMER]) {
    try {
      text = readFileSync(join(live, named, 'launch.json'), 'utf8');
      dir = named;
      break;
    } catch { /* not under this name */ }
  }
  if (text === null) return { home: root, dir: OWN, problem: null };
  const needs = (parsed(text) as { launcher?: unknown } | null)?.launcher;
  if (typeof needs !== 'number' || !Number.isInteger(needs) || needs < 1) {
    return { home: root, dir: OWN, problem: `its ${dir}/launch.json does not say which launcher it needs, so this install's launcher (version ${LAUNCHER}) cannot start it: ${UPDATE}` };
  }
  if (needs > LAUNCHER) {
    return { home: root, dir: OWN, problem: `its stem needs launcher version ${needs} and this install's launcher is version ${LAUNCHER}: ${UPDATE}` };
  }
  return { home: live, dir, problem: null };
}

/** Run the launcher until the agent is stopped or nothing can run. Returns the exit status. */
export async function launch(o: LaunchOptions): Promise<number> {
  const { root } = o;
  const log = o.log ?? ((line: string) => console.error(`[teneral] launcher: ${line}`));
  const live = join(root, '.teneral', 'live');
  const statePath = join(root, '.teneral', 'state.json');
  const trialPath = join(root, '.teneral', 'trial.json');
  const journal = join(root, 'memory', 'journal.jsonl');
  const env = { ...process.env, TENERAL_ROOT: root, TENERAL_LAUNCHER: String(LAUNCHER) };

  const readState = (): { current: string; previous: string | null } | null => {
    const s = json(statePath) as { current?: unknown; previous?: unknown } | null;
    if (typeof s?.current !== 'string' || !COMMIT.test(s.current)) return null;
    return { current: s.current, previous: typeof s.previous === 'string' && COMMIT.test(s.previous) ? s.previous : null };
  };
  /** Make the live checkout exactly `commit`, as the supervisor does. Returns why it could not. */
  const checkout = (commit: string): string | null => {
    for (const args of [['checkout', '-q', '-f', '--detach', commit], ['clean', '-q', '-fdx', '-e', 'node_modules']]) {
      const r = spawnSync('git', args, { cwd: live, encoding: 'utf8' });
      if (r.status !== 0) return `git ${args[0]} in ${live} failed: ${(r.stderr ?? '').trim() || (r.error?.message ?? `status ${r.status}`)}`;
    }
    return null;
  };

  let stopping = false;
  let child: ReturnType<typeof spawn> | null = null;
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const onSignal = (signal: NodeJS.Signals) => { stopping = true; child?.kill(signal); };
  for (const signal of signals) process.on(signal, onSignal);

  /**
   * One run of the stem in `home`. With `gen`, it is on trial: `ready` says whether the journal
   * gained that generation's `generation.ready` during the run, and a run that has not got there
   * within the trial time is stopped. `said` is the end of what it wrote to stderr.
   */
  const run = (home: string, dir: string, args: string[], gen: string | null): Promise<{ code: number; ready: boolean; late: boolean; said: string }> => new Promise((resolve) => {
    let said = Buffer.alloc(0);
    let ready = false;
    let late = false;
    let from = 0;
    try { from = statSync(journal).size; } catch { /* no journal yet */ }
    const look = () => {
      if (ready || gen === null) return;
      try {
        const size = statSync(journal).size;
        if (size <= from) return;
        const bytes = Buffer.alloc(size - from);
        const fd = openSync(journal, 'r');
        try { readSync(fd, bytes, 0, bytes.length, from); } finally { closeSync(fd); }
        for (const line of bytes.toString('utf8').split('\n')) {
          if (!line.includes('"generation.ready"')) continue;
          const e = parsed(line) as { type?: unknown; gen?: unknown } | null;
          if (e?.type === 'generation.ready' && e.gen === gen) ready = true;
        }
      } catch { /* looked at again in a moment */ }
      if (ready) {
        // Proven: the trial is over, unless the file already names a later one.
        if ((json(trialPath) as { generation?: unknown } | null)?.generation === gen) rmSync(trialPath, { force: true });
      }
    };
    const stem = spawn(process.execPath, [join(home, dir, 'main.ts'), ...args], { cwd: root, env, stdio: ['inherit', 'inherit', 'pipe'] });
    child = stem;
    stem.stderr!.on('data', (chunk: Buffer) => {
      (o.stderr ?? ((c: Buffer) => { process.stderr.write(c); }))(chunk);
      said = Buffer.concat([said, chunk]).subarray(-2000);
    });
    const stop = () => {
      stem.kill('SIGTERM');
      setTimeout(() => stem.kill('SIGKILL'), o.graceMs ?? 20_000).unref();
    };
    const poll = gen === null ? undefined : setInterval(look, 200);
    const limit = gen === null ? undefined : setTimeout(() => {
      look();
      if (ready) return;
      late = true;
      stop();
    }, o.trialMs ?? 300_000);
    const done = (code: number) => {
      clearInterval(poll);
      clearTimeout(limit);
      child = null;
      look();
      resolve({ code, ready, late, said: said.toString('utf8').trim() });
    };
    stem.on('error', (err) => { said = Buffer.from(`could not be started: ${err.message}`); done(127); });
    stem.on('close', (code, signal) => done(code ?? (signal === null ? 1 : 128)));
  });

  try {
    /** The generation whose stem last asked for another to be started. */
    let asked: string | null = null;
    for (;;) {
      if (stopping) return 0;
      let state = readState();
      let problem = state === null ? `${statePath} does not hold a generation` : checkout(state.current);
      if (problem !== null) {
        // Nothing here yet, or a checkout that has to be mended (an install that was moved): the install's own stem does that.
        const made = await run(root, OWN, ['--prepare'], null);
        if (stopping) return 0;
        state = readState();
        if (made.code !== 0 || state === null) {
          log(`cannot start: ${problem}, and the install's own stem could not mend that (bun stem/main.ts --prepare exited with ${made.code})`);
          return 1;
        }
        problem = checkout(state.current);
      }
      const { current, previous } = state!;
      const t = json(trialPath) as { generation?: unknown; previous?: unknown } | null;
      const trial = previous !== null && t?.generation === current && t?.previous === previous;
      // A trial file that names anything else is from a change that never happened, or is long over.
      if (!trial) rmSync(trialPath, { force: true });

      const stem = stemOf(root, live);
      let outdated = false;
      if (problem === null && stem.problem !== null) {
        problem = stem.problem;
        outdated = true;
      }
      if (problem === null && asked === current) problem = 'its stem asked for another stem to be started without having changed the generation';
      let said = '';
      if (problem === null) {
        if (stem.home === root && asked !== null) log(`generation ${current} is from before the launcher; the install's own stem supervises it`);
        const ran = await run(stem.home, stem.dir, [], trial ? current : null);
        if (ran.code === RELAUNCH_EXIT && !stopping) {
          asked = current;
          continue;
        }
        if (stopping || !trial || ran.ready) return ran.code === RELAUNCH_EXIT ? 0 : ran.code;
        said = ran.said;
        problem = ran.late
          ? `that stem did not bring it to ready within ${(o.trialMs ?? 300_000) / 1000} s`
          : `that stem ended with status ${ran.code} before the generation was ready`;
      }
      if (!trial) {
        log(`generation ${current} cannot be run: ${problem}`);
        return outdated ? OUTDATED_EXIT : 1;
      }
      // The new stem failed its trial. Back to the generation before, by this hand and not the failed stem's:
      // the state first, then the journal, as the supervisor does it, so that a kill in between is mended at the next start.
      const reason = `came with a new stem, and ${problem}, so the launcher went back to the generation before it`
        + (said === '' ? '' : `. That stem's stderr ended with:\n${said}`);
      const tmp = `${statePath}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ current: previous, previous: null }, null, 2)}\n`);
      renameSync(tmp, statePath);
      mkdirSync(dirname(journal), { recursive: true });
      // The line break first: a line a killed writer left unfinished must not swallow this one.
      appendFileSync(journal, `\n${JSON.stringify({
        type: 'generation.rolledback', commit: current, to: previous, reason, v: 1, id: randomUUID(), ts: new Date().toISOString(), gen: previous,
      })}\n`);
      rmSync(trialPath, { force: true });
      log(`rolled back ${current} to ${previous}: it ${reason}`);
      asked = null;
    }
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
  }
}

if (import.meta.main) {
  const root = join(import.meta.dir, '..');
  const args = process.argv.slice(2);
  if (args.length === 0) process.exit(await launch({ root }));
  if (args.length === 1 && args[0] === 'home') {
    // For ./nest: where the stem is that answers the owner's commands now, relative to the install.
    // The checkout is taken as it stands, because a supervisor may be running from it.
    const stem = stemOf(root, join(root, '.teneral', 'live'));
    if (stem.problem !== null) console.error(`[teneral] launcher: the current generation's own stem is not used: ${stem.problem}`);
    console.log(stem.home === root ? '.' : '.teneral/live');
    process.exit(0);
  }
  console.error('usage: bun stem/launcher.ts         run the agent: start the current generation\'s stem, and the next one when it asks');
  console.error('       bun stem/launcher.ts home    print where the stem is that the owner\'s commands use, relative to the install');
  process.exit(2);
}
