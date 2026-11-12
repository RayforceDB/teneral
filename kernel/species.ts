import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gitPaths, runCheck, sh } from './gates';
import { appendEvent } from './journal';
import { ACCEPT_SUFFIX } from './owner';
import { CHANGEABLE, protectedChanges } from './protected';

// The species: one git ref the owner trusts, the project's published line. A lineage is a branch
// of its own that merges the species from time to time, and that is the only way anything outside
// the changeable paths (kernel/protected.ts) ever changes in it. The rule the gate keeps:
//
//   In every generation, everything outside the changeable paths is byte for byte what a commit
//   of the species holds; and the species commit a lineage stands on only moves forward.
//
// "The species commit X stands on" is the merge base of X and the species ref. A molt that leaves
// everything outside the changeable paths alone is not looked at here at all and needs no network.
// One that does not is a mutation from the species, or a mistake, and this file tells which.

/** The branch a lineage's own commits are on (LINEAGE_BRANCH in kernel/supervisor.ts, which builds on this file). */
const LINEAGE = 'lineage/local';

/** The gate that answers for everything about the species, except a plain change to a protected path. */
export const SPECIES_GATE = 'species';

/** What the owner allows: `ask` before each new species commit, `auto` without asking, `off` never. */
export type SpeciesMode = 'ask' | 'auto' | 'off';

/** TENERAL_SPECIES as a mode. Unset, or anything that is not one of the three: `ask`. */
export function speciesMode(value: string | undefined): SpeciesMode {
  const v = (value ?? '').trim().toLowerCase();
  return v === 'auto' || v === 'off' ? v : 'ask';
}

export interface SpeciesRef {
  /** As the owner would write it: `origin/main`, or `main`. */
  name: string;
  /** The full ref. */
  ref: string;
  /** Set when it is a branch of a remote, which the kernel fetches itself before it judges. */
  remote: { name: string; branch: string } | null;
}

const run = (root: string, ...args: string[]) => sh(['git', ...args], root);
const out = (root: string, ...args: string[]): string | null => {
  const r = run(root, ...args);
  return r.code === 0 ? r.stdout.trim() : null;
};
const short = (commit: string): string => commit.slice(0, 12);

/**
 * Which ref is the species. `upstream` is TENERAL_UPSTREAM: `<remote>/<branch>` when its first
 * part names a remote of this repository, else a local branch. Unset: `origin/main` when there is
 * a remote `origin`, else the branch the owner's checkout is on.
 */
export function speciesRef(root: string, upstream?: string): SpeciesRef | { problem: string } {
  const remotes = (out(root, 'remote') ?? '').split('\n').filter(Boolean);
  let name = (upstream ?? '').trim();
  if (name === '') {
    name = remotes.includes('origin') ? 'origin/main' : out(root, 'symbolic-ref', '-q', '--short', 'HEAD') ?? '';
    // The lineage's own branch is never the species: everything on it would then be the species' word.
    if (name === '' || name === LINEAGE) {
      return { problem: 'nothing says which ref is the species: this repository has no remote named origin, and its main checkout is on no branch other than the lineage\'s own. '
        + 'The owner sets TENERAL_UPSTREAM in .env, to <remote>/<branch> or to a local branch' };
    }
  }
  if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(name) || run(root, 'check-ref-format', `refs/heads/${name}`).code !== 0) {
    return { problem: `TENERAL_UPSTREAM is "${name}", which is not the name of a branch` };
  }
  const slash = name.indexOf('/');
  const remote = slash > 0 && remotes.includes(name.slice(0, slash)) ? { name: name.slice(0, slash), branch: name.slice(slash + 1) } : null;
  return { name, ref: remote ? `refs/remotes/${remote.name}/${remote.branch}` : `refs/heads/${name}`, remote };
}

// --- the maintainer's signature ---

