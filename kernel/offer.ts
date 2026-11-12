import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { identity } from './envelope';
import { DEFAULT_CHECKS, repoRoot, runGates, type Check, type GateResult } from './gates';
import { DEFAULT_API, GitHubError, TOKEN_FILE, TOKEN_NEEDS, api, gitRemote, githubRemote, hasToken, remoteFailure, saveToken, type Hub } from './github';
import { appendEvent } from './journal';
import { GIT_NAMESPACE, KEY_FILE, WITNESS_NAMESPACE, commitSigner, ensureKey, run, signCommits, signText, signerOf, type Key } from './offerkey';
import { approve, approved, useApproval } from './owner';
import { isProtected } from './protected';
import { speciesRef as resolveSpecies } from './species';
import { authDir, userAgent } from './providers';

// Offering a change to the species, and witnessing somebody else's offer.
//
// The species is a git repository; only a human merges into its main branch. An individual that
// built something of general use puts it on a branch of its own that holds nothing else, and then:
//
//   check     the kernel looks at the branch as a stranger would: it descends from the species, its
//             commits are signed with this individual's key, its last commit says what and why,
//             nothing in it looks private, and the gates pass on it as on a fresh seed;
//   approve   the owner says that exactly this commit may go out (kernel/owner.ts);
//   publish   the commit is pushed to contrib/<individual>/<name> and a pull request is opened;
//   witness   another individual runs the same check on that pull request and posts what it saw.
//
// None of it reaches the species' main branch, and none of it is a boundary against a body that
// means harm: the agent has a shell where the key, the token and the approvals lie. It keeps an
// honest agent from publishing by mistake what it should not, and gives the human who merges
// something to go by.

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const COMMIT = /^[0-9a-f]{40}$/;
const short = (commit: string): string => commit.slice(0, 12);

