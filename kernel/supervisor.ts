import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, linkModules, runGates, type GateResult } from './gates';
import { appendEvent, readEvents, type JournalEvent } from './journal';

/** The agent exits with this code to ask for a molt. */
export const MOLT_EXIT = 75;
/** Crashes in a row, with no reply in between, before a generation is given up on. */
export const CRASH_LIMIT = 3;

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

export interface Paths {
  root: string;
  /** Worktree the running agent's code is checked out in. */
  live: string;
  /** Worktree the agent edits. */
  candidate: string;
  journal: string;
  state: string;
}

export function paths(root: string): Paths {
  return {
    root,
    live: join(root, '.teneral', 'live'),
    candidate: join(root, '.teneral', 'candidate'),
    journal: join(root, 'memory', 'journal.jsonl'),
    state: join(root, '.teneral', 'state.json'),
  };
}

export interface State {
  current: string;
  /** The generation to return to if `current` fails; null when there is none. */
  previous: string | null;
}

function saveState(p: Paths, state: State): void {
  mkdirSync(join(p.root, '.teneral'), { recursive: true });
  const tmp = `${p.state}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, p.state);
}

/** First run: create both worktrees at HEAD. Later runs: read the state back. */
export function init(root: string): State {
  const p = paths(root);
  if (existsSync(p.state)) return JSON.parse(readFileSync(p.state, 'utf8')) as State;
  const head = git(root, 'rev-parse', 'HEAD');
  mkdirSync(join(root, '.teneral'), { recursive: true });
  git(root, 'worktree', 'add', '--detach', p.live, head);
  git(root, 'worktree', 'add', '-b', LINEAGE_BRANCH, p.candidate, head);
  linkModules(root, p.live);
  linkModules(root, p.candidate);
  const state: State = { current: head, previous: null };
  saveState(p, state);
  return state;
}

export interface Options {
  root: string;
  agentCmd?: string[];
  gates?: (dir: string, from: string, to: string) => GateResult;
  /** How long a generation has to journal `generation.ready` before it is killed. */
  readyTimeoutMs?: number;
  log?: (line: string) => void;
}

function lastOf<T extends JournalEvent['type']>(events: JournalEvent[], type: T): Extract<JournalEvent, { type: T }> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === type) return e as Extract<JournalEvent, { type: T }>;
  }
  return undefined;
}

/** Run generations until the agent exits cleanly ('stopped') or nothing can run ('halted'). */
export async function supervise(opts: Options): Promise<'stopped' | 'halted'> {
  const p = paths(opts.root);
  const gates = opts.gates ?? runGates;
  const cmd = opts.agentCmd ?? ['bun', 'body/main.ts'];
  const readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;
  const log = opts.log ?? ((line: string) => console.error(`[teneral] ${line}`));
  let state = init(opts.root);
  let crashes = 0;
  let stopping = false;
  let child: ReturnType<typeof Bun.spawn> | null = null;
  const onSignal = () => { stopping = true; child?.kill(); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    for (;;) {
      const mark = readEvents(p.journal).length;
      appendEvent(p.journal, state.current, { type: 'generation.started', commit: state.current });
      const since = () => readEvents(p.journal).slice(mark);
      const isReady = () => since().some((e) => e.type === 'generation.ready' && e.gen === state.current);

      child = Bun.spawn(cmd, {
        cwd: p.live,
        env: { ...process.env, TENERAL_GEN: state.current, TENERAL_JOURNAL: p.journal, TENERAL_WORKSPACE: p.candidate },
        stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
      });
      const running = child;
      const timer = setTimeout(() => {
        // Nothing may throw out of a timer: a journal that cannot be read counts as not ready.
        let ready = false;
        try { ready = isReady(); } catch { /* not ready */ }
        if (!ready) running.kill();
      }, readyTimeoutMs);
      const code = await running.exited;
      clearTimeout(timer);
      child = null;
      if (stopping) return 'stopped';

      const events = since();
      const replied = events.some((e) => e.type === 'assistant');
      if (replied) crashes = 0;
      const ready = isReady();
      const standing = { hasPrevious: state.previous !== null, crashes };
      let decision = decide({ code, ready }, standing);
      const request = lastOf(events, 'molt.requested');
      if (decision === 'gate' && !request) {
        // A molt with no commit named is a crash like any other, so it is counted and cannot spin.
        log(`generation ${state.current} exited with ${code} but named no commit; treating it as a crash`);
        decision = decide({ code: 1, ready }, standing);
      }

      if (decision === 'stop') return 'stopped';
      if (decision === 'halt') {
        log(`generation ${state.current} exited with ${code} and there is nothing to roll back to`);
        return 'halted';
      }
      if (decision === 'restart') {
        crashes += 1;
        log(`generation ${state.current} exited with ${code}; restarting (${crashes}/${CRASH_LIMIT})`);
        continue;
      }
      if (decision === 'rollback') {
        const to = state.previous!;
        const reason = ready ? `crashed ${CRASH_LIMIT} times without a reply` : `exited with ${code} before it was ready`;
        git(p.live, 'checkout', '-q', '--detach', to);
        appendEvent(p.journal, to, { type: 'generation.rolledback', commit: state.current, to, reason });
        log(`rolled back ${state.current} to ${to}: ${reason}`);
        state = { current: to, previous: null };
        saveState(p, state);
        crashes = 0;
        continue;
      }
      // decision === 'gate', and the request exists or the decision would have been replaced above.
      if (!request) throw new Error('unreachable: gate without a molt request');
      const result = gates(p.candidate, state.current, request.commit);
      if (!result.ok) {
        appendEvent(p.journal, state.current, { type: 'molt.rejected', commit: request.commit, gate: result.gate, output: result.output });
        log(`molt to ${request.commit} rejected at gate ${result.gate}`);
        continue;
      }
      git(p.live, 'checkout', '-q', '--detach', request.commit);
      appendEvent(p.journal, request.commit, { type: 'generation.promoted', commit: request.commit, previous: state.current });
      log(`promoted ${request.commit}`);
      state = { current: request.commit, previous: state.current };
      saveState(p, state);
      crashes = 0;
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