/**
 * The file in the owner's checkout that lists the keys whose signature makes a commit the species' word, in the
 * form git and ssh-keygen read (`<principal> <key type> <key>` a line). It is part of the cage: the install's
 * copy is the one read, whatever a generation's checkout holds.
 */
export const SIGNERS = 'SIGNERS';

/**
 * Why species commit `commit` is not signed by a key the install trusts, as git says it; null when it is.
 * Also null where the install keeps no such file: then no signature is asked for.
 */
export function unsigned(root: string, commit: string): string | null {
  const file = join(root, SIGNERS);
  if (!existsSync(file)) return null;
  const r = run(root, '-c', 'gpg.format=ssh', '-c', `gpg.ssh.allowedSignersFile=${file}`, 'verify-commit', commit);
  return r.code === 0 ? null : r.output.trim() || `git verify-commit exited with ${r.code}`;
}

// --- the owner's consent ---

/** How an acceptance reached the kernel: `./box accept`, or `/accept` in a talk client. */
export type AcceptRoute = 'box' | 'talk';

/** What `.teneral/species.json` holds. */
export interface Consent {
  /** The species commit a molt last stood on that the owner had not accepted: what `/accept` with no commit means. */
  asked?: string;
  /** The species commit the owner accepted last. It covers that commit and every one before it. */
  accepted?: string;
  route?: AcceptRoute;
  at?: string;
}

const COMMIT = /^[0-9a-f]{40}$/;
const consentFile = (root: string): string => join(root, '.teneral', 'species.json');

/** Never throws: a file that is missing or is not what it should be holds no consent. */
export function readConsent(root: string): Consent {
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(readFileSync(consentFile(root), 'utf8'));
    if (typeof value === 'object' && value !== null) parsed = value as Record<string, unknown>;
  } catch { /* nothing asked, nothing accepted */ }
  const commit = (v: unknown): string | undefined => (typeof v === 'string' && COMMIT.test(v) ? v : undefined);
  return {
    asked: commit(parsed.asked), accepted: commit(parsed.accepted),
    route: parsed.route === 'box' || parsed.route === 'talk' ? parsed.route : undefined,
    at: typeof parsed.at === 'string' ? parsed.at : undefined,
  };
}