function git(dir: string, ...args: string[]): string {
  const r = run(['git', ...args], { cwd: dir });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout.toString()).trim()}`);
  return r.stdout.toString();
}
const gitOk = (dir: string, ...args: string[]): boolean => run(['git', ...args], { cwd: dir }).code === 0;

// --- settings ---

/**
 * The owner's settings. They are read from `.env` itself where there is one, at every command: a
 * change needs no restart, and a variable set in the shell the agent runs commands in changes
 * nothing. Without that file (an install run by hand), from the environment.
 */
export function settings(root: string, env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  let text: string;
  try {
    text = readFileSync(join(root, '.env'), 'utf8');
  } catch {
    return env;
  }
  const found: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (m) found[m[1]!] = m[2]!.trim();
  }
  return found;
}

export type Consent = 'ask' | 'auto' | 'off';

/** `TENERAL_PUBLISH`: whether anything goes out, and whether the owner is asked first. Anything but `auto` and `off` is `ask`. */
export function consent(s: Record<string, string | undefined>): Consent {
  return s.TENERAL_PUBLISH === 'auto' || s.TENERAL_PUBLISH === 'off' ? s.TENERAL_PUBLISH : 'ask';
}

/**
 * Which ref is the species, as the receiving side decides it (`speciesRef` in kernel/species.ts): `TENERAL_UPSTREAM`,
 * as `<remote>/<branch>` or a local branch, with the same defaults. `remote` is null for a local branch,
 * which can be checked against but not published to.
 */
export function speciesRef(root: string, s: Record<string, string | undefined>): { ref: string; remote: string | null; branch: string } {
  const found = resolveSpecies(root, s.TENERAL_UPSTREAM);
  if ('problem' in found) throw new Error(found.problem);
  return { ref: found.name, remote: found.remote?.name ?? null, branch: found.remote?.branch ?? found.name };
}

/** The species' head as this install knows it. Nothing is fetched here. */
export function speciesHead(root: string, s: Record<string, string | undefined>): string {
  const { ref } = speciesRef(root, s);
  const r = run(['git', 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root });
  if (r.code !== 0) throw new Error(`the species ref ${ref} (TENERAL_UPSTREAM) names no commit here`);
  return r.stdout.toString().trim();
}

/**
 * Where the species is published: the remote of its ref. A remote on github.com is pushed to over
 * HTTPS whatever way it is spelled here. `TENERAL_SPECIES_REPO` (`owner/name`) and
 * `TENERAL_GITHUB_API` say it for a remote that is somewhere else: a GitHub server of one's own, or a test.
 */
export function hubOf(root: string, s: Record<string, string | undefined>): Hub & { branch: string } {
  const { ref, remote, branch } = speciesRef(root, s);
  if (remote === null) throw new Error(`the species ref ${ref} is a local branch, and there is nowhere to publish to. TENERAL_UPSTREAM has to name it as <remote>/<branch>`);
  const url = git(root, 'remote', 'get-url', remote).trim();
  const known = githubRemote(url);
  const slug = s.TENERAL_SPECIES_REPO || known?.slug;
  if (!slug || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(slug)) {
    throw new Error(`the remote ${remote} (${url}) is not on github.com, so TENERAL_SPECIES_REPO has to say which repository it is, as owner/name`);
  }
  return { url: known?.https ?? url, slug, api: (s.TENERAL_GITHUB_API || DEFAULT_API).replace(/\/+$/, ''), branch };
}

// --- the leak scan ---

export interface Finding {
  /** The commit that brings it, or the one whose message holds it. */
  commit: string;
  /** `path`, `path:line`, or `the commit message`. */
  where: string;
  what: string;
}

/** Directories of an individual that are never committed, at the top of the repository. */
const PRIVATE_TOP = ['soul', 'memory', 'inbox', 'node_modules'];
/** Names that are private wherever they stand in a path. */
const PRIVATE_ANYWHERE = ['.teneral', '.env'];
/** File names keys are usually kept under. */
const KEY_NAME = /^(id_(rsa|dsa|ecdsa|ed25519)|.*\.(pem|p12|pfx|ppk|keystore))$/;

/** Strings that look like a credential whoever issued it. Each is a shape, not a proof. */
const SHAPES: readonly [string, RegExp][] = [
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['an API key (sk-...)', /\bsk-[A-Za-z0-9_-]{24,}/],
  ['an AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['a signed web token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/],
  ['an address with a password in it', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:[^\s/@'"]{6,}@[^\s'"]/i],
];
/** A quoted value of some length given to a name that says it is a secret. */
const ASSIGNED = /(?:api[_-]?key|secret|passw(?:or)?d|token|authorization)["']?\s*[:=]\s*["'`]([A-Za-z0-9+/_.=-]{24,})["'`]/i;

interface Secret { value: string; what: string }

/**
 * This install's own secrets, to be looked for literally: what `.env` and the environment hold
 * under a name that says key, token, secret or password, and what the files of the auth directory
 * hold. They are compared and never shown.
 */
export function ownSecrets(root: string, env: Record<string, string | undefined> = process.env): Secret[] {
  const found: Secret[] = [];
  const add = (value: unknown, what: string) => {
    if (typeof value === 'string' && value.trim().length >= 12) found.push({ value: value.trim(), what });
  };
  const named = /KEY|TOKEN|SECRET|PASSW/i;
  for (const [source, values] of [['.env', existsSync(join(root, '.env')) ? settings(root, {}) : {}], ['the environment', env]] as const) {
    for (const [name, value] of Object.entries(values)) if (named.test(name)) add(value, `the value of ${name} from ${source}`);
  }
  const auth = authDir(root);
  let names: string[] = [];
  try { names = readdirSync(auth); } catch { /* no credentials here */ }
  for (const name of names) {
    if (name.endsWith('.pub') || name.endsWith('.tmp') || name.startsWith('.')) continue;
    let text: string;
    try { text = readFileSync(join(auth, name), 'utf8'); } catch { continue; }
    const at = `.teneral/auth/${name}`;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    if (typeof parsed === 'object' && parsed !== null) {
      for (const [field, value] of Object.entries(parsed)) if (/token|secret|key|email|subject|passw/i.test(field) && field !== 'token_type') add(value, `${field} from ${at}`);
    } else {
      // A token is one line; a key is many, and each of them gives it away.
      for (const line of text.split('\n')) if (!line.startsWith('-----') && line.trim().length >= 20) add(line, `a line of ${at}`);
    }
  }
  return found;
}

function inText(text: string, secrets: readonly Secret[]): string | null {
  for (const s of secrets) if (text.includes(s.value)) return `${s.what}, literally`;
  for (const [what, shape] of SHAPES) if (shape.test(text)) return `what looks like ${what}`;
  const assigned = ASSIGNED.exec(text);
  if (assigned && /[0-9]/.test(assigned[1]!) && /[A-Za-z]/.test(assigned[1]!)) return 'a long literal value given to a name that says secret, token, key or password';
  return null;
}

function pathProblem(path: string, layout: ReadonlySet<string>): string | null {
  const segments = path.split('/');
  if (/[\\\x00-\x1f\x7f"]/.test(path)) return 'a path with a control character, a quote or a backslash in it';
  if (PRIVATE_TOP.includes(segments[0]!)) return `under ${segments[0]}/, which belongs to one individual and is never committed`;
  const hit = segments.find((s) => PRIVATE_ANYWHERE.includes(s) || (s.startsWith('.env.') && s !== '.env.example'));
  if (hit !== undefined) return `named ${hit}, which is where an install keeps what is its own`;
  if (KEY_NAME.test(segments.at(-1)!)) return 'named the way key files are';
  if (!layout.has(segments[0]!)) return `outside the species' layout: nothing named ${segments[0]} is at the top of the species`;
  return null;
}

/**
 * Looks through everything the commits from `base` to `tip` would publish: every path a commit
 * touches, every line a commit adds, and every commit message. History counts: a file added by
 * one commit and removed by the next is still published.
 *
 * What it refuses: a path outside what the species has at its top; a path under a private
 * directory or named the way private files are; an added line or a message that holds one of this
 * install's own secrets literally, or a string shaped like a credential.
 *
 * What it does not catch: anything private that is prose (a name, an address, something the owner
 * said), a secret that is encoded, split or shaped unlike the above, anything inside a file git
 * takes for binary, and a secret of somebody else's that has no known shape. It is a net for
 * mistakes. The owner reading the summary is the check.
 */
export function scan(root: string, base: string, tip: string, secrets: readonly Secret[]): { findings: Finding[]; binary: string[] } {
  const findings: Finding[] = [];
  const binary = new Set<string>();
  const layout = new Set(git(root, 'ls-tree', '-z', '--name-only', base).split('\0').filter(Boolean));
  for (const commit of git(root, 'rev-list', '--reverse', `${base}..${tip}`).split('\n').filter(Boolean)) {
    const message = inText(git(root, 'log', '-1', '--format=%an <%ae>%n%B', commit), secrets);
    if (message !== null) findings.push({ commit, where: 'the commit message', what: message });
    // Against the first parent: what this commit, and for a merge what its other side, brings in.
    for (const path of git(root, 'diff', '--name-only', '--no-renames', '-z', `${commit}^`, commit).split('\0').filter(Boolean)) {
      const problem = pathProblem(path, layout);
      if (problem !== null) findings.push({ commit, where: path, what: problem });
    }
    let path = '';
    let line = 0;
    let inHunk = false;
    for (const row of git(root, 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '-U0', `${commit}^`, commit).split('\n')) {
      if (row.startsWith('diff --git ')) {
        inHunk = false;
      } else if (!inHunk && row.startsWith('+++ ')) {
        path = row.slice(4).replace(/^b\//, '');
      } else if (!inHunk && row.startsWith('Binary files ')) {
        binary.add(/ and (?:b\/)?(.*) differ$/.exec(row)?.[1] ?? row);
      } else if (row.startsWith('@@ ')) {
        inHunk = true;
        line = Number(/\+(\d+)/.exec(row)?.[1] ?? 1) - 1;
      } else if (inHunk && row.startsWith('+')) {
        line += 1;
        const what = inText(row.slice(1), secrets);
        if (what !== null) findings.push({ commit, where: `${path}:${line}`, what });
      }
    }
  }
  return { findings, binary: [...binary] };
}

// --- the check ---

export interface Step {
  name: string;
  /** null: not run, because an earlier step failed. */
  ok: boolean | null;
  detail: string;
}

export interface Report {
  what: 'publish' | 'witness';
  ok: boolean;
  commit: string;
  /** The species commit it was checked against. */
  species: string;
  /** The local branch, for an offer of one's own. */
  branch?: string;
  /** The pull request, for a witness. */
  pr?: number;
  /** The last commit's subject and the rest of its message: the pull request's title and description. */
  title: string;
  body: string;
  commits: { commit: string; subject: string; signer: string | null }[];
  files: { path: string; change: string; bytes: number }[];
  /** The changed paths outside what a mutation may change: the kernel, its tests, the project's own files. */
  outside: string[];
  /** Changed files git takes for binary: nothing looked inside them. */
  binary: string[];
  steps: Step[];
  at: string;
  /** The end of what the failing gate printed. Kept here and shown here; never sent anywhere. */
  output?: string;
  published?: { url: string; branch: string; at: string };
}

/** What the last commit of an offer has to say, each at the start of a line of its message. */
export const SECTIONS = ['What it changes:', 'Why:', 'Evidence:', 'Not verified:'] as const;

/** The gates of a mutation, in the order they run, as a fresh seed meets them. */
const GATES = ['body', 'size', 'organs', 'types', 'tests-kernel', 'tests-body', 'smoke'] as const;

/**
 * The full gates on `commit` as if it were a fresh seed: its size, its organs as it pins them, the
 * type check, the kernel's tests, the body's tests and the smoke run, in a checkout made for it.
 * The commit is compared with itself, so the rule about which paths a mutation may change, and any
 * rule about what the rest must be identical to, has nothing to say here: an offer may touch the
 * kernel, and it is the human who decides about that.
 */
async function seedGates(root: string, commit: string, o: { provider?: string; signal?: AbortSignal; checks?: readonly Check[]; smoke?: boolean }): Promise<GateResult> {
  // Named like a gate checkout, so one left behind by a kill is cleared with those at the next start.
  const tree = join(root, '.teneral', `gate-offer-${short(commit)}`);
  const drop = () => {
    if (existsSync(tree)) run(['git', 'worktree', 'remove', '--force', tree], { cwd: root });
    rmSync(tree, { recursive: true, force: true });
    run(['git', 'worktree', 'prune'], { cwd: root });
  };
  mkdirSync(join(root, '.teneral'), { recursive: true });
  drop();
  try {
    git(root, 'worktree', 'add', '--detach', tree, commit);
    return await runGates(tree, commit, commit, o.checks ?? DEFAULT_CHECKS, { signal: o.signal, provider: o.provider, ...(o.smoke === undefined ? {} : { smoke: o.smoke }) });
  } catch (err) {
    return { ok: false, gate: 'kernel', output: reasonOf(err) };
  } finally {
    drop();
  }
}

/** What `commit` holds beyond `species`, read from git alone: nothing is run. */
export function describe(root: string, species: string, commit: string): Pick<Report, 'title' | 'body' | 'commits' | 'files' | 'outside'> {
  const message = git(root, 'log', '-1', '--format=%B', commit).trim();
  const [title = '', ...rest] = message.split('\n');
  const commits = git(root, 'rev-list', '--reverse', `${species}..${commit}`).split('\n').filter(Boolean).map((c) => ({
    commit: c, subject: git(root, 'log', '-1', '--format=%s', c).trim(), signer: commitSigner(root, c),
  }));
  const sizes = new Map<string, number>();
  for (const record of git(root, 'ls-tree', '-r', '-l', '-z', commit).split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    sizes.set(record.slice(tab + 1), Number(record.slice(0, tab).split(/ +/)[3]) || 0);
  }
  const fields = git(root, 'diff', '--name-status', '--no-renames', '-z', species, commit).split('\0').filter(Boolean);
  const files: Report['files'] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const change = ({ A: 'added', M: 'changed', D: 'removed', T: 'changed' } as Record<string, string>)[fields[i]![0]!] ?? fields[i]!;
    files.push({ path: fields[i + 1]!, change, bytes: sizes.get(fields[i + 1]!) ?? 0 });
  }
  return { title, body: rest.join('\n').trim(), commits, files, outside: files.map((f) => f.path).filter(isProtected) };
}

export interface CheckOptions {
  what: 'publish' | 'witness';
  /** For an offer of one's own: every commit must be signed with this key, and the last must describe the offer. */
  key?: Key;
  secrets?: readonly Secret[];
  provider?: string;
  signal?: AbortSignal;
  /** In place of running the gates: for tests of everything around them. */
  gates?: (commit: string) => Promise<GateResult>;
}

/**
 * Looks at `commit` as an offer on top of `species`. Every step that only reads is done whatever
 * the others said; the gates, which run the commit's code, only when all of those passed.
 */
export async function check(root: string, species: string, commit: string, o: CheckOptions): Promise<Report> {
  const steps: Step[] = [];
  const descends = commit !== species && gitOk(root, 'merge-base', '--is-ancestor', species, commit);
  const empty = { title: '', body: '', commits: [], files: [], outside: [] };
  const said = descends ? describe(root, species, commit) : empty;
  steps.push({
    name: 'descends', ok: descends,
    detail: descends ? `${said.commits.length} commit${said.commits.length === 1 ? '' : 's'} on top of the species at ${short(species)}`
      : `it is not built on the species' head, ${short(species)}: start the branch there, or rebase it onto it, so that it holds your offer and nothing else`,
  });
  let binary: string[] = [];
  if (descends) {
    const signers = [...new Set(said.commits.map((c) => c.signer ?? 'none'))];
    const unsigned = said.commits.filter((c) => (o.key ? c.signer !== o.key.fingerprint : c.signer === null));
    steps.push({
      name: 'signed', ok: unsigned.length === 0,
      detail: unsigned.length === 0 ? `every commit carries a valid SSH signature, by ${signers.join(', ')}${o.key ? ' (this individual\'s key)' : '; whose key that is, nothing here knows'}`
        : `${unsigned.map((c) => short(c.commit)).join(', ')} ${o.key ? `not signed with this individual's key (${o.key.fingerprint}): bun kernel/offer.ts sign <branch> signs them` : 'carry no valid SSH signature'}`,
    });
    if (o.what === 'publish') {
      const missing = SECTIONS.filter((s) => !said.body.split('\n').some((line) => line.toLowerCase().startsWith(s.toLowerCase())));
      steps.push({
        name: 'description', ok: missing.length === 0 && said.title !== '',
        detail: missing.length === 0 ? 'the last commit\'s message says what it changes, why, the evidence and what was not verified'
          : `the last commit's message becomes the pull request's text and has to have a line starting with each of: ${SECTIONS.join(' ')} Missing: ${missing.join(' ')}`,
      });
    }
    const scanned = scan(root, species, commit, o.secrets ?? []);
    binary = scanned.binary;
    steps.push({
      name: 'scan', ok: scanned.findings.length === 0,
      detail: scanned.findings.length === 0 ? 'no private path, none of this install\'s own secrets and nothing shaped like a credential, in any commit or message'
        : scanned.findings.slice(0, 20).map((f) => `${short(f.commit)} ${f.where}: ${f.what}`).join('\n'),
    });
  }
  let output: string | undefined;
  if (steps.every((s) => s.ok)) {
    const r = await (o.gates ?? ((c: string) => seedGates(root, c, { provider: o.provider, signal: o.signal })))(commit);
    const at = (GATES as readonly string[]).indexOf(r.gate);
    if (!r.ok && at === -1) {
      steps.push({ name: 'gates', ok: false, detail: `the gates could not be run to an answer (${r.gate})` });
    } else {
      GATES.forEach((gate, i) => steps.push({ name: gate, ok: r.ok || i < at ? true : i === at ? false : null, detail: '' }));
    }
    if (!r.ok) output = r.output;
  } else {
    for (const gate of GATES) steps.push({ name: gate, ok: null, detail: '' });
  }
  return { what: o.what, ok: steps.every((s) => s.ok === true), commit, species, ...said, binary, steps, at: new Date().toISOString(), ...(output === undefined ? {} : { output }) };
}

const mark = (ok: boolean | null): string => (ok === null ? 'not run' : ok ? 'pass' : 'FAIL');

/** The report as the owner and the agent read it. */
export function formatReport(r: Report): string {
  const lines: string[] = [];
  lines.push(`${r.what === 'witness' ? `pull request #${r.pr}` : `offer ${r.branch ?? ''}`.trim()}: commit ${r.commit}`);
  lines.push(`on the species at ${short(r.species)}`);
  if (r.title !== '') lines.push('', `  ${r.title}`, ...(r.body === '' ? [] : ['', ...r.body.split('\n').map((l) => `  ${l}`)]));
  if (r.commits.length > 0) lines.push('', `commits (${r.commits.length}):`, ...r.commits.map((c) => `  ${short(c.commit)} ${c.subject}`));
  if (r.files.length > 0) {
    const total = r.files.reduce((sum, f) => sum + f.bytes, 0);
    lines.push('', `files (${r.files.length}, ${total} bytes as they would stand):`, ...r.files.map((f) => `  ${f.change.padEnd(8)}${String(f.bytes).padStart(8)}  ${f.path}`));
  }
  if (r.outside.length > 0) lines.push('', `It changes ${r.outside.length} path${r.outside.length === 1 ? '' : 's'} a mutation could not: the kernel, its tests or the project's own files.`, ...r.outside.map((p) => `  ${p}`));
  if (r.binary.length > 0) lines.push('', `Binary, so nothing looked inside: ${r.binary.join(', ')}`);
  lines.push('', 'checks:');
  for (const s of r.steps) lines.push(`  ${s.name.padEnd(13)}${mark(s.ok)}${s.detail === '' ? '' : `  ${s.detail.split('\n').join('\n                 ')}`}`);
  if (r.output) lines.push('', 'the failing gate printed, at its end:', ...r.output.trimEnd().split('\n').slice(-40).map((l) => `  | ${l}`));
  if (r.published) lines.push('', `published ${r.published.at} as ${r.published.branch}: ${r.published.url}`);
  return lines.join('\n');
}

// --- records ---

/** Where the kernel keeps what it found for each commit it checked, and what became of it. */
export const offersDir = (root: string): string => join(root, '.teneral', 'offers');

function saveReport(root: string, r: Report): void {
  mkdirSync(offersDir(root), { recursive: true });
  const file = join(offersDir(root), `${r.commit}.json`);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(r, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

export function readReport(root: string, commit: string): Report | null {
  try {
    const r = JSON.parse(readFileSync(join(offersDir(root), `${commit}.json`), 'utf8')) as Report;
    return r.commit === commit && Array.isArray(r.steps) ? r : null;
  } catch {
    return null;
  }
}

export function reports(root: string): Report[] {
  let names: string[] = [];
  try { names = readdirSync(offersDir(root)); } catch { /* nothing was ever checked */ }
  return names.filter((n) => /^[0-9a-f]{40}\.json$/.test(n)).map((n) => readReport(root, n.slice(0, 40))).filter((r): r is Report => r !== null)
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** Whether a checked commit is waiting for the owner's word. */
const waiting = (owner: string, r: Report): boolean => (r.what === 'witness' || r.ok) && !r.published && !approved(owner, r.commit);

// --- the install, as these commands need it ---

interface Install {
  root: string;
  s: Record<string, string | undefined>;
  auth: string;
  owner: string;
  id: string;
}

export function install(root: string, env: Record<string, string | undefined> = process.env): Install {
  return { root, s: settings(root, env), auth: authDir(root), owner: join(root, '.teneral', 'owner'), id: identity(join(root, '.teneral')) };
}

/** The generation that is current, for the journal; the checkout's own commit before there is a state. */
function generation(root: string): string {
  try {
    const current = (JSON.parse(readFileSync(join(root, '.teneral', 'state.json'), 'utf8')) as { current?: unknown }).current;
    if (typeof current === 'string' && COMMIT.test(current)) return current;
  } catch { /* never started */ }
  return git(root, 'rev-parse', 'HEAD').trim();
}

const journalOf = (root: string): string => join(root, 'memory', 'journal.jsonl');

/** What a command came to: its exit status and what it says. 0 done, 1 refused or failed, 3 waiting for the owner. */
export interface Outcome { status: 0 | 1 | 3; text: string }
export const WAITING = 3;

const OFF = 'TENERAL_PUBLISH is off in your owner\'s settings: nothing goes out from this install.';
const askOwner = (commit: string): string => `Waiting for your owner. Nothing goes out until they approve exactly this commit:\n\n    ./box offer approve ${short(commit)}\n\n`
  + `(or /approve ${short(commit)} in ./box talk; /offers shows what is waiting). Tell them what it is and why, then run this command again. A commit changed after the approval needs a new one.`;

function resolve(root: string, name: string): string {
  const r = run(['git', 'rev-parse', '--verify', '--quiet', `${name}^{commit}`], { cwd: root });
  if (r.code !== 0) throw new Error(`${name} names no commit in this repository`);
  return r.stdout.toString().trim();
}

/** The name an offer is published under, from its branch: what is left of `offer/<name>` in small letters, digits and dashes. */
export function slugOf(branch: string): string {
  const slug = branch.replace(/^refs\/heads\//, '').replace(/^offer\//, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  if (slug === '') throw new Error(`${branch} gives no name to publish under: name the branch offer/<a-few-words>`);
  return slug;
}

const branchRef = (root: string, branch: string): string => {
  const ref = `refs/heads/${branch.replace(/^refs\/heads\//, '')}`;
  if (!gitOk(root, 'show-ref', '--verify', '--quiet', ref)) throw new Error(`${branch} is not a branch of this repository. An offer is a branch, for instance offer/<a-few-words>, started at the species' head`);
  return ref;
};

// --- sign, check ---

/** Sign what `branch` holds beyond the species with this individual's key, and move the branch to the signed commits. */
export function sign(i: Install, branch: string): Outcome {
  const ref = branchRef(i.root, branch);
  const tip = resolve(i.root, ref);
  const species = speciesHead(i.root, i.s);
  if (!gitOk(i.root, 'merge-base', '--is-ancestor', species, tip)) {
    return { status: 1, text: `${branch} is not built on the species' head, ${short(species)}; rebase it first: signing would otherwise sign commits that are not your offer.` };
  }
  const key = ensureKey(i.auth, i.id);
  const signed = signCommits(i.root, species, tip, key);
  if (signed === tip) return { status: 0, text: `${branch} was signed already: ${tip}` };
  git(i.root, 'update-ref', '-m', 'offer: signed', ref, signed, tip);
  return { status: 0, text: `${branch} is now ${signed}, every commit signed with ${key.fingerprint}. The files are as they were.` };
}

/** `check <branch>`: look at the branch as an offer, keep what was found, and say it. */
export async function checkBranch(i: Install, branch: string, o: Pick<CheckOptions, 'gates' | 'signal'> = {}): Promise<Outcome & { report: Report }> {
  const commit = resolve(i.root, branchRef(i.root, branch));
  const species = speciesHead(i.root, i.s);
  const report = { ...await check(i.root, species, commit, { what: 'publish', key: ensureKey(i.auth, i.id), secrets: ownSecrets(i.root), provider: i.s.TENERAL_PROVIDER, ...o }), branch };
  saveReport(i.root, report);
  const mode = consent(i.s);
  const next = !report.ok ? 'Not ready to publish. Mend what failed, commit, sign and check again: a changed branch is another commit, and is checked from the start.'
    : mode === 'off' ? OFF
      : `Ready. This is what would be published, as contrib/${i.id}/${slugOf(branch)} and a pull request against the species.\n`
        + (mode === 'auto' ? `Your owner set TENERAL_PUBLISH=auto: bun kernel/offer.ts publish ${branch} sends it.` : `Your owner has to approve it first: bun kernel/offer.ts publish ${branch} says how.`);
  return { status: report.ok ? 0 : 1, text: `${formatReport(report)}\n\n${next}`, report };
}

// --- publish ---

interface Pull { number: number; html_url: string; state: string; head: { sha: string; ref: string }; base: { ref: string } }

function asPull(value: unknown): Pull {
  const p = value as Partial<Pull> | null;
  if (!p || typeof p.number !== 'number' || typeof p.html_url !== 'string' || typeof p.head?.sha !== 'string' || typeof p.base?.ref !== 'string') {
    throw new GitHubError(0, 'GitHub answered with something that is not a pull request as its documentation describes one');
  }
  return p as Pull;
}

/** What stands under the agent's own words in a pull request: who offers it and what its install checked. Facts, said as such. */
function footer(i: Install, r: Report, key: Key): string {
  return ['---', `Offered by teneral individual \`${i.id}\` (${userAgent()}). Commit \`${r.commit}\`, on the species at \`${short(r.species)}\`. `
    + `Its commits are signed with the SSH key \`${key.fingerprint}\`, which says they come from that install and nothing about what they hold.`,
  `That install's own kernel checked the commit before it was sent: ${r.steps.map((s) => `${s.name} ${mark(s.ok)}`).join(', ')}. `
    + 'These are one install\'s results: evidence for the maintainer, not a verdict.'].join('\n');
}

export interface NetOptions { send?: typeof fetch }

/**
 * `publish <branch>`: push the checked and approved commit to `contrib/<individual>/<name>` on the
 * species' repository and open a pull request against its branch. Every step can be run again: a
 * push of the same commit changes nothing, a pull request that is already there is found and named,
 * and the approval is used up only when all of it is done.
 */
export async function publish(i: Install, branch: string, o: NetOptions = {}): Promise<Outcome> {
  const mode = consent(i.s);
  if (mode === 'off') return { status: 1, text: OFF };
  const commit = resolve(i.root, branchRef(i.root, branch));
  const report = readReport(i.root, commit);
  if (report === null || report.what !== 'publish' || !report.ok) {
    return { status: 1, text: `${branch} is at ${short(commit)}, and no check has passed for that commit. Run: bun kernel/offer.ts check ${branch}` };
  }
  if (report.published) return { status: 0, text: `Already published: ${report.published.url} (commit ${short(commit)} as ${report.published.branch}).` };
  const hub = hubOf(i.root, i.s);
  const species = speciesHead(i.root, i.s);
  if (species !== report.species && !gitOk(i.root, 'merge-base', '--is-ancestor', species, commit)) {
    return { status: 1, text: `The species moved to ${short(species)} since the check, and ${branch} is not built on that. Rebase it, sign and check again.` };
  }
  if (mode === 'ask' && !approved(i.owner, commit)) return { status: WAITING, text: askOwner(commit) };
  if (!hasToken(i.auth)) return { status: 1, text: `No GitHub token is stored here, so nothing can be sent. Your owner stores one with ./box offer token; it needs ${TOKEN_NEEDS}.` };
  const key = ensureKey(i.auth, i.id);

  // The species as it stands at its home, now: an offer built on an older head is one the maintainer would have to mend.
  const heads = gitRemote(i.root, i.auth, ['ls-remote', hub.url, `refs/heads/${hub.branch}`]);
  if (heads.code !== 0) return { status: 1, text: remoteFailure(hub, 'Asking for the species\' head', heads) };
  const theirs = heads.stdout.toString().split(/\s+/)[0] ?? '';
  if (!COMMIT.test(theirs)) return { status: 1, text: `${hub.url} has no branch ${hub.branch}.` };
  if (!gitOk(i.root, 'merge-base', '--is-ancestor', theirs, commit)) {
    return { status: 1, text: `The species is at ${short(theirs)} at its home, and ${branch} is not built on that. Fetch it, rebase the branch onto it, sign and check again; then your owner approves the new commit.` };
  }

  const target = `contrib/${i.id}/${slugOf(branch)}`;
  // Forced: the branch is this individual's own, and a mended offer replaces the one before it.
  const pushed = gitRemote(i.root, i.auth, ['push', '--quiet', hub.url, `+${commit}:refs/heads/${target}`]);
  if (pushed.code !== 0) return { status: 1, text: `${remoteFailure(hub, `Pushing ${target}`, pushed)}\nNothing was published. Run this again once that is mended; the approval still stands.` };

  let pull: Pull;
  let note = '';
  try {
    try {
      pull = asPull(await api(hub, i.auth, 'POST', `/repos/${hub.slug}/pulls`, { title: report.title, head: target, base: hub.branch, body: `${report.body}\n\n${footer(i, report, key)}` }, o.send));
    } catch (err) {
      if (!(err instanceof GitHubError) || err.status !== 422 || !/already exists/i.test(err.detail)) throw err;
      // An earlier run got as far as this, or an earlier offer under the same name is still open: the push above has brought it to this commit.
      const open = await api(hub, i.auth, 'GET', `/repos/${hub.slug}/pulls?state=open&head=${encodeURIComponent(`${hub.slug.split('/')[0]}:${target}`)}`, undefined, o.send);
      if (!Array.isArray(open) || open.length === 0) throw err;
      pull = asPull(open[0]);
      note = ' The pull request was already open; it now shows this commit, with the title and text it had.';
    }
  } catch (err) {
    return { status: 1, text: `The commit was pushed as ${target}, but the pull request was not opened: ${reasonOf(err)}.\nRun this again once that is mended: it goes on from here, and the approval still stands.` };
  }
  const published = { url: pull.html_url, branch: target, at: new Date().toISOString() };
  saveReport(i.root, { ...report, published });
  appendEvent(journalOf(i.root), generation(i.root), { type: 'offer.published', commit, branch: target, url: pull.html_url });
  if (mode === 'ask') useApproval(i.owner, commit);
  return { status: 0, text: `Published ${short(commit)} as ${target}: ${pull.html_url}${note}\nIt is an offer now. A human reads it and decides; nothing here merges it.` };
}

// --- witness ---

/** A witness report as it is posted: the text that is signed, and the signature. */
export function witnessComment(reportText: string, signature: string, ok: boolean): string {
  return [`**teneral witness: ${ok ? 'pass' : 'fail'}** (what one install saw when it ran the checks; evidence, not a vote)`, '', '```', reportText.trimEnd(), '```', '', '```', signature.trimEnd(), '```', '',
    `The second block is an SSH signature of the first, taken as its lines with a line break after each, in the namespace \`${WITNESS_NAMESPACE}\`. `
    + `To see which key made it: \`ssh-keygen -Y check-novalidate -n ${WITNESS_NAMESPACE} -s <signature file> < <report file>\`. It says which install reported, not that the report is right.`].join('\n');
}

/** The report and the fingerprint of the key that signed it, from a posted comment; null when it holds no report whose signature holds. */
export function readWitness(comment: string): { report: string; signer: string } | null {
  const blocks = [...comment.matchAll(/```\n([\s\S]*?)\n```/g)].map((m) => m[1]!);
  if (blocks.length < 2) return null;
  const report = `${blocks[0]}\n`;
  const signer = signerOf(WITNESS_NAMESPACE, report, `${blocks[1]}\n`);
  return signer === null ? null : { report, signer };
}

function facts(): string {
  const gitVersion = run(['git', '--version']).stdout.toString().trim().replace(/^git version /, 'git ');
  return `${userAgent()}, bun ${Bun.version}, ${gitVersion}, ${process.platform} ${process.arch}`;
}

export interface WitnessOptions extends NetOptions {
  /** One more command of the witness's own, run in a checkout of the pull request's head with what any check sees. */
  also?: string | null;
  gates?: CheckOptions['gates'];
  signal?: AbortSignal;
}

/**
 * `witness <pr>`: fetch an open pull request, run on its head what `check` runs on an offer of
 * one's own, and post what was seen as a signed comment. Under `ask` the owner approves the pull
 * request's exact head commit first, and nothing of it is run before that: running it is running
 * a stranger's code here, with everything this install's shell can reach.
 *
 * What goes out is pass or fail per check and a few facts about this environment. What the
 * commit's code printed stays here: its tests could print anything they can read.
 */
export async function witness(i: Install, pr: number, o: WitnessOptions = {}): Promise<Outcome> {
  const mode = consent(i.s);
  if (mode === 'off') return { status: 1, text: OFF };
  if (!hasToken(i.auth)) return { status: 1, text: `No GitHub token is stored here, so a report could not be posted. Your owner stores one with ./box offer token; it needs ${TOKEN_NEEDS}.` };
  const hub = hubOf(i.root, i.s);
  let pull: Pull;
  try {
    pull = asPull(await api(hub, i.auth, 'GET', `/repos/${hub.slug}/pulls/${pr}`, undefined, o.send));
  } catch (err) {
    return { status: 1, text: `Pull request #${pr} could not be read: ${reasonOf(err)}` };
  }
  if (pull.state !== 'open') return { status: 1, text: `Pull request #${pr} is ${pull.state}, not open: there is nothing left to witness.` };
  let problem = '';
  // Into FETCH_HEAD only: no ref of this repository moves, the species' ref least of all.
  const fetched = (ref: string): string | null => {
    const r = gitRemote(i.root, i.auth, ['fetch', '--quiet', '--no-tags', hub.url, ref]);
    if (r.code === 0) return git(i.root, 'rev-parse', 'FETCH_HEAD').trim();
    problem = remoteFailure(hub, `Fetching ${ref}`, r);
    return null;
  };
  const species = fetched(`refs/heads/${pull.base.ref}`);
  const commit = species === null ? null : fetched(`refs/pull/${pr}/head`);
  if (species === null || commit === null) return { status: 1, text: problem };
  if (commit !== pull.head.sha) return { status: 1, text: `Pull request #${pr} moved while it was being fetched (${short(pull.head.sha)}, then ${short(commit)}). Run this again.` };

  const key = ensureKey(i.auth, i.id);
  if (mode === 'ask' && !approved(i.owner, commit)) {
    // Read, not run: the owner is shown what they would be letting in.
    const seen = await check(i.root, species, commit, { what: 'witness', secrets: ownSecrets(i.root), gates: async () => ({ ok: false, gate: 'waiting', output: '' }) });
    const waitingReport: Report = { ...seen, pr, ok: false, steps: seen.steps.filter((s) => s.name !== 'gates'), output: undefined };
    saveReport(i.root, waitingReport);
    return { status: WAITING, text: `${formatReport(waitingReport)}\n\nNothing of it has been run. Witnessing runs this commit's code here, with what your shell can reach, and posts the result in public.\n${askOwner(commit)}` };
  }

  const report: Report = { ...await check(i.root, species, commit, { what: 'witness', secrets: ownSecrets(i.root), provider: i.s.TENERAL_PROVIDER, gates: o.gates, signal: o.signal }), pr };
  let also: boolean | null = null;
  if (o.also) {
    const extra = await seedGates(i.root, commit, { checks: [{ gate: 'also', cmd: ['bash', '-c', o.also] }], smoke: false, signal: o.signal });
    also = extra.ok;
    if (!extra.ok) report.output = `${report.output ?? ''}\n[${o.also}]\n${extra.output}`.trim();
  }
  const ok = report.ok && also !== false;
  const text = [
    'teneral witness report', `pull request: ${hub.slug}#${pr}`, `commit: ${commit}`, `species: ${pull.base.ref} at ${species}`, `result: ${ok ? 'pass' : 'fail'}`,
    ...report.steps.map((s) => `${s.name}: ${mark(s.ok)}${s.name === 'signed' && s.ok ? ` (${[...new Set(report.commits.map((c) => c.signer))].join(', ')})` : ''}`),
    ...(o.also ? [`also, the witness's own \`${o.also.replace(/\s+/g, ' ').slice(0, 200)}\`: ${mark(also)}`] : []),
    `environment: ${facts()}${i.s.TENERAL_PROVIDER ? `, smoke run as provider ${i.s.TENERAL_PROVIDER}` : ''}`,
    `witness: teneral individual ${i.id}, key ${key.fingerprint}`, `at: ${report.at}`, '',
  ].join('\n');
  let url: string;
  try {
    const posted = await api(hub, i.auth, 'POST', `/repos/${hub.slug}/issues/${pr}/comments`, { body: witnessComment(text, signText(key, WITNESS_NAMESPACE, text), ok) }, o.send) as { html_url?: unknown } | null;
    url = typeof posted?.html_url === 'string' ? posted.html_url : pull.html_url;
  } catch (err) {
    saveReport(i.root, report);
    return { status: 1, text: `${formatReport(report)}\n\nThe checks ran, but the report was not posted: ${reasonOf(err)}.\nRun this again once that is mended: it runs the checks again and posts then.` };
  }
  saveReport(i.root, { ...report, ok, published: { url, branch: pull.head.ref, at: new Date().toISOString() } });
  appendEvent(journalOf(i.root), generation(i.root), { type: 'offer.witnessed', commit, pr, ok, url });
  if (mode === 'ask') useApproval(i.owner, commit);
  return { status: 0, text: `${formatReport(report)}\n\nWitnessed pull request #${pr} at ${short(commit)}: ${ok ? 'pass' : 'fail'}. Posted: ${url}\nWhat the checks printed was kept here and not posted.` };
}

// --- the owner's side ---

/** What is waiting for the owner, each with what was found; for `list`, `/offers`, and before an approval. */
export function pending(i: Install): Report[] {
  return reports(i.root).filter((r) => waiting(i.owner, r));
}

function one(i: Install, prefix: string): Report | string {
  if (!/^[0-9a-f]{7,40}$/.test(prefix)) return 'Name the commit by its first seven or more characters, as the list shows it.';
  const found = pending(i).filter((r) => r.commit.startsWith(prefix));
  if (found.length === 1) return found[0]!;
  return found.length === 0 ? `Nothing that starts with ${prefix} is waiting for you. What is: ${pending(i).map((r) => short(r.commit)).join(', ') || 'nothing'}.`
    : `${prefix} is the start of ${found.length} waiting commits; give more of it.`;
}

/** The report for a waiting commit, with what it holds read again from git now rather than taken from the record. */
export function showPending(i: Install, prefix: string): { report: Report | null; text: string } {
  const r = one(i, prefix);
  if (typeof r === 'string') return { report: null, text: r };
  let fresh = r;
  try { fresh = { ...r, ...describe(i.root, r.species, r.commit) }; } catch { /* the record's own account stands */ }
  return { report: fresh, text: formatReport(fresh) };
}

/** The owner approves one waiting commit. Returns what to tell them. */
export function approvePending(i: Install, prefix: string): Outcome {
  const r = one(i, prefix);
  if (typeof r === 'string') return { status: 1, text: r };
  if (consent(i.s) === 'off') return { status: 1, text: 'TENERAL_PUBLISH is off in .env: nothing goes out, approved or not. Change that first.' };
  approve(i.owner, r.commit);
  return {
    status: 0,
    text: r.what === 'witness' ? `Approved: ${short(r.commit)}, the head of pull request #${r.pr}, may be run here and a report on it posted. The agent does that when it next runs the witness command; tell it.`
      : `Approved: ${short(r.commit)} (${r.branch}) may be published. The agent does that when it next runs the publish command; tell it. If the branch changes, this approval is for nothing.`,
  };
}

/** `/offers` and `/approve <commit>` in the talk clients: the lines to show, or null for a line that is neither. */
export function ownerCommand(root: string, line: string): string[] | null {
  const [name = '', arg = '', ...more] = line.trim().split(/\s+/);
  if (name !== '/offers' && name !== '/approve') return null;
  try {
    const i = install(root);
    if (name === '/offers') {
      const all = pending(i);
      if (all.length === 0) return ['Nothing is waiting for your approval.'];
      return [...all.flatMap((r) => [...showPending(i, r.commit).text.split('\n'), '']), `/approve <commit> lets one of them go out (TENERAL_PUBLISH is ${consent(i.s)}).`];
    }
    if (arg === '' || more.length > 0) return ['/approve <commit>: the first seven or more characters of a commit that /offers lists.'];
    return approvePending(i, arg).text.split('\n');
  } catch (err) {
    return [`That could not be done: ${reasonOf(err)}`];
  }
}

// --- the command line ---

const USAGE = `usage: bun kernel/offer.ts <command>     (your owner: ./box offer <command>)

  check <branch>            look at a branch as an offer to the species: what it would publish, and whether it may
  sign <branch>             sign the branch's own commits with this individual's key
  publish <branch>          push the checked commit, approved by the owner, and open a pull request
  witness <pr> [--also <command>]
                            run the same checks on an open pull request and post what was seen
  list                      what was checked here, and what waits for the owner
  key                       print this individual's public signing key, making it first if there is none
  gates [<commit>]          the gates of a mutation on a commit as a fresh seed, and nothing else (default: HEAD)

for the owner, at a terminal:
  approve <commit>          let exactly this commit go out
  token                     store the GitHub token publishing needs

TENERAL_PUBLISH in .env: ask (the default: the owner approves each commit), auto, or off.`;

/** The command line. Returns the exit status: 0 done, 1 refused or failed, 2 not understood, 3 waiting for the owner. */
export async function main(
  args: string[], root: string, out: (line: string) => void, err: (line: string) => void, tty: boolean = process.stdin.isTTY === true,
): Promise<number> {
  const [command = '', ...rest] = args;
  const say = (o: Outcome): number => {
    (o.status === 1 ? err : out)(o.text);
    return o.status;
  };
  try {
    if (command === 'gates' && rest.length <= 1) {
      // What a mutation must pass, on any commit, with nothing of an install around it: for the species' own CI, and for a look by hand.
      const commit = resolve(root, rest[0] ?? 'HEAD');
      const r = await seedGates(root, commit, { provider: settings(root).TENERAL_PROVIDER });
      const at = (GATES as readonly string[]).indexOf(r.gate);
      for (const [n, gate] of GATES.entries()) out(`${gate.padEnd(13)}${mark(r.ok || (at !== -1 && n < at) ? true : n === at ? false : null)}`);
      if (!r.ok) err(`\n${short(commit)} fails at gate ${r.gate}:\n${r.output.trimEnd()}`);
      return r.ok ? 0 : 1;
    }
    const i = install(root);
    switch (command) {
      case 'check':
        if (rest.length !== 1) break;
        return say(await checkBranch(i, rest[0]!));
      case 'sign':
        if (rest.length !== 1) break;
        return say(sign(i, rest[0]!));
      case 'publish':
        if (rest.length !== 1) break;
        return say(await publish(i, rest[0]!));
      case 'witness': {
        const pr = Number(rest[0]);
        const also = rest[1] === '--also' && rest.length === 3 ? rest[2]! : null;
        if (!Number.isInteger(pr) || pr < 1 || (rest.length !== 1 && also === null)) break;
        return say(await witness(i, pr, { also }));
      }
      case 'list': {
        if (rest.length !== 0) break;
        const all = reports(i.root);
        if (all.length === 0) out('Nothing has been checked here yet.');
        for (const r of all) {
          const state = r.published ? `sent: ${r.published.url}` : waiting(i.owner, r) ? 'waiting for the owner' : approved(i.owner, r.commit) ? 'approved, not sent yet' : 'did not pass';
          out(`${short(r.commit)}  ${r.what === 'witness' ? `witness of #${r.pr}` : `offer ${r.branch}`}  ${state}  ${r.title}`);
        }
        return 0;
      }
      case 'key': {
        if (rest.length !== 0) break;
        const key = ensureKey(i.auth, i.id);
        out(key.public);
        err(`\nThis individual's signing key, ${key.fingerprint}. The private half is ${join(i.auth, KEY_FILE)}, readable only by you, and by the agent's shell.`);
        err('To have GitHub show its commits as verified, add the line above to your GitHub account as a signing key (Settings, SSH and GPG keys, New SSH key, key type: Signing Key).');
        err(`To verify one yourself: git -c gpg.ssh.allowedSignersFile=<file> verify-commit <commit>, where <file> holds a line: teneral-${i.id} namespaces="${GIT_NAMESPACE}" ${key.public.split(' ').slice(0, 2).join(' ')}`);
        return 0;
      }
      case 'approve': {
        if (rest.length !== 1) break;
        if (!tty) {
          err('An approval is the owner\'s, given at a terminal: ./box offer approve <commit>, or /approve <commit> in ./box talk. This is not a terminal, and nothing was approved.');
          return 1;
        }
        const shown = showPending(i, rest[0]!);
        (shown.report ? out : err)(shown.text);
        if (shown.report === null) return 1;
        const { terminalIo } = await import('./setup');
        const io = terminalIo();
        out(`\nThis goes to a public place and cannot be taken back. The kernel's check is above; what the agent told you about it is not part of it.`);
        const answer = (await io.ask(`Type ${short(shown.report.commit).slice(0, 7)} to approve, anything else to leave it: `))?.trim() ?? '';
        if (answer.length < 7 || !shown.report.commit.startsWith(answer)) {
          err('Left as it was: nothing was approved.');
          return 1;
        }
        return say(approvePending(i, shown.report.commit));
      }
      case 'token': {
        if (rest.length !== 0) break;
        if (!tty) {
          err('The token is typed by the owner at a terminal: ./box offer token. This is not a terminal, and nothing was stored.');
          return 1;
        }
        const hub = hubOf(i.root, i.s);
        const { terminalIo } = await import('./setup');
        out(`A token for publishing to ${hub.slug}: ${TOKEN_NEEDS}.`);
        out('GitHub cannot limit a token to some branches. What keeps this one out of the species\' main branch is that branch\'s protection, not the token.');
        out(`It is stored in ${join(i.auth, TOKEN_FILE)}, readable only by you, and by the agent's shell.\n`);
        const typed = (await terminalIo().ask('Token (not shown): ', { hidden: true }))?.trim() ?? '';
        if (typed === '') {
          err('Nothing was entered, and nothing was stored.');
          return 1;
        }
        const before = join(i.auth, `.${TOKEN_FILE}.before`);
        const had = existsSync(join(i.auth, TOKEN_FILE));
        if (had) renameSync(join(i.auth, TOKEN_FILE), before);
        const restore = () => { if (had) renameSync(before, join(i.auth, TOKEN_FILE)); else rmSync(join(i.auth, TOKEN_FILE), { force: true }); };
        try {
          saveToken(i.auth, typed);
          await api(hub, i.auth, 'GET', `/repos/${hub.slug}`);
        } catch (e) {
          restore();
          err(`Not stored: the token was tried on ${hub.slug} first, and ${reasonOf(e)}`);
          return 1;
        }
        rmSync(before, { force: true });
        out(`Stored. GitHub accepted it for reading ${hub.slug}; whether it may push and open pull requests shows at the first publish.`);
        return 0;
      }
      case '': case 'help': case '-h': case '--help':
        out(USAGE);
        return 0;
      default:
    }
  } catch (e) {
    err(reasonOf(e));
    return 1;
  }
  err(USAGE);
  return 2;
}

if (import.meta.main) {
  // The install this kernel belongs to, also when run from one of its worktrees, as the agent does from its workspace.
  process.exit(await main(process.argv.slice(2), repoRoot(import.meta.dir), (line) => console.log(line), (line) => console.error(line)));
}
