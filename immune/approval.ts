import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gitPaths, sh } from './gates';
import { appendEvent } from '../brain/journal';
import { MUTATION_SUFFIX } from '../keeper/owner';
import { FREE, isInert, protectedChanges } from './protected';

// The owner's approval. A mutation changes the agent's body on the agent's own word. It may change
// everything else as well, the stem that judges it included, but such a commit becomes a
// generation only when the owner has approved it. The rule the gate keeps:
//
//   A candidate that differs from the running generation outside the free paths (immune/protected.ts)
//   passes only when, outside those paths, it holds exactly what a commit the owner approved holds.
//
// So an approval is for what a commit holds outside the body, and a later commit that changes only
// the body needs no new one. A mutation that stays inside the free paths is not looked at here at all.
// What makes this safe to allow is not here but in the launcher (stem/launcher.ts), which no
// mutation changes: it holds a new stem on trial and goes back by its own hand when that stem
// does not bring its generation to ready.

/** The gate a mutation waits at for the owner's approval: nothing was judged, and nothing is wrong with it. */
export const APPROVAL_GATE = 'approval';
/** The gate that refuses a change outside the free paths for any other reason: it is switched off, or its stem cannot be started here. */
export const STEM_GATE = 'stem';

/** What the owner allows outside the free paths: `ask` before each such change, `auto` without asking, `off` never. */
export type ApprovalMode = 'ask' | 'auto' | 'off';

/** TENERAL_APPROVAL as a mode. Unset, or anything that is not one of the three: `ask`. */
export function approvalMode(value: string | undefined): ApprovalMode {
  const v = (value ?? '').trim().toLowerCase();
  return v === 'auto' || v === 'off' ? v : 'ask';
}

const run = (root: string, ...args: string[]) => sh(['git', ...args], root);
const out = (root: string, ...args: string[]): string | null => {
  const r = run(root, ...args);
  return r.code === 0 ? r.stdout.trim() : null;
};
const short = (commit: string): string => commit.slice(0, 12);

/**
 * The paths in which commits `a` and `b` hold another stem: everything outside the free paths, but
 * the project's page, documents and CI, which no stem runs. Empty when the owner's word for one is a word for the other.
 */
export function stemDiff(root: string, a: string, b: string): string[] {
  return protectedChanges(gitPaths(root, 'diff', '--name-only', '--no-renames', '-z', a, b)).filter((path) => !isInert(path));
}

/** A list of paths for a line of text: the first few, and how many more. */
export function someOf(paths: readonly string[], most = 8): string {
  return paths.length <= most ? paths.join(', ') : `${paths.slice(0, most).join(', ')} and ${paths.length - most} more`;
}

// --- the owner's word ---

/** How an approval reached the stem: `./one approve`, or `/approve` in a talk client. */
export type ApprovalRoute = 'one' | 'talk';

/** What `.teneral/approval.json` holds. */
export interface Approval {
  /** The commit a mutation last asked for that the owner had not approved: what `/approve` with no commit means. */
  asked?: string;
  /** The commit the owner approved last. It covers every commit that holds the same outside the free paths. */
  approved?: string;
  route?: ApprovalRoute;
  at?: string;
}

const COMMIT = /^[0-9a-f]{40}$/;
const approvalFile = (root: string): string => join(root, '.teneral', 'approval.json');

/** Never throws: a file that is missing or is not what it should be holds no approval. */
export function readApproval(root: string): Approval {
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(readFileSync(approvalFile(root), 'utf8'));
    if (typeof value === 'object' && value !== null) parsed = value as Record<string, unknown>;
  } catch { /* nothing asked, nothing approved */ }
  const commit = (v: unknown): string | undefined => (typeof v === 'string' && COMMIT.test(v) ? v : undefined);
  return {
    asked: commit(parsed.asked), approved: commit(parsed.approved),
    route: parsed.route === 'one' || parsed.route === 'talk' ? parsed.route : parsed.route === 'box' ? 'one' : undefined,
    at: typeof parsed.at === 'string' ? parsed.at : undefined,
  };
}