function writeConsent(root: string, consent: Consent): void {
  const file = consentFile(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(consent, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/** The commit `text` names in this repository, when it is a commit id or seven or more characters of one; else null. */
export function commitNamed(root: string, text: string): string | null {
  if (!/^[0-9a-f]{7,40}$/.test(text)) return null;
  const commit = out(root, 'rev-parse', '--verify', '--quiet', `${text}^{commit}`);
  return commit !== null && COMMIT.test(commit) ? commit : null;
}

/**
 * Which commit the owner means by `accept <wanted>`, in either client: the commit named, or, with
 * nothing named, the one the gate last asked about. `subject` is that commit's first line, so the
 * owner sees what it is they accept.
 */
export function chooseAccept(root: string, wanted: string): { commit: string; subject: string } | { why: string } {
  const consent = readConsent(root);
  let commit: string | null;
  if (wanted === '') {
    if (consent.asked === undefined) {
      return { why: 'nothing is waiting for your acceptance: no molt has stood on a species commit you had not accepted. With a commit named, one is accepted ahead of time' };
    }
    commit = consent.asked;
  } else {
    commit = commitNamed(root, wanted);
    if (commit === null) return { why: `"${wanted}" names no commit of this repository: give a commit id, or seven or more characters of one` };
  }
  return { commit, subject: out(root, 'log', '-1', '--format=%s', commit) ?? '' };
}

/**
 * The owner accepts the species commit `commit`, and with it every one before it. The file is
 * written first and the journal second; `gen` is the generation the event is written under.
 */
export function acceptSpecies(root: string, journal: string, gen: string, commit: string, route: AcceptRoute): void {
  const { asked } = readConsent(root);
  writeConsent(root, { ...(asked !== undefined && asked !== commit ? { asked } : {}), accepted: commit, route, at: new Date().toISOString() });
  appendEvent(journal, gen, { type: 'species.accepted', commit, route });
}

/**
 * Take in what the owner accepted from a talk client: the files in the owner's channel whose
 * names end in `.accept` (kernel/owner.ts), each holding one commit id. The kernel reads them,
 * never the body; the kind is in the name, so nothing typed as a line can be one. A file that
 * does not name a commit of this repository is dropped and said. Returns the commits accepted.
 */
export function takeAccepts(root: string, owner: string, journal: string, gen: string, log: (line: string) => void = () => {}): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(owner).filter((name) => name.startsWith('.') && name.endsWith(ACCEPT_SUFFIX)).sort();
  } catch { /* no channel yet */ }
  const taken: string[] = [];
  for (const name of names) {
    const file = join(owner, name);
    try {
      const text = readFileSync(file, 'utf8').trim();
      // A whole commit id and nothing else: the client looked it up before it wrote the file.
      const commit = COMMIT.test(text) ? commitNamed(root, text) : null;
      // Removed first: an acceptance that failed half-way is asked for again, not taken twice.
      rmSync(file);
      if (commit === null) {
        log(`an acceptance from the owner's terminal (${name}) names no commit of this repository; dropped`);
        continue;
      }
      acceptSpecies(root, journal, gen, commit, 'talk');
      taken.push(commit);
    } catch (err) {
      log(`an acceptance from the owner's terminal (${name}) could not be taken: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return taken;
}

// --- the gate ---

export interface SpeciesOptions {
  /** TENERAL_UPSTREAM. */
  upstream?: string;
  /** TENERAL_SPECIES. */
  mode?: string;
  /**
   * The version of the launcher this supervisor was started by (kernel/launcher.ts); null or
   * unset when it was started without one. A mutation from the species changes the kernel, and
   * only the launcher can start another kernel, so without one there is none.
   */
  launcher?: number | null;
  /** How long the fetch of a remote species may take. Default 60 s. */
  fetchTimeoutMs?: number;
}

export type SpeciesVerdict =
  /** `commit`: the species commit the candidate stands on. */
  | { ok: true; commit: string }
  /** `undecided`: nothing was judged, and the same commit may be asked for again, as often as it takes. */
  | { ok: false; gate: string; output: string; undecided?: boolean; interrupted?: boolean };

/** The launcher version the kernel of `commit` says it needs: a number, null for a kernel from before the launcher, or why it cannot be told. */
export function launcherNeeded(dir: string, commit: string): number | null | { problem: string } {
  if (gitPaths(dir, 'ls-tree', '-z', '--name-only', commit, '--', 'kernel/launch.json').length === 0) return null;
  let needs: unknown = null;
  try { needs = (JSON.parse(run(dir, 'show', `${commit}:kernel/launch.json`).stdout) as { launcher?: unknown } | null)?.launcher; } catch { /* said below */ }
  if (typeof needs !== 'number' || !Number.isInteger(needs) || needs < 1) return { problem: 'its kernel/launch.json does not say which launcher version it needs' };
  return needs;
}

const AREA = CHANGEABLE.map((entry) => `\`${entry}\``).join(', ');
const UPDATE = 'your owner must update the install on their machine (git pull in the checkout, then ./box down and ./box up)';

/**
 * Judge a candidate `to` that differs from the generation `from` in `forbidden`, paths outside
 * the changeable ones. With U(X) the species commit X stands on, it passes when U(to) is ahead
 * of U(from), `to` holds outside the changeable paths exactly what U(to) holds, this install's
 * launcher can start its kernel, and the owner allows it. When U(to) is U(from) it is no mutation
 * from the species but a change to protected paths, refused in the words it always was.
 */
export async function judgeSpecies(
  dir: string, root: string, from: string, to: string, forbidden: string[], o: SpeciesOptions = {}, r: { signal?: AbortSignal; graceMs?: number } = {},
): Promise<SpeciesVerdict> {
  const plain: SpeciesVerdict = { ok: false, gate: 'protected', output: `protected paths changed: ${forbidden.join(', ')}` };
  const no = (output: string, undecided = false): SpeciesVerdict => ({ ok: false, gate: SPECIES_GATE, output, ...(undecided ? { undecided } : {}) });
  const mode = speciesMode(o.mode);
  const species = speciesRef(root, o.upstream);
  if ('problem' in species) return { ...plain, output: `${plain.output}\nIf this was meant as a mutation from the species: ${species.problem}.` };

  let unfetched = '';
  // With `off` nothing is taken from the species, so nothing is fetched to find out what there would be.
  if (species.remote !== null && mode !== 'off') {
    const { name, branch } = species.remote;
    const timeoutMs = o.fetchTimeoutMs ?? 60_000;
    const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !(key in env)) env[key] = value;
    const fetched = await runCheck(['git', 'fetch', '--quiet', '--no-tags', name, `+refs/heads/${branch}:${species.ref}`], root, env, { signal: r.signal, graceMs: r.graceMs ?? 5_000, timeoutMs });
    if (fetched.interrupted) return { ok: false, gate: 'interrupted', output: '', interrupted: true };
    if (fetched.code !== 0) unfetched = `the species ${species.name} could not be fetched (git fetch ${name} ${branch}, at most ${timeoutMs / 1000} s): ${fetched.output.trim() || `git exited with ${fetched.code}`}`;
  }
  const tip = out(root, 'rev-parse', '--verify', '--quiet', `${species.ref}^{commit}`);
  if (tip === null) {
    return { ...plain, output: `${plain.output}\nIf this was meant as a mutation from the species: ${unfetched !== '' ? unfetched : `the species ${species.name} (${species.ref}) is not in this repository; your owner sets TENERAL_UPSTREAM`}.` };
  }
  const bases = (commit: string): string[] => (out(root, 'merge-base', '--all', commit, tip) ?? '').split('\n').filter(Boolean);
  const within = (a: string, b: string): boolean => a === b || run(root, 'merge-base', '--is-ancestor', a, b).code === 0;
  const shallow = out(root, 'rev-parse', '--is-shallow-repository') === 'true'
    ? ' This repository is a shallow clone, so git may not see the history the two share: git fetch --unshallow gets it.' : '';
  const stands = bases(to);
  const stood = bases(from);
  if (stands.length === stood.length && stands.every((commit) => stood.includes(commit))) {
    // It stands where the running generation stands: not a mutation from the species, whatever else it is.
    if (unfetched !== '') return { ...plain, output: `${plain.output}\n(${unfetched}. If this commit merges a species commit this repository has not seen, the kernel cannot tell.)` };
    return stands.length === 0 && shallow !== '' ? { ...plain, output: `${plain.output}\n(It shares no history with the species ${species.name}.${shallow})` } : plain;
  }
  if (mode === 'off') {
    return no(`this commit changes files outside ${AREA} by merging the species (${species.name}), and your owner has switched mutations from the species off (TENERAL_SPECIES=off). `
      + 'Molt only what you changed in your own body; tell your owner that the species has moved on, if you want it.');
  }
  // From here on it claims to be a mutation from the species, and that is judged against the species as it is now.
  if (unfetched !== '') return no(`${unfetched}.\nA mutation from the species is judged against the species as its remote has it, so nothing was decided. Call molt again for this commit when the remote can be reached.`, true);
  if (stands.length !== 1) {
    return no(stands.length === 0
      ? `this commit shares no history with the species ${species.name} (${short(tip)}).${shallow} Merge the species into your workspace: git merge ${species.name}.`
      : `this commit has more than one merge base with the species ${species.name} (${stands.map(short).join(', ')}), so there is no one species commit it stands on. `
        + `Merge the species' tip into your workspace (git merge ${species.name}, now ${short(tip)}); then it stands on that.`);
  }
  const on = stands[0]!;
  if (stood.length === 0) {
    return no(`the running generation shares no history with the species ${species.name} that git can see, so it cannot be told whether standing on species commit ${short(on)} moves this lineage forward.${shallow} `
      + 'If the species was never part of this lineage, your owner has to bring it in by hand.');
  }
  const behind = stood.find((commit) => !within(commit, on));
  if (behind !== undefined) {
    return no(`this commit would move the species back from ${behind} to ${on}: the running generation stands on species commit ${short(behind)}, and ${short(on)} is not that commit or a descendant of it. `
      + `A lineage only moves forward along the species. Merge ${species.name} (now ${short(tip)}) into your workspace instead.${shallow}`);
  }
  const differs = protectedChanges(gitPaths(root, 'diff', '--name-only', '--no-renames', '-z', on, to));
  if (differs.length > 0) {
    return no(`outside ${AREA} this commit differs from the species commit ${on} in: ${differs.join(', ')}\n`
      + `A mutation from the species takes everything outside those paths exactly as the species has it. For each path: git checkout ${short(on)} -- <path>, or git rm <path> when the species has no such file. `
      + `If a species commit later than ${short(on)} was meant, merge it first: git merge ${species.name}.${shallow}`);
  }
  const signature = unsigned(root, on);
  if (signature !== null) {
    return no(`the species commit ${on} does not carry a signature by a key this install trusts (the file ${SIGNERS} in your owner's checkout): ${signature}\n`
      + 'A mutation from the species is taken only from a commit its maintainer signed. There is nothing in your workspace to mend: tell your owner which commit it is and what git said.');
  }
  const needs = launcherNeeded(root, to);
  if (typeof needs === 'object' && needs !== null) return no(`the species commit ${on} cannot be started here: ${needs.problem}, so ${UPDATE}.`);
  if (o.launcher === undefined || o.launcher === null) {
    return no(`the species commit ${on} brings another kernel, and this supervisor was not started by the launcher (kernel/launcher.ts), which is what starts another kernel. `
      + `So ${UPDATE}; an install run without the container is started with bun start.`);
  }
  if (needs !== null && needs > o.launcher) {
    return no(`the kernel of species commit ${on} needs launcher version ${needs}, and this install's launcher is version ${o.launcher}: ${UPDATE}. Nothing else is wrong with this commit so far.`);
  }
  if (mode === 'ask') {
    const consent = readConsent(root);
    if (consent.accepted === undefined || !within(on, consent.accepted)) {
      if (consent.asked !== on) writeConsent(root, { ...consent, asked: on });
      return no(`this is a mutation from the species: it moves what this lineage stands on from species commit ${stood.map(short).join(', ') || '(none)'} to ${on}, and with that its kernel. `
        + `Your owner has not accepted that commit${consent.accepted === undefined ? '' : ` (the last one accepted is ${short(consent.accepted)})`}. Nothing has been checked or run yet, and nothing is wrong with the commit so far.\n`
        + `Ask your owner to accept species commit ${short(on)}: /accept in ./box talk, or ./box accept ${short(on)} on their machine. Say what the species brings and that you ran its tests. `
        + 'When they have, call molt again for this same commit; asking again before that only gets this answer again.', true);
    }
  }
  return { ok: true, commit: on };
}

// --- the cage ---

/**
 * The files that are the owner's install and that no mutation from the species puts into effect:
 * the script that builds and runs the container, the image, and the launcher the container starts.
 */
export const CAGE: readonly string[] = ['box', 'Dockerfile', '.dockerignore', 'kernel/launcher.ts', SIGNERS];

/**
 * Which cage files of the kernel at `home` differ from the install's own at `root`. Only a kernel
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
  return `The species has other versions of ${differ.join(', ')} than this install. They are yours and were not changed: `
    + 'look at them with git diff, and take them with git pull in this directory, then ./box down and ./box up.';
}
