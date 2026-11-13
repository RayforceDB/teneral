import { existsSync } from 'node:fs';
import { sh } from '../immune/gates';
import { appendEvent, readEvents, type JournalEvent } from '../brain/journal';
import {
  dropLock, installRoot, paths, readState, saveState, takeLock,
} from '../stem/supervisor';

// `./nest back`: the owner sends the agent back to a generation it lived in before.
//
// The stem rolls back by itself only what fails visibly. A generation that answers once and is
// then useless is for the owner to judge, and after any rollback the state file no longer names
// a generation to return to. So the choice is made from the journal, which remembers them all.

/**
 * The reason on the rollback event. One line, and worded to follow "Generation <commit> ..." in
 * the note the body shows the agent, and "rolled back <a> to <b>: ..." on the owner's terminal.
 */
export const OWNER_REASON = 'was set aside by your owner';

const SHORT = 12;
const short = (commit: string): string => commit.slice(0, SHORT);

interface History {
  /** The generation that was current, each time it changed, oldest first. A generation returned to appears again. */
  timeline: string[];
  /** Every commit the journal names as a generation, in the order first met. */
  known: string[];
  /** When each generation first journaled `generation.ready` under its own id. */
  readyAt: Map<string, string>;
  /** Assistant events per generation. */
  replies: Map<string, number>;
}

function history(events: JournalEvent[]): History {
  const timeline: string[] = [];
  const known: string[] = [];
  const readyAt = new Map<string, string>();
  const replies = new Map<string, number>();
  const know = (commit: string) => { if (!known.includes(commit)) known.push(commit); };
  const becomes = (commit: string) => {
    know(commit);
    if (timeline.at(-1) !== commit) timeline.push(commit);
  };
  for (const e of events) {
    if (e.type === 'generation.started') becomes(e.commit);
    else if (e.type === 'generation.promoted') {
      know(e.previous);
      becomes(e.commit);
    } else if (e.type === 'generation.rolledback') {
      know(e.commit);
      becomes(e.to);
    } else if (e.type === 'generation.ready') {
      know(e.gen);
      if (!readyAt.has(e.gen)) readyAt.set(e.gen, e.ts);
    } else if (e.type === 'assistant') {
      replies.set(e.gen, (replies.get(e.gen) ?? 0) + 1);
    }
  }
  return { timeline, known, readyAt, replies };
}

export interface Generation {
  commit: string;
  /** When it first reported ready; null if it never did. */
  readyAt: string | null;
  replies: number;
  current: boolean;
}

/** The generations this individual has lived in, oldest first. */
export function generations(events: JournalEvent[], current: string): Generation[] {
  const h = history(events);
  const commits = h.known.includes(current) ? h.known : [...h.known, current];
  return commits.map((commit) => ({
    commit, readyAt: h.readyAt.get(commit) ?? null, replies: h.replies.get(commit) ?? 0, current: commit === current,
  }));
}

export function formatList(rows: Generation[]): string {
  return rows.map((row) => {
    const ready = row.readyAt === null ? 'never became ready      ' : `ready ${row.readyAt}`;
    const replies = `${row.replies} ${row.replies === 1 ? 'reply' : 'replies'}`;
    return `${row.current ? '*' : ' '} ${short(row.commit)}  ${ready}  ${replies.padStart(11)}${row.current ? '  current' : ''}`;
  }).join('\n');
}

export type Choice = { ok: true; target: string } | { ok: false; why: string };

/**
 * Which generation to go back to. `wanted` is a commit or a prefix of one, or null for "the one before".
 *
 * A generation qualifies only if the journal shows it reported ready at some time, it is not the
 * current one, and git still has it (`exists`).
 *
 * The one before: take the order in which generations were current. Find the point where the
 * current generation FIRST became current. The answer is the nearest qualifying generation before
 * that point. So after the stem rolled B back to A, the one before A is what A was promoted
 * over, not B; and going back repeatedly walks towards the first generation and stops there.
 */
export function chooseTarget(events: JournalEvent[], current: string, wanted: string | null, exists: (commit: string) => boolean): Choice {
  const h = history(events);
  const qualifies = (commit: string) => commit !== current && h.readyAt.has(commit) && exists(commit);

  if (wanted === null) {
    const first = h.timeline.indexOf(current);
    const upTo = first === -1 ? h.timeline.length : first;
    for (let i = upTo - 1; i >= 0; i--) {
      if (qualifies(h.timeline[i]!)) return { ok: true, target: h.timeline[i]! };
    }
    if (upTo === 0) return { ok: false, why: `there is no generation before ${short(current)}: it is the first this individual lived in` };
    return { ok: false, why: `none of the generations before ${short(current)} can be gone back to: each either never became ready or is no longer in git` };
  }

  if (!/^[0-9a-f]{7,40}$/.test(wanted)) return { ok: false, why: `"${wanted}" does not name a generation: give its commit id, or at least 7 characters of it` };
  const commits = h.known.includes(current) ? h.known : [...h.known, current];
  const matches = commits.filter((commit) => commit.startsWith(wanted));
  if (matches.length === 0) return { ok: false, why: `no generation of this individual starts with ${wanted}` };
  if (matches.length > 1) return { ok: false, why: `more than one generation starts with ${wanted}: ${matches.map(short).join(', ')}. Give more of it` };
  const target = matches[0]!;
  if (target === current) return { ok: false, why: `${short(target)} is the generation it is already on` };
  if (!h.readyAt.has(target)) return { ok: false, why: `${short(target)} never became ready, so there is nothing to show it can start` };
  if (!exists(target)) return { ok: false, why: `${short(target)} is in the journal, but git no longer has that commit` };
  return { ok: true, target };
}