function writeApproval(root: string, approval: Approval): void {
  const file = approvalFile(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(approval, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/** The commit `text` names in this repository, when it is a commit id or seven or more characters of one; else null. */
export function commitNamed(root: string, text: string): string | null {
  if (!/^[0-9a-f]{7,40}$/.test(text)) return null;
  const commit = out(root, 'rev-parse', '--verify', '--quiet', `${text}^{commit}`);
  return commit !== null && COMMIT.test(commit) ? commit : null;
}

export interface Chosen {
  commit: string;
  /** The commit's first line, so the owner sees what it is they approve. */
  subject: string;
  /** The paths outside the body in which it differs from the generation now running; empty when that is not known. */
  changes: string[];
}

/**
 * Which commit the owner means by `approve <wanted>`, in either client: the commit named, or, with
 * nothing named, the one the gate last asked about. `running` is the generation now running.
 */
export function chooseApproval(root: string, wanted: string, running?: string): Chosen | { why: string } {
  const approval = readApproval(root);
  let commit: string | null;
  if (wanted === '') {
    if (approval.asked === undefined) {
      return { why: 'nothing is waiting for your approval: no mutation has asked to change anything outside the body. With a commit named, one is approved ahead of time' };
    }
    commit = approval.asked;
  } else {
    commit = commitNamed(root, wanted);
    if (commit === null) return { why: `"${wanted}" names no commit of this repository: give a commit id, or seven or more characters of one` };
  }
  let changes: string[] = [];
  try {
    if (running !== undefined) changes = stemDiff(root, running, commit);
  } catch { /* said without them */ }
  return { commit, subject: out(root, 'log', '-1', '--format=%s', commit) ?? '', changes };
}

/** What the owner is told they approved, the same in every client. */
export function approvedSummary(chosen: Chosen): string {
  const what = chosen.changes.length === 0 ? '' : ` It changes ${chosen.changes.length === 1 ? '1 path' : `${chosen.changes.length} paths`} outside the body: ${someOf(chosen.changes)}.`;
  return `Approved commit ${short(chosen.commit)}${chosen.subject === '' ? '' : `, "${chosen.subject.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 80)}"`}.${what}`;
}

/**
 * The owner approves `commit`: what it holds outside the free paths may run here. The file is
 * written first and the journal second; `gen` is the generation the event is written under.
 */
export function approveMutation(root: string, journal: string, gen: string, commit: string, route: ApprovalRoute): void {
  const { asked } = readApproval(root);
  writeApproval(root, { ...(asked !== undefined && asked !== commit ? { asked } : {}), approved: commit, route, at: new Date().toISOString() });
  appendEvent(journal, gen, { type: 'mutation.approved', commit, route });
}

/**
 * Take in what the owner approved from a talk client: the files in the owner's channel whose
 * names end in `.mutation` (keeper/owner.ts), each holding one commit id. The stem reads them,
 * never the body; the kind is in the name, so nothing typed as a line can be one. A file that
 * does not name a commit of this repository is dropped and said. Returns the commits approved.
 */
export function takeApprovals(root: string, owner: string, journal: string, gen: string, log: (line: string) => void = () => {}): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(owner).filter((name) => name.startsWith('.') && name.endsWith(MUTATION_SUFFIX)).sort();
  } catch { /* no channel yet */ }
  const taken: string[] = [];
  for (const name of names) {
    const file = join(owner, name);
    try {
      const text = readFileSync(file, 'utf8').trim();
      // A whole commit id and nothing else: the client looked it up before it wrote the file.
      const commit = COMMIT.test(text) ? commitNamed(root, text) : null;
      // Removed first: an approval that failed half-way is asked for again, not taken twice.
      rmSync(file);
      if (commit === null) {
        log(`an approval from the owner's terminal (${name}) names no commit of this repository; dropped`);
        continue;
      }
      taken.push(commit);
      // Said twice, or said here after `./one approve` said it: it stands already, and the journal has it once.
      if (readApproval(root).approved === commit) continue;
      approveMutation(root, journal, gen, commit, 'talk');
    } catch (err) {
      log(`an approval from the owner's terminal (${name}) could not be taken: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return taken;
}

// --- the gate ---

export interface ApprovalOptions {
  /** TENERAL_APPROVAL. */
  mode?: string;
  /**
   * The version of the launcher this supervisor was started by (stem/launcher.ts); null or
   * unset when it was started without one. A commit that changes the stem is run by another
   * stem, and only the launcher can start another stem, so without one there is none.
   */
  launcher?: number | null;
}

export type ApprovalVerdict =
  | { ok: true }
  /** `undecided`: nothing was judged, and the same commit may be asked for again, as often as it takes. */
  | { ok: false; gate: string; output: string; undecided?: boolean };

/** The launcher version the stem of `commit` says it needs: a number, null for a stem from before the launcher, or why it cannot be told. */
export function launcherNeeded(dir: string, commit: string): number | null | { problem: string } {
  if (gitPaths(dir, 'ls-tree', '-z', '--name-only', commit, '--', 'stem/launch.json').length === 0) return null;
  let needs: unknown = null;
  try { needs = (JSON.parse(run(dir, 'show', `${commit}:stem/launch.json`).stdout) as { launcher?: unknown } | null)?.launcher; } catch { /* said below */ }
  if (typeof needs !== 'number' || !Number.isInteger(needs) || needs < 1) return { problem: 'its stem/launch.json does not say which launcher version it needs' };
  return needs;
}

const AREA = FREE.map((entry) => `\`${entry}\``).join(', ');
const UPDATE = 'your owner must update the install on their machine (git pull in the checkout, then ./one down and ./one up)';

/**
 * Judge a candidate `to` that differs from the generation `from` in `changed`, paths outside the
 * free ones. It passes when this install's launcher can start its stem and the owner allows it:
 * by `auto`, or by having approved a commit that holds outside the free paths what `to` holds.
 */
export function judgeApproval(root: string, from: string, to: string, changed: string[], o: ApprovalOptions = {}): ApprovalVerdict {
  const no = (output: string): ApprovalVerdict => ({ ok: false, gate: STEM_GATE, output });
  // The project's page, documents and CI alone: the stem that runs stays the one that ran, so there is nothing to approve or to hand over.
  if (changed.every(isInert)) return { ok: true };
  const stem = changed.filter((path) => !isInert(path));
  const mode = approvalMode(o.mode);
  if (mode === 'off') {
    return no(`this commit changes files outside ${AREA}: ${someOf(stem)}\n`
      + 'Your owner has switched that off (TENERAL_APPROVAL=off). Mutate only what is inside those paths, and tell your owner what you wanted to change, if you still want it.');
  }
  const needs = launcherNeeded(root, to);
  if (typeof needs === 'object' && needs !== null) {
    return no(`this commit changes files outside ${AREA} (${someOf(stem)}), and its stem cannot be started here: ${needs.problem}. Put stem/launch.json back as it was.`);
  }
  if (o.launcher === undefined || o.launcher === null) {
    return no(`this commit changes files outside ${AREA} (${someOf(stem)}), so it brings another stem, and this supervisor was not started by the launcher (stem/launcher.ts), which is what starts another stem. `
      + `So ${UPDATE}; an install run without the container is started with bun start.`);
  }
  if (needs !== null && needs > o.launcher) {
    return no(`the stem of this commit says it needs launcher version ${needs}, and this install's launcher is version ${o.launcher}. The launcher is your owner's install, and no mutation changes it: ${UPDATE}. Nothing else is wrong with this commit so far.`);
  }
  if (mode === 'ask') {
    const approval = readApproval(root);
    let covered = false;
    try {
      covered = approval.approved !== undefined && stemDiff(root, approval.approved, to).length === 0;
    } catch { /* a commit that is no longer in the repository approves nothing */ }
    if (!covered) {
      if (approval.asked !== to) writeApproval(root, { ...approval, asked: to });
      return { ok: false, gate: APPROVAL_GATE, undecided: true, output: `this commit changes ${stem.length === 1 ? '1 path' : `${stem.length} paths`} outside ${AREA}: ${someOf(stem)}\n`
        + `That is yours to change, but it becomes a generation only when your owner has approved it, and they have not approved this commit${approval.approved === undefined ? '' : ` (the last one approved is ${short(approval.approved)}, which holds something else there)`}. `
        + 'Nothing has been checked or run yet, and nothing is wrong with the commit so far.\n'
        + `Ask your owner to approve commit ${short(to)}: /approve in ./one talk, or ./one approve ${short(to)} on their machine. Tell them which files you changed outside your body and why, and that you ran the tests. `
        + `When they have, ask again for this same commit; asking again before that only gets this answer again. A later commit that changes only ${AREA} needs no new approval.` };
    }
  }
  return { ok: true };
}

// --- the cage ---

/**
 * The files that are the owner's install and that no mutation puts into effect, whatever a
 * generation's commit holds: the script that builds and runs the container, the image, and the
 * launcher the container starts.
 */
export const CAGE: readonly string[] = ['one', 'Dockerfile', '.dockerignore', 'stem/launcher.ts'];

/**
 * Which cage files of the stem at `home` differ from the install's own at `root`. Only a stem
 * that runs from the generation's checkout is asked: any other is the install's, or nobody's.
 */
export function cageDifferences(root: string, home: string): string[] {
  if (home !== join(root, '.teneral', 'live') || !existsSync(home)) return [];
  const bytes = (file: string): string | null => {
    try { return readFileSync(file, 'latin1'); } catch { return null; }
  };
  return CAGE.filter((path) => existsSync(join(home, path)) !== existsSync(join(root, path)) || bytes(join(home, path)) !== bytes(join(root, path)));
}

/** One line for the owner about that, or null when there is nothing to say. */
export function cageNotice(root: string, home: string): string | null {
  let differ: string[] = [];
  try { differ = cageDifferences(root, home); } catch { /* nothing to say */ }
  if (differ.length === 0) return null;
  return `The running generation has other versions of these files than this install: ${differ.map((path) => `./${path}`).join(', ')}. They are yours and were not changed: `
    + 'look at the difference with git diff HEAD lineage/local, and take the species\' versions with git pull in this directory, then ./one down and ./one up.';
}