export interface BackResult {
  ok: boolean;
  /** For the owner: what was done, or why nothing was. */
  message: string;
  from?: string;
  to?: string;
}

/**
 * Send the install at `root` back. Refuses while a supervisor runs it. The state is written
 * first and the journal second, as the supervisor does: if this is killed in between, the next
 * supervisor finds the state ahead of the journal and writes the rollback note itself.
 * Neither the workspace nor the lineage branch is touched.
 */
export function goBack(root: string, wanted: string | null, opts: { dryRun?: boolean } = {}): BackResult {
  const p = paths(root);
  const no = (why: string): BackResult => ({ ok: false, message: `Not done: ${why}.` });
  if (!existsSync(p.state)) return no('this individual has never been started here, so it has lived in no generation yet');

  if (!opts.dryRun) {
    let holder: number | null;
    try {
      holder = takeLock(p.lock);
    } catch (err) {
      return no(`the lock ${p.lock} could not be taken (${err instanceof Error ? err.message : String(err)})`);
    }
    if (holder !== null) return no(`the agent is running (its supervisor is pid ${holder}). Stop it first; ./nest back does that by itself`);
  }
  try {
    const state = readState(p);
    const events = readEvents(p.journal);
    const inGit = (commit: string) => sh(['git', 'cat-file', '-e', `${commit}^{commit}`], root).code === 0;
    const choice = chooseTarget(events, state.current, wanted, inGit);
    if (!choice.ok) return no(choice.why);
    const from = state.current;
    const to = choice.target;
    const row = generations(events, from).find((g) => g.commit === to)!;
    const about = `${short(to)}, which became ready ${row.readyAt} and gave ${row.replies} ${row.replies === 1 ? 'reply' : 'replies'}`;
    if (opts.dryRun) return { ok: true, from, to, message: `Would go from ${short(from)} back to ${about}.` };

    saveState(p, { current: to, previous: null });
    // Attributed to the generation gone back to, as the supervisor's own rollbacks are.
    appendEvent(p.journal, to, { type: 'generation.rolledback', commit: from, to, reason: OWNER_REASON });
    return {
      ok: true, from, to,
      message: [
        `Was on  ${short(from)}`,
        `Now on  ${about}.`,
        'The workspace (.teneral/candidate, branch lineage/local) was not touched: it still holds the later code.',
        'The agent is told at its next start, as after any rollback.',
      ].join('\n'),
    };
  } catch (err) {
    return no(err instanceof Error ? err.message : String(err));
  } finally {
    if (!opts.dryRun) dropLock(p.lock);
  }
}

const USAGE = `usage: back [--list | --dry-run] [<commit>]

  back             go to the generation before the current one
  back <commit>    go to that earlier generation: its id, or 7 or more characters of it
  back --list      show the generations this individual has lived in, oldest first; change nothing`;

/** The command line. Returns the exit status: 0 done, 1 refused, 2 not understood. */
export function main(args: string[], root: string, out: (line: string) => void, err: (line: string) => void): number {
  const flags = args.filter((a) => a.startsWith('-'));
  const rest = args.filter((a) => !a.startsWith('-'));
  const unknown = flags.filter((f) => !['--list', '--dry-run', '--help', '-h'].includes(f));
  if (unknown.length > 0 || rest.length > 1 || (flags.includes('--list') && rest.length > 0)) {
    err(USAGE);
    return 2;
  }
  if (flags.includes('--help') || flags.includes('-h')) {
    out(USAGE);
    return 0;
  }
  if (flags.includes('--list')) {
    const p = paths(root);
    if (!existsSync(p.state)) {
      err('This individual has never been started here, so it has lived in no generation yet.');
      return 1;
    }
    try {
      out(formatList(generations(readEvents(p.journal), readState(p).current)));
    } catch (e) {
      err(e instanceof Error ? e.message : String(e));
      return 1;
    }
    return 0;
  }
  const result = goBack(root, rest[0] ?? null, { dryRun: flags.includes('--dry-run') });
  (result.ok ? out : err)(result.message);
  return result.ok ? 0 : 1;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2), installRoot(import.meta.dir), (line) => console.log(line), (line) => console.error(line)));
}
